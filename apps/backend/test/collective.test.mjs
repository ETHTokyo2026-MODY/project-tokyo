import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import {
  CollectiveBatch,
  guardProgram,
  parseCollectiveProgram,
} from '../src/collective.mjs';

const coordinator = '0x3333333333333333333333333333333333333333';
const relayer = '0x4444444444444444444444444444444444444444';
const router = '0x7777777777777777777777777777777777777777';
const campaign = `0x${'aa'.repeat(32)}`;
const priceProgram = `0x9e20${toHex(1_000_000n, { size: 32 }).slice(2)}540180`;
const program = guardProgram({
  coordinator,
  campaign,
  minParticipants: 2,
  minSpend: 2_000_000n,
  priceProgram,
});

function fixture(
  programs = [program, program],
  buyers = [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ],
) {
  const records = new Map();
  const pairs = programs.map((bytes, i) => {
    const common = {
      pool: `0x${'55'.repeat(32)}`,
      startDay: '40000',
      endDay: '40001',
      quantity: '1',
      terms: `0x${'66'.repeat(32)}`,
      programHash: keccak256(bytes),
    };
    const bidHash = toHex(2 * i + 1, { size: 32 });
    const askHash = toHex(2 * i + 2, { size: 32 });
    records.set(bidHash, {
      order: { ...common, buy: true, maker: buyers[i] },
      signature: '0x01',
      mandate: { buyer: buyers[i] },
      program: bytes,
    });
    records.set(askHash, {
      order: { ...common, buy: false, maker: relayer },
      signature: '0x02',
      program: bytes,
    });
    return [bidHash, askHash];
  });
  const client = {
    chain: { id: 31337 },
    getChainId: async () => 31337,
    readContract: async ({ functionName }) =>
      functionName === 'collective' ? coordinator : router,
    simulateContract: async (request) => ({
      request,
      result: [2_000_000n, 20_000n],
    }),
  };
  const batch = new CollectiveBatch(
    { get: (hash) => records.get(hash) },
    client,
    relayer,
    { chainId: 31337, router, collective: coordinator },
  );
  return { batch, pairs, client };
}

test('builds and simulates one common campaign from persisted orders', async () => {
  const { batch, pairs } = fixture();
  const parsed = parseCollectiveProgram(program);
  assert.equal(parsed.campaign, campaign);
  assert.equal(parsed.minParticipants, 2);
  assert.equal(parsed.minSpend, 2_000_000n);
  const { request, result } = await batch.simulate(pairs);
  assert.equal(request.address, coordinator);
  assert.equal(request.functionName, 'activate');
  assert.equal(request.args[0].length, 2);
  assert.equal(
    request.args[0][0].bid.maker,
    '0x1111111111111111111111111111111111111111',
  );
  assert.deepEqual(result, [2_000_000n, 20_000n]);
});

test('rejects duplicate wallets, mixed thresholds, too few fills and wrong chain', async () => {
  const duplicate = fixture(
    [program, program],
    [
      '0x1111111111111111111111111111111111111111',
      '0x1111111111111111111111111111111111111111',
    ],
  );
  assert.throws(
    () => duplicate.batch.build(duplicate.pairs),
    /Duplicate collective buyer/,
  );
  const altered = guardProgram({
    coordinator,
    campaign,
    minParticipants: 2,
    minSpend: 2_000_001n,
    priceProgram,
  });
  const mixed = fixture([program, altered]);
  assert.throws(
    () => mixed.batch.build(mixed.pairs),
    /Mixed collective campaigns/,
  );
  const ordinary = fixture([program, priceProgram]);
  assert.throws(
    () => ordinary.batch.build(ordinary.pairs),
    /Wrong collective coordinator/,
  );
  assert.throws(
    () => ordinary.batch.build([ordinary.pairs[0]]),
    /Invalid collective batch size/,
  );
  const wrongChain = fixture();
  wrongChain.client.getChainId = async () => 1;
  await assert.rejects(
    wrongChain.batch.simulate(wrongChain.pairs),
    /Wrong chain/,
  );
  const wrongDeployment = fixture();
  wrongDeployment.client.readContract = async () => relayer;
  await assert.rejects(
    wrongDeployment.batch.simulate(wrongDeployment.pairs),
    /Collective deployment mismatch/,
  );
});
