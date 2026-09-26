import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer, verifyDeployment } from '../src/server.mjs';
import { DiscoveryInputError, DiscoveryNotFound } from '../src/discovery.mjs';
import { SupplyInputError } from '../src/supply.mjs';
import { OrderInputError } from '../src/orders.mjs';

const hash = `0x${'ab'.repeat(32)}`;
const order = {
  hash,
  strategy: {
    maker: '0x1111111111111111111111111111111111111111',
    nonce: '1',
    group: `0x${'0'.repeat(64)}`,
  },
};
const records = new Map();
const book = {
  async submit(value) {
    if (value.reject) throw new OrderInputError('private validation detail');
    if (value.rpcError) throw new Error('RPC secret');
    records.set(hash, order);
    return order;
  },
  get(value) {
    return records.get(value.toLowerCase());
  },
  list({ limit, offset }) {
    return [...records.values()].slice(offset, offset + limit);
  },
};
let status = 'open';
const index = {
  tip: () => ({ number: 42 }),
  async status(value) {
    assert.equal(value.hash, hash);
    if (status === 'error') throw new Error('RPC secret');
    return status;
  },
};
const supply = {
  publish: async ({ invalid }) => {
    if (invalid) throw new SupplyInputError('private detail');
    throw new Error('RPC credential');
  },
};
let marketFails = false;
const market = {
  async quotes(page) {
    if (marketFails) throw new Error('RPC secret');
    return { page, quotes: [] };
  },
  async history(page) {
    return { page, sales: [] };
  },
};
const discovery = {
  async resolve(name) {
    if (name === 'invalid') throw new DiscoveryInputError('private detail');
    if (name === 'unknown') throw new DiscoveryNotFound('private detail');
    if (name === 'rpc') throw new Error('RPC credential');
    return { name, pool: hash };
  },
};
const server = createServer({ book, index, market, supply, discovery });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (path, options) => {
  const response = await fetch(`${base}${path}`, options);
  return { code: response.status, body: await response.json() };
};

test('bounded intake, pagination, indexed detail and health', async () => {
  assert.deepEqual((await request('/health')).body, {
    cursor: 42,
    stale: true,
    lastSyncAt: null,
  });
  server.reportIndexSync();
  assert.equal((await request('/health')).body.stale, false);
  const lastSyncAt = (await request('/health')).body.lastSyncAt;
  const realNow = Date.now;
  try {
    Date.now = () => lastSyncAt + 30_001;
    assert.equal((await request('/health')).body.stale, true);
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    (await request('/orders', { method: 'POST', body: JSON.stringify({}) }))
      .code,
    201,
  );
  assert.deepEqual((await request('/orders?limit=1&offset=0')).body.orders, [
    order,
  ]);
  assert.deepEqual((await request('/orders?limit=1&offset=1')).body.orders, []);
  assert.equal((await request('/orders?limit=1001')).code, 400);
  assert.equal((await request(`/orders/${hash}`)).body.status, 'open');
  assert.equal((await request(`/orders/${'0x' + 'cc'.repeat(32)}`)).code, 404);
  server.reportIndexSync(new Error('RPC down'));
  assert.equal((await request('/health')).body.stale, true);
});

test('market read API bounds pages and surfaces unavailable chain state', async () => {
  assert.deepEqual((await request('/market/quotes?limit=2&offset=3')).body, {
    page: { limit: 2, offset: 3 },
    quotes: [],
  });
  assert.equal((await request('/market/quotes?limit=21')).code, 400);
  assert.equal((await request('/market/quotes?offset=1001')).code, 400);
  assert.equal((await request('/market/history?offset=-1')).code, 400);
  assert.deepEqual((await request('/market/history')).body.sales, []);
  marketFails = true;
  try {
    assert.deepEqual(await request('/market/quotes'), {
      code: 503,
      body: { error: 'market state unavailable' },
    });
  } finally {
    marketFails = false;
  }
});

test('inventory discovery exposes concrete pools with bounded sanitized errors', async () => {
  assert.deepEqual(await request('/inventory/resolve?name=room.rental.eth'), {
    code: 200,
    body: { name: 'room.rental.eth', pool: hash },
  });
  assert.equal((await request('/inventory/resolve')).code, 400);
  assert.equal((await request('/inventory/resolve?name=a&name=b')).code, 400);
  assert.equal((await request('/inventory/resolve?name=a&other=1')).code, 400);
  assert.deepEqual(await request('/inventory/resolve?name=invalid'), {
    code: 400,
    body: { error: 'invalid pool name' },
  });
  assert.deepEqual(await request('/inventory/resolve?name=unknown'), {
    code: 404,
    body: { error: 'pool name not found' },
  });
  assert.deepEqual(await request('/inventory/resolve?name=rpc'), {
    code: 503,
    body: { error: 'pool discovery unavailable' },
  });
});

test('startup verifies RPC chain and deployed router USDC', async () => {
  const config = {
    chainId: 11155111,
    router: '0x1111111111111111111111111111111111111111',
    usdc: '0x2222222222222222222222222222222222222222',
    aqua: '0x3333333333333333333333333333333333333333',
  };
  const client = {
    getChainId: async () => 11155111,
    readContract: async ({ functionName }) => {
      return functionName === 'AQUA' ? config.aqua : config.usdc;
    },
  };
  await verifyDeployment(client, config);
  await assert.rejects(
    verifyDeployment({ ...client, getChainId: async () => 1 }, config),
    /Wrong chain/,
  );
  await assert.rejects(
    verifyDeployment(
      { ...client, readContract: async () => config.router },
      config,
    ),
    /deployment mismatch/,
  );
  await assert.rejects(
    verifyDeployment(
      {
        ...client,
        readContract: async () => {
          throw new Error('no deployed code');
        },
      },
      config,
    ),
    /no deployed code/,
  );
});

test('sanitized validation and RPC failures, malformed and oversized JSON', async () => {
  assert.deepEqual(
    await request('/orders', {
      method: 'POST',
      body: JSON.stringify({ reject: true }),
    }),
    { code: 400, body: { error: 'invalid order' } },
  );
  assert.deepEqual(
    await request('/orders', {
      method: 'POST',
      body: JSON.stringify({ rpcError: true }),
    }),
    { code: 503, body: { error: 'order verification unavailable' } },
  );
  assert.equal(
    (await request('/orders', { method: 'POST', body: '{' })).code,
    400,
  );
  assert.equal(
    (await request('/orders', { method: 'POST', body: ' '.repeat(65_537) }))
      .code,
    413,
  );
  status = 'error';
  assert.deepEqual(await request(`/orders/${hash}`), {
    code: 503,
    body: { error: 'chain status unavailable' },
  });
});

test('supply intake distinguishes invalid intent from verification outages', async () => {
  assert.equal(
    (
      await request('/supply', {
        method: 'POST',
        body: JSON.stringify({ invalid: true }),
      })
    ).code,
    400,
  );
  assert.deepEqual(await request('/supply', { method: 'POST', body: '{}' }), {
    code: 503,
    body: { error: 'supply verification unavailable' },
  });
});
