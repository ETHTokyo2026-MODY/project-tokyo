import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('forwards optional ENS resolution through the same-origin read-only route', async () => {
  vi.stubEnv('DAY_BACKEND_URL', 'http://127.0.0.1:8787');
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ asset: 'canonical-asset', day: 20723 }));
  vi.stubGlobal('fetch', fetcher);
  const request = new NextRequest(
    'https://app.test/api/day/resolve?name=2026-09-27.car.example.eth',
  );
  const result = await GET(request, {
    params: Promise.resolve({ path: ['resolve'] }),
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ asset: 'canonical-asset', day: 20723 });
  expect(String(fetcher.mock.calls[0][0])).toBe(
    'http://127.0.0.1:8787/resolve?name=2026-09-27.car.example.eth',
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    headers: {},
    cache: 'no-store',
  });
});

it('preserves disabled ENS errors and rejects unlisted proxy paths', async () => {
  vi.stubEnv('DAY_BACKEND_URL', 'http://127.0.0.1:8787');
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { error: 'ENS discovery is not configured' },
        { status: 503 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const result = await GET(
    new NextRequest('https://app.test/api/day/resolve?name=car.example.eth'),
    { params: Promise.resolve({ path: ['resolve'] }) },
  );
  expect(result.status).toBe(503);
  const rejected = await GET(
    new NextRequest('https://app.test/api/day/resolve/other'),
    { params: Promise.resolve({ path: ['resolve', 'other'] }) },
  );
  expect(rejected.status).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
