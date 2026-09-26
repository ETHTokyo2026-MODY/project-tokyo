import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChainIndex } from '../src/chain.mjs';
import { Market, MarketInputError } from '../src/market.mjs';
import { Store } from '../src/store.mjs';

const HASH = `0x${'ab'.repeat(32)}`;
const MAKER = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const config = { chainId: 31337, router: ROUTER };
const block = { number: 42n, hash: HASH, timestamp: 100n };
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

function order(n, buy, programHash = hash(9), overrides = {}) {
  return {
    hash: hash(n),
    order: {
      maker: MAKER,
      recipient: MAKER,
      buy,
      pool: hash(1),
      startDay: '100',
      endDay: '101',
      quantity: '1',
      terms: hash(2),
      expiry: '1000',
      programHash,
      mandate: hash(3),
      ...overrides,
    },
    signature: '0x1234',
    program: '0x1234',
    ...(buy ? { mandate: { expiry: '1000' } } : {}),
  };
}

function market(orders, simulate) {
  const calls = [];
  const client = {
    async getChainId() {
      return 31337;
    },
    async getBlock() {
      return block;
    },
    async simulateContract(request) {
      calls.push(request);
      return simulate(request);
    },
  };
  const book = {
    list: ({ limit, offset }) => orders.slice(offset, offset + limit),
  };
  const instance = new Market(book, { tip: () => null }, client, config);
  return { instance, calls, client };
}

test('ranks individual signed alternatives by buyer total at one block', async () => {
  const orders = [
    order(1, true, hash(9)),
    order(2, false, hash(9)),
    order(3, true, hash(10)),
    order(4, false, hash(10)),
  ];
  const { instance, calls } = market(orders, ({ args }) => ({
    result:
      args[0].programHash === hash(9)
        ? [1_000_000n, 10_000n]
        : [990_000n, 9_900n],
  }));
  const result = await instance.quotes();
  assert.equal(result.quotes.length, 2);
  assert.equal(result.bestByBasket.length, 1);
  assert.equal(result.bestByBasket[0].bidHash, hash(3));
  assert.equal(result.bestByBasket[0].total, '999900');
  assert.deepEqual(
    result.quotes.map(({ bidMaker, mandate }) => [bidMaker, mandate]),
    [
      [MAKER, hash(3)],
      [MAKER, hash(3)],
    ],
  );
  assert.match(result.execution, /alternatives/);
  assert.equal(result.window.checkedPairs, 2);
  assert.ok(calls.every(({ blockNumber }) => blockNumber === 42n));
});

test('keeps buyers and unlike rental baskets in distinct price groups', async () => {
  const secondBuyer = '0x3333333333333333333333333333333333333333';
  const orders = [
    order(1, true, hash(9)),
    order(2, false, hash(9)),
    order(3, true, hash(10), { startDay: '101', endDay: '102' }),
    order(4, false, hash(10), { startDay: '101', endDay: '102' }),
    order(5, true, hash(9), { maker: secondBuyer, mandate: hash(5) }),
  ];
  const { instance } = market(orders, async ({ args }) => ({
    result:
      args[0].programHash === hash(9)
        ? [1_000_000n, 10_000n]
        : [2_000_000n, 20_000n],
  }));
  const result = await instance.quotes();
  assert.equal(result.quotes.length, 3);
  assert.equal(result.bestByBasket.length, 3);
  assert.deepEqual(
    result.bestByBasket.map((quote) => [quote.bidMaker, quote.startDay]),
    [
      [MAKER, '100'],
      [MAKER, '101'],
      [secondBuyer, '100'],
    ],
  );
  assert.equal(Object.hasOwn(result, 'best'), false);
});

test('keeps signed guest recipients distinct within one buyer basket', async () => {
  const guest = '0x4444444444444444444444444444444444444444';
  const orders = [
    order(1, true),
    order(2, true, hash(9), { recipient: guest }),
    order(3, false),
  ];
  const { instance } = market(orders, async () => ({
    result: [1_000_000n, 10_000n],
  }));
  const result = await instance.quotes();
  assert.equal(result.quotes.length, 2);
  assert.deepEqual(
    result.bestByBasket.map((quote) => [quote.bidHash, quote.bidRecipient]),
    [[hash(1), MAKER], [hash(2), guest]],
  );
});

test('filters expiry and contract failures, surfaces RPC failure and reorg', async () => {
  const expired = order(1, true, hash(9), { expiry: '100' });
  const liveBid = order(2, true);
  const ask = order(3, false);
  const { instance, calls, client } = market(
    [expired, liveBid, ask],
    async () => {
      const error = new Error('cancelled or unfunded');
      error.name = 'ContractFunctionRevertedError';
      throw error;
    },
  );
  assert.deepEqual((await instance.quotes()).quotes, []);
  assert.equal(calls.length, 1);
  client.simulateContract = async () => {
    throw new Error('RPC unavailable');
  };
  await assert.rejects(instance.quotes(), /RPC unavailable/);
  client.getChainId = async () => 1;
  await assert.rejects(instance.quotes(), /chain ID/);
  client.getChainId = async () => 31337;
  client.simulateContract = async () => ({ result: [1n, 0n] });
  client.getBlock = async (request) =>
    request?.blockNumber ? { ...block, hash: hash(99) } : block;
  await assert.rejects(instance.quotes(), /reorganized/);
});

test('caps each order window at twenty and at most one hundred pair checks', async () => {
  const orders = [
    ...Array.from({ length: 10 }, (_, i) => order(i + 1, true)),
    ...Array.from({ length: 11 }, (_, i) => order(i + 20, false)),
  ];
  const { instance, calls } = market(orders, async () => ({
    result: [1n, 0n],
  }));
  const first = await instance.quotes();
  assert.equal(first.window.checkedPairs, 100);
  assert.equal(calls.length, 100);
  assert.equal(first.quotes.length, 100);
  assert.deepEqual(
    [first.quotes[0].bidHash, first.quotes[0].askHash],
    [hash(1), hash(20)],
  );
  assert.deepEqual(
    [first.quotes.at(-1).bidHash, first.quotes.at(-1).askHash],
    [hash(10), hash(29)],
  );
  assert.equal(
    (await instance.quotes({ limit: 1, offset: 20 })).quotes.length,
    0,
  );
  await assert.rejects(instance.quotes({ limit: 21 }), MarketInputError);
  await assert.rejects(instance.quotes({ offset: 1001 }), MarketInputError);
});

test('history joins canonical settlement events to stored baskets only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rental-market-'));
  const store = new Store(join(directory, 'orders.db'));
  try {
    const client = {
      getChainId: async () => 31337,
      getBlock: async () => block,
      simulateContract: async () => null,
    };
    const index = new ChainIndex(store, client, { ...config, startBlock: 0 });
    store.db
      .prepare('INSERT INTO blocks VALUES(?,?,?)')
      .run(42, HASH, hash(41));
    for (const record of [order(1, true), order(2, false)]) {
      store.db
        .prepare('INSERT INTO orders(hash,payload,created_at) VALUES(?,?,?)')
        .run(record.hash, JSON.stringify(record), 1);
    }
    const insert = store.db.prepare(
      'INSERT INTO chain_events VALUES(?,?,?,?,?)',
    );
    insert.run(
      42,
      0,
      hash(8),
      'Settled',
      JSON.stringify({
        buyHash: hash(1),
        sellHash: hash(2),
        price: '1000000',
        fee: '10000',
      }),
    );
    insert.run(
      42,
      1,
      hash(9),
      'Settled',
      JSON.stringify({
        buyHash: hash(1),
        sellHash: hash(99),
        price: '2000000',
        fee: '20000',
      }),
    );
    const book = { store, list: () => [] };
    const market = new Market(book, index, client, config);
    const result = await market.history();
    assert.equal(result.sales.length, 1);
    assert.equal(result.sales[0].price, '1000000');
    assert.equal(result.sales[0].startDay, '100');
    assert.equal(result.bookingHistory, 'unavailable');
    assert.deepEqual(result.window, {
      limit: 20,
      offset: 0,
      events: 2,
      attributed: 1,
    });

    // A page is a window of indexed events, even when none can be attributed
    // to retained order envelopes. Later pages can still contain known sales.
    for (let logIndex = 2; logIndex < 27; logIndex++)
      insert.run(
        42,
        logIndex,
        hash(100 + logIndex),
        'Settled',
        JSON.stringify({
          buyHash: hash(98),
          sellHash: hash(99),
          price: '1',
          fee: '0',
        }),
      );
    const first = await market.history();
    assert.deepEqual(first.sales, []);
    assert.deepEqual(first.window, {
      limit: 20,
      offset: 0,
      events: 20,
      attributed: 0,
    });
    const second = await market.history({ offset: 20 });
    assert.equal(second.sales.length, 1);
    assert.equal(second.sales[0].transactionHash, hash(8));
    assert.deepEqual(second.window, {
      limit: 20,
      offset: 20,
      events: 7,
      attributed: 1,
    });
    const plan = store.db
      .prepare(`EXPLAIN QUERY PLAN
        WITH event_window AS MATERIALIZED (
          SELECT block_number, log_index FROM chain_events
          WHERE name = 'Settled'
          ORDER BY block_number DESC, log_index DESC LIMIT 20 OFFSET 20
        )
        SELECT * FROM event_window`)
      .all();
    assert.ok(plan.some((step) => step.detail === 'MATERIALIZE event_window'));
    assert.ok(
      plan.some((step) => step.detail.includes('chain_events_name_position')),
    );
    store.db.prepare('DELETE FROM chain_events').run();
    assert.deepEqual(
      (await market.history()).sales,
      [],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
