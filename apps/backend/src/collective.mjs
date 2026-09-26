import {
  concatHex,
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  sliceHex,
} from 'viem';
import { compatible } from './matcher.mjs';
import {
  collectiveAbi,
  hashMandate,
  hashOrder,
  routerAbi,
  ZERO_HASH,
} from './protocol.mjs';

const GUARD = '0xa280';
const PREFIX_BYTES = 130;
const guardFields = [
  { name: 'coordinator', type: 'address' },
  { name: 'campaign', type: 'bytes32' },
  { name: 'minParticipants', type: 'uint256' },
  { name: 'minSpend', type: 'uint256' },
];

export function parseCollectiveProgram(program) {
  if (typeof program !== 'string' || !isHex(program) || program.length % 2)
    throw new Error('Invalid program');
  const normalized = program.toLowerCase();
  if (!normalized.startsWith('0xa2')) return null;
  if (
    !normalized.startsWith(GUARD) ||
    normalized.length <= 2 + PREFIX_BYTES * 2
  )
    throw new Error('Invalid collective guard');
  const encoded = sliceHex(normalized, 2, PREFIX_BYTES);
  const [coordinator, campaign, minParticipants, minSpend] =
    decodeAbiParameters(guardFields, encoded);
  if (
    !isAddress(coordinator) ||
    getAddress(coordinator) === '0x0000000000000000000000000000000000000000' ||
    campaign.toLowerCase() === ZERO_HASH ||
    minParticipants < 2n ||
    minParticipants > 8n ||
    minSpend === 0n ||
    encodeAbiParameters(guardFields, [
      coordinator,
      campaign,
      minParticipants,
      minSpend,
    ]).toLowerCase() !== encoded
  )
    throw new Error('Invalid collective guard');
  return {
    coordinator: getAddress(coordinator),
    campaign: campaign.toLowerCase(),
    minParticipants: Number(minParticipants),
    minSpend,
    prefix: sliceHex(normalized, 0, PREFIX_BYTES),
    priceProgram: sliceHex(normalized, PREFIX_BYTES),
  };
}

export function guardProgram({
  coordinator,
  campaign,
  minParticipants,
  minSpend,
  priceProgram,
}) {
  const program = concatHex([
    GUARD,
    encodeAbiParameters(guardFields, [
      coordinator,
      campaign,
      BigInt(minParticipants),
      BigInt(minSpend),
    ]),
    priceProgram,
  ]);
  parseCollectiveProgram(program);
  return program;
}

// Build and simulate an atomic activation from persisted signed envelopes.
export class CollectiveBatch {
  constructor(book, client, account, { chainId, router, collective }) {
    this.book = book;
    this.client = client;
    this.account = account;
    this.accountAddress = getAddress(
      typeof account === 'string' ? account : account.address,
    );
    this.chainId = Number(chainId);
    if (
      !Number.isSafeInteger(this.chainId) ||
      this.chainId <= 0 ||
      client.chain?.id !== this.chainId
    )
      throw new Error('Wrong configured chain');
    this.router = getAddress(router);
    this.collective = getAddress(collective);
  }

  build(pairs) {
    if (!Array.isArray(pairs) || pairs.length < 2 || pairs.length > 8)
      throw new Error('Invalid collective batch size');
    const fills = [];
    const buyers = new Set();
    let common;
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2)
        throw new Error('Invalid collective pair');
      const bid = this.book.get(pair[0]);
      const ask = this.book.get(pair[1]);
      if (!bid || !ask || !compatible(bid, ask))
        throw new Error('Incompatible collective orders');
      const guard = parseCollectiveProgram(bid.program);
      if (!guard || guard.coordinator !== this.collective)
        throw new Error('Wrong collective coordinator');
      if (common && common.prefix !== guard.prefix)
        throw new Error('Mixed collective campaigns');
      common ??= guard;
      const buyer = bid.order.maker.toLowerCase();
      if (buyers.has(buyer)) throw new Error('Duplicate collective buyer');
      buyers.add(buyer);
      fills.push({
        bid: bid.order,
        bidSig: bid.signature,
        ask: ask.order,
        askSig: ask.signature,
        mandate: bid.mandate,
        program: bid.program,
      });
    }
    if (pairs.length < common.minParticipants)
      throw new Error('Collective participant threshold unmet');
    return {
      address: this.collective,
      abi: collectiveAbi,
      functionName: 'activate',
      args: [fills],
      account: this.account,
      chain: this.client.chain,
    };
  }

  async simulate(pairs) {
    if ((await this.client.getChainId()) !== this.chainId)
      throw new Error('Wrong chain');
    const [deployedCollective, boundRouter] = await Promise.all([
      this.client.readContract({
        address: this.router,
        abi: routerAbi,
        functionName: 'collective',
      }),
      this.client.readContract({
        address: this.collective,
        abi: collectiveAbi,
        functionName: 'router',
      }),
    ]);
    if (
      getAddress(deployedCollective) !== this.collective ||
      getAddress(boundRouter) !== this.router
    )
      throw new Error('Collective deployment mismatch');
    return this.client.simulateContract(this.build(pairs));
  }

  // Check exact calldata, current receipt and every settlement/activation event.
  async confirm(receipt, request) {
    if ((await this.client.getChainId()) !== this.chainId)
      throw new Error('Wrong chain');
    if (
      receipt?.status !== 'success' ||
      getAddress(receipt.to) !== this.collective
    )
      throw new Error('Collective transaction failed');
    const [current, tx] = await Promise.all([
      this.client.getTransactionReceipt({ hash: receipt.transactionHash }),
      this.client.getTransaction({ hash: receipt.transactionHash }),
    ]);
    const expectedData = encodeFunctionData({
      abi: collectiveAbi,
      functionName: 'activate',
      args: request.args,
    });
    if (
      current.status !== 'success' ||
      current.blockHash !== receipt.blockHash ||
      getAddress(tx.to) !== this.collective ||
      getAddress(tx.from) !== this.accountAddress ||
      Number(tx.chainId) !== this.chainId ||
      tx.input.toLowerCase() !== expectedData.toLowerCase()
    )
      throw new Error('Collective transaction mismatch');
    const fills = request.args[0];
    const settlements = [];
    const activations = [];
    for (const log of current.logs) {
      if (getAddress(log.address) === this.router) {
        const event = decodeEventLog({
          abi: routerAbi,
          data: log.data,
          topics: log.topics,
        });
        if (event.eventName === 'Settled') settlements.push(event.args);
      } else if (getAddress(log.address) === this.collective) {
        const event = decodeEventLog({
          abi: collectiveAbi,
          data: log.data,
          topics: log.topics,
        });
        if (event.eventName === 'Activated') activations.push(event.args);
      }
    }
    if (settlements.length !== fills.length || activations.length !== 1)
      throw new Error('Incomplete collective receipt');
    let price = 0n;
    let fee = 0n;
    for (let i = 0; i < fills.length; ++i) {
      const fill = fills[i];
      const event = settlements[i];
      if (
        event.buyHash.toLowerCase() !==
          hashOrder(fill.bid, {
            chainId: this.chainId,
            router: this.router,
          }).toLowerCase() ||
        event.sellHash.toLowerCase() !==
          hashOrder(fill.ask, {
            chainId: this.chainId,
            router: this.router,
          }).toLowerCase() ||
        event.mandate.toLowerCase() !== hashMandate(fill.mandate).toLowerCase()
      )
        throw new Error('Collective fill receipt mismatch');
      price += event.price;
      fee += event.fee;
    }
    const guard = parseCollectiveProgram(fills[0].program);
    const activation = activations[0];
    if (
      activation.campaign.toLowerCase() !== guard.campaign ||
      activation.participants !== BigInt(fills.length) ||
      activation.price !== price ||
      activation.fee !== fee ||
      price + fee < guard.minSpend
    )
      throw new Error('Collective activation receipt mismatch');
    const canonical = await this.client.getBlock({
      blockNumber: current.blockNumber,
    });
    if (canonical?.hash?.toLowerCase() !== current.blockHash?.toLowerCase())
      throw new Error('Collective receipt not canonical');
    return {
      transactionHash: receipt.transactionHash,
      campaign: guard.campaign,
      participants: fills.length,
      price,
      fee,
    };
  }
}
