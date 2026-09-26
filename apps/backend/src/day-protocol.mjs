import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
} from 'viem';

export const dayRouterAbi = parseAbi([
  'struct Bid { address buyer; uint256 chainId; address app; address asset; uint32 startDay; uint32 endDayExclusive; uint256 maxTotal; uint256 nonce; uint40 deadline; bytes32 salt; }',
  'struct Ask { address seller; uint256 chainId; address app; address asset; uint32 day; uint64 saleNonce; uint64 discountVersion; bytes32 salt; }',
  'struct DayFill { address token; address seller; bytes32 askHash; uint256 payment; }',
  'function hashBid(Bid bid) pure returns (bytes32)',
  'function hashAsk(Ask ask) pure returns (bytes32)',
  'function program(address asset,uint32 day,uint16 duration) view returns (bytes)',
  'function quote(Bid bid,Ask[] asks,bytes[] programs) returns (uint256 total,DayFill[] fills)',
  'function settle(Bid bid,Ask[] asks,bytes[] programs) returns (uint256 total)',
  'function cancel(uint256 nonce)',
  'function used(address buyer,uint256 nonce) view returns (bool)',
  'function AQUA() view returns (address)',
  'function USDC() view returns (address)',
  'function FACTORY() view returns (address)',
  'event Cancelled(address indexed buyer,uint256 indexed nonce)',
  'event DaySettled(bytes32 indexed bidHash,bytes32 indexed askHash,address indexed token,uint256 payment)',
  'event Settled(bytes32 indexed bidHash,address indexed buyer,address indexed asset,uint256 total)',
]);

// Official Aqua's event arguments are NOT indexed. These are its ERC-20 ABIs.
export const officialAquaAbi = parseAbi([
  'function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32)',
  'function dock(address app,bytes32 strategyHash,address[] tokens)',
  'function rawBalances(address maker,address app,bytes32 strategyHash,address token) view returns (uint248 balance,uint8 tokensCount)',
  'event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)',
  'event Docked(address maker,address app,bytes32 strategyHash)',
  'event Pulled(address maker,address app,bytes32 strategyHash,address token,uint256 amount)',
]);

export const dayTokenAbi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function transfer(address to,uint256 amount) returns (bool)',
  'function owner() view returns (address)',
  'function decimals() view returns (uint8)',
]);

const defaultDefinition =
  'struct AssetDefaults { uint128 minimum; uint128[7] listedPrices; uint128[7] sellingPrices; }';
const discountDefinition =
  'struct DiscountStep { uint16 minDays; uint16 discountBps; }';
export const dayFactoryAbi = parseAbi([
  defaultDefinition,
  discountDefinition,
  'function createAsset(bytes32 hostSalt,string metadataURI,AssetDefaults defaults,DiscountStep[] discounts) returns (address asset)',
  'function isAsset(address asset) view returns (bool)',
  'function assets(address host,bytes32 salt) view returns (address)',
  'event AssetCreated(address indexed asset,address indexed host,bytes32 indexed hostSalt,uint32 startDay,uint32 endDayExclusive)',
]);
export const dayAssetAbi = parseAbi([
  discountDefinition,
  'struct Point { uint32 day; uint128 price; }',
  'struct DayView { address token; address owner; bool deployed; bool listed; uint64 saleNonce; bool booked; uint128 listedPrice; uint128 sellingPrice; }',
  'function host() view returns (address)',
  'function startDay() view returns (uint32)',
  'function endDayExclusive() view returns (uint32)',
  'function metadataURI() view returns (string)',
  'function dayState(uint32 day) view returns (DayView)',
  'function rangeState(uint32 start,uint32 endExclusive) view returns (DayView[])',
  'function materialize(uint32 day) returns (address)',
  'function setListing(uint32 start,uint32 endExclusive,bool listed,uint128 sellingPrice)',
  'function setListedPrice(uint32 start,uint32 endExclusive,uint128 listedPrice)',
  'function setCurve(uint32 day,uint128 minimum,Point[] points)',
  'function bookingRelayers(address reporter) view returns (bool)',
  'function curve(uint32 day) view returns (uint128 minimum,Point[] points)',
  'function setBooked(uint32 day,bool booked,uint128 expectedListedPrice)',
  'function setBookingRelayer(address relayer,bool allowed)',
  'function setDiscountLadder(DiscountStep[] steps)',
  'function discountLadder() view returns (DiscountStep[])',
  'function discountVersion() view returns (uint64)',
]);

const tuple = (kind) => {
  if (kind !== 'bid' && kind !== 'ask')
    throw new Error('Unknown strategy kind');
  return dayRouterAbi.find(
    (x) => x.name === (kind === 'bid' ? 'hashBid' : 'hashAsk'),
  ).inputs[0];
};

export function encodeDayStrategy(kind, strategy) {
  return encodeAbiParameters([tuple(kind)], [strategy]);
}

export function hashDayStrategy(kind, strategy) {
  return keccak256(encodeDayStrategy(kind, strategy));
}

/** Decode only canonical, domain-bound publications authenticated by Aqua's maker. */
export function decodeDayPublication(args, { chainId, router }) {
  const kind =
    args.strategy.length === 642
      ? 'bid'
      : args.strategy.length === 514
        ? 'ask'
        : null;
  if (!kind) throw new Error('Unsupported strategy encoding');
  const [strategy] = decodeAbiParameters([tuple(kind)], args.strategy);
  const maker = kind === 'bid' ? strategy.buyer : strategy.seller;
  if (
    getAddress(args.app) !== getAddress(router) ||
    getAddress(strategy.app) !== getAddress(router) ||
    getAddress(args.maker) !== getAddress(maker) ||
    strategy.chainId !== BigInt(chainId) ||
    BigInt(strategy.asset) === 0n ||
    BigInt(maker) === 0n ||
    encodeDayStrategy(kind, strategy).toLowerCase() !==
      args.strategy.toLowerCase() ||
    hashDayStrategy(kind, strategy).toLowerCase() !==
      args.strategyHash.toLowerCase()
  )
    throw new Error('Invalid strategy publication');
  if (kind === 'bid' && strategy.startDay >= strategy.endDayExclusive)
    throw new Error('Empty day range');
  return { kind, hash: args.strategyHash.toLowerCase(), strategy };
}

/** Prepare wallet transactions; these helpers neither sign nor reserve funds. */
export function shipDayStrategy({ aqua, kind, strategy, token }) {
  return {
    to: getAddress(aqua),
    data: encodeFunctionData({
      abi: officialAquaAbi,
      functionName: 'ship',
      args: [
        strategy.app,
        encodeDayStrategy(kind, strategy),
        [token],
        [kind === 'bid' ? strategy.maxTotal : 1n],
      ],
    }),
  };
}

export function dockDayStrategy({ aqua, router, hash, token }) {
  return {
    to: getAddress(aqua),
    data: encodeFunctionData({
      abi: officialAquaAbi,
      functionName: 'dock',
      args: [router, hash, [token]],
    }),
  };
}

export function approveDayFunding({ token, aqua, amount }) {
  return {
    to: getAddress(token),
    data: encodeFunctionData({
      abi: dayTokenAbi,
      functionName: 'approve',
      args: [aqua, amount],
    }),
  };
}

/** JST date identity uses UTC arithmetic; the caller's local timezone is irrelevant. */
export function tokyoDay(timestampSeconds) {
  const timestamp = BigInt(timestampSeconds);
  if (timestamp < 0n) throw new Error('Negative timestamp');
  const day = (timestamp + 32400n) / 86400n;
  if (day > 0xffffffffn) throw new Error('Day out of range');
  return Number(day);
}
