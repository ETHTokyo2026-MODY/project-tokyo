import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDayHandler } from '../src/day-server.mjs';
import { lazyDayWeb } from '../src/day-web.mjs';

test('Fetch transport serves config and indexing state without a listener', async () => {
  const handle = createDayHandler({
    config: { chainId: 11155111 },
    client: {},
    index: { sync: async () => {}, readiness: async () => ({ ready: false }) },
  });
  assert.equal(
    (await (await handle(new Request('http://local/config'))).json()).chainId,
    11155111,
  );
  assert.deepEqual(
    await (await handle(new Request('http://local/state'))).json(),
    { ready: false, indexing: true },
  );
  const response = await handle(
    new Request('http://local/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(65537),
    }),
  );
  assert.equal(response.status, 413);
});

test('concurrent requests share initialization; failed setup retries', async () => {
  let starts = 0;
  const handle = lazyDayWeb(async () => {
    if (++starts === 1) throw new Error('temporary RPC failure');
    return () => Response.json({ ready: true });
  });
  const first = await Promise.allSettled([handle(), handle()]);
  assert.ok(first.every((result) => result.status === 'rejected'));
  assert.equal(starts, 1);
  const responses = await Promise.all([handle(), handle()]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(starts, 2);
});
