import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
} from 'viem';
import { dayRouterAbi, hashDayStrategy } from './day-protocol.mjs';

const bid = dayRouterAbi.find((entry) => entry.name === 'hashBid').inputs[0];
const asks = {
  ...dayRouterAbi.find((entry) => entry.name === 'hashAsk').inputs[0],
  name: 'asks',
  type: 'tuple[]',
};
export const fundingFields = [
  ['buyer', 'address'],
  ['bidHash', 'bytes32'],
  ['asksHash', 'bytes32'],
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
export const dayConversionAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'intent', type: 'tuple', components: fundingFields },
      { name: 'signature', type: 'bytes' },
      { ...bid, name: 'bid' },
      asks,
      { name: 'programs', type: 'bytes[]' },
    ],
    outputs: [
      { name: 'output', type: 'uint256' },
      { name: 'total', type: 'uint256' },
    ],
  },
];

function uint(value) {
  if (!(
    typeof value === 'bigint' ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ))
    throw new Error('Funding bounds must be exact unsigned integers');
  const result = BigInt(value);
  if (result < 0n || result >= 1n << 256n)
    throw new Error('Funding bound exceeds uint256');
  return result;
}

/** Bind one configured converter, exact WETH input and ordered basket; this helper never signs or reserves funds. */
export function dayFundingIntent({
  converter,
  bid,
  asks: basket,
  sourceToken,
  maxInput,
  minOutput,
  usdcCap,
  deadline,
  nonce,
}) {
  return {
    buyer: getAddress(bid.buyer),
    bidHash: hashDayStrategy('bid', bid),
    asksHash: keccak256(encodeAbiParameters([asks], [basket])),
    sourceToken: getAddress(sourceToken),
    maxInput: uint(maxInput),
    minOutput: uint(minOutput),
    usdcCap: uint(usdcCap),
    recipient: getAddress(bid.buyer),
    deadline: uint(deadline),
    chainId: uint(bid.chainId),
    executor: getAddress(converter),
    nonce: uint(nonce),
  };
}

/** The buyer signs this EIP-712 request in their wallet; route addresses/fee are immutable in the converter. */
export function dayFundingTypedData(intent) {
  return {
    domain: {
      name: 'DayAtomicConverter',
      version: '1',
      chainId: intent.chainId,
      verifyingContract: intent.executor,
    },
    types: { FundingIntent: fundingFields },
    primaryType: 'FundingIntent',
    message: intent,
  };
}

/** Calldata for an independently submitted atomic conversion; the buyer must first approve and publish to Aqua. */
export function encodeDayConversion({
  intent,
  signature,
  bid,
  asks,
  programs,
}) {
  return {
    to: getAddress(intent.executor),
    data: encodeFunctionData({
      abi: dayConversionAbi,
      functionName: 'execute',
      args: [intent, signature, bid, asks, programs],
    }),
    value: 0n,
  };
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const converterViews = [
  ...['rentalRouter', 'swapRouter', 'sourceToken', 'usdc'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  })),
  {
    type: 'function',
    name: 'poolFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'used',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
];

/** Validate one operator-configured direct WETH route, never a caller-supplied swap target. */
export async function conversionRoute(read, config) {
  const c = config.conversion;
  if (!c) throw new Error('WETH conversion is not configured');
  const converter = getAddress(c.converter),
    sourceToken = getAddress(c.sourceToken);
  const actual = await Promise.all(
    ['rentalRouter', 'swapRouter', 'sourceToken', 'usdc', 'poolFee'].map(
      (name) => read(converter, converterViews, name),
    ),
  );
  if (
    !same(actual[0], config.router) ||
    !same(actual[1], c.swapRouter) ||
    !same(actual[2], sourceToken) ||
    !same(actual[3], config.usdc) ||
    Number(actual[4]) !== Number(c.poolFee)
  )
    throw new Error(
      'Configured conversion route differs from deployed contract',
    );
  return { ...c, converter, sourceToken };
}

/** Exact signed execution is simulated after the approval/publication receipts, before wallet submission. */
export async function prepareConversionExecution(
  client,
  config,
  actor,
  body,
  read,
) {
  const route = await conversionRoute(read, config);
  const { intent, signature, bid, asks, programs } = body;
  if (
    !intent ||
    !bid ||
    !Array.isArray(asks) ||
    !Array.isArray(programs) ||
    !same(intent.buyer, actor) ||
    !same(bid.buyer, actor) ||
    !same(intent.executor, route.converter) ||
    !same(intent.sourceToken, route.sourceToken) ||
    uint(intent.chainId) !== BigInt(config.chainId)
  )
    throw new Error('Funding intent differs from wallet or configured route');
  const request = {
    address: route.converter,
    abi: dayConversionAbi,
    functionName: 'execute',
    args: [intent, signature, bid, asks, programs],
    account: getAddress(actor),
    gas: BigInt(config.transactionGasLimit ?? 16_777_216),
  };
  if (request.gas < 21000n || request.gas > 16_777_216n)
    throw new Error('Invalid conversion gas limit');
  await client.simulateContract(request);
  const estimate = await client.estimateContractGas(request);
  if (estimate > request.gas)
    throw new Error('Conversion exceeds transaction gas limit');
  const buffered = (estimate * 120n + 99n) / 100n;
  const gas = buffered > request.gas ? request.gas : buffered;
  await client.simulateContract({ ...request, gas });
  return {
    transactions: [
      {
        ...encodeDayConversion(body),
        value: '0x0',
        gas: `0x${gas.toString(16)}`,
      },
    ],
  };
}
