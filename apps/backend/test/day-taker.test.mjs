import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DayTaker } from '../src/day-taker.mjs';
import {
  dayRouterAbi,
  encodeDayStrategy,
  hashDayStrategy,
} from '../src/day-protocol.mjs';

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const config = {
  chainId: 31337,
  aqua: addr(1),
  router: addr(2),
  factory: addr(3),
  maxFills: 1,
};
const maker = addr(4),
  buyer = addr(5),
  asset = addr(6),
  token = addr(7);
const account = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const bid = {
  buyer,
  chainId: 31337n,
  app: config.router,
  asset,
  startDay: 20000,
  endDayExclusive: 20001,
  maxTotal: 100n,
  nonce: 1n,
  deadline: 2000000000,
  salt: zeroHash,
};
const ask = {
  seller: maker,
  chainId: 31337n,
  app: config.router,
  asset,
  day: 20000,
  saleNonce: 0n,
  discountVersion: 1n,
  salt: zeroHash,
};
const publication = (kind, strategy, blockNumber) => ({
  address: config.aqua,
  blockNumber,
  logIndex: 0,
  args: {
    app: config.router,
    maker: kind === 'bid' ? strategy.buyer : strategy.seller,
    strategyHash: hashDayStrategy(kind, strategy),
    strategy: encodeDayStrategy(kind, strategy),
  },
});

function setup(t, extraRows = []) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const rows = [
    publication('ask', ask, 1),
    publication('bid', bid, 2),
    ...extraRows,
  ].reverse();
  const index = {
    confirmations: 0,
    ready: true,
    pages: 0,
    async sync() {},
    async readiness() {
      return { ready: this.ready };
    },
    events(name, limit, before) {
      this.pages++;
      const from = before ? rows.findIndex((row) => row === before) + 1 : 0;
      return rows.slice(from, from + limit);
    },
  };
  const client = {
    sent: [],
    receipts: new Map(),
    used: new Set(),
    simulations: [],
    nextStatus: 'success',
    nextLogs: true,
    async getChainId() {
      return 31337;
    },
    async getBlockNumber() {
      return 10n;
    },
    async getBlock() {
      return { number: 10n, hash: zeroHash, timestamp: 1800000000n };
    },
    async readContract({ functionName, args }) {
      if (functionName === 'isAsset') return true;
      if (functionName === 'used') return this.used.has(args[1].toString());
      if (functionName === 'rangeState')
        return [
          { token, owner: maker, deployed: true, listed: true, saleNonce: 0n },
        ];
      if (functionName === 'discountVersion') return 1n;
      if (functionName === 'rawBalances') return [1n, 1];
      if (functionName === 'program') return '0x1234';
      throw new Error(`Unexpected read ${functionName}`);
    },
    async simulateContract({ args }) {
      this.simulations.push(args);
      if (this.failure) throw this.failure;
      return { result: 90n };
    },
    async getTransactionCount() {
      return this.receipts.size;
    },
    async getTransactionReceipt({ hash }) {
      if (this.receipts.has(hash)) return this.receipts.get(hash);
      const e = new Error('not mined');
      e.name = 'TransactionReceiptNotFoundError';
      throw e;
    },
    async sendRawTransaction({ serializedTransaction }) {
      this.sent.push(serializedTransaction);
      const hash = keccak256(serializedTransaction);
      const b = this.simulations.at(-1)[0];
      if (this.nextStatus === 'success') this.used.add(b.nonce.toString());
      this.receipts.set(hash, {
        transactionHash: hash,
        to: config.router,
        from: account.address,
        blockNumber: 10n,
        blockHash: zeroHash,
        status: this.nextStatus,
        logs: this.nextLogs
          ? [
              {
                address: config.router,
                topics: encodeEventTopics({
                  abi: dayRouterAbi,
                  eventName: 'Settled',
                  args: {
                    bidHash: hashDayStrategy('bid', b),
                    buyer: b.buyer,
                    asset: b.asset,
                  },
                }),
                data: encodeAbiParameters([{ type: 'uint256' }], [90n]),
              },
            ]
          : [],
      });
      return hash;
    },
  };
  const wallet = {
    account,
    chain: { id: 31337 },
    signatures: 0,
    async prepareTransactionRequest({ to, data, value }) {
      return {
        to,
        data,
        value,
        type: 'eip1559',
        chainId: 31337,
        gas: 1000000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      };
    },
    async signTransaction(request) {
      this.signatures++;
      return account.signTransaction(request);
    },
  };
  return {
    db,
    index,
    client,
    wallet,
    make: () => new DayTaker(db, index, client, wallet, config),
  };
}

test('reads beyond 1000 publications and skips malformed or foreign data without hiding old bids', async (t) => {
  const newer = { ...bid, nonce: 2n };
  const junk = Array.from({ length: 1000 }, (_, i) => ({
    address: config.aqua,
    blockNumber: i + 3,
    logIndex: 0,
    args: { strategy: '0x' },
  }));
  junk.push({ ...publication('bid', newer, 1003), address: addr(8) });
  junk.push({
    ...publication('bid', newer, 1004),
    args: { ...publication('bid', newer, 1004).args, maker: maker },
  });
  junk.push(publication('bid', newer, 1005));
  const f = setup(t, junk);
  const result = await f.make().tick();
  assert.ok(f.index.pages >= 2);
  assert.equal(result.submissions.length, 1);
  assert.equal(result.submissions[0].bidHash, hashDayStrategy('bid', bid));
  assert.equal(result.submissions[0].state, 'filled');
  const second = await f.make().tick();
  assert.equal(second.submissions[0].bidHash, hashDayStrategy('bid', newer));
  assert.equal(f.client.sent.length, 2);
});

test('index reorg or catch-up readiness blocks signing and execution', async (t) => {
  const f = setup(t);
  f.index.ready = false;
  assert.equal((await f.make().tick()).state, 'indexing');
  assert.equal(f.client.simulations.length, 0);
  assert.equal(f.wallet.signatures, 0);
});

test('unsupported legacy job fails closed before new signatures', async (t) => {
  const f = setup(t),
    taker = f.make();
  f.db
    .prepare(
      `INSERT INTO submissions(id,bid_hash,ask_hash,sender,nonce,unsigned,kind)
    VALUES('legacy','bid','ask',?,0,'{}','ordinary')`,
    )
    .run(account.address.toLowerCase());
  await assert.rejects(taker.tick(), /Unsupported saved submission/);
  assert.equal(f.wallet.signatures, 0);
  assert.equal(f.client.sent.length, 0);
});

test('RPC failure surfaces while a contract rejection remains conditional', async (t) => {
  const f = setup(t),
    taker = f.make();
  f.client.failure = new Error('RPC unavailable');
  await assert.rejects(taker.tick(), /RPC unavailable/);
  f.client.failure = Object.assign(new Error('too expensive'), {
    name: 'ContractFunctionRevertedError',
  });
  assert.equal((await taker.tick()).submissions.length, 0);
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM submissions').get().n,
    0,
  );
  f.client.failure = undefined;
  assert.equal((await taker.tick()).submissions[0].state, 'filled');
});

test('mined success needs matching router settlement evidence', async (t) => {
  const f = setup(t);
  f.client.nextLogs = false;
  await assert.rejects(f.make().tick(), /lacks the expected settlement/);
  await assert.rejects(f.make().tick(), /lacks the expected settlement/);
  assert.equal(f.wallet.signatures, 1);
  assert.equal(f.client.sent.length, 1);
});

test('orphaned receipt blocks new admission and cannot become filled', async (t) => {
  const f = setup(t, [publication('bid', { ...bid, nonce: 2n }, 3)]);
  await f.make().tick();
  f.client.receipts.values().next().value.blockHash = `0x${'ff'.repeat(32)}`;
  const result = await f.make().tick();
  assert.equal(result.state, 'pending');
  assert.equal(result.recovered[0].state, 'pending');
  assert.equal(f.wallet.signatures, 1);
  assert.equal(f.client.sent.length, 1);
});

test('canonical reverted receipt permits a new attempt with a new relayer nonce', async (t) => {
  const f = setup(t);
  f.client.nextStatus = 'reverted';
  const first = await f.make().tick();
  assert.equal(first.submissions[0].state, 'reverted');
  f.client.nextStatus = 'success';
  const second = await f.make().tick();
  assert.equal(second.submissions[0].state, 'filled');
  assert.notEqual(first.submissions[0].id, second.submissions[0].id);
  const jobs = f.db
    .prepare('SELECT nonce,unsigned FROM submissions ORDER BY nonce')
    .all();
  assert.deepEqual(
    jobs.map((job) => job.nonce),
    [0, 1],
  );
  assert.equal(
    decodeFunctionData({
      abi: dayRouterAbi,
      data: JSON.parse(jobs[1].unsigned).data,
    }).functionName,
    'settle',
  );
});

test('restart replays saved signed bytes and nonce without signing again', async (t) => {
  const f = setup(t);
  const send = f.client.sendRawTransaction.bind(f.client);
  f.client.sendRawTransaction = async ({ serializedTransaction }) => {
    f.client.sent.push(serializedTransaction);
    throw new Error('connection lost before acceptance');
  };
  await assert.rejects(f.make().tick(), /connection lost/);
  const saved = f.db.prepare('SELECT * FROM submissions').get();
  assert.ok(saved.raw);
  f.client.sendRawTransaction = send;
  f.wallet.signTransaction = async () => {
    throw new Error('unexpected signature');
  };
  const recovered = await f.make().tick();
  assert.equal(recovered.recovered[0].state, 'filled');
  assert.equal(recovered.submissions.length, 0);
  assert.deepEqual(f.client.sent, [saved.raw, saved.raw]);
  assert.deepEqual(f.db.prepare('SELECT * FROM submissions').get(), saved);
  assert.equal(f.wallet.signatures, 1);
});
