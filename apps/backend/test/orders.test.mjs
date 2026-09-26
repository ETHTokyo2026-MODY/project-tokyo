import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { Store } from '../src/store.mjs';
import { OrderBook, OrderInputError } from '../src/orders.mjs';
import {
  aquaAbi,
  decodeStrategy,
  encodeStrategy,
  hashStrategy,
  registration,
  rentalStrategy,
  ZERO_HASH,
} from '../src/protocol.mjs';
import { config, envelope, inventory, buyer, hex } from './native-fixture.mjs';
function fixture() {
  const store = new Store(':memory:');
  const client = {
    getChainId: async () => 31337,
    getBlock: async () => ({ number: 1n, hash: hex(1), timestamp: 100n }),
    readContract: async ({ functionName }) =>
      functionName === 'AQUA'
        ? config.aqua
        : functionName === 'USDC'
          ? config.usdc
          : [300n, 1],
  };
  const book = new OrderBook(store, client, config);
  return { store, client, book };
}
test('onchain authorization intake is immutable and idempotent, without signatures or mandates', async (t) => {
  const { store, book } = fixture();
  t.after(() => store.close());
  const expected = envelope();
  const accepted = await book.submit({ strategy: expected.strategy });
  assert.deepEqual(accepted, expected);
  assert.deepEqual(
    await book.submit({ strategy: expected.strategy }),
    expected,
  );
  assert.equal(book.list().length, 1);
  assert.deepEqual(
    new OrderBook(store, book.publicClient, config).get(expected.hash),
    expected,
  );
  await assert.rejects(
    book.submit({ strategy: expected.strategy, signature: '0x1234' }),
    OrderInputError,
  );
});
test('rejects wrong deployment, absent/docked registrations, malformed and duplicate IDs', async (t) => {
  const { store, book, client } = fixture();
  t.after(() => store.close());
  for (const ids of [[], ['2', '1'], ['1', '1']])
    await assert.rejects(
      book.submit({ strategy: { ...envelope().strategy, ids } }),
      OrderInputError,
    );
  const original = client.readContract;
  for (const count of [0, 255]) {
    client.readContract = async (x) =>
      x.functionName === 'rawBalances' ? [300n, count] : original(x);
    await assert.rejects(
      book.submit({ strategy: envelope().strategy }),
      /not actively registered/,
    );
  }
  client.readContract = async () => config.router;
  await assert.rejects(
    book.submit({ strategy: envelope().strategy }),
    /deployment mismatch/,
  );
});
test('registration snapshot reorg and RPC outage cannot authorize intake', async (t) => {
  const { store, book, client } = fixture();
  t.after(() => store.close());
  client.getBlock = async (args) => ({
    number: 1n,
    hash: args ? hex(2) : hex(1),
    timestamp: 100n,
  });
  await assert.rejects(
    book.submit({ strategy: envelope().strategy }),
    /reorganized/,
  );
  client.readContract = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    book.submit({ strategy: envelope().strategy }),
    /offline/,
  );
  assert.equal(book.list().length, 0);
});
test('different protocol/deployment databases cannot be silently reused', (t) => {
  const { store, client } = fixture();
  t.after(() => store.close());
  assert.throws(
    () => new OrderBook(store, client, { ...config, aqua: inventory }),
    /mismatch/,
  );
});
test('canonical shipped log can populate the book; mismatched maker or app cannot', (t) => {
  const { store, book } = fixture();
  t.after(() => store.close());
  const e = envelope();
  const log = {
    app: config.router,
    maker: e.strategy.maker,
    strategyHash: e.hash,
    strategy: encodeStrategy(e.strategy),
  };
  book.ingestShipped({ ...log, maker: inventory });
  book.ingestShipped({ ...log, app: inventory });
  assert.equal(book.list().length, 0);
  book.ingestShipped(log);
  assert.deepEqual(book.get(e.hash), e);
});
test('registration calldata binds native assets, basket and budget; a 90-day range needs no 31-day trading cap', () => {
  const s = rentalStrategy(
    {
      maker: buyer,
      inventory,
      pool: hex(1),
      terms: hex(2),
      startDay: 30000,
      endDay: 30090,
      quantity: 1,
      buy: false,
      price: 300n,
      expiry: 10000n,
      nonce: 1,
      salt: ZERO_HASH,
    },
    config,
  );
  assert.equal(s.ids.length, 90);
  const r = registration(s, config);
  const decoded = decodeFunctionData({ abi: aquaAbi, data: r.request.data });
  assert.equal(decoded.functionName, 'ship');
  assert.equal(decoded.args[2].length, 90);
  assert.deepEqual(decodeStrategy(decoded.args[1], config.usdc), s);
  assert.equal(r.hash, hashStrategy(s));
  assert.throws(() =>
    rentalStrategy(
      {
        ...s,
        pool: hex(1),
        terms: hex(2),
        startDay: 1,
        endDay: 256,
        price: 1,
        expiry: 1,
      },
      config,
    ),
  );
});
