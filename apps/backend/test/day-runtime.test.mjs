import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadDayRuntimeOptions, startDayRuntime } from '../src/day-runtime.mjs';
import { createDayServer } from '../src/day-server.mjs';

const address = (n) => `0x${String(n).padStart(40, '0')}`;
const config = {
  chainId: 31337,
  startBlock: 1,
  factory: address(1),
  router: address(2),
  aqua: address(3),
  usdc: address(4),
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
class Server extends EventEmitter {
  listening = false;
  closes = 0;
  listen(port, host, done) {
    this.port = port;
    this.host = host;
    this.listening = true;
    queueMicrotask(done);
  }
  close(done) {
    this.closes++;
    this.listening = false;
    if (this.holdClose) this.finishClose = done;
    else queueMicrotask(done);
  }
}
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'day-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    config,
    databasePath: join(directory, 'state.sqlite'),
    intervalMs: 1,
    client: {
      getChainId: async () => 31337,
      readContract: async ({ functionName }) =>
        ({
          FACTORY: config.factory,
          AQUA: config.aqua,
          USDC: config.usdc,
          decimals: 6,
        })[functionName],
    },
  };
  const server = new Server();
  let db, indexOptions;
  class Index {
    constructor(database, client, input) {
      db = database;
      indexOptions = input;
    }
    async sync() {}
  }
  return {
    directory,
    options,
    server,
    Index,
    db: () => db,
    indexOptions: () => indexOptions,
    serverFactory: () => server,
  };
}

test('external configuration keeps signer credentials out of public config and defaults to read-only', (t) => {
  const { directory } = setup(t);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  const env = {
    DAY_CONFIG: path,
    DAY_DB: join(directory, 'state.sqlite'),
    DAY_RPC_URL: 'http://127.0.0.1:8545',
  };
  const options = loadDayRuntimeOptions(env);
  assert.equal(options.takerWallet, null);
  assert.equal(options.bookingWallet, null);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.config.confirmations, 2);
  const signed = loadDayRuntimeOptions({
    ...env,
    DAY_TAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  });
  assert.ok(signed.takerWallet.account.address);
  assert.equal(JSON.stringify(signed.config).includes('private'), false);
  assert.throws(
    () =>
      loadDayRuntimeOptions({
        ...env,
        DAY_BOOKING_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
      }),
    /requires its database/,
  );
  assert.throws(
    () => loadDayRuntimeOptions({ ...env, DAY_INTERVAL_MS: '1.5' }),
    /Invalid runtime/,
  );
  assert.equal(existsSync(options.databasePath), false);
});

test('read-only composition wires known event sources and closes private storage exactly once', async (t) => {
  const f = setup(t);
  const started = deferred();
  let cycles = 0;
  class Index extends f.Index {
    async sync() {
      if (++cycles === 2) started.resolve();
    }
  }
  const runtime = await startDayRuntime(f.options, {
    Index,
    serverFactory: f.serverFactory,
  });
  t.after(() => runtime.stop());
  await started.promise;
  assert.equal(runtime.taker, null);
  assert.equal(f.server.host, '127.0.0.1');
  assert.equal(f.server.port, 8787);
  assert.deepEqual(
    f.indexOptions().sources.map((source) => source.address),
    [config.factory, config.aqua, config.router],
  );
  assert.ok(
    f
      .indexOptions()
      .sources[1].events.some((event) => event.name === 'Shipped'),
  );
  assert.equal(statSync(f.options.databasePath).mode & 0o077, 0);
  await Promise.all([runtime.stop(), runtime.stop()]);
  assert.equal(f.server.closes, 1);
  assert.throws(() => f.db().prepare('SELECT 1'), /closed|not open/i);
});

test('slow taker cycles never overlap; shutdown drains both the cycle and active HTTP requests', async (t) => {
  const f = setup(t),
    pending = deferred();
  let calls = 0;
  class Taker {
    async tick() {
      calls++;
      await pending.promise;
    }
  }
  f.server.holdClose = true;
  const runtime = await startDayRuntime(
    { ...f.options, takerWallet: { account: { address: address(8) } } },
    { Index: f.Index, Taker, serverFactory: f.serverFactory },
  );
  t.after(() => runtime.stop());
  await new Promise((done) => setTimeout(done, 15));
  assert.equal(calls, 1);
  let stopped = false;
  const closing = runtime.stop().then(() => {
    stopped = true;
  });
  pending.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(stopped, false);
  assert.equal(f.db().prepare('SELECT 1 AS n').get().n, 1);
  f.server.finishClose();
  await closing;
  assert.equal(calls, 1);
  assert.throws(() => f.db().prepare('SELECT 1'), /closed|not open/i);
});

test('cycle failures are redacted and a later cycle can retry', async (t) => {
  const f = setup(t),
    retried = deferred(),
    messages = [];
  let calls = 0;
  class Taker {
    async tick() {
      if (++calls === 1)
        throw new Error('secret key and RPC credential payload');
      retried.resolve();
    }
  }
  const runtime = await startDayRuntime(
    { ...f.options, takerWallet: { account: { address: address(8) } } },
    {
      Index: f.Index,
      Taker,
      serverFactory: f.serverFactory,
      log: (line) => messages.push(line),
    },
  );
  t.after(() => runtime.stop());
  await retried.promise;
  await runtime.stop();
  assert.deepEqual(messages, [
    'Day backend cycle failed; saved transactions retained.',
  ]);
});

test('booking reporter gets a separate wallet/database and stops before admitting the next taker cycle', async (t) => {
  const f = setup(t),
    recovering = deferred();
  let reporterDb,
    passed,
    takerCalls = 0;
  class Reporter {
    constructor(db, client, wallet, scope) {
      reporterDb = db;
      assert.equal(wallet.account.address, address(9));
      assert.deepEqual(scope, {
        chainId: config.chainId,
        factory: config.factory,
      });
    }
    async recover() {
      await recovering.promise;
    }
  }
  class Taker {
    async tick() {
      takerCalls++;
    }
  }
  const options = {
    ...f.options,
    takerWallet: { account: { address: address(8) } },
    bookingWallet: { account: { address: address(9) } },
    bookingDatabasePath: join(f.directory, 'booking.sqlite'),
    webhookToken: 'private-webhook-token',
  };
  const runtime = await startDayRuntime(options, {
    Index: f.Index,
    Taker,
    BookingReporter: Reporter,
    serverFactory: (input) => {
      passed = input;
      return f.server;
    },
  });
  t.after(() => runtime.stop());
  assert.notEqual(reporterDb, f.db());
  assert.equal(passed.config.bookingReporter, address(9));
  assert.equal(passed.webhookToken, options.webhookToken);
  const closing = runtime.stop();
  recovering.resolve();
  await closing;
  assert.equal(takerCalls, 0);
  assert.throws(() => reporterDb.prepare('SELECT 1'), /closed|not open/i);
  await assert.rejects(
    startDayRuntime({ ...options, bookingDatabasePath: options.databasePath }),
    /separate wallet, database/,
  );
});

test('wrong chain, unsafe database location and failed listen cannot leave a running loop or database', async (t) => {
  const f = setup(t);
  await assert.rejects(
    startDayRuntime({ ...f.options, client: { getChainId: async () => 1 } }),
    /Wrong runtime chain/,
  );
  assert.equal(existsSync(f.options.databasePath), false);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  await assert.rejects(
    startDayRuntime({
      ...f.options,
      databasePath: join(root, 'runtime.sqlite'),
    }),
    /outside Git/,
  );
  chmodSync(f.directory, 0o755);
  await assert.rejects(startDayRuntime(f.options), /directory must be private/);
  chmodSync(f.directory, 0o700);
  f.server.listen = () =>
    queueMicrotask(() =>
      f.server.emit('error', new Error('listen unavailable')),
    );
  await assert.rejects(
    startDayRuntime(f.options, {
      Index: f.Index,
      serverFactory: f.serverFactory,
    }),
    /listen unavailable/,
  );
  assert.throws(() => f.db().prepare('SELECT 1'), /closed|not open/i);
});

test('HTTP drain tracks a handler after its client disconnects', async () => {
  const receipt = deferred();
  const blockHash = `0x${'ab'.repeat(32)}`;
  const server = createDayServer({
    config,
    client: {
      getTransactionReceipt: () => receipt.promise,
      getBlock: async () => ({ hash: blockHash }),
    },
  });
  const response = { destroyed: false, writeHead() {}, end() {}, destroy() {} };
  server.emit(
    'request',
    { method: 'GET', url: `/receipt/${blockHash}` },
    response,
  );
  response.destroyed = true;
  let drained = false;
  const done = server.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  receipt.resolve({ blockNumber: 1n, blockHash, status: 'success', logs: [] });
  await done;
  assert.equal(drained, true);
});
