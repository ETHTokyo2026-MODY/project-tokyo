import { describe, expect, it } from 'vitest';
import { sepolia } from 'viem/chains';
import { dayRpcUrl } from './rpc';

describe('dayRpcUrl', () => {
  it('falls back to viem Sepolia when DAY_RPC_URL is unset', () => {
    expect(dayRpcUrl({})).toBe(new URL(sepolia.rpcUrls.default.http[0]).href);
  });
  it('requires DAY_RPC_URL for a custom chain in DAY_CONFIG_JSON', () => {
    expect(() =>
      dayRpcUrl({ DAY_CONFIG_JSON: JSON.stringify({ chainId: 1 }) }),
    ).toThrow('A custom chain requires DAY_RPC_URL');
  });
});
