import { getAddress, isAddress, isHex, keccak256 } from 'viem';
import {
  hashMandate,
  hashOrder,
  orderDomain,
  orderTypes,
  routerAbi,
  ZERO_HASH,
} from './protocol.mjs';
import { parseCollectiveProgram } from './collective.mjs';

const UINT256_MAX = (1n << 256n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const DAY = 86_400n;
const orderFields = orderTypes.Order;
const mandateFields = routerAbi[0].inputs[4].components;

export class OrderInputError extends Error {}
function fail(message) {
  throw new OrderInputError(message);
}
function exactObject(value, fields, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some(({ name }) => !Object.hasOwn(value, name))
  )
    fail(`invalid ${label} fields`);
}
function uint(value, bits, label) {
  if (!(
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
  ))
    fail(`invalid ${label}`);
  const n = BigInt(value);
  if (n < 0n || n > (bits === 32 ? UINT32_MAX : UINT256_MAX))
    fail(`invalid ${label}`);
  return n.toString();
}
function hex(value, bytes, label) {
  if (
    typeof value !== 'string' ||
    !isHex(value) ||
    value.length !== bytes * 2 + 2
  )
    fail(`invalid ${label}`);
  return value.toLowerCase();
}
function addr(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) fail(`invalid ${label}`);
  const canonical = getAddress(value);
  if (canonical === getAddress('0x0000000000000000000000000000000000000000'))
    fail(`zero ${label}`);
  return canonical;
}
function normalize(value, fields, label) {
  exactObject(value, fields, label);
  return Object.fromEntries(
    fields.map(({ name, type }) => {
      const v = value[name];
      if (type === 'address') return [name, addr(v, `${label}.${name}`)];
      if (type === 'bytes32') return [name, hex(v, 32, `${label}.${name}`)];
      if (type === 'bool') {
        if (typeof v !== 'boolean') fail(`invalid ${label}.${name}`);
        return [name, v];
      }
      if (type === 'uint32') return [name, uint(v, 32, `${label}.${name}`)];
      if (type === 'uint256') return [name, uint(v, 256, `${label}.${name}`)];
      fail(`unsupported ${label}.${name}`);
    }),
  );
}
function normalizeProgram(value) {
  if (typeof value !== 'string' || !isHex(value) || value.length % 2)
    fail('invalid program');
  const p = value.toLowerCase();
  const bytes = Buffer.from(p.slice(2), 'hex');
  const lengths = new Map([
    [0x9e, 37],
    [0x9f, 133],
    [0xa0, 133],
    [0xa1, 229],
  ]);
  if (
    bytes.length !== lengths.get(bytes[0]) ||
    bytes[1] !== bytes.length - 5 ||
    bytes.at(-3) !== 0x54 ||
    bytes.at(-2) !== 1 ||
    bytes.at(-1) !== 0x80
  )
    fail('invalid program');
  const word = (offset) =>
    BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`);
  if (bytes[0] === 0x9e && word(2) === 0n) fail('invalid fixed program');
  if (bytes[0] === 0xa0 || bytes[0] === 0xa1) {
    const feeOffset = bytes[0] === 0xa0 ? 34 : 130;
    const feeBps = word(feeOffset);
    const threshold = word(feeOffset + 32);
    const discountBps = word(feeOffset + 64);
    if (
      feeBps > 1000n ||
      discountBps > 9000n ||
      (discountBps === 0n
        ? threshold !== 0n
        : threshold < 1n || threshold > 31n)
    )
      fail('invalid economic terms');
    if (bytes[0] === 0xa0 && (word(2) === 0n || word(2) > UINT128_MAX))
      fail('invalid fixed unit price');
  }
  if (bytes[0] === 0x9f || bytes[0] === 0xa1) {
    const [high, low, start, end] = [word(2), word(34), word(66), word(98)];
    if (
      high > UINT128_MAX ||
      high < low ||
      low === 0n ||
      end <= start ||
      end - start > UINT64_MAX
    )
      fail('invalid Dutch program');
  }
  return p;
}

export class OrderBook {
  constructor(store, publicClient, config) {
    if (!store?.db || typeof publicClient?.verifyTypedData !== 'function')
      fail('invalid order book dependencies');
    if (!Number.isSafeInteger(config?.chainId) || config.chainId <= 0)
      fail('invalid chainId');
    this.config = {
      chainId: config.chainId,
      router: addr(config.router, 'router'),
      usdc: addr(config.usdc, 'usdc'),
    };
    this.store = store;
    this.publicClient = publicClient;
    const scope = JSON.stringify(this.config);
    const existing = store.db
      .prepare("SELECT value FROM metadata WHERE key = 'scope'")
      .get();
    if (existing && existing.value !== scope)
      fail('order store chain/router/token mismatch');
    if (!existing)
      store.db
        .prepare("INSERT INTO metadata (key, value) VALUES ('scope', ?)")
        .run(scope);
  }

  async submit(envelope) {
    exactObject(
      envelope,
      [
        { name: 'order' },
        { name: 'signature' },
        { name: 'program' },
        ...(envelope && Object.hasOwn(envelope, 'mandate')
          ? [{ name: 'mandate' }]
          : []),
      ],
      'envelope',
    );
    const order = normalize(envelope.order, orderFields, 'order');
    const signature = envelope.signature;
    if (
      typeof signature !== 'string' ||
      !isHex(signature) ||
      signature.length <= 2 ||
      signature.length % 2
    )
      fail('invalid signature');
    let guard;
    try {
      guard = parseCollectiveProgram(envelope.program);
    } catch {
      fail('invalid collective program');
    }
    normalizeProgram(guard?.priceProgram ?? envelope.program);
    const program = envelope.program.toLowerCase();
    if (keccak256(program).toLowerCase() !== order.programHash)
      fail('program hash mismatch');
    if (guard) {
      const collective = await this.publicClient.readContract({
        address: this.config.router,
        abi: routerAbi,
        functionName: 'collective',
      });
      if (getAddress(collective) !== guard.coordinator)
        fail('collective coordinator mismatch');
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const start = BigInt(order.startDay);
    const end = BigInt(order.endDay);
    if (
      start >= end ||
      end - start > 31n ||
      BigInt(order.quantity) === 0n ||
      now >= start * DAY ||
      now >= BigInt(order.expiry)
    )
      fail('inactive basket or order');
    let mandate;
    if (order.buy) {
      if (!envelope.mandate) fail('missing mandate');
      mandate = normalize(envelope.mandate, mandateFields, 'mandate');
      if (
        mandate.buyer !== order.maker ||
        mandate.app !== this.config.router ||
        mandate.token !== this.config.usdc ||
        now >= BigInt(mandate.expiry) ||
        hashMandate(mandate).toLowerCase() !== order.mandate
      )
        fail('mandate mismatch');
    } else if (order.mandate !== ZERO_HASH || envelope.mandate !== undefined)
      fail('ask must have zero mandate');
    const hash = hashOrder(order, this.config).toLowerCase();
    const stored = {
      hash,
      order,
      signature: signature.toLowerCase(),
      program,
      ...(mandate ? { mandate } : {}),
    };
    const prior = this.get(hash);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(stored))
        fail('conflicting signed order');
    }
    const valid = await this.publicClient.verifyTypedData({
      address: order.maker,
      domain: orderDomain(this.config),
      types: orderTypes,
      primaryType: 'Order',
      message: order,
      signature,
    });
    if (!valid) fail('invalid signature');
    if (prior) return prior;
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO orders (hash, payload, created_at) VALUES (?, ?, ?)',
      )
      .run(hash, JSON.stringify(stored), Math.floor(Date.now() / 1000));
    const persisted = this.get(hash);
    if (JSON.stringify(persisted) !== JSON.stringify(stored))
      fail('conflicting signed order');
    return persisted;
  }

  get(hash) {
    const normalized = hex(hash, 32, 'order hash');
    const row = this.store.db
      .prepare('SELECT payload FROM orders WHERE hash = ?')
      .get(normalized);
    return row ? JSON.parse(row.payload) : undefined;
  }

  list({ limit = 100, offset = 0 } = {}) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      fail('invalid pagination');
    return this.store.db
      .prepare(
        'SELECT payload FROM orders ORDER BY created_at, rowid LIMIT ? OFFSET ?',
      )
      .all(limit, offset)
      .map(({ payload }) => JSON.parse(payload));
  }
}
