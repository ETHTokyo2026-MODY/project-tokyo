import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDayHandler } from '../src/day-server.mjs';
import {
  lazyDayWeb,
  boundedIndexSync,
  createDayWebHandler,
} from '../src/day-web.mjs';

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

test('cold reads yield while a single batch progresses and late RPC errors remain visible', async () => {
  let reject,
    calls = 0;
  const work = new Promise((resolve, fail) => {
    reject = fail;
  });
  const sync = boundedIndexSync(
    {
      sync: () => {
        calls++;
        return work;
      },
    },
    1,
  );
  assert.equal(await sync(), false);
  assert.equal(await sync(), false);
  assert.equal(calls, 1);
  reject(new Error('RPC unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(sync(), /RPC unavailable/);
});

test('a slow completed batch is consumed before another sync begins', async () => {
  let finish,
    calls = 0;
  const work = new Promise((resolve) => {
    finish = resolve;
  });
  const sync = boundedIndexSync(
    {
      sync: () => {
        calls++;
        return work;
      },
    },
    1,
  );
  assert.equal(await sync(), false);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await sync(), true);
  assert.equal(calls, 1);
});

test('public config needs no RPC and timed-out reads finish once across retries', async () => {
  let finish,
    calls = 0;
  const work = new Promise((resolve) => {
    finish = resolve;
  });
  const handle = createDayWebHandler(() => {
    calls++;
    return work;
  }, 1);
  assert.equal((await handle(new Request('https://local/config'))).status, 200);
  assert.equal(calls, 0);
  const request = () => new Request('https://local/state');
  assert.equal((await handle(request())).status, 503);
  assert.equal((await handle(request())).status, 503);
  assert.equal(calls, 1);
  finish(Response.json({ ready: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await (await handle(request())).json(), { ready: true });
  assert.equal(calls, 1);
});
