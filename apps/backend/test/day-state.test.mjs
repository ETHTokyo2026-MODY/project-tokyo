import assert from 'node:assert/strict';
import test from 'node:test';
import { createDayServer } from '../src/day-server.mjs';
const address = (n) => `0x${n.repeat(40)}`;
const hash = (n) => `0x${n.repeat(64)}`;
const config = {
  chainId: 11155111,
  factory: address('1'),
  router: address('2'),
  aqua: address('3'),
  usdc: address('4'),
};
async function state({
  rewind = false,
  missing = false,
  reorg = false,
  futureAsset = false,
} = {}) {
  let tip = { number: 10, hash: hash('a') },
    reads = 0;
  let futureDecodes = 0;
  const index = {
    reorgVersion: 0,
    sync: async () => {},
    readiness: async () => ({ ready: true, tip: { ...tip } }),
    tip: () => tip,
    block: (number) => {
      assert.equal(number, 10n);
      return missing ? null : { number: 10, hash: hash('a') };
    },
    events: (name) =>
      name === 'Shipped' && futureAsset
        ? [
            {
              address: config.aqua,
              blockNumber: 11,
              get args() {
                futureDecodes++;
                return {};
              },
            },
          ]
        : name === 'AssetCreated' && futureAsset
          ? [
              {
                address: config.factory,
                blockNumber: 11,
                args: { asset: address('9') },
              },
            ]
          : [],
  };
  const client = {
    getBlock: async ({ blockNumber }) => {
      assert.equal(blockNumber, 10n);
      reads++;
      // Simulate normal sync growth while the snapshot RPC is in flight.
      tip = { number: 11, hash: hash('b') };
      if (rewind) index.reorgVersion++;
      return {
        number: 10n,
        hash: reorg && reads > 1 ? hash('c') : hash('a'),
        timestamp: 1790450000n,
      };
    },
    readContract: async () => {
      throw Error('Future asset must not be read at the pinned snapshot');
    },
  };
  const server = createDayServer({ client, index, config });
  const response = await new Promise((resolve, reject) => {
    let status;
    server.emit(
      'request',
      { method: 'GET', url: '/state', headers: {} },
      {
        writeHead: (value) => {
          status = value;
        },
        end: (value) => resolve({ status, body: JSON.parse(value) }),
        destroy: reject,
      },
    );
  });
  await server.drain();
  assert.equal(
    futureDecodes,
    0,
    'Future publications must be filtered before decoding',
  );
  return response;
}

test('pinned canonical state survives forward index growth and excludes future assets', async () => {
  const response = await state({ futureAsset: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.ready, true);
  assert.equal(response.body.blockNumber, '10');
  assert.deepEqual(response.body.calendars, []);
});

test('state rejects removed ancestry, RPC reorg, and rewind followed by the same hash', async () => {
  for (const condition of [
    { missing: true },
    { reorg: true },
    { rewind: true },
  ]) {
    const response = await state(condition);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ready: false, indexing: true });
  }
});
