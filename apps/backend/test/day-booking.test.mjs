import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  parseTransaction,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DayBookingReporter } from '../src/day-booking.mjs';
import { dayAssetAbi } from '../src/day-protocol.mjs';

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const host = address(1),
  asset = address(2),
  factory = address(3);
const account = privateKeyToAccount(`0x${'34'.repeat(32)}`);
const input = {
  eventId: 'host-event-1',
  host,
  asset,
  day: 20000,
  booked: true,
  expectedListedPrice: '120000000',
};
const eventAbi = parseAbi([
  'event BookingChanged(uint32 indexed day,bool booked,uint128 listedPrice)',
]);

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const client = {
    host,
    recognized: true,
    authorized: true,
    state: { booked: false, listedPrice: 120000000n },
    receipts: new Map(),
    sent: [],
    simulations: 0,
    log: true,
    pending: false,
    async getChainId() {
      return 31337;
    },
    async getBlockNumber() {
      return 10n;
    },
    async getBlock({ blockNumber } = {}) {
      return {
        number: 10n,
        hash: blockNumber && this.reorg ? `0x${'ff'.repeat(32)}` : zeroHash,
        timestamp: 1728000000n,
      };
    },
    async readContract({ functionName }) {
      if (functionName === 'isAsset') return this.recognized;
      if (functionName === 'host') return this.host;
      if (functionName === 'startDay') return 20000;
      if (functionName === 'endDayExclusive') return 20365;
      if (functionName === 'bookingRelayers') return this.authorized;
      if (functionName === 'dayState') return this.state;
      throw new Error(`Unexpected read ${functionName}`);
    },
    async simulateContract() {
      this.simulations++;
      return {};
    },
    async getTransactionCount() {
      return this.receipts.size;
    },
    async getTransactionReceipt({ hash }) {
      if (this.receipts.has(hash)) return this.receipts.get(hash);
      const error = new Error('Not mined');
      error.name = 'TransactionReceiptNotFoundError';
      throw error;
    },
    async sendRawTransaction({ serializedTransaction }) {
      this.sent.push(serializedTransaction);
      if (this.failBroadcast) throw new Error('broadcast lost');
      const hash = keccak256(serializedTransaction);
      if (this.pending) return hash;
      const tx = parseTransaction(serializedTransaction);
      const [day, booked, expected] = decodeFunctionData({
        abi: dayAssetAbi,
        data: tx.data,
      }).args;
      const price = booked ? expected : 90000000n;
      this.state = { booked, listedPrice: price };
      this.receipts.set(hash, {
        transactionHash: hash,
        from: account.address,
        to: asset,
        blockNumber: 10n,
        blockHash: zeroHash,
        status: 'success',
        logs: this.log
          ? [
              {
                address: asset,
                topics: encodeEventTopics({
                  abi: eventAbi,
                  eventName: 'BookingChanged',
                  args: { day },
                }),
                data: encodeAbiParameters(
                  [{ type: 'bool' }, { type: 'uint128' }],
                  [booked, price],
                ),
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
    failSign: false,
    async prepareTransactionRequest({ to, data, value }) {
      return {
        to,
        data,
        value,
        chainId: 31337,
        type: 'eip1559',
        gas: 300000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      };
    },
    async signTransaction(request) {
      if (this.failSign) throw new Error('signer unavailable');
      this.signatures++;
      return account.signTransaction(request);
    },
  };
  const make = () =>
    new DayBookingReporter(db, client, wallet, {
      chainId: 31337,
      factory,
      maxRecovery: 2,
    });
  return { db, client, wallet, make };
}

test('trusted authorized reporter submits one exact booking and duplicate event reuses its hash', async (t) => {
  const f = setup(t),
    reporter = f.make();
  const first = await reporter.report(input);
  assert.match(first.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(f.client.state.booked, true);
  assert.deepEqual(await reporter.report(input), first);
  assert.equal(f.wallet.signatures, 1);
  assert.equal(f.client.sent.length, 1);
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM submissions').get().n,
    1,
  );
  await assert.rejects(
    reporter.report({ ...input, expectedListedPrice: '121000000' }),
    /Conflicting booking event ID/,
  );
});

test('validates canonical factory, actual host, reporter permission, live day and current price', async (t) => {
  const f = setup(t),
    reporter = f.make();
  f.client.recognized = false;
  await assert.rejects(reporter.report(input), /Unknown booking asset/);
  f.client.recognized = true;
  await assert.rejects(
    reporter.report({ ...input, host: address(7) }),
    /host does not own/,
  );
  f.client.authorized = false;
  await assert.rejects(reporter.report(input), /not authorized/);
  f.client.authorized = true;
  for (const day of [19999, 20365])
    await assert.rejects(reporter.report({ ...input, day }), /live calendar/);
  await assert.rejects(
    reporter.report({ ...input, expectedListedPrice: '119000000' }),
    /current price differs/,
  );
  f.client.state.booked = true;
  await assert.rejects(reporter.report(input), /status or expected/);
  assert.equal(f.wallet.signatures, 0);
});

test('the host wallet can report directly without relayer authorization', async (t) => {
  const f = setup(t);
  f.client.host = account.address;
  f.client.authorized = false;
  assert.ok((await f.make().report({ ...input, host: account.address })).hash);
});

test('rejects ambiguous payloads and block changes before signing', async (t) => {
  const f = setup(t),
    reporter = f.make();
  for (const changed of [
    { eventId: 12 },
    { eventId: '' },
    { booked: 'true' },
    { day: 20000.5 },
    { expectedListedPrice: '1e8' },
    { expectedListedPrice: -1 },
  ])
    await assert.rejects(reporter.report({ ...input, ...changed }));
  f.client.reorg = true;
  await assert.rejects(reporter.report(input), /changed during reorg/);
  assert.equal(f.wallet.signatures, 0);
  assert.equal(f.client.simulations, 0);
});

test('unbooking compares frozen expected price but accepts the resumed curve event price', async (t) => {
  const f = setup(t);
  f.client.state.booked = true;
  await f.make().report({ ...input, eventId: 'host-unbook-1', booked: false });
  assert.deepEqual(f.client.state, { booked: false, listedPrice: 90000000n });
});

test('unsigned recovery revalidates revoked authorization before any signature', async (t) => {
  const f = setup(t);
  f.wallet.failSign = true;
  await assert.rejects(f.make().report(input), /signer unavailable/);
  assert.equal(f.db.prepare('SELECT raw FROM submissions').get().raw, null);
  f.wallet.failSign = false;
  f.client.authorized = false;
  await assert.rejects(f.make().report(input), /not authorized/);
  assert.equal(f.wallet.signatures, 0);
  f.client.authorized = true;
  assert.ok((await f.make().report(input)).hash);
  assert.equal(f.wallet.signatures, 1);
});

test('broadcast recovery preserves raw bytes, nonce and event identity', async (t) => {
  const f = setup(t);
  f.client.failBroadcast = true;
  await assert.rejects(f.make().report(input), /broadcast lost/);
  const before = f.db.prepare('SELECT * FROM submissions').get();
  assert.ok(before.raw);
  f.client.failBroadcast = false;
  f.wallet.signTransaction = async () => {
    throw new Error('unexpected signature');
  };
  assert.deepEqual(await f.make().report(input), { hash: before.tx_hash });
  assert.deepEqual(f.client.sent, [before.raw, before.raw]);
  assert.deepEqual(f.db.prepare('SELECT * FROM submissions').get(), before);
});

test('pending prior submission prevents admission of another event', async (t) => {
  const f = setup(t);
  f.client.pending = true;
  const reporter = f.make(),
    first = await reporter.report(input);
  assert.ok(first.hash);
  await assert.rejects(
    reporter.report({ ...input, eventId: 'next' }),
    /requires recovery/,
  );
  assert.equal(f.wallet.signatures, 1);
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM submissions').get().n,
    1,
  );
  assert.equal((await reporter.recover()).complete, false);
});

test('canonical successful receipt must contain the expected booking effect', async (t) => {
  const f = setup(t);
  f.client.log = false;
  await assert.rejects(f.make().report(input), /expected booking event/);
  await assert.rejects(f.make().report(input), /expected booking event/);
  assert.equal(f.wallet.signatures, 1);
});

test('legacy pending jobs fail closed and consumed unsigned nonces require explicit recovery', async (t) => {
  const f = setup(t),
    reporter = f.make();
  f.db
    .prepare(
      `INSERT INTO submissions(id,bid_hash,ask_hash,sender,nonce,unsigned) VALUES('old','bid','ask',?,0,'{}')`,
    )
    .run(account.address.toLowerCase());
  await assert.rejects(reporter.recover(), /Unsupported saved booking/);
  f.client.getTransactionCount = async () => 1;
  await assert.rejects(reporter.recover(), /consumed outside/);
  assert.equal(f.wallet.signatures, 0);
});
