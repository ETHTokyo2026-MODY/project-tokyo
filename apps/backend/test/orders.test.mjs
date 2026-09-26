import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keccak256, toHex, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { OrderBook } from '../src/orders.mjs';
import { guardProgram } from '../src/collective.mjs';
import {
  hashMandate,
  orderDomain,
  orderTypes,
  ZERO_HASH,
} from '../src/protocol.mjs';
import { Store } from '../src/store.mjs';

const directory = mkdtempSync(join(tmpdir(), 'rental-orders-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const router = '0x1111111111111111111111111111111111111111';
const usdc = '0x2222222222222222222222222222222222222222';
const collective = '0x3333333333333333333333333333333333333333';
const config = { chainId: 11155111, router, usdc };
const client = {
  verifyTypedData: (args) => verifyTypedData(args),
  readContract: async () => collective,
};
const day = Math.floor(Date.now() / 1000 / 86_400) + 2;
const expiry = Math.floor(Date.now() / 1000) + 3600;
const program = `0x9e20${toHex(1_000_000n, { size: 32 }).slice(2)}540180`;
const programHash = keccak256(program);
const word = (value) => toHex(BigInt(value), { size: 32 }).slice(2);
const fixedTerms = (unitPrice, feeBps, threshold, discountBps) =>
  `0xa080${[unitPrice, feeBps, threshold, discountBps].map(word).join('')}540180`;
const dutchTerms = (high, low, start, end, feeBps, threshold, discountBps) =>
  `0xa1e0${[high, low, start, end, feeBps, threshold, discountBps].map(word).join('')}540180`;
const filename = () => join(directory, `${Math.random()}.db`);

async function envelope({
  buy = true,
  overrides = {},
  programBytes = program,
} = {}) {
  const mandate = {
    buyer: account.address,
    app: router,
    token: usdc,
    limit: '100000000',
    expiry: String(expiry),
    salt: `0x${'77'.repeat(32)}`,
  };
  const order = {
    maker: account.address,
    buy,
    pool: `0x${'33'.repeat(32)}`,
    startDay: String(day),
    endDay: String(day + 7),
    quantity: '2',
    terms: `0x${'44'.repeat(32)}`,
    recipient: account.address,
    priceLimit: '2000000',
    maxFee: '20000',
    expiry: String(expiry),
    nonce: '1',
    group: ZERO_HASH,
    mandate: buy ? hashMandate(mandate) : ZERO_HASH,
    programHash: keccak256(programBytes),
    ...overrides,
  };
  const signature = await account.signTypedData({
    domain: orderDomain(config),
    types: orderTypes,
    primaryType: 'Order',
    message: order,
  });
  return {
    order,
    signature,
    program: programBytes,
    ...(buy ? { mandate } : {}),
  };
}

test('valid EOA order is canonical, idempotent, and survives restart', async () => {
  const path = filename();
  let store = new Store(path);
  assert.equal(
    store.db.prepare('PRAGMA journal_mode').get().journal_mode,
    'wal',
  );
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  let book = new OrderBook(store, client, config);
  const input = await envelope();
  const first = await book.submit(input);
  assert.equal(first.order.startDay, String(day));
  assert.equal(first.order.quantity, '2');
  assert.equal(first.hash.length, 66);
  assert.deepEqual(await book.submit(input), first);
  assert.deepEqual(book.list(), [first]);
  assert.deepEqual(book.list({ limit: 1, offset: 1 }), []);
  assert.throws(() => book.list({ limit: 1001 }), /invalid pagination/);
  assert.throws(() => book.list({ offset: -1 }), /invalid pagination/);
  store.close();
  store = new Store(path);
  book = new OrderBook(store, client, config);
  assert.deepEqual(book.get(first.hash), first);
  assert.throws(
    () => new OrderBook(store, client, { ...config, chainId: 1 }),
    /mismatch/,
  );
  store.close();
});

test('rejects changed signed fields, conflicting signature bytes, and malformed payload', async () => {
  const store = new Store(filename());
  const book = new OrderBook(store, client, config);
  const input = await envelope();
  const first = await book.submit(input);
  assert.equal((await book.submit(input)).hash, first.hash);
  await assert.rejects(
    book.submit({ ...input, order: { ...input.order, quantity: '3' } }),
    /invalid signature/,
  );
  await assert.rejects(
    book.submit({ ...input, signature: `0x${'00'.repeat(65)}` }),
    /conflicting signed order/,
  );
  await assert.rejects(
    book.submit({ ...input, program: '0x1234' }),
    /invalid program/,
  );
  await assert.rejects(
    book.submit({ ...input, order: { ...input.order, extra: 1 } }),
    /invalid order fields/,
  );
  await assert.rejects(
    book.submit({ ...input, order: { ...input.order, recipient: '0x1234' } }),
    /invalid order.recipient/,
  );
  await assert.rejects(
    book.submit({
      ...input,
      order: { ...input.order, endDay: String(day + 32) },
    }),
    /inactive basket/,
  );
  await assert.rejects(
    book.submit({ ...input, mandate: { ...input.mandate, token: router } }),
    /mandate mismatch/,
  );
  store.close();
});

test('ask has zero mandate and verification is delegated to the public client (mock, not ERC-1271 proof)', async () => {
  const input = await envelope({ buy: false });
  let observed;
  let valid = true;
  const store = new Store(filename());
  const book = new OrderBook(
    store,
    {
      verifyTypedData: async (args) => {
        observed = args;
        return valid;
      },
    },
    config,
  );
  const stored = await book.submit(input);
  assert.equal(stored.order.mandate, ZERO_HASH);
  assert.equal(observed.address, account.address);
  assert.equal(observed.message.programHash, programHash);
  await assert.rejects(
    book.submit({ ...input, mandate: {} }),
    /ask must have zero mandate/,
  );
  valid = false;
  await assert.rejects(book.submit(input), /invalid signature/);
  store.close();
});

test('accepts signed fixed and Dutch economic terms and rejects altered program bytes', async () => {
  const store = new Store(filename());
  const book = new OrderBook(store, client, config);
  const fixed = fixedTerms(10_000_000, 250, 7, 1000);
  const input = await envelope({ programBytes: fixed });
  assert.equal((await book.submit(input)).program, fixed);
  await assert.rejects(
    book.submit({ ...input, program: fixedTerms(10_000_000, 250, 7, 999) }),
    /program hash mismatch/,
  );
  const dutch = dutchTerms(
    11_000_000,
    7_000_000,
    expiry,
    expiry + 100,
    1000,
    3,
    3333,
  );
  assert.equal(
    (await book.submit(await envelope({ programBytes: dutch }))).program,
    dutch,
  );
  store.close();
});

test('backend rejects the same fee, discount, curve, and shape bounds as the VM', async () => {
  const store = new Store(filename());
  const book = new OrderBook(store, client, config);
  const invalid = [
    fixedTerms(0, 0, 0, 0),
    fixedTerms(1n << 128n, 0, 0, 0),
    fixedTerms(1, 1001, 0, 0),
    fixedTerms(1, 0, 0, 9001),
    fixedTerms(1, 0, 7, 0),
    fixedTerms(1, 0, 32, 1),
    dutchTerms(1, 2, 1, 2, 0, 0, 0),
    dutchTerms(2, 1, 2, 2, 0, 0, 0),
    dutchTerms(1n << 128n, 1, 1, 2, 0, 0, 0),
    fixedTerms(1, 0, 0, 0).slice(0, -2),
  ];
  for (const programBytes of invalid) {
    await assert.rejects(
      book.submit(await envelope({ programBytes })),
      /invalid/,
    );
  }
  store.close();
});

test('guarded orders bind the deployed coordinator, campaign and both thresholds', async () => {
  const store = new Store(filename());
  const book = new OrderBook(store, client, config);
  const campaign = `0x${'aa'.repeat(32)}`;
  const guarded = guardProgram({
    coordinator: collective,
    campaign,
    minParticipants: 2,
    minSpend: 2_000_000n,
    priceProgram: fixedTerms(1_000_000, 250, 0, 0),
  });
  const input = await envelope({ programBytes: guarded });
  assert.equal((await book.submit(input)).program, guarded);
  await assert.rejects(
    book.submit({
      ...input,
      program: guarded.replace(campaign.slice(2), 'bb'.repeat(32)),
    }),
    /program hash mismatch/,
  );
  const fakeCoordinator = guardProgram({
    coordinator: router,
    campaign,
    minParticipants: 2,
    minSpend: 2_000_000n,
    priceProgram: program,
  });
  await assert.rejects(
    book.submit(await envelope({ programBytes: fakeCoordinator })),
    /collective coordinator mismatch/,
  );
  await assert.rejects(
    book.submit(
      await envelope({ programBytes: guarded.replace('0xa280', '0xa27f') }),
    ),
    /invalid collective program/,
  );
  assert.throws(
    () =>
      guardProgram({
        coordinator: collective,
        campaign,
        minParticipants: 9,
        minSpend: 1n,
        priceProgram: program,
      }),
    /Invalid collective guard/,
  );
  store.close();
});
