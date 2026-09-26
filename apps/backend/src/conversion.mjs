import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isHex,
  keccak256,
  parseEventLogs,
} from 'viem';
import { compatible } from './matcher.mjs';
import { collectiveAbi, routerAbi } from './protocol.mjs';
import { StoredSubmission } from './submission.mjs';

const address = (value) => {
  const result = getAddress(value);
  if (result === '0x0000000000000000000000000000000000000000')
    throw new Error('Zero conversion address');
  return result;
};
const same = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.toLowerCase() === b.toLowerCase();
const pack = (value) =>
  JSON.stringify(value, (_, v) =>
    typeof v === 'bigint' ? { bigint: v.toString() } : v,
  );
const unpack = (value) =>
  JSON.parse(value, (_, v) =>
    v && typeof v === 'object' && Object.keys(v).length === 1 && 'bigint' in v
      ? BigInt(v.bigint)
      : v,
  );
const uint = (value, name) => {
  if (
    !(
      typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
    )
  )
    throw new Error(`Invalid ${name}`);
  const result = BigInt(value);
  if (result < 0n || result >= 1n << 256n)
    throw new Error(`Invalid ${name}`);
  return result;
};
const hash = (value, name) => {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66)
    throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
};
const signature = (value, name) => {
  if (
    typeof value !== 'string' ||
    !isHex(value) ||
    value.length < 4 ||
    value.length % 2
  )
    throw new Error(`Invalid ${name}`);
  return value;
};

const intentFields = [
  ['buyer', 'address'],
  ['bidHash', 'bytes32'],
  ['askHash', 'bytes32'],
  ['batchHash', 'bytes32'],
  ['sourceToken', 'address'],
  ['maxInput', 'uint256'],
  ['minOutput', 'uint256'],
  ['usdcCap', 'uint256'],
  ['recipient', 'address'],
  ['deadline', 'uint256'],
  ['chainId', 'uint256'],
  ['executor', 'address'],
  ['nonce', 'uint256'],
].map(([name, type]) => ({ name, type }));
const tuple = (name, components) => ({ name, type: 'tuple', components });
const conversionEvent = {
  type: 'event',
  name: 'ConvertedSettled',
  inputs: [
    { name: 'buyer', type: 'address', indexed: true },
    { name: 'nonce', type: 'uint256', indexed: true },
    { name: 'bidHash', type: 'bytes32', indexed: true },
    { name: 'askHash', type: 'bytes32', indexed: false },
    { name: 'input', type: 'uint256', indexed: false },
    { name: 'output', type: 'uint256', indexed: false },
    { name: 'price', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
  ],
};
export const converterAbi = [
  {
    type: 'function',
    name: 'executeCollective',
    stateMutability: 'nonpayable',
    inputs: [
      tuple('intent', intentFields),
      { name: 'intentSig', type: 'bytes' },
      collectiveAbi[1].inputs[0],
    ],
    outputs: [
      { name: 'output', type: 'uint256' },
      { name: 'totalPrice', type: 'uint256' },
      { name: 'totalFee', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'hashBatch',
    stateMutability: 'pure',
    inputs: [collectiveAbi[1].inputs[0]],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'collective',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      tuple('intent', intentFields),
      { name: 'intentSig', type: 'bytes' },
      routerAbi[0].inputs[0],
      routerAbi[0].inputs[1],
      routerAbi[0].inputs[2],
      routerAbi[0].inputs[3],
      routerAbi[0].inputs[4],
      routerAbi[0].inputs[5],
    ],
    outputs: [
      { name: 'output', type: 'uint256' },
      { name: 'price', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
  },
  ...['rentalRouter', 'swapRouter', 'sourceToken', 'usdc'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  })),
  {
    type: 'function',
    name: 'poolFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
  },
  conversionEvent,
  {
    type: 'event',
    name: 'ConvertedCollective',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: true },
      { name: 'batchHash', type: 'bytes32', indexed: true },
      { name: 'bidHash', type: 'bytes32', indexed: false },
      { name: 'input', type: 'uint256', indexed: false },
      { name: 'output', type: 'uint256', indexed: false },
      { name: 'buyerPrice', type: 'uint256', indexed: false },
      { name: 'buyerFee', type: 'uint256', indexed: false },
      { name: 'totalPrice', type: 'uint256', indexed: false },
      { name: 'totalFee', type: 'uint256', indexed: false },
    ],
  },
];
export const hashBatch = (fills) =>
  keccak256(encodeAbiParameters([collectiveAbi[1].inputs[0]], [fills]));

export const intentTypes = {
  FundingIntent: intentFields.map(({ name, type }) => ({ name, type })),
};
export const intentDomain = ({ chainId, executor }) => ({
  name: 'RentalAtomicConverter',
  version: '1',
  chainId: Number(chainId),
  verifyingContract: executor,
});
export const hashIntent = (intent, config) =>
  hashTypedData({
    domain: intentDomain(config),
    types: intentTypes,
    primaryType: 'FundingIntent',
    message: intent,
  });

// Consumes orders already authenticated and persisted by OrderBook. As with
// Matcher, unsigned requests and exact signed bytes survive process restarts.
export class ConversionRelay {
  constructor(book, publicClient, walletClient, config) {
    if (
      !book?.get ||
      !book?.store?.db ||
      !publicClient?.getChainId ||
      !publicClient?.readContract ||
      !publicClient?.simulateContract ||
      !publicClient?.waitForTransactionReceipt ||
      !publicClient?.getTransactionReceipt ||
      !publicClient?.getTransactionCount ||
      !publicClient?.sendRawTransaction ||
      !publicClient?.getBlock ||
      !publicClient?.getBlockNumber ||
      !publicClient?.getTransaction ||
      !walletClient?.getChainId ||
      !walletClient?.prepareTransactionRequest ||
      !walletClient?.signTransaction ||
      !walletClient?.account?.address
    )
      throw new Error('Conversion relay requires orders and chain clients');
    if (
      !Number.isSafeInteger(config?.chainId) ||
      config.chainId <= 0 ||
      !Number.isSafeInteger(config?.poolFee) ||
      config.poolFee < 1 ||
      config.poolFee > 1_000_000 ||
      !Number.isSafeInteger(config?.confirmations ?? 2) ||
      (config.confirmations ?? 2) < 1
    )
      throw new Error('Invalid conversion configuration');
    this.config = {
      chainId: config.chainId,
      executor: address(config.executor),
      router: address(config.router),
      collective: address(config.collective),
      swapRouter: address(config.swapRouter),
      sourceToken: address(config.sourceToken),
      usdc: address(config.usdc),
      poolFee: config.poolFee,
      confirmations: config.confirmations ?? 2,
    };
    if (
      book.config?.chainId !== this.config.chainId ||
      !same(book.config?.router, this.config.router) ||
      !same(book.config?.usdc, this.config.usdc)
    )
      throw new Error('Order book differs from conversion deployment');
    this.book = book;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.db = book.store.db;
    this.sender = walletClient.account.address.toLowerCase();
    const scope = JSON.stringify(this.config);
    const existing = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'conversion_scope'")
      .get();
    if (existing && existing.value !== scope)
      throw new Error('Conversion store deployment differs');
    if (!existing)
      this.db
        .prepare("INSERT INTO metadata (key, value) VALUES ('conversion_scope', ?)")
        .run(scope);
    this.submissions = new StoredSubmission(this.db, publicClient, walletClient, {
      chainId: this.config.chainId,
      kind: 'conversion',
    });
  }

  get(id) {
    return this.submissions.get(hash(id, 'conversion id'));
  }

  async submit({ bidHash, askHash, intent, intentSig }) {
    return this.#submit('single', [{ bidHash, askHash }], intent, intentSig);
  }

  async submitCollective({ pairs, intent, intentSig }) {
    if (!Array.isArray(pairs) || pairs.length < 2 || pairs.length > 8)
      throw new Error('Collective conversion requires 2–8 persisted pairs');
    return this.#submit('collective', pairs, intent, intentSig);
  }

  async recover() {
    const rows = this.db
      .prepare("SELECT payload FROM submissions WHERE kind = 'conversion' ORDER BY nonce")
      .all();
    const results = [];
    for (const { payload } of rows) {
      const saved = unpack(payload);
      results.push(
        await this.#submit(saved.mode, saved.pairs, saved.intent, saved.intentSig),
      );
    }
    return results;
  }

  async status(id) {
    await this.#assertChainDeployment();
    const job = this.get(id);
    if (!job) throw new Error('Unknown conversion submission');
    if (!job.raw) return { id: job.id, state: 'prepared' };
    const receipt = await this.#receipt(job.tx_hash);
    if (!receipt) return { id: job.id, transactionHash: job.tx_hash, state: 'broadcast' };
    await this.#assertCanonical(receipt);
    if (receipt.status !== 'success')
      return { id: job.id, transactionHash: job.tx_hash, state: 'reverted' };
    const latestNumber = await this.publicClient.getBlockNumber();
    if (
      latestNumber - receipt.blockNumber + 1n <
      BigInt(this.config.confirmations)
    )
      return { id: job.id, transactionHash: job.tx_hash, state: 'mined' };
    const saved = unpack(job.payload);
    return this.#verify(job, receipt, this.#build(saved.mode, saved.pairs, saved.intent, saved.intentSig));
  }

  #build(mode, pairs, intent, intentSig) {
    if (mode !== 'single' && mode !== 'collective')
      throw new Error('Invalid conversion mode');
    if (
      !Array.isArray(pairs) ||
      pairs.length < (mode === 'single' ? 1 : 2) ||
      pairs.length > (mode === 'single' ? 1 : 8)
    )
      throw new Error('Invalid conversion pairs');
    const canonicalPairs = pairs.map(({ bidHash, askHash }) => ({
      bidHash: hash(bidHash, 'bid hash'),
      askHash: hash(askHash, 'ask hash'),
    }));
    const entries = canonicalPairs.map(({ bidHash, askHash }) => {
      const bid = this.book.get(bidHash);
      const ask = this.book.get(askHash);
      if (!bid || !ask || !compatible(bid, ask) || bid.program !== ask.program)
        throw new Error('Unknown or incompatible conversion orders');
      return { bid, ask };
    });
    if (
      !intent ||
      typeof intent !== 'object' ||
      Array.isArray(intent) ||
      Object.keys(intent).length !== intentFields.length ||
      intentFields.some(({ name }) => !Object.hasOwn(intent, name))
    )
      throw new Error('Invalid funding intent fields');
    const normalized = Object.fromEntries(
      intentFields.map(({ name, type }) => [
        name,
        type === 'address'
          ? address(intent[name])
          : type === 'bytes32'
            ? hash(intent[name], name)
            : uint(intent[name], name),
      ]),
    );
    const signed = signature(intentSig, 'funding signature');
    const selected = entries.filter(
      ({ bid }) => same(bid.order.maker, normalized.buyer),
    );
    if (selected.length !== 1)
      throw new Error('Conversion buyer must occur exactly once');
    const chosen = selected[0];
    if (
      !same(normalized.bidHash, chosen.bid.hash) ||
      !same(normalized.askHash, chosen.ask.hash) ||
      !same(normalized.recipient, chosen.bid.order.recipient) ||
      !same(normalized.sourceToken, this.config.sourceToken) ||
      !same(normalized.executor, this.config.executor) ||
      normalized.chainId !== BigInt(this.config.chainId) ||
      normalized.maxInput === 0n ||
      normalized.minOutput === 0n ||
      normalized.usdcCap === 0n
    )
      throw new Error('Funding intent differs from signed orders or deployment');
    const fills = entries.map(({ bid, ask }) => ({
      bid: bid.order,
      bidSig: bid.signature,
      ask: ask.order,
      askSig: ask.signature,
      mandate: bid.mandate,
      program: bid.program,
    }));
    const batch = mode === 'collective' ? hashBatch(fills) : `0x${'0'.repeat(64)}`;
    if (!same(normalized.batchHash, batch))
      throw new Error('Funding intent batch hash mismatch');
    const functionName = mode === 'single' ? 'execute' : 'executeCollective';
    const args =
      mode === 'single'
        ? [
            normalized,
            signed,
            fills[0].bid,
            fills[0].bidSig,
            fills[0].ask,
            fills[0].askSig,
            fills[0].mandate,
            fills[0].program,
          ]
        : [normalized, signed, fills];
    return {
      mode,
      pairs: canonicalPairs,
      entries,
      chosen,
      fills,
      normalized,
      signed,
      functionName,
      args,
      batch,
    };
  }

  async #assertChainDeployment() {
    const [rpcChain, walletChain] = await Promise.all([
      this.publicClient.getChainId(),
      this.walletClient.getChainId(),
    ]);
    if (
      Number(rpcChain) !== this.config.chainId ||
      Number(walletChain) !== this.config.chainId ||
      (this.walletClient.chain &&
        this.walletClient.chain.id !== this.config.chainId)
    )
      throw new Error('Conversion chain mismatch');
    const names = [
      'rentalRouter',
      'swapRouter',
      'sourceToken',
      'usdc',
      'poolFee',
      'collective',
    ];
    const deployed = await Promise.all(
      names.map((functionName) =>
        this.publicClient.readContract({
          address: this.config.executor,
          abi: converterAbi,
          functionName,
        }),
      ),
    );
    if (
      names.some((name, i) =>
        name === 'poolFee'
          ? Number(deployed[i]) !== this.config.poolFee
          : !same(deployed[i], this.config[name === 'rentalRouter' ? 'router' : name]),
      )
    )
      throw new Error('Conversion deployment differs from configuration');
    const actualCollective = await this.publicClient.readContract({
      address: this.config.router,
      abi: routerAbi,
      functionName: 'collective',
    });
    if (!same(actualCollective, this.config.collective))
      throw new Error('Conversion coordinator differs from rental router');
  }

  async #submit(mode, pairs, intent, intentSig) {
    const prepared = this.#build(mode, pairs, intent, intentSig);
    const { normalized, signed } = prepared;
    const id = hashIntent(normalized, this.config).toLowerCase();
    await this.#assertChainDeployment();
    const payload = pack({
      mode,
      pairs: prepared.pairs,
      intent: normalized,
      intentSig: signed,
    });
    const data = encodeFunctionData({
      abi: converterAbi,
      functionName: prepared.functionName,
      args: prepared.args,
    });
    const { job } = await this.submissions.submit({
      id,
      bidHash: normalized.bidHash,
      askHash: normalized.askHash,
      to: this.config.executor,
      data,
      payload,
      simulate: async () => {
        const latest = await this.publicClient.getBlock({ blockTag: 'latest' });
        if (normalized.deadline < latest.timestamp)
          throw new Error('Funding intent expired on chain');
        await this.publicClient.simulateContract({
          address: this.config.executor,
          abi: converterAbi,
          functionName: prepared.functionName,
          args: prepared.args,
          account: this.walletClient.account,
        });
      },
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: job.tx_hash,
      confirmations: this.config.confirmations,
    });
    if (receipt.status !== 'success')
      return { id, transactionHash: job.tx_hash, state: 'reverted' };
    return this.#verify(job, receipt, prepared);
  }

  async #receipt(transactionHash) {
    return this.submissions.receipt(transactionHash);
  }

  async #assertCanonical(receipt) {
    const block = await this.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (!same(block.hash, receipt.blockHash))
      throw new Error('Conversion block is no longer canonical');
  }

  async #verify(job, receipt, prepared) {
    if (
      receipt.status !== 'success' ||
      !same(receipt.transactionHash, job.tx_hash)
    )
      throw new Error('Conversion receipt mismatched');
    await this.#assertCanonical(receipt);
    const mined = await this.publicClient.getTransaction({ hash: job.tx_hash });
    const expectedData = encodeFunctionData({
      abi: converterAbi,
      functionName: prepared.functionName,
      args: prepared.args,
    });
    if (
      !same(mined?.hash, job.tx_hash) ||
      !same(mined?.blockHash, receipt.blockHash) ||
      mined?.blockNumber !== receipt.blockNumber ||
      !same(mined?.to, this.config.executor) ||
      !same(mined?.from, this.sender) ||
      Number(mined?.chainId) !== this.config.chainId ||
      !same(mined?.input, expectedData)
    )
      throw new Error('Conversion mined call mismatched');
    const eventName =
      prepared.mode === 'single' ? 'ConvertedSettled' : 'ConvertedCollective';
    const converted = parseEventLogs({
      abi: converterAbi,
      logs: receipt.logs.filter((log) => same(log.address, this.config.executor)),
      eventName,
      strict: true,
    });
    const settled = parseEventLogs({
      abi: routerAbi,
      logs: receipt.logs.filter((log) => same(log.address, this.config.router)),
      eventName: 'Settled',
      strict: true,
    });
    if (converted.length !== 1 || settled.length !== prepared.entries.length)
      throw new Error('Conversion settlement events missing');
    const conversion = converted[0].args;
    if (
      !same(conversion.buyer, prepared.normalized.buyer) ||
      conversion.nonce !== prepared.normalized.nonce ||
      conversion.input !== prepared.normalized.maxInput ||
      settled.some(
        ({ args: sale }, i) =>
          !same(sale.buyHash, prepared.entries[i].bid.hash) ||
          !same(sale.sellHash, prepared.entries[i].ask.hash) ||
          !same(sale.mandate, prepared.entries[i].bid.order.mandate),
      )
    )
      throw new Error('Conversion settlement events mismatched');
    let buyerPrice, buyerFee, totalPrice, totalFee;
    if (prepared.mode === 'single') {
      const sale = settled[0].args;
      if (
        !same(conversion.bidHash, prepared.chosen.bid.hash) ||
        !same(conversion.askHash, prepared.chosen.ask.hash) ||
        conversion.price !== sale.price ||
        conversion.fee !== sale.fee
      )
        throw new Error('Conversion settlement event mismatched');
      buyerPrice = totalPrice = sale.price;
      buyerFee = totalFee = sale.fee;
    } else {
      const selected = prepared.entries.indexOf(prepared.chosen);
      const own = settled[selected].args;
      const activated = parseEventLogs({
        abi: collectiveAbi,
        logs: receipt.logs.filter((log) => same(log.address, this.config.collective)),
        eventName: 'Activated',
        strict: true,
      });
      if (
        activated.length !== 1 ||
        !same(conversion.batchHash, prepared.batch) ||
        !same(conversion.bidHash, prepared.chosen.bid.hash) ||
        conversion.buyerPrice !== own.price ||
        conversion.buyerFee !== own.fee ||
        conversion.totalPrice !== activated[0].args.price ||
        conversion.totalFee !== activated[0].args.fee ||
        activated[0].args.participants !== BigInt(prepared.entries.length)
      )
        throw new Error('Conversion collective event mismatched');
      buyerPrice = own.price;
      buyerFee = own.fee;
      totalPrice = conversion.totalPrice;
      totalFee = conversion.totalFee;
    }
    return {
      id: job.id,
      state: 'confirmed',
      transactionHash: job.tx_hash,
      blockHash: receipt.blockHash,
      input: conversion.input,
      output: conversion.output,
      buyerPrice,
      buyerFee,
      totalPrice,
      totalFee,
      conversionSurplus: conversion.output - buyerPrice - buyerFee,
    };
  }
}
