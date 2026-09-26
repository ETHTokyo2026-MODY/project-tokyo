import assert from 'node:assert/strict';
import { test } from 'node:test';
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
