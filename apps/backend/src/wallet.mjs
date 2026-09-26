import { encodeFunctionData, getAddress } from 'viem';
import {
  aquaAbi,
  assetsFor,
  erc20Abi,
  erc1155Abi,
  hashStrategy,
  normalizeStrategy,
  registration,
  verifyDeployment,
} from './protocol.mjs';

/** Unsigned requests can be sent by a wallet extension; the HTTP service never needs a signing key. */
export function approvalRequest(strategy, config, amount) {
  const s = normalizeStrategy(strategy, config.usdc);
  return s.buy
    ? {
        to: config.usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [config.aqua, BigInt(amount)],
        }),
      }
    : {
        to: s.inventory,
        data: encodeFunctionData({
          abi: erc1155Abi,
          functionName: 'setApprovalForAll',
          args: [config.aqua, true],
        }),
      };
}
export function cancellationRequest(strategy, config) {
  const s = normalizeStrategy(strategy, config.usdc);
  return {
    to: config.aqua,
    data: encodeFunctionData({
      abi: aquaAbi,
      functionName: 'dock',
      args: [config.router, hashStrategy(s), assetsFor(s, config.usdc)],
    }),
  };
}

/** Role-owned wallet client for approval, registration and cancellation; no custody or offchain order signature. */
export class StrategyWallet {
  constructor(client, wallet, config) {
    this.client = client;
    this.wallet = wallet;
    this.config = config;
  }
  async send(strategy, request) {
    const s = normalizeStrategy(strategy, this.config.usdc);
    if (getAddress(s.maker) !== getAddress(this.wallet.account.address))
      throw new Error('Wallet is not strategy maker');
    if (
      Number(await this.wallet.getChainId()) !== Number(this.config.chainId) ||
      (this.wallet.chain &&
        this.wallet.chain.id !== Number(this.config.chainId))
    )
      throw new Error('Wallet chain mismatch');
    await verifyDeployment(this.client, this.config);
    const hash = await this.wallet.sendTransaction({
      ...request,
      account: this.wallet.account,
      chain: this.wallet.chain,
    });
    const receipt = await this.client.waitForTransactionReceipt({
      hash,
      confirmations: this.config.confirmations ?? 1,
    });
    if (receipt.status !== 'success')
      throw new Error('Wallet transaction reverted');
    const [tx, block] = await Promise.all([
      this.client.getTransaction({ hash }),
      this.client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (
      tx.hash?.toLowerCase() !== hash.toLowerCase() ||
      tx.blockHash !== receipt.blockHash ||
      tx.blockNumber !== receipt.blockNumber ||
      block.hash !== receipt.blockHash ||
      getAddress(tx.from) !== getAddress(s.maker) ||
      getAddress(tx.to) !== getAddress(request.to) ||
      tx.input.toLowerCase() !== request.data.toLowerCase() ||
      Number(tx.chainId) !== Number(this.config.chainId)
    )
      throw new Error('Wallet receipt does not match request');
    return { hash, receipt };
  }
  approve(strategy, amount) {
    return this.send(strategy, approvalRequest(strategy, this.config, amount));
  }
  ship(strategy, budget) {
    return this.send(
      strategy,
      registration(strategy, this.config, budget).request,
    );
  }
  dock(strategy) {
    return this.send(strategy, cancellationRequest(strategy, this.config));
  }
}
