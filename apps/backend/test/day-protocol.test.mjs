import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFunctionData,
  encodeAbiParameters,
  decodeEventLog,
  keccak256,
  toHex,
} from 'viem';
import {
  encodeDayStrategy,
  hashDayStrategy,
  decodeDayPublication,
  shipDayStrategy,
  officialAquaAbi,
  tokyoDay,
} from '../src/day-protocol.mjs';

const buyer = '0x0000000000000000000000000000000000000001';
const router = '0x0000000000000000000000000000000000000002';
const asset = '0x0000000000000000000000000000000000000003';
const aqua = '0x0000000000000000000000000000000000000004';
const usdc = '0x0000000000000000000000000000000000000005';
const salt = `0x${'00'.repeat(32)}`;
const bid = {
  buyer,
  chainId: 11155111n,
  app: router,
  asset,
  startDay: 20000,
  endDayExclusive: 20007,
  maxTotal: 500000000n,
  nonce: 1n,
  deadline: 1900000000,
  salt,
};
const scope = { chainId: 11155111, router };
const publication = (strategy = bid) => ({
  maker: buyer,
  app: router,
  strategyHash: hashDayStrategy('bid', strategy),
  strategy: encodeDayStrategy('bid', strategy),
});

test('Aqua publication roundtrip binds maker, chain, app and exact bytes', () => {
  assert.equal(decodeDayPublication(publication(), scope).kind, 'bid');
  for (const changed of [
    { ...publication(), maker: asset },
    { ...publication(), app: asset },
    publication({ ...bid, chainId: 1n }),
    publication({ ...bid, app: asset }),
    { ...publication(), strategyHash: salt },
    { ...publication(), strategy: `${publication().strategy}00` },
  ])
    assert.throws(() => decodeDayPublication(changed, scope));
});

test('official Shipped log has non-indexed arguments and is consumable', () => {
  const p = publication();
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'bytes32' },
      { type: 'bytes' },
    ],
    [p.maker, p.app, p.strategyHash, p.strategy],
  );
  const log = decodeEventLog({
    abi: officialAquaAbi,
    topics: [keccak256(toHex('Shipped(address,address,bytes32,bytes)'))],
    data,
  });
  assert.equal(decodeDayPublication(log.args, scope).hash, p.strategyHash);
});

test('buyer shipment publishes cap against one USDC token, with no escrow transfer', () => {
  const tx = shipDayStrategy({ aqua, kind: 'bid', strategy: bid, token: usdc });
  assert.equal(tx.to, aqua);
  const call = decodeFunctionData({ abi: officialAquaAbi, data: tx.data });
  assert.equal(call.functionName, 'ship');
  assert.deepEqual(call.args.slice(2), [[usdc], [bid.maxTotal]]);
});

test('single-day asks are distinguishable from bids', () => {
  const ask = {
    seller: buyer,
    chainId: bid.chainId,
    app: router,
    asset,
    day: 20000,
    saleNonce: 0n,
    discountVersion: 1n,
    salt,
  };
  const decoded = decodeDayPublication(
    {
      maker: buyer,
      app: router,
      strategy: encodeDayStrategy('ask', ask),
      strategyHash: hashDayStrategy('ask', ask),
    },
    scope,
  );
  assert.equal(decoded.kind, 'ask');
  assert.equal(decoded.strategy.day, 20000);
});

test('Tokyo identity switches at 15:00 UTC', () => {
  assert.equal(tokyoDay(86400n - 32400n - 1n), 0);
  assert.equal(tokyoDay(86400n - 32400n), 1);
});
