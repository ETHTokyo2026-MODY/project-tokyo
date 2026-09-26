import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redemption } from '../src/redemption.mjs';
const address = `0x${'11'.repeat(20)}`;
const request = {
  holder: address,
  beneficiary: address,
  pool: `0x${'22'.repeat(32)}`,
  terms: `0x${'33'.repeat(32)}`,
  startDay: 30000,
  endDay: 30001,
  quantity: 1,
};
test('reservation refuses a signing wallet connected or configured for another chain before submitting', async () => {
  let writes = 0;
  const client = {
    getChainId: async () => 31337,
    simulateContract: async () => {
      throw new Error('must not simulate');
    },
    waitForTransactionReceipt() {},
    getBlock() {},
  };
  const wallet = {
    account: { address },
    getChainId: async () => 1,
    writeContract: async () => writes++,
  };
  const consumer = new Redemption(client, wallet, {
    chainId: 31337,
    inventory: address,
  });
  await assert.rejects(consumer.reserve(request), /Signing wallet chain/);
  wallet.getChainId = async () => 31337;
  wallet.chain = { id: 1 };
  await assert.rejects(consumer.reserve(request), /Signing wallet chain/);
  assert.equal(writes, 0);
});
