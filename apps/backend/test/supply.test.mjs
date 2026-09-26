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
    functionName === 'issued' ? 2n : 1n;
  const consumed = await book.reconcile(result.hash);
  assert.equal(consumed.slots[0].outstanding, '1');
  assert.ok(consumed.slots.every((x) => x.transaction === null));
  store.close();
});
