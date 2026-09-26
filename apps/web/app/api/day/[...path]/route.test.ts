import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const address = '0x1111111111111111111111111111111111111111';
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => ({
    getChainId: async () => 11155111,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals'
        ? 6
        : `0x${({ FACTORY: '1', AQUA: '2', USDC: '3' } as Record<string, string>)[functionName].repeat(40)}`,
    getBlock: async () => null,
    getLogs: async () => [],
    getBlockNumber: async () => BigInt(0),
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const context = (path: string) => ({
  params: Promise.resolve({ path: [path] }),
});
it('Next serves config and indexing state directly with no backend HTTP fetch', async () => {
  vi.stubEnv(
    'DAY_CONFIG_JSON',
    JSON.stringify({
      chainId: 11155111,
      startBlock: 1,
      factory: address,
      router: '0x' + '4'.repeat(40),
      aqua: '0x' + '2'.repeat(40),
      usdc: '0x' + '3'.repeat(40),
    }),
  );
  vi.stubEnv('DAY_RPC_URL', 'https://rpc.invalid');
  const fetch = vi.fn(() => {
    throw new Error('Unexpected HTTP proxy');
  });
  vi.stubGlobal('fetch', fetch);
  const config = await GET(
    new NextRequest('http://localhost/api/day/config'),
    context('config'),
  );
  expect(config.status).toBe(200);
  expect((await config.json()).factory).toBe(address);
  const state = await GET(
    new NextRequest('http://localhost/api/day/state'),
    context('state'),
  );
  expect(await state.json()).toMatchObject({ ready: false, indexing: true });
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects cross-origin preparation and leaves the signer disabled without explicit worker configuration', async () => {
  const post = (origin: string) =>
    new NextRequest('http://localhost/api/day/webhook', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{}',
    });
  expect(
    (await POST(post('https://evil.invalid'), context('webhook'))).status,
  ).toBe(403);
  expect(
    (await POST(post('http://localhost'), context('webhook'))).status,
  ).toBe(503);
});
