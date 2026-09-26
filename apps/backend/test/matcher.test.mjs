import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Matcher, ensureSubmissions } from '../src/matcher.mjs';
import { StoredSubmission } from '../src/submission.mjs';
import { fixedProgram, hashStrategy, ZERO_HASH } from '../src/protocol.mjs';
import { Store } from '../src/store.mjs';

const directory = mkdtempSync(join(tmpdir(), 'rental-matcher-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const filename = () => join(directory, `${Math.random()}.db`);
const relayer = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const buyer = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const seller = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const config = {
  chainId: 31337,
  router: '0x1111111111111111111111111111111111111111',
  usdc: '0x2222222222222222222222222222222222222222',
};

test('saved signed jobs cannot be retried with a different exact call', async () => {
  const store = new Store(filename());
  try {
    const sender = new StoredSubmission(store.db, fakeClient(), localWallet(), {
      chainId: config.chainId,
      kind: 'ordinary',
    });
    const args = {
      id: 'saved-call',
      bidHash: 'bid',
      askHash: 'ask',
      to: config.router,
      data: '0x1234',
      simulate: async () => {},
    };
    await sender.submit(args);
    await assert.rejects(
      sender.submit({ ...args, to: config.usdc }),
      /Stored transaction differs/,
    );
    await assert.rejects(
      sender.submit({ ...args, data: '0x5678' }),
      /Stored transaction differs/,
    );
  } finally {
    store.close();
  }
});

test('legacy ordinary submissions migrate into the shared nonce namespace', () => {
  const store = new Store(filename());
  try {
    store.db.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, bid_hash TEXT NOT NULL, ask_hash TEXT NOT NULL,
      sender TEXT NOT NULL, nonce INTEGER NOT NULL, unsigned TEXT,
      raw TEXT, tx_hash TEXT, UNIQUE(sender, nonce)
    )`);
    store.db
      .prepare(
        'INSERT INTO submissions(id,bid_hash,ask_hash,sender,nonce) VALUES(?,?,?,?,?)',
      )
      .run('old', 'bid', 'ask', relayer.address.toLowerCase(), 7);
    ensureSubmissions(store.db);
    ensureSubmissions(store.db);
    const old = store.db
      .prepare('SELECT nonce,kind,payload FROM submissions WHERE id = ?')
      .get('old');
    assert.equal(old.nonce, 7);
    assert.equal(old.kind, 'ordinary');
    assert.equal(old.payload, null);
    assert.throws(
      () =>
        store.db
          .prepare(
            "INSERT INTO submissions(id,bid_hash,ask_hash,sender,nonce,kind) VALUES(?,?,?,?,?,'conversion')",
          )
          .run('new', 'bid', 'ask', relayer.address.toLowerCase(), 7),
      /UNIQUE constraint failed/,
    );
  } finally {
    store.close();
  }
});

test('unsigned ordinary job blocks a later conversion nonce until recovered', async () => {
  const store = new Store(filename());
  const client = fakeClient();
  const badWallet = localWallet();
  badWallet.failSign = true;
  const ordinary = new StoredSubmission(store.db, client, badWallet, {
    chainId: config.chainId,
    kind: 'ordinary',
  });
  const args = {
    bidHash: 'bid',
    askHash: 'ask',
    to: config.router,
    data: '0x1234',
    simulate: async () => {},
  };
  await assert.rejects(
    ordinary.submit({ ...args, id: 'ordinary' }),
    /signing failed/,
  );
  const conversion = new StoredSubmission(store.db, client, localWallet(), {
    chainId: config.chainId,
    kind: 'conversion',
  });
  await assert.rejects(
    conversion.submit({ ...args, id: 'conversion', payload: 'signed intent' }),
    /Earlier relayer submission requires recovery/,
  );
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    1,
  );
  const recovered = new StoredSubmission(store.db, client, localWallet(), {
    chainId: config.chainId,
    kind: 'ordinary',
  });
  await recovered.submit({ ...args, id: 'ordinary' });
  const later = await conversion.submit({
    ...args,
    id: 'conversion',
    payload: 'signed intent',
  });
  assert.equal(later.job.nonce, 1);
  store.close();
});

test('saved but unbroadcast ordinary transaction blocks later conversion', async () => {
  const store = new Store(filename());
  const client = fakeClient();
  client.sendRawTransaction = async () => {
    throw new Error('transport failed before acceptance');
  };
  const ordinary = new StoredSubmission(store.db, client, localWallet(), {
    chainId: config.chainId,
    kind: 'ordinary',
  });
  const args = {
    bidHash: 'bid',
    askHash: 'ask',
    to: config.router,
    data: '0x1234',
    simulate: async () => {},
  };
  await assert.rejects(
    ordinary.submit({ ...args, id: 'ordinary' }),
    /transport failed/,
  );
  assert.ok(ordinary.get('ordinary').raw);
  const conversion = new StoredSubmission(store.db, client, localWallet(), {
    chainId: config.chainId,
    kind: 'conversion',
  });
  await assert.rejects(
    conversion.submit({ ...args, id: 'conversion', payload: 'intent' }),
    /not accepted by RPC/,
  );
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    1,
  );
  store.close();
});

async function pair() {
  const inventory = '0x7777777777777777777777777777777777777777';
  const make = (account, buy, price) => {
    const strategy = {
      maker: account.address,
      inventory,
      ids: ['1'],
      quantity: '1',
      buy,
      salt: ZERO_HASH,
      program: fixedProgram({
        usdc: config.usdc,
        inventory,
        price,
        expiry: 10000n,
        nonce: 1,
      }),
    };
    return { hash: hashStrategy(strategy), strategy };
  };
  const bid = make(buyer, true, 1100000n),
    ask = make(seller, false, 1000000n);
  return {
    bid,
    ask,
    book: { get: (hash) => [bid, ask].find((e) => e.hash === hash) },
  };
}

function fakeClient() {
  const client = {
    sent: [],
    receipts: new Map(),
    async getChainId() {
      return config.chainId;
    },
    async simulateContract() {
      return { result: 1_000_000n };
    },
    async getTransactionCount() {
      return this.sent.length;
    },
    async getTransactionReceipt({ hash }) {
      if (this.receipts.has(hash)) return this.receipts.get(hash);
      const error = new Error('Receipt not found');
      error.name = 'TransactionReceiptNotFoundError';
      throw error;
    },
    async sendRawTransaction({ serializedTransaction }) {
      this.sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
  };
  return client;
}

function localWallet() {
  return {
    account: relayer,
    chain: { id: config.chainId },
    failEstimate: false,
    failSign: false,
    async prepareTransactionRequest({ to, data, value }) {
      if (this.failEstimate) throw new Error('estimate failed');
      return {
        account: this.account,
        chain: this.chain,
        type: 'eip1559',
        chainId: config.chainId,
        to,
        data,
        value,
        gas: 500_000n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      };
    },
    async signTransaction(request) {
      if (this.failSign) throw new Error('signing failed');
      return this.account.signTransaction(request);
    },
  };
}

test('concurrent submissions of one pair persist and broadcast the same signed bytes', async () => {
  const store = new Store(filename());
  const { bid, ask, book } = await pair();
  const client = fakeClient();
  const matcher = new Matcher(store, book, client, localWallet(), config);
  const [first, second] = await Promise.all([
    matcher.submit(bid.hash, ask.hash),
    matcher.submit(bid.hash, ask.hash),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.state, 'broadcast');
  const jobs = store.db
    .prepare('SELECT nonce, raw, tx_hash FROM submissions')
    .all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].nonce, 0);
  assert.equal(jobs[0].tx_hash, first.transactionHash);
  assert.equal(new Set(client.sent).size, 1);
  assert.equal(client.sent[0], jobs[0].raw);
  store.close();
});

test('failed estimation leaves no reserved nonce', async () => {
  const store = new Store(filename());
  const { bid, ask, book } = await pair();
  const wallet = localWallet();
  wallet.failEstimate = true;
  const matcher = new Matcher(store, book, fakeClient(), wallet, config);
  await assert.rejects(matcher.submit(bid.hash, ask.hash), /estimate failed/);
  assert.equal(
    store.db.prepare('SELECT count(*) AS n FROM submissions').get().n,
    0,
  );
  store.close();
});

test('signing failure leaves durable unsigned bytes for recovery after restart', async () => {
  const path = filename();
  let store = new Store(path);
  const { bid, ask, book } = await pair();
  const client = fakeClient();
  const wallet = localWallet();
  wallet.failSign = true;
  const matcher = new Matcher(store, book, client, wallet, config);
  await assert.rejects(matcher.submit(bid.hash, ask.hash), /signing failed/);
  const before = store.db
    .prepare('SELECT nonce, unsigned, raw FROM submissions')
    .get();
  assert.equal(before.nonce, 0);
  assert.ok(before.unsigned);
  assert.equal(before.raw, null);
  store.close();

  store = new Store(path);
  const restarted = new Matcher(store, book, client, localWallet(), config);
  const [recovered] = await restarted.recover();
  assert.equal(recovered.state, 'broadcast');
  assert.ok(store.db.prepare('SELECT raw FROM submissions').get().raw);
  assert.equal(client.sent.length, 1);
  store.close();
});

test('a reverted receipt remains reverted through submission, status, and recovery', async () => {
  const store = new Store(filename());
  const { bid, ask, book } = await pair();
  const client = fakeClient();
  const matcher = new Matcher(store, book, client, localWallet(), config);
  const broadcast = await matcher.submit(bid.hash, ask.hash);
  client.receipts.set(broadcast.transactionHash, { status: 'reverted' });
  assert.equal((await matcher.submit(bid.hash, ask.hash)).state, 'reverted');
  assert.equal(
    (await matcher.status(broadcast.id, { status: async () => 'filled' }))
      .state,
    'reverted',
  );
  assert.equal((await matcher.recover())[0].state, 'reverted');
  assert.equal(client.sent.length, 1);
  store.close();
});
