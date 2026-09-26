import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventIndex } from '../src/event-index.mjs';

const AQUA = `0x${'1'.repeat(40)}`;
const FACTORY = `0x${'2'.repeat(40)}`;
const hex = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const shipped = {
  type: 'event',
  name: 'Shipped',
  inputs: [{ name: 'amount', type: 'uint256', indexed: false }],
};
const created = { type: 'event', name: 'Created', inputs: [] };
const options = {
  chainId: 11155111,
  startBlock: 0,
  confirmations: 0,
  sources: [
    { address: AQUA, events: [shipped] },
    { address: FACTORY, events: [created] },
  ],
  scope: { deployment: 'sepolia-demo-1', factory: FACTORY },
};
const event = (amount = 1n) => ({
  address: AQUA,
  eventName: 'Shipped',
  args: { amount },
});

class Chain {
  blocks = [];
  fork = 0;
  queries = [];
  add(events = []) {
    const number = this.blocks.length;
    this.blocks.push({
      number: BigInt(number),
      hash: hex(1000 + this.fork * 10000 + number),
      parentHash: number ? this.blocks.at(-1).hash : hex(0),
      events,
    });
  }
  replace(from, events) {
    this.blocks.length = from;
    this.fork++;
    for (const block of events) this.add(block);
  }
  async getChainId() {
    return 11155111;
  }
  async getBlockNumber() {
    return BigInt(this.blocks.length - 1);
  }
  async getBlock({ blockNumber }) {
    return this.blocks[Number(blockNumber)] ?? null;
  }
  async getLogs(query) {
    this.queries.push(query);
    assert.equal(query.strict, true);
    assert.equal(query.fromBlock, undefined);
    const block = this.blocks.find((b) => b.hash === query.blockHash);
    const logs = (block?.events ?? [])
      .map((e, logIndex) => ({
        ...e,
        blockHash: block.hash,
        blockNumber: block.number,
        transactionHash: hex(5000 + Number(block.number)),
        logIndex,
      }))
      .filter((log) => log.address === query.address);
    return this.onLogs ? this.onLogs(query, logs) : logs;
  }
}

function setup(t, extra = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const chain = new Chain();
  chain.add();
  return {
    db,
    chain,
    index: new EventIndex(db, chain, { ...options, ...extra }),
  };
}

test('persists decoded events and empty ancestry across index restart', async (t) => {
  const { db, chain, index } = setup(t);
  chain.add([
    event(9007199254740993n),
    { address: FACTORY, eventName: 'Created', args: {} },
  ]);
  chain.add();
  assert.equal((await index.sync()).number, 2);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM event_index_blocks').get().n,
    3,
  );
  assert.deepEqual(index.events('Shipped'), [
    {
      address: AQUA,
      name: 'Shipped',
      args: { amount: '9007199254740993' },
      transactionHash: hex(5001),
      blockHash: chain.blocks[1].hash,
      blockNumber: 1,
      logIndex: 0,
    },
  ]);
  assert.deepEqual(
    index.events().map((e) => e.name),
    ['Created', 'Shipped'],
  );
  const restarted = new EventIndex(db, chain, options);
  const reads = chain.queries.length;
  await restarted.sync();
  assert.equal(chain.queries.length, reads);
  assert.equal((await restarted.readiness()).ready, true);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%order%'",
      )
      .get().n,
    0,
  );
});

test('reorg through empty descendants removes orphan Shipped and replays replacement', async (t) => {
  const { chain, index } = setup(t);
  chain.add([event(1n)]);
  chain.add();
  chain.add();
  await index.sync();
  const genesis = index.block(0);
  const original = index.block(1);
  assert.equal(index.reorgVersion, 0);
  chain.replace(1, [[], [event(2n)], []]);
  assert.equal((await index.readiness()).canonical, false);
  await index.sync();
  assert.deepEqual(
    index.events('Shipped').map((e) => e.args.amount),
    ['2'],
  );
  assert.ok(index.reorgVersion > 0);
  assert.deepEqual(index.block(0), genesis);
  assert.notEqual(index.block(1).hash, original.hash);
  const version = index.reorgVersion;
  chain.add();
  await index.sync();
  assert.equal(index.reorgVersion, version);
  assert.equal(index.block(999), null);
  assert.equal((await index.readiness()).ready, true);
});

test('cursor pages recover publications older than 1000 with no gaps or overlap', async (t) => {
  const { chain, index } = setup(t);
  chain.add(Array.from({ length: 1205 }, (_, i) => event(BigInt(i))));
  chain.add([
    { address: FACTORY, eventName: 'Created', args: {} },
    event(1205n),
  ]);
  await index.sync();
  assert.equal(index.events('Shipped').length, 1000);
  const rows = [];
  let before;
  while (true) {
    const page = index.events('Shipped', 127, before);
    rows.push(...page);
    if (page.length < 127) break;
    before = page.at(-1);
  }
  assert.equal(rows.length, 1206);
  assert.deepEqual(
    rows.map((row) => row.args.amount),
    Array.from({ length: 1206 }, (_, i) => String(1205 - i)),
  );
  assert.equal(
    new Set(rows.map((row) => `${row.blockNumber}:${row.logIndex}`)).size,
    rows.length,
  );
  assert.deepEqual(index.events('Shipped', 127, rows.at(-1)), []);
  const first = index.events(undefined, 1);
  assert.equal(first[0].name, 'Shipped');
  assert.equal(index.events(undefined, 1, first[0])[0].name, 'Created');
  for (const cursor of [null, {}, { blockNumber: 1, logIndex: -1 }])
    assert.throws(() => index.events('Shipped', 10, cursor), /Invalid/);
});

test('foreign log rejects the entire block even after a valid source was read', async (t) => {
  const { db, chain, index } = setup(t);
  await index.sync();
  chain.add([event(), { address: FACTORY, eventName: 'Created', args: {} }]);
  chain.onLogs = (query, logs) =>
    query.address === FACTORY
      ? logs.map((log) => ({ ...log, address: AQUA }))
      : logs;
  await assert.rejects(index.sync(), /does not match source/);
  assert.equal(index.tip().number, 0);
  assert.deepEqual(index.events(), []);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM event_index_blocks').get().n,
    1,
  );
  chain.onLogs = null;
  await index.sync();
  assert.equal(index.events().length, 2);
});

test('duplicate positions roll back both block and prior event insert', async (t) => {
  const { chain, index } = setup(t);
  chain.add([event()]);
  chain.onLogs = (_, logs) => [...logs, ...logs];
  await assert.rejects(index.sync(), /UNIQUE/);
  assert.equal(index.tip().number, 0);
  assert.deepEqual(index.events(), []);
});

test('concurrent sync calls share one in-flight pass', async (t) => {
  const { chain, index } = setup(t);
  chain.add([event()]);
  let release, started;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  chain.onLogs = async (_, logs) => {
    started();
    await blocked;
    return logs;
  };
  const first = index.sync();
  await entered;
  const second = index.sync();
  release();
  assert.deepEqual(await first, await second);
  assert.equal(chain.queries.length, 4);
  assert.equal(index.events().length, 1);
});

test('source reads start concurrently and drain a late source before rejecting', async (t) => {
  const { chain, index } = setup(t);
  await index.sync();
  chain.add([event()]);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  chain.onLogs = async (query, logs) => {
    started.push(query.address);
    if (query.address === AQUA) throw new Error('RPC failure');
    await pending;
    return logs;
  };
  let settled = false;
  const syncing = index.sync().finally(() => {
    settled = true;
  });
  // Observe rejection immediately while checking that the other source drains.
  const rejected = assert.rejects(syncing, /RPC failure/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [AQUA, FACTORY]);
  assert.equal(settled, false);
  assert.equal(index.tip().number, 0);
  assert.deepEqual(index.events(), []);
  release();
  await rejected;
  assert.equal(index.tip().number, 0);
  assert.deepEqual(index.events(), []);
  chain.onLogs = null;
  await index.sync();
  assert.equal(index.events().length, 1);
});

test('reorg during log reads cannot commit the old block or its events', async (t) => {
  const { chain, index } = setup(t);
  await index.sync();
  chain.add([event(1n)]);
  chain.onLogs = (query, logs) => {
    if (query.address === FACTORY) {
      chain.replace(1, [[event(2n)]]);
      chain.onLogs = null;
    }
    return logs;
  };
  await index.sync();
  assert.equal(index.tip().number, 0);
  assert.deepEqual(index.events(), []);
  assert.equal((await index.readiness()).ready, false);
  await index.sync();
  assert.deepEqual(
    index.events().map((e) => e.args.amount),
    ['2'],
  );
});

test('caps catch-up at 64 blocks and reports confirmed readiness', async (t) => {
  const { chain, index } = setup(t, { confirmations: 2 });
  for (let n = 1; n <= 70; n++) chain.add(n === 69 ? [event()] : []);
  assert.equal((await index.sync()).number, 63);
  assert.equal((await index.readiness()).ready, false);
  assert.equal((await index.sync()).number, 68);
  assert.equal((await index.readiness()).ready, true);
  assert.deepEqual(index.events(), []);
  chain.blocks.length = 65;
  await index.sync();
  assert.equal(index.tip().number, 62);
});

test('deep reorg rewinds in bounded passes and never reports a stale tip ready', async (t) => {
  const { chain, index } = setup(t);
  chain.add([event(1n)]);
  for (let n = 2; n < 130; n++) chain.add();
  for (let n = 0; n < 3; n++) await index.sync();
  chain.replace(
    1,
    Array.from({ length: 129 }, () => []),
  );
  assert.equal((await index.sync()).number, 65);
  assert.equal((await index.readiness()).ready, false);
  assert.equal((await index.sync()).number, 1);
  assert.equal((await index.readiness()).ready, false);
  while (!(await index.readiness()).ready) await index.sync();
  assert.deepEqual(index.events('Shipped'), []);
});

test('pins deployment, ABI, start and confirmations across restarts', (t) => {
  const { db, chain } = setup(t);
  for (const changed of [
    { scope: { deployment: 'other' } },
    { chainId: 1 },
    { startBlock: 1 },
    { confirmations: 1 },
    { sources: [{ address: AQUA, events: [created] }] },
  ])
    assert.throws(
      () => new EventIndex(db, chain, { ...options, ...changed }),
      /identity differs/,
    );
  assert.doesNotThrow(
    () =>
      new EventIndex(db, chain, {
        ...options,
        sources: [...options.sources].reverse(),
        scope: { factory: FACTORY, deployment: 'sepolia-demo-1' },
      }),
  );
});

test('rejects wrong chain and malformed decoded logs without committing', async (t) => {
  const { chain, index } = setup(t);
  chain.getChainId = async () => 1;
  await assert.rejects(index.sync(), /RPC chain ID/);
  chain.getChainId = async () => 11155111;
  chain.add([event()]);
  for (const changes of [
    { eventName: 'Created' },
    { blockHash: hex(99) },
    { blockNumber: 5n },
    { transactionHash: '0x12' },
    { removed: true },
    { logIndex: null },
    { args: undefined },
  ]) {
    chain.onLogs = (_, logs) => logs.map((log) => ({ ...log, ...changes }));
    await assert.rejects(index.sync());
    assert.equal(index.tip().number, 0);
    assert.deepEqual(index.events(), []);
  }
});
