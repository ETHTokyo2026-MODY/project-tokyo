import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StrategyWallet } from '../src/wallet.mjs';
import { config, envelope } from './native-fixture.mjs';

test('wallet chain and maker are checked before requesting a signature', async () => {
  const strategy = envelope().strategy;
  let signed = false;
  const wallet = {
    account: { address: strategy.maker },
    getChainId: async () => 1,
    sendTransaction: async () => {
      signed = true;
    },
  };
  const consumer = new StrategyWallet({}, wallet, config);
  await assert.rejects(consumer.ship(strategy), /Wallet chain mismatch/);
  wallet.getChainId = async () => config.chainId;
  wallet.chain = { id: 1 };
  await assert.rejects(consumer.dock(strategy), /Wallet chain mismatch/);
  wallet.account.address = config.router;
  await assert.rejects(consumer.ship(strategy), /not strategy maker/);
  assert.equal(signed, false);
});
