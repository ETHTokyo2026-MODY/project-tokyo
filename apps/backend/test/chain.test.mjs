import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChainIndex } from '../src/chain.mjs';

const ROUTER = '0x1111111111111111111111111111111111111111';
const MAKER = '0x2222222222222222222222222222222222222222';
const BUY = `0x${'a'.repeat(64)}`;
const SELL = `0x${'b'.repeat(64)}`;
const GROUP = `0x${'c'.repeat(64)}`;
const hex = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const order = (hash = BUY, nonce = 7n, group = GROUP) => ({
  hash,
  maker: MAKER,
  nonce,
  group,
});

class FakeChain {
  constructor() {
    this.blocks = [];
    this.used = new Set();
    this.closedGroups = new Set();
    this.add([]);
  }

  add(events) {
    const number = this.blocks.length;
    const block = {
      number: BigInt(number),
      hash: hex(1000 + number + (this.fork ?? 0) * 10000),
      parentHash: number ? this.blocks[number - 1].hash : hex(0),
      events,
    };
    this.blocks.push(block);
    return block;
  }

  replace(from, eventLists) {
    this.blocks.length = from;
    this.fork = (this.fork ?? 0) + 1;
    for (const events of eventLists) this.add(events);
  }

  async getChainId() {
    return 31337;
  }
  async getBlockNumber() {
    return BigInt(this.blocks.length - 1);
  }
  async getBlock({ blockNumber }) {
    return this.blocks[Number(blockNumber)] ?? null;
  }
  async getLogs({ address, blockHash }) {
    assert.equal(address.toLowerCase(), ROUTER);
    const block = this.blocks.find((candidate) => candidate.hash === blockHash);
    return (block?.events ?? []).map((event, logIndex) => ({
      ...event,
      address: ROUTER,
      blockHash,
      blockNumber: block.number,
      transactionHash: hex(Number(block.number) * 100 + logIndex),
      logIndex,
    }));
  }
  async readContract({ functionName, args, blockNumber }) {
    assert.ok(this.blocks[Number(blockNumber)]);
    const key = `${args[0].toLowerCase()}:${args[1].toString().toLowerCase()}`;
    return functionName === 'used'
      ? this.used.has(key)
      : this.closedGroups.has(key);
  }
}

function index(db, chain, extra = {}) {
  return new ChainIndex({ db }, chain, {
    chainId: 31337,
    router: ROUTER,
    startBlock: 0,
    confirmations: 0,
    ...extra,
  });
}

test('indexes empty blocks, persists cursor, and repeats sync without duplicates', async () => {
  const db = new DatabaseSync(':memory:');
  const chain = new FakeChain();
  chain.add([]);
  chain.add([
    {
      eventName: 'Settled',
      args: {
        buyHash: BUY,
        sellHash: SELL,
        mandate: hex(3),
        price: 1n,
        fee: 0n,
      },
    },
  ]);
  const first = index(db, chain);
  assert.equal(await first.sync(), 2);
  assert.equal(await first.sync(), 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM blocks').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chain_events').get().n, 1);
  const restarted = index(db, chain);
  assert.equal(await restarted.sync(), 2);
  assert.equal(restarted.settled(BUY), true);
  assert.equal(await restarted.confirmedSettlement(hex(200), BUY, SELL), true);
  assert.equal(await restarted.confirmedSettlement(hex(999), BUY, SELL), false);
  assert.equal(await restarted.confirmedSettlement(hex(200), SELL, BUY), false);
  assert.equal(await restarted.status(order()), 'filled');
  db.close();
});

test('unwinds orphaned events, including a reorg across an empty block', async () => {
  const db = new DatabaseSync(':memory:');
  const chain = new FakeChain();
  chain.add([]);
  chain.add([
    {
      eventName: 'Settled',
      args: {
        buyHash: BUY,
        sellHash: SELL,
        mandate: hex(3),
        price: 1n,
        fee: 0n,
      },
    },
  ]);
  const idx = index(db, chain);
  await idx.sync();
  chain.replace(1, [
    [],
    [{ eventName: 'Cancelled', args: { maker: MAKER, nonce: 7n } }],
  ]);
  assert.equal(await idx.sync(), 2);
  assert.equal(idx.settled(BUY), false);
  assert.equal(await idx.confirmedSettlement(hex(200), BUY, SELL), false);
  assert.equal(await idx.status(order()), 'cancelled');
  assert.equal(db.prepare('SELECT count(*) AS n FROM blocks').get().n, 3);
  db.close();
});

test('bounds catchup, handles a shorter chain, and rejects mismatched identity', async () => {
  const db = new DatabaseSync(':memory:');
  const chain = new FakeChain();
  for (let n = 0; n < 70; n++) chain.add([]);
  const idx = index(db, chain);
  assert.equal(await idx.sync(), 63);
  assert.equal(await idx.sync(), 70);
  chain.replace(2, [[]]);
  assert.equal(await idx.sync(), 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM blocks').get().n, 3);
  assert.throws(() => index(db, chain, { router: MAKER }), /identity/);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
    'scope',
    JSON.stringify({ chainId: 31337, router: MAKER }),
  );
  assert.throws(() => index(db, chain), /order store scope/);
  db.close();
});

test('checks used and closedGroup at the indexed block and returns unknown on a reorg', async () => {
  const db = new DatabaseSync(':memory:');
  const chain = new FakeChain();
  chain.add([]);
  const idx = index(db, chain);
  assert.equal(await idx.status(order()), 'unknown');
  await idx.sync();
  assert.equal(await idx.status(order()), 'open');
  chain.used.add(`${MAKER}:7`);
  assert.equal(
    await idx.status({
      hash: BUY,
      order: { maker: MAKER, nonce: '7', group: GROUP },
    }),
    'closed',
  );
  chain.used.clear();
  chain.closedGroups.add(`${MAKER}:${GROUP}`);
  assert.equal(await idx.status(order()), 'closed');
  chain.replace(1, [[]]);
  assert.equal(await idx.status(order()), 'unknown');
  db.close();
});

test('rejects mixed block logs atomically and retries from the persisted cursor', async () => {
  const db = new DatabaseSync(':memory:');
  const chain = new FakeChain();
  chain.add([
    { eventName: 'GroupClosed', args: { maker: MAKER, group: GROUP } },
  ]);
  const idx = index(db, chain);
  const originalGetLogs = chain.getLogs.bind(chain);
  chain.getLogs = async (query) =>
    (await originalGetLogs(query)).map((log) => ({
      ...log,
      blockHash: hex(999),
    }));
  await assert.rejects(idx.sync(), /Log does not match/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM blocks').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chain_events').get().n, 0);
  chain.getLogs = originalGetLogs;
  assert.equal(await idx.sync(), 1);
  assert.equal(await idx.status(order()), 'cancelled');
  db.close();
});
