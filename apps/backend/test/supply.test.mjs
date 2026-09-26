import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Store } from '../src/store.mjs';
import {
  SupplyBook,
  scheduleTypes,
  supplyDomain,
  serviceDay,
} from '../src/supply.mjs';
const supplier = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const config = {
  chainId: 31337,
  inventory: '0x1111111111111111111111111111111111111111',
};
const startDay = serviceDay('2030-03-08');
const schedule = {
  supplier: supplier.address,
  pool: `0x${'33'.repeat(32)}`,
  terms: `0x${'44'.repeat(32)}`,
  startDay,
  endDay: startDay + 7,
  weekdays: 127,
  target: 2,
};
const sign = (s) =>
  supplier.signTypedData({
    domain: supplyDomain(config),
    types: scheduleTypes,
    primaryType: 'Schedule',
    message: s,
  });
test('supplier authenticates immutable recurrence, calendar dates cross DST without losing nights', async () => {
  const store = new Store(':memory:');
  const block = {
    number: 1n,
    hash: `0x${'55'.repeat(32)}`,
    timestamp: BigInt((startDay - 1) * 86400),
  };
  const client = {
    verifyTypedData,
    getChainId: async () => config.chainId,
    getBlock: async () => block,
    readContract: async ({ functionName }) =>
      functionName === 'pools'
        ? [supplier.address, startDay, startDay + 90, 3]
        : 0n,
  };
  const book = new SupplyBook(store, client, config);
  const envelope = { schedule, signature: await sign(schedule) };
  const result = await book.publish(envelope);
  assert.equal(result.days.length, 7);
  assert.deepEqual(await book.publish(envelope), result);
  assert.equal(serviceDay('2030-03-11') - serviceDay('2030-03-09'), 2);
  assert.throws(() => serviceDay('2030-02-30'));
  await assert.rejects(
    book.publish({
      schedule: { ...schedule, target: 3 },
      signature: envelope.signature,
    }),
    /signature/,
  );
  const changed = { ...schedule, terms: `0x${'66'.repeat(32)}` };
  await assert.rejects(
    book.publish({ schedule: changed, signature: await sign(changed) }),
    /overlapping/,
  );
  assert.equal(
    store.db.prepare('SELECT count(*) AS n FROM supply_schedules').get().n,
    1,
  );
  const state = await book.reconcile(result.hash);
  assert.equal(state.slots.filter((x) => x.transaction).length, 7);
  client.readContract = async ({ functionName }) =>
    functionName === 'pools'
      ? [supplier.address, startDay, startDay + 90, 3]
      : functionName === 'consumedByToken'
        ? 1n
        : 2n;
  const consumed = await book.reconcile(result.hash);
  assert.equal(consumed.slots[0].outstanding, '1');
  assert.ok(consumed.slots.every((x) => x.transaction === null));
  client.getChainId = async () => 1;
  await assert.rejects(book.reconcile(result.hash), /chain mismatch/);
  await assert.rejects(book.publish(envelope), /chain mismatch/);
  store.close();
});

test('publication rejects an orphaned authorization snapshot without persisting capacity', async () => {
  const store = new Store(':memory:');
  let reads = 0;
  const client = {
    verifyTypedData,
    getChainId: async () => config.chainId,
    getBlock: async () => ({
      number: 1n,
      timestamp: BigInt((startDay - 1) * 86400),
      hash: ++reads === 1 ? '0xaaa' : '0xbbb',
    }),
    readContract: async ({ functionName }) =>
      functionName === 'pools'
        ? [supplier.address, startDay, startDay + 90, 3]
        : 0n,
  };
  const book = new SupplyBook(store, client, config);
  await assert.rejects(
    book.publish({ schedule, signature: await sign(schedule) }),
    /snapshot reorganized/,
  );
  assert.equal(
    store.db.prepare('SELECT count(*) AS n FROM supply_schedules').get().n,
    0,
  );
  store.close();
});

test('other terms cannot satisfy a schedule and orphaned supplier cannot block its replacement', async () => {
  const store = new Store(':memory:');
  const replacement = privateKeyToAccount(`0x${'55'.repeat(32)}`);
  let owner = supplier.address,
    total = 2n;
  const client = {
    verifyTypedData,
    getChainId: async () => config.chainId,
    getBlock: async () => ({
      number: 1n,
      hash: '0xaaa',
      timestamp: BigInt((startDay - 1) * 86400),
    }),
    readContract: async ({ functionName }) =>
      functionName === 'pools'
        ? [owner, startDay, startDay + 90, 3]
        : functionName === 'issued'
          ? total
          : 0n,
  };
  const book = new SupplyBook(store, client, config);
  const input = { schedule, signature: await sign(schedule) };
  await assert.rejects(
    book.publish(input),
    /capacity committed under other terms/,
  );
  total = 0n;
  const old = await book.publish(input);
  owner = replacement.address;
  await assert.rejects(book.reconcile(old.hash), /canonical pool/);
  await assert.rejects(book.publish(input), /unauthorized/);
  const next = { ...schedule, supplier: owner };
  const nextSig = await replacement.signTypedData({
    domain: supplyDomain(config),
    types: scheduleTypes,
    primaryType: 'Schedule',
    message: next,
  });
  const current = await book.publish({ schedule: next, signature: nextSig });
  assert.equal(
    store.db.prepare('SELECT count(*) AS n FROM supply_schedules').get().n,
    2,
  );
  assert.ok(
    store.db
      .prepare('SELECT hash FROM supply_days')
      .all()
      .every((row) => row.hash === current.hash),
  );
  assert.equal((await book.reconcile(current.hash)).slots[0].issued, '0');
  owner = supplier.address;
  assert.deepEqual(await book.publish(input), old);
  assert.ok(
    store.db
      .prepare('SELECT hash FROM supply_days')
      .all()
      .every((row) => row.hash === old.hash),
  );
  const conflicting = { ...schedule, terms: `0x${'99'.repeat(32)}` };
  await assert.rejects(
    book.publish({ schedule: conflicting, signature: await sign(conflicting) }),
    /overlapping/,
  );
  store.close();
});
