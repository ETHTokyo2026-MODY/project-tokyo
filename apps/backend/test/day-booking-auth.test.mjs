import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { bookingMessage } from '../src/day-booking-auth.mjs';
import { createDayServer } from '../src/day-server.mjs';

const host = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const address = (value) => `0x${value.repeat(40)}`;
const config = { chainId: 31337, factory: address('a') };
const input = {
  host: host.address,
  asset: address('b'),
  eventId: 'host-booking:1',
  day: 20000,
  booked: true,
  expectedListedPrice: '80000000',
};
const sign = (body = input, domain = config, account = host) =>
  account.signMessage({ message: bookingMessage({ ...body, ...domain }) });

function setup() {
  const reports = [];
  const server = createDayServer({
    config,
    webhookToken: 'test-adapter',
    bookingReporter: {
      async report(body) {
        reports.push(body);
        return { hash: `0x${'ab'.repeat(32)}` };
      },
    },
  });
  return {
    reports,
    async post(body, token = 'test-adapter', chunks) {
      const request = Readable.from(chunks ?? [JSON.stringify(body)], {
        objectMode: false,
      });
      Object.assign(request, {
        method: 'POST',
        url: '/webhook',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      });
      let status;
      const response = await new Promise((resolve, reject) => {
        server.emit('request', request, {
          writeHead(value) {
            status = value;
          },
          end(value) {
            resolve({ status, body: JSON.parse(value) });
          },
          destroy: reject,
        });
      });
      await server.drain();
      return response;
    },
  };
}

test('booking plaintext fixes field order, decimal units and lowercase addresses', () => {
  assert.equal(
    bookingMessage({ ...input, ...config }),
    [
      'ProjectTokyo booking v1',
      'chainId:31337',
      `factory:${config.factory}`,
      `host:${host.address.toLowerCase()}`,
      `asset:${input.asset}`,
      'eventId:host-booking:1',
      'day:20000',
      'booked:true',
      'expectedListedPrice:80000000',
    ].join('\n'),
  );
  assert.equal(
    bookingMessage({ ...input, ...config, day: '20000', chainId: 31337n }),
    bookingMessage({ ...input, ...config }),
  );
});

test('booking plaintext rejects ambiguous or lossy values and newline injection', () => {
  for (const change of [
    { day: 2 ** 32 },
    { chainId: 0 },
    { day: -1 },
    { expectedListedPrice: Number.MAX_SAFE_INTEGER + 1 },
    { expectedListedPrice: '080000000' },
    { expectedListedPrice: (1n << 128n).toString() },
    { booked: 'false' },
    { eventId: 'id\nbooked:false' },
    { asset: address('0') },
  ])
    assert.throws(() => bookingMessage({ ...input, ...config, ...change }));
});

test('signed host requests reach reporter and retries retain the exact event', async () => {
  const f = setup();
  const body = { ...input, signature: await sign() };
  assert.equal((await f.post(body)).status, 200);
  assert.equal((await f.post(body)).status, 200);
  assert.deepEqual(f.reports, [body, body]);
});

test('bearer token alone, another wallet and malformed signatures cannot book', async () => {
  const f = setup();
  for (const signature of [
    undefined,
    '0x1234',
    await sign(input, config, stranger),
  ]) {
    assert.equal((await f.post({ ...input, signature })).status, 401);
  }
  assert.equal(
    (await f.post({ ...input, signature: await sign() }, 'wrong-token')).status,
    401,
  );
  assert.equal(f.reports.length, 0);
});

test('signature binds every operation field and the configured deployment', async () => {
  const f = setup();
  const signature = await sign();
  for (const change of [
    { host: stranger.address },
    { asset: address('c') },
    { eventId: 'host-booking:2' },
    { day: input.day + 1 },
    { booked: false },
    { expectedListedPrice: '80000001' },
  ])
    assert.equal(
      (await f.post({ ...input, ...change, signature })).status,
      401,
    );
  for (const domain of [
    { ...config, chainId: 1 },
    { ...config, factory: address('c') },
  ]) {
    // Supplying the signer's chosen domain cannot override server configuration.
    assert.equal(
      (
        await f.post({
          ...input,
          ...domain,
          signature: await sign(input, domain),
        })
      ).status,
      401,
    );
  }
  assert.equal(f.reports.length, 0);
});

test('HTTP JSON decoding preserves multibyte metadata across network chunks', async () => {
  const app = setup();
  const body = {
    ...input,
    metadataURI: 'https://example.test/東京',
    signature: await sign(),
  };
  const bytes = Buffer.from(JSON.stringify(body));
  const cut = bytes.indexOf(Buffer.from('東')) + 1;
  const result = await app.post(body, 'test-adapter', [
    bytes.subarray(0, cut),
    bytes.subarray(cut),
  ]);
  assert.equal(result.status, 200);
  assert.equal(app.reports[0].metadataURI, body.metadataURI);
});
