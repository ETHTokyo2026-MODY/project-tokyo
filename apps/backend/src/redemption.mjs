import { getAddress, isHex, parseEventLogs } from 'viem';

const ZERO = '0x0000000000000000000000000000000000000000';
const UINT32_MAX = (1n << 32n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

export const inventoryReservationAbi = [
  {
    type: 'function',
    name: 'reserve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'holder', type: 'address' },
      { name: 'pool', type: 'bytes32' },
      { name: 'start', type: 'uint32' },
      { name: 'end', type: 'uint32' },
      { name: 'terms', type: 'bytes32' },
      { name: 'quantity', type: 'uint256' },
      { name: 'beneficiary', type: 'address' },
    ],
    outputs: [{ name: 'reservationId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Reserved',
    inputs: [
      { name: 'reservationId', type: 'uint256', indexed: true },
      { name: 'holder', type: 'address', indexed: true },
      { name: 'beneficiary', type: 'address', indexed: true },
      { name: 'pool', type: 'bytes32', indexed: false },
      { name: 'startDay', type: 'uint32', indexed: false },
      { name: 'endDay', type: 'uint32', indexed: false },
      { name: 'terms', type: 'bytes32', indexed: false },
      { name: 'quantity', type: 'uint256', indexed: false },
    ],
  },
];

function address(value) {
  const result = getAddress(value);
  if (result === ZERO) throw new Error('Zero address');
  return result;
}

function bytes32(value) {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66)
    throw new Error('Invalid bytes32');
  return value.toLowerCase();
}

function integer(value, max) {
  if (!(
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
  ))
    throw new Error('Invalid integer');
  const result = BigInt(value);
  if (result < 0n || result > max) throw new Error('Invalid integer');
  return result;
}

// The caller supplies its own holder or approved-operator wallet client.
// A mined receipt remains subject to a later chain reorganization.
export class Redemption {
  constructor(
    publicClient,
    walletClient,
    { chainId, inventory, confirmations = 2 },
  ) {
    if (
      !publicClient?.simulateContract ||
      !publicClient?.waitForTransactionReceipt ||
      !publicClient?.getBlock ||
      !walletClient?.writeContract ||
      !walletClient?.account
    )
      throw new Error('Chain clients and a signing account required');
    if (
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !Number.isSafeInteger(confirmations) ||
      confirmations < 0
    )
      throw new Error('Invalid chain configuration');
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.chainId = chainId;
    this.inventory = address(inventory);
    this.confirmations = confirmations;
  }

  async reserve({
    holder,
    pool,
    startDay,
    endDay,
    terms,
    quantity,
    beneficiary,
  }) {
    const values = {
      holder: address(holder),
      pool: bytes32(pool),
      startDay: integer(startDay, UINT32_MAX),
      endDay: integer(endDay, UINT32_MAX),
      terms: bytes32(terms),
      quantity: integer(quantity, UINT256_MAX),
      beneficiary: address(beneficiary),
    };
    if (
      values.startDay >= values.endDay ||
      values.endDay - values.startDay > 31n ||
      values.quantity === 0n
    )
      throw new Error('Invalid reservation basket');
    if (Number(await this.publicClient.getChainId()) !== this.chainId)
      throw new Error('RPC chain ID differs from reservation chain');
    if (
      Number(await this.walletClient.getChainId()) !== this.chainId ||
      (this.walletClient.chain && this.walletClient.chain.id !== this.chainId)
    )
      throw new Error('Signing wallet chain differs from reservation chain');
    const args = [
      values.holder,
      values.pool,
      Number(values.startDay),
      Number(values.endDay),
      values.terms,
      values.quantity,
      values.beneficiary,
    ];
    const { request } = await this.publicClient.simulateContract({
      address: this.inventory,
      abi: inventoryReservationAbi,
      functionName: 'reserve',
      args,
      account: this.walletClient.account,
    });
    const transactionHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: this.confirmations,
    });
    if (
      receipt.status !== 'success' ||
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
    )
      throw new Error('Reservation transaction reverted or receipt mismatched');
    const block = await this.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      throw new Error('Reservation block is no longer canonical');
    const events = parseEventLogs({
      abi: inventoryReservationAbi,
      logs: receipt.logs.filter(
        (log) => log.address.toLowerCase() === this.inventory.toLowerCase(),
      ),
      eventName: 'Reserved',
      strict: true,
    });
    const matches = events.filter(
      ({ args: event }) =>
        event.holder.toLowerCase() === values.holder.toLowerCase() &&
        event.beneficiary.toLowerCase() === values.beneficiary.toLowerCase() &&
        event.pool.toLowerCase() === values.pool &&
        BigInt(event.startDay) === values.startDay &&
        BigInt(event.endDay) === values.endDay &&
        event.terms.toLowerCase() === values.terms &&
        event.quantity === values.quantity,
    );
    if (matches.length !== 1 || events.length !== 1)
      throw new Error('Reservation event missing or mismatched');
    return {
      reservationId: matches[0].args.reservationId,
      transactionHash,
      blockHash: receipt.blockHash,
    };
  }
}
