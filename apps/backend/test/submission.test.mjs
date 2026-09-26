import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { StoredSubmission, ensureSubmissions } from '../src/submission.mjs';

const directory = mkdtempSync(join(tmpdir(), 'day-submission-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const filename = () => join(directory, `${Math.random()}.db`);
const relayer = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const config = {
  chainId: 31337,
  router: '0x1111111111111111111111111111111111111111',
  usdc: '0x2222222222222222222222222222222222222222',
};

test('saved signed jobs cannot be retried with a different exact call', async () => {
  const store = new DatabaseSync(filename());
  try {
    const sender = new StoredSubmission(store, fakeClient(), localWallet(), {
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
  const store = new DatabaseSync(filename());
  try {
    store.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, bid_hash TEXT NOT NULL, ask_hash TEXT NOT NULL,
      sender TEXT NOT NULL, nonce INTEGER NOT NULL, unsigned TEXT,
      raw TEXT, tx_hash TEXT, UNIQUE(sender, nonce)
    )`);
    store
      .prepare(
        'INSERT INTO submissions(id,bid_hash,ask_hash,sender,nonce) VALUES(?,?,?,?,?)',
      )
      .run('old', 'bid', 'ask', relayer.address.toLowerCase(), 7);
    ensureSubmissions(store);
    ensureSubmissions(store);
    const old = store
      .prepare('SELECT nonce,kind,payload FROM submissions WHERE id = ?')
      .get('old');
    assert.equal(old.nonce, 7);
    assert.equal(old.kind, 'ordinary');
    assert.equal(old.payload, null);
    assert.throws(
      () =>
        store
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
  const store = new DatabaseSync(filename());
  const client = fakeClient();
  const badWallet = localWallet();
  badWallet.failSign = true;
  const ordinary = new StoredSubmission(store, client, badWallet, {
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
  const conversion = new StoredSubmission(store, client, localWallet(), {
    chainId: config.chainId,
    kind: 'conversion',
  });
  await assert.rejects(
    conversion.submit({ ...args, id: 'conversion', payload: 'signed intent' }),
    /Earlier relayer submission requires recovery/,
  );
  assert.equal(
    store.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    1,
  );
  const recovered = new StoredSubmission(store, client, localWallet(), {
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
  const store = new DatabaseSync(filename());
  const client = fakeClient();
  client.sendRawTransaction = async () => {
    throw new Error('transport failed before acceptance');
  };
  const ordinary = new StoredSubmission(store, client, localWallet(), {
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
  const conversion = new StoredSubmission(store, client, localWallet(), {
    chainId: config.chainId,
    kind: 'conversion',
  });
  await assert.rejects(
    conversion.submit({ ...args, id: 'conversion', payload: 'intent' }),
    /not accepted by RPC/,
  );
  assert.equal(
    store.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    1,
  );
  store.close();
});

test('estimation leaves no nonce while signing failure survives database restart', async () => {
  const path = filename();
  let db = new DatabaseSync(path);
  const client = fakeClient(),
    wallet = localWallet();
  const args = {
    id: 'restart',
    bidHash: 'bid',
    askHash: 'ask',
    to: config.router,
    data: '0x1234',
    simulate: async () => {},
  };
  try {
    const sender = new StoredSubmission(db, client, wallet, {
      chainId: config.chainId,
      kind: 'ordinary',
    });
    wallet.failEstimate = true;
    await assert.rejects(sender.submit(args), /estimate failed/);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM submissions').get().n,
      0,
    );
    wallet.failEstimate = false;
    wallet.failSign = true;
    await assert.rejects(sender.submit(args), /signing failed/);
    const saved = sender.get(args.id);
    assert.equal(saved.nonce, 0);
    assert.ok(saved.unsigned);
    assert.equal(saved.raw, null);
    db.close();
    db = new DatabaseSync(path);
    const recovered = new StoredSubmission(db, client, localWallet(), {
      chainId: config.chainId,
      kind: 'ordinary',
    });
    await recovered.submit(args);
    assert.equal(recovered.get(args.id).unsigned, saved.unsigned);
    assert.equal(recovered.get(args.id).nonce, saved.nonce);
    assert.ok(recovered.get(args.id).raw);
    assert.equal(client.sent.length, 1);
  } finally {
    db.close();
  }
});

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
