import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Market } from '../src/market.mjs';
import { Store } from '../src/store.mjs';
import { ChainIndex } from '../src/chain.mjs';
import { programTerms, serialize } from '../src/protocol.mjs';
import { config, envelope, hex } from './native-fixture.mjs';
const block = { number: 42n, hash: hex(42), timestamp: 100n };
function fixture(orders) {
  const client = {
    getChainId: async () => 31337,
    getBlock: async () => block,
    simulateContract: async ({ functionName, args, blockNumber }) => {
      assert.equal(functionName, 'swap');
      assert.equal(blockNumber, 42n);
      const cap = programTerms(args[0], config.usdc).price,
        price = programTerms(args[1], config.usdc).price;
      if (price > cap)
        throw Object.assign(new Error('price'), {
          name: 'ContractFunctionRevertedError',
        });
      return { result: price };
    },
  };
  const book = {
    list: ({ limit, offset }) => orders.slice(offset, offset + limit),
  };
  return {
    client,
    book,
    market: new Market(book, { tip: () => null }, client, config),
  };
}
test('one buyer cap ranks independent seller programs and rejects over-budget asks', async () => {
  const bid = envelope(true, 300n),
    old = envelope(false, 330n),
    a = envelope(false, 290n),
    b = envelope(false, 280n);
  const { market } = fixture([bid, old, a, b]);
  const result = await market.quotes();
  assert.equal(result.window.checkedPairs, 3);
  assert.equal(result.quotes.length, 2);
  assert.equal(result.bestByBasket.length, 1);
  assert.equal(result.bestByBasket[0].askHash, b.hash);
  assert.equal(result.bestByBasket[0].price, '280');
});
test('market RPC failures and inconsistent snapshots surface rather than becoming empty liquidity', async () => {
  const { client, market } = fixture([envelope(), envelope(false)]);
  client.simulateContract = async () => {
    throw new Error('offline');
  };
  await assert.rejects(market.quotes(), /offline/);
  client.simulateContract = async () => ({ result: 290n });
  let reads = 0;
  client.getBlock = async () => ({
    ...block,
    hash: reads++ ? hex(99) : block.hash,
  });
  await assert.rejects(market.quotes(), /reorganized/);
});
test('canonical history attributes native events to concrete inventory IDs', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const bid = envelope(),
    ask = envelope(false, 290n);
  for (const e of [bid, ask])
    store.db
      .prepare('INSERT INTO orders VALUES (?,?,?)')
      .run(e.hash, serialize(e), 0);
  const client = {
    getBlock: async () => block,
    getChainId: async () => 31337,
    simulateContract: async () => ({ result: 290n }),
  };
  const index = new ChainIndex(store, client, {
    ...config,
    startBlock: 42,
    confirmations: 0,
  });
  store.db
    .prepare('INSERT INTO blocks VALUES (?,?,?)')
    .run(42, block.hash, hex(41));
  store.db.prepare('INSERT INTO chain_events VALUES (?,?,?,?,?)').run(
    42,
    0,
    hex(100),
    'Swapped',
    serialize({
      bidHash: bid.hash,
      askHash: ask.hash,
      payment: 290n,
      quantity: 1n,
    }),
  );
  const market = new Market({ list: () => [], store }, index, client, config);
  const history = await market.history();
  assert.equal(history.sales.length, 1);
  assert.deepEqual(history.sales[0].ids, ['1', '2']);
  assert.equal(history.sales[0].price, '290');
  assert.equal(history.bookingHistory, 'unavailable');
});
