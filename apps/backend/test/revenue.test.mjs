import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import { RevenueClient, bookingStrategy } from '../src/revenue.mjs';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const REVENUE = '0x2222222222222222222222222222222222222222';
const AQUA = '0x3333333333333333333333333333333333333333';
const USDC = '0x4444444444444444444444444444444444444444';

test('booking strategy requires exact positive claim and payment', () => {
  const base = {
    buyer: ACCOUNT,
    app: REVENUE,
    token: USDC,
    claimId: 1,
    beneficiary: ACCOUNT,
    price: 10,
    expiry: 100,
    salt: `0x${'0'.repeat(64)}`,
  };
  assert.equal(bookingStrategy(base).mandate.price, 10n);
  assert.notEqual(
    bookingStrategy(base).hash,
    bookingStrategy({ ...base, beneficiary: REVENUE }).hash,
  );
  assert.throws(() => bookingStrategy({ ...base, price: 0 }));
  assert.throws(() => bookingStrategy({ ...base, claimId: 0 }));
});

test('revenue consumer rejects a wallet on a different chain before signing', async () => {
  let simulated = false;
  let submitted = false;
  const publicClient = {
    getChainId: async () => 31337,
    readContract: async () => {
      throw new Error('Unexpected deployment read');
    },
    simulateContract: async () => {
      simulated = true;
      throw new Error('Unexpected simulation');
    },
    waitForTransactionReceipt: async () => {},
    getBlock: async () => {},
    getTransaction: async () => {},
  };
  const walletClient = {
    account: { address: ACCOUNT },
    chain: { id: 1 },
    getChainId: async () => 1,
    writeContract: async () => {
      submitted = true;
      throw new Error('Unexpected submission');
    },
  };
  const client = new RevenueClient(publicClient, walletClient, {
    chainId: 31337,
    revenue: REVENUE,
    aqua: AQUA,
    usdc: USDC,
  });
  await assert.rejects(client.setPrice(1n, 10n), /Chain client differs/);
  assert.equal(simulated, false);
  assert.equal(submitted, false);
});

test('revenue consumer rejects mismatched deployed funding contracts', async () => {
  let simulated = false;
  const publicClient = {
    getChainId: async () => 31337,
    readContract: async ({ functionName }) =>
      functionName === 'aqua' ? AQUA : ACCOUNT,
    simulateContract: async () => {
      simulated = true;
      throw new Error('Unexpected simulation');
    },
    waitForTransactionReceipt: async () => {},
    getBlock: async () => {},
    getTransaction: async () => {},
  };
  const walletClient = {
    account: { address: ACCOUNT },
    chain: { id: 31337 },
    getChainId: async () => 31337,
    writeContract: async () => {},
  };
  const client = new RevenueClient(publicClient, walletClient, {
    chainId: 31337,
    revenue: REVENUE,
    aqua: AQUA,
    usdc: USDC,
  });
  await assert.rejects(client.setPrice(1n, 10n), /deployment differs/);
  assert.equal(simulated, false);
});

test('Aqua Shipped event cannot confirm a ship with empty token allowance', async () => {
  const hash = `0x${'a'.repeat(64)}`;
  const blockHash = `0x${'b'.repeat(64)}`;
  const strategy = bookingStrategy({
    buyer: ACCOUNT,
    app: REVENUE,
    token: USDC,
    claimId: 1n,
    beneficiary: ACCOUNT,
    price: 10n,
    expiry: 100n,
    salt: `0x${'0'.repeat(64)}`,
  });
  const aquaAbi = parseAbi([
    'function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32 strategyHash)',
    'event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)',
  ]);
  const shippedEvent = aquaAbi.find((item) => item.type === 'event');
  const log = {
    address: AQUA,
    topics: encodeEventTopics({ abi: aquaAbi, eventName: 'Shipped' }),
    data: encodeAbiParameters(shippedEvent.inputs, [
      ACCOUNT,
      REVENUE,
      strategy.hash,
      strategy.strategy,
    ]),
  };
  const publicClient = {
    getChainId: async () => 31337,
    readContract: async ({ functionName }) =>
      functionName === 'aqua' ? AQUA : USDC,
    simulateContract: async () => ({ request: {} }),
    waitForTransactionReceipt: async () => ({
      status: 'success',
      transactionHash: hash,
      blockHash,
      blockNumber: 1n,
      logs: [log],
    }),
    getBlock: async () => ({ hash: blockHash }),
    getTransaction: async () => ({
      hash,
      blockHash,
      blockNumber: 1n,
      to: AQUA,
      from: ACCOUNT,
      chainId: 31337,
      input: encodeFunctionData({
        abi: aquaAbi,
        functionName: 'ship',
        args: [REVENUE, strategy.strategy, [], []],
      }),
    }),
  };
  const walletClient = {
    account: { address: ACCOUNT },
    chain: { id: 31337 },
    getChainId: async () => 31337,
    writeContract: async () => hash,
  };
  const client = new RevenueClient(publicClient, walletClient, {
    chainId: 31337,
    revenue: REVENUE,
    aqua: AQUA,
    usdc: USDC,
  });
  await assert.rejects(
    client.shipBooking(strategy.mandate),
    /transaction call mismatched/,
  );
});
