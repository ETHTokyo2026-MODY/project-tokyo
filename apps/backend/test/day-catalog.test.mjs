import test from 'node:test';
import assert from 'node:assert/strict';
import { readDayAsset } from '../src/day-catalog.mjs';

const asset = '0x0000000000000000000000000000000000000001';
const factory = '0x0000000000000000000000000000000000000002';
function fixture(reorg = false) {
  let blocks = 0;
  const calls = [];
  return {
    calls,
    client: {
      getBlockNumber: async () => 10n,
      getBlock: async () => ({
        hash: reorg && blocks++ ? '0xbb' : '0xaa',
        timestamp: 86400n,
      }),
      readContract: async (call) => {
        calls.push(call);
        const fields = {
          isAsset: true,
          host: asset,
          startDay: 100,
          endDayExclusive: 465,
          metadataURI: '',
          discountLadder: [],
          discountVersion: 1n,
        };
        if (call.functionName !== 'rangeState')
          return fields[call.functionName];
        return Array.from({ length: call.args[1] - call.args[0] }, () => ({
          owner: asset,
          deployed: false,
          listed: true,
        }));
      },
    },
  };
}
test('calendar reads are complete and pinned to one block', async () => {
  const f = fixture();
  const result = await readDayAsset(f.client, { factory, asset });
  assert.equal(result.days.length, 365);
  assert.equal(result.days[364].day, 464);
  assert.ok(f.calls.every((call) => call.blockNumber === 10n));
});
test('a reorg during calendar reads does not publish mixed data', async () => {
  const f = fixture(true);
  await assert.rejects(readDayAsset(f.client, { factory, asset }), /reorg/);
});
