import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isHex,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';

export const PROTOCOL = 'aquavapor-v1';
export const ZERO_HASH = `0x${'00'.repeat(32)}`;
export const strategyFields = [
  ['maker', 'address'],
  ['inventory', 'address'],
  ['ids', 'uint256[]'],
  ['quantity', 'uint256'],
  ['buy', 'bool'],
  ['salt', 'bytes32'],
  ['program', 'bytes'],
].map(([name, type]) => ({ name, type }));
export const strategyType = { type: 'tuple', components: strategyFields };
const strategyDefinition =
  'struct Strategy { address maker; address inventory; uint256[] ids; uint256 quantity; bool buy; bytes32 salt; bytes program; }';
const assetDefinition =
  'struct Asset { uint8 kind; address token; uint256 id; }';
export const routerAbi = parseAbi([
  strategyDefinition,
  'function AQUA() view returns (address)',
  'function USDC() view returns (address)',
  'function hash(Strategy strategy) pure returns (bytes32)',
  'function quote(Strategy bid, Strategy ask) returns (uint256 payment)',
  'function swap(Strategy bid, Strategy ask) returns (uint256 payment)',
  'function bitInvalidators(address maker,uint256 slotIndex) view returns (uint256)',
  'function invalidateBit(uint256 bitIndex)',
  'event Swapped(bytes32 indexed bidHash,bytes32 indexed askHash,uint256 payment,uint256 quantity)',
  'event InvalidateBitUpdated(address indexed maker,uint256 slotIndex,uint256 slotValue)',
]);
export const aquaAbi = parseAbi([
  assetDefinition,
  'function ship(address app,bytes strategy,Asset[] assets,uint256[] amounts) returns (bytes32)',
  'function dock(address app,bytes32 strategyHash,Asset[] assets)',
  'function rawBalances(address maker,address app,bytes32 strategyHash,Asset asset) view returns (uint248 amount,uint8 count)',
  'event Shipped(address indexed maker,address indexed app,bytes32 indexed strategyHash,bytes strategy)',
  'event Docked(address indexed maker,address indexed app,bytes32 indexed strategyHash)',
  'event Moved(address indexed maker,address indexed app,bytes32 indexed strategyHash,bytes32 asset,uint256 amount,address counterparty,bool incoming)',
]);
export const erc20Abi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
]);
export const erc1155Abi = parseAbi([
  'function setApprovalForAll(address operator,bool approved)',
]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const serialize = (v) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
export function uint(value, bits = 256) {
  if (!(
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
  ))
    throw new Error('Invalid integer');
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bits))
    throw new Error('Integer out of range');
  return n;
}
export function address(value) {
  const a = getAddress(value);
  if (BigInt(a) === 0n) throw new Error('Zero address');
  return a;
}
export function encodeStrategy(s) {
  return encodeAbiParameters([strategyType], [s]);
}
export function hashStrategy(s) {
  return keccak256(encodeStrategy(s));
}
export function decodeStrategy(bytes, usdc) {
  const [s] = decodeAbiParameters([strategyType], bytes);
  const normalized = normalizeStrategy(s, usdc);
  if (!same(encodeStrategy(normalized), bytes))
    throw new Error('Noncanonical strategy encoding');
  return normalized;
}

/** Maintained fixed-price program: absolute expiry, optional single-use bit, and upstream full-amount swap. */
export function fixedProgram({
  usdc,
  inventory,
  price,
  quantity = 1n,
  expiry,
  nonce,
}) {
  const amount = uint(price),
    units = uint(quantity),
    deadline = uint(expiry, 39);
  if (!amount || !units || !deadline)
    throw new Error('Price, quantity and expiry must be positive');
  const direction = BigInt(address(usdc)) < BigInt(address(inventory));
  return concatHex([
    '0x2005',
    toHex(deadline, { size: 5 }),
    ...(nonce === undefined
      ? []
      : ['0x4004', toHex(uint(nonce, 32), { size: 4 })]),
    '0x9040',
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      direction ? [amount, units] : [units, amount],
    ),
    '0x5401',
    direction ? '0x80' : '0x00',
  ]);
}

/** Parse the supported program form, not a second pricing engine. Solidity remains execution authority. */
export function programTerms(s, usdc) {
  const p = s.program;
  if (!isHex(p) || p.length % 2) throw new Error('Invalid program');
  const bytes = Buffer.from(p.slice(2), 'hex');
  const word = (a, b) => BigInt(`0x${bytes.subarray(a, b).toString('hex')}`);
  if (bytes[0] !== 0x20 || bytes[1] !== 5 || bytes.length < 76)
    throw new Error('Unsupported program');
  const expiry = word(2, 7);
  if (!expiry || expiry >= 1n << 39n)
    throw new Error('Absolute expiry required');
  let i = 7,
    nonce;
  if (bytes[i] === 0x40 && bytes[i + 1] === 4) {
    nonce = word(i + 2, i + 6);
    i += 6;
  }
  if (
    bytes.length !== i + 69 ||
    bytes[i] !== 0x90 ||
    bytes[i + 1] !== 64 ||
    bytes[i + 66] !== 0x54 ||
    bytes[i + 67] !== 1
  )
    throw new Error('Unsupported program');
  const direction = BigInt(address(usdc)) < BigInt(s.inventory);
  if (bytes[i + 68] !== (direction ? 0x80 : 0))
    throw new Error('Wrong swap direction');
  const a = word(i + 2, i + 34),
    b = word(i + 34, i + 66);
  const [price, quantity] = direction ? [a, b] : [b, a];
  if (!price || quantity !== BigInt(s.quantity))
    throw new Error('Invalid program amounts');
  return { price, expiry, nonce };
}
export function normalizeStrategy(input, usdc) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !==
      strategyFields
        .map((x) => x.name)
        .sort()
        .join()
  )
    throw new Error('Invalid strategy fields');
  if (
    typeof input.buy !== 'boolean' ||
    !Array.isArray(input.ids) ||
    !input.ids.length ||
    input.ids.length > 254
  )
    throw new Error('Invalid basket');
  const ids = input.ids.map((x) => uint(x).toString());
  if (ids.some((id, i) => i > 0 && BigInt(ids[i - 1]) >= BigInt(id)))
    throw new Error('IDs must be sorted and unique');
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.salt)) throw new Error('Invalid salt');
  const s = {
    maker: address(input.maker),
    inventory: address(input.inventory),
    ids,
    quantity: uint(input.quantity).toString(),
    buy: input.buy,
    salt: input.salt.toLowerCase(),
    program: input.program?.toLowerCase(),
  };
  if (same(s.inventory, usdc) || BigInt(s.quantity) === 0n)
    throw new Error('Invalid inventory or quantity');
  programTerms(s, usdc);
  return s;
}
export function assetsFor(s, usdc) {
  return s.buy
    ? [{ kind: 0, token: address(usdc), id: 0n }]
    : s.ids.map((id) => ({ kind: 1, token: s.inventory, id: BigInt(id) }));
}
export function registration(s, config, budget) {
  s = normalizeStrategy(s, config.usdc);
  const assets = assetsFor(s, config.usdc);
  const amount = s.buy
    ? uint(budget ?? programTerms(s, config.usdc).price, 248)
    : uint(s.quantity, 248);
  if (!amount) throw new Error('Registration amount must be positive');
  return {
    hash: hashStrategy(s),
    assets,
    amounts: assets.map(() => amount),
    strategy: s,
    request: {
      to: address(config.aqua),
      data: encodeFunctionData({
        abi: aquaAbi,
        functionName: 'ship',
        args: [
          address(config.router),
          encodeStrategy(s),
          assets,
          assets.map(() => amount),
        ],
      }),
    },
  };
}
export async function verifyDeployment(client, config, at = {}) {
  if (Number(await client.getChainId()) !== Number(config.chainId))
    throw new Error('Wrong chain');
  const [aqua, token] = await Promise.all(
    ['AQUA', 'USDC'].map((functionName) =>
      client.readContract({
        address: config.router,
        abi: routerAbi,
        functionName,
        ...at,
      }),
    ),
  );
  if (!same(aqua, config.aqua) || !same(token, config.usdc))
    throw new Error('Router deployment mismatch');
}

/** Translate a rental range into canonical native IDs before wallet authorization. */
export function rentalStrategy(draft, config) {
  const {
    maker,
    inventory,
    pool,
    startDay,
    endDay,
    terms,
    quantity,
    buy,
    price,
    expiry,
    nonce,
    salt,
  } = draft;
  const start = uint(startDay, 32),
    end = uint(endDay, 32);
  if (end <= start || end - start > 254n || uint(expiry) > start * 86400n)
    throw new Error('Invalid rental range or expiry');
  const ids = [];
  for (let day = start; day < end; day++)
    ids.push(
      BigInt(
        keccak256(
          encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }],
            [pool, Number(day), terms],
          ),
        ),
      ),
    );
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return normalizeStrategy(
    {
      maker,
      inventory,
      ids,
      quantity,
      buy,
      salt,
      program: fixedProgram({
        usdc: config.usdc,
        inventory,
        price,
        quantity,
        expiry,
        nonce,
      }),
    },
    config.usdc,
  );
}
