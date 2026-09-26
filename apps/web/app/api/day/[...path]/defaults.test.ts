import { expect, it, vi } from 'vitest';
import deployment from '../../../../../../contracts/deployments/sepolia.json';
import { createDayWeb } from '../../../../../backend/src/day-web.mjs';

vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({
    getChainId: async () => deployment.chainId,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals'
        ? 6
        : deployment[functionName.toLowerCase() as 'factory' | 'aqua' | 'usdc'],
    getBlock: async () => null,
    getLogs: async () => [],
    getBlockNumber: async () => BigInt(0),
  }),
}));

it('uses the maintained Sepolia deployment without environment setup', async () => {
  const handle = await createDayWeb({});
  const response = await handle(new Request('https://site.invalid/config'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    chainId: deployment.chainId,
    factory: deployment.factory,
    router: deployment.router,
  });
});

it('invalid explicit overrides fail instead of silently switching deployment', async () => {
  await expect(createDayWeb({ DAY_CONFIG_JSON: '{broken' })).rejects.toThrow();
  await expect(createDayWeb({ DAY_RPC_URL: '' })).rejects.toThrow();
  await expect(
    createDayWeb({
      DAY_CONFIG_JSON: JSON.stringify({ ...deployment, chainId: 1 }),
    }),
  ).rejects.toThrow('A custom chain requires DAY_RPC_URL');
});
