import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, zeroAddress, zeroHash } from 'viem';
import { prepareDayAction } from '../src/day-commands.mjs';
import {
  dayAssetAbi,
  dayFactoryAbi,
  dayRouterAbi,
  dayTokenAbi,
  officialAquaAbi,
  hashDayStrategy,
  decodeDayPublication,
} from '../src/day-protocol.mjs';

const addr = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const host = addr(1),
  buyer = addr(2),
  asset = addr(3);
const config = {
  chainId: 31337,
  factory: addr(4),
  router: addr(5),
  aqua: addr(6),
  usdc: addr(7),
};
const today = 20000;
const timestamp = BigInt(today * 86400 - 32400 + 100);
const combined = [
  ...dayAssetAbi,
  ...dayFactoryAbi,
  ...dayRouterAbi,
  ...dayTokenAbi,
  ...officialAquaAbi,
];
const decode = (plan) =>
  plan.transactions.map((tx) => {
    assert.equal(tx.value, '0x0');
    assert.deepEqual(Object.keys(tx).sort(), ['data', 'to', 'value']);
    return {
      to: tx.to,
      ...decodeFunctionData({ abi: combined, data: tx.data }),
    };
  });
const range = { asset, startDay: today + 1, endDayExclusive: today + 3 };
const bidBody = {
  ...range,
  maxTotal: '250000000',
  nonce: '5',
  deadline: String(timestamp + 3600n),
  salt: hash(9),
};
function fixture() {
  const data = {
    overrides: new Map(),
    allowances: new Map(),
    shipments: new Map(),
    used: new Set(),
    calls: [],
    chainId: config.chainId,
    recognized: true,
    existingAsset: zeroAddress,
    version: 9n,
    reorg: false,
  };
  const state = (d) => ({
    token: addr(d),
    owner: host,
    deployed: true,
    listed: true,
    saleNonce: 3n,
    booked: false,
    listedPrice: 80000000n,
    sellingPrice: 100000000n,
    ...data.overrides.get(d),
  });
  const client = {
    getChainId: async () => data.chainId,
    getBlock: async (request) => ({
      number: 10n,
      hash: hash(request && data.reorg ? 99 : 10),
      timestamp,
    }),
    readContract: async (request) => {
      const {
        address,
        abi,
        functionName: name,
        args = [],
        blockNumber,
      } = request;
      data.calls.push(request);
      assert.equal(blockNumber, 10n);
      assert.ok(
        abi.some((item) => item.name === name),
        `Missing ABI: ${name}`,
      );
      if (name === 'FACTORY') return data.factory ?? config.factory;
      if (name === 'AQUA') return config.aqua;
      if (name === 'USDC') return config.usdc;
      if (name === 'decimals') return 6;
      if (name === 'assets') return data.existingAsset;
      if (name === 'isAsset') return data.recognized;
      if (name === 'host') return host;
      if (name === 'startDay') return today;
      if (name === 'endDayExclusive') return today + 365;
      if (name === 'discountVersion') return data.version;
      if (name === 'rangeState')
        return Array.from({ length: args[1] - args[0] }, (_, i) =>
          state(args[0] + i),
        );
      if (name === 'curve')
        return [data.overrides.get(args[0])?.minimum ?? 1000000n, []];
      if (name === 'allowance')
        return data.allowances.get(address.toLowerCase()) ?? 0n;
      if (name === 'rawBalances') return data.shipments.get(args[2]) ?? [0n, 0];
      if (name === 'used') return data.used.has(args[1]);
      throw new Error(`Unexpected read ${name}`);
    },
  };
  return {
    data,
    client,
    plan: (action, body, actor = host) =>
      prepareDayAction(client, config, actor, action, body),
  };
}
const ask = (day) => ({
  seller: host,
  chainId: 31337n,
  app: config.router,
  asset,
  day,
  saleNonce: 3n,
  discountVersion: 9n,
  salt: zeroHash,
});

test('create asset preserves explicit defaults/salt and rejects reused host identity', async () => {
  const { plan, data } = fixture();
  const body = {
    salt: hash(8),
    metadataURI: 'ipfs://item',
    defaults: {
      minimum: '1000000',
      listedPrices: Array(7).fill('80000000'),
      sellingPrices: Array(7).fill('95000000'),
    },
    discounts: [{ minDays: 7, discountBps: 1500 }],
  };
  const [call] = decode(await plan('create-asset', body));
  assert.equal(call.functionName, 'createAsset');
  assert.equal(call.args[0], body.salt);
  assert.equal(call.args[2].minimum, 1000000n);
  assert.deepEqual(call.args[3], [{ minDays: 7, discountBps: 1500 }]);
  data.existingAsset = asset;
  await assert.rejects(plan('create-asset', body), /salt already/);
});

test('listing resumes partial materialization and authorization with exact current ask hashes', async () => {
  const { plan, data } = fixture();
  data.overrides.set(today + 1, { deployed: false });
  data.allowances.set(addr(today + 2), 1n);
  data.shipments.set(hashDayStrategy('ask', ask(today + 2)), [1n, 1]);
  const result = await plan('list', { ...range, sellingPrice: '123456789' });
  const calls = decode(result);
  assert.deepEqual(
    calls.map((c) => c.functionName),
    ['materialize', 'approve', 'ship', 'setListing'],
  );
  assert.deepEqual(calls[0].args, [today + 1]);
  assert.equal(calls[1].to.toLowerCase(), addr(today + 1));
  assert.deepEqual(calls[1].args, [config.aqua, 1n]);
  assert.deepEqual(calls[3].args, [today + 1, today + 3, true, 123456789n]);
  const published = decodeDayPublication(
    {
      maker: host,
      app: config.router,
      strategyHash: hashDayStrategy('ask', result.strategy[0]),
      strategy: calls[2].args[1],
    },
    config,
  );
  assert.equal(published.hash, hashDayStrategy('ask', ask(today + 1)));
  assert.equal(published.strategy.discountVersion, 9n);
  assert.equal(published.strategy.saleNonce, 3n);
  assert.equal(
    data.calls.filter((c) => c.functionName === 'allowance').length,
    1,
  );
});

test('unlisting preserves each distinct selling price while grouping equal adjacent days', async () => {
  const { plan, data } = fixture();
  data.overrides.set(today + 3, { sellingPrice: 200000001n });
  const calls = decode(
    await plan('unlist', { ...range, endDayExclusive: today + 4 }),
  );
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      [today + 1, today + 3, false, 100000000n],
      [today + 3, today + 4, false, 200000001n],
    ],
  );
});

test('price and curve actions enforce ownership, booking locks and per-day floors', async () => {
  const { plan, data } = fixture();
  assert.equal(
    decode(await plan('set-price', { ...range, listedPrice: '40000000' }))[0]
      .functionName,
    'setListedPrice',
  );
  data.overrides.set(today + 2, { minimum: 50000000n });
  await assert.rejects(
    plan('set-price', { ...range, listedPrice: '40000000' }),
    /minimum/,
  );
  data.overrides.set(today + 2, { booked: true });
  await assert.rejects(
    plan('set-price', { ...range, listedPrice: '60000000' }),
    /Booked/,
  );
  data.overrides.clear();
  const body = {
    asset,
    day: today + 2,
    minimum: '1000000',
    points: [
      { day: today, price: '60000000' },
      { day: today + 2, price: '1000000' },
    ],
  };
  assert.equal(decode(await plan('curve', body))[0].functionName, 'setCurve');
  await assert.rejects(
    plan('curve', { ...body, points: body.points.slice(1) }),
    /from today/,
  );
  await assert.rejects(plan('curve', body, buyer), /does not own/);
});

test('only host changes discounts or booking, even after ownership transfers', async () => {
  const { plan, data } = fixture();
  const steps = [
    { minDays: 2, discountBps: 10000 },
    { minDays: 365, discountBps: 0 },
  ];
  assert.equal(
    decode(await plan('discounts', { asset, discounts: steps }))[0]
      .functionName,
    'setDiscountLadder',
  );
  await assert.rejects(
    plan('discounts', { asset, discounts: steps }, buyer),
    /Only the host/,
  );
  await assert.rejects(
    plan('discounts', { asset, discounts: [...steps].reverse() }),
    /Invalid discount/,
  );
  data.overrides.set(today + 1, { owner: buyer });
  const body = { asset, day: today + 1, expectedListedPrice: '80000000' };
  assert.deepEqual(decode(await plan('book', body))[0].args, [
    today + 1,
    true,
    80000000n,
  ]);
  await assert.rejects(plan('book', body, buyer), /Only the host/);
  await assert.rejects(
    plan('book', { ...body, expectedListedPrice: '81000000' }),
    /expected current price/,
  );
  data.overrides.set(today + 1, { owner: buyer, booked: true });
  assert.deepEqual(decode(await plan('unbook', body))[0].args, [
    today + 1,
    false,
    80000000n,
  ]);
});

test('buyer publishes exact conditional USDC cap without escrow or seller readiness prerequisite', async () => {
  const { plan, data } = fixture();
  data.overrides.set(today + 1, { listed: false, deployed: false });
  const result = await plan('buy', bidBody, buyer),
    calls = decode(result);
  assert.deepEqual(
    calls.map((c) => c.functionName),
    ['approve', 'ship'],
  );
  assert.equal(calls[0].to, config.usdc);
  assert.deepEqual(calls[0].args, [config.aqua, 250000000n]);
  assert.deepEqual(calls[1].args.slice(2), [[config.usdc], [250000000n]]);
  assert.equal(result.strategy.maxTotal, '250000000');
  const published = decodeDayPublication(
    {
      maker: buyer,
      app: config.router,
      strategyHash: hashDayStrategy('bid', result.strategy),
      strategy: calls[1].args[1],
    },
    config,
  );
  assert.equal(published.strategy.nonce, 5n);
  assert.equal(published.strategy.buyer, buyer);
  data.shipments.set(published.hash, [250000000n, 1]);
  data.allowances.set(config.usdc, 250000000n);
  assert.deepEqual(
    (await plan('publish-bid', bidBody, buyer)).transactions,
    [],
  );
});

test('closed bid identities, expired deadlines, impersonation and docked asks fail before returning steps', async () => {
  const { plan, data } = fixture();
  data.used.add(5n);
  await assert.rejects(plan('buy', bidBody, buyer), /nonce is closed/);
  data.used.clear();
  await assert.rejects(
    plan('buy', { ...bidBody, deadline: String(timestamp - 1n) }, buyer),
    /deadline expired/,
  );
  await assert.rejects(
    plan('buy', { ...bidBody, buyer: host }, buyer),
    /wallet actor/,
  );
  await assert.rejects(plan('buy', bidBody, host), /already owns/);
  data.shipments.set(hashDayStrategy('ask', ask(today + 2)), [0n, 255]);
  await assert.rejects(
    plan('list', { ...range, sellingPrice: '1' }),
    /fresh salt/,
  );
  assert.equal(
    decode(
      await plan('list', { ...range, sellingPrice: '1', askSalt: hash(123) }),
    ).filter((c) => c.functionName === 'ship').length,
    2,
  );
  assert.equal(
    decode(await plan('cancel-bid', { nonce: '5' }, buyer))[0].functionName,
    'cancel',
  );
  data.used.add(5n);
  assert.deepEqual(
    (await plan('cancel-bid', { nonce: '5' }, buyer)).transactions,
    [],
  );
});

test('rejects unsafe numbers, arithmetic overflow, unknown assets and noncanonical configuration', async () => {
  const { plan, data } = fixture();
  for (const maxTotal of [
    Number.MAX_SAFE_INTEGER + 1,
    '1e6',
    '-1',
    '01',
    String(1n << 248n),
  ])
    await assert.rejects(plan('buy', { ...bidBody, maxTotal }, buyer));
  for (const changed of [
    { startDay: today - 1 },
    { endDayExclusive: today + 366 },
    { startDay: today + 3 },
    { startDay: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await assert.rejects(
      plan('list', { ...range, sellingPrice: '1', ...changed }),
    );
  data.overrides.set(today + 2, { owner: buyer });
  await assert.rejects(
    plan('list', { ...range, sellingPrice: '1' }),
    /does not own every/,
  );
  data.recognized = false;
  await assert.rejects(plan('unlist', range), /Unknown factory asset/);
  data.recognized = true;
  data.factory = addr(999);
  await assert.rejects(plan('unlist', range), /configuration/);
  data.factory = config.factory;
  data.chainId = 1;
  await assert.rejects(plan('unlist', range), /Wrong action chain/);
});

test('reorg rejects the plan and a full 365-day range has no smaller business cap', async () => {
  const { plan, data } = fixture();
  const full = { ...range, startDay: today, endDayExclusive: today + 365 };
  const result = await plan('unlist', full);
  assert.deepEqual(decode(result)[0].args, [
    today,
    today + 365,
    false,
    100000000n,
  ]);
  assert.equal(
    data.calls.filter((c) => c.functionName === 'rangeState').length,
    6,
  );
  data.reorg = true;
  await assert.rejects(plan('unlist', full), /reorg/);
});

test('only the host can authorize the configured booking reporter', async () => {
  const { client } = fixture();
  const cfg = { ...config, bookingReporter: addr(9) };
  const calls = decode(
    await prepareDayAction(client, cfg, host, 'authorize-reporter', { asset }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functionName, 'setBookingRelayer');
  assert.deepEqual(calls[0].args, [addr(9), true]);
  await assert.rejects(
    prepareDayAction(client, cfg, buyer, 'authorize-reporter', { asset }),
    /Only the host/,
  );
});
