import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { handleDayWeb } from '../../../../../backend/src/day-web.mjs';
vi.mock('../../../../../backend/src/day-web.mjs', () => ({
  handleDayWeb: vi.fn(async () => Response.json({ transactions: [] })),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('keeps a configured loopback origin exact despite Next URL normalization', async () => {
  vi.stubEnv('DAY_APP_ORIGIN', 'http://127.0.0.1:3001');
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ transactions: [] }));
  vi.stubGlobal('fetch', fetcher);
  const request = new NextRequest('http://127.0.0.1:3001/api/day/prepare', {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:3001',
      'content-type': 'application/json',
      'x-forwarded-host': 'attacker.test',
    },
    body: '{}',
  });
  expect(request.nextUrl.origin).toBe('http://localhost:3001');
  expect(
    (await POST(request, { params: Promise.resolve({ path: ['prepare'] }) }))
      .status,
  ).toBe(200);
  for (const origin of [
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'https://attacker.test',
  ]) {
    const rejected = await POST(
      new NextRequest('http://127.0.0.1:3001/api/day/prepare', {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-forwarded-host': new URL(origin).host,
        },
        body: '{}',
      }),
      { params: Promise.resolve({ path: ['prepare'] }) },
    );
    expect(rejected.status).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(handleDayWeb).toHaveBeenCalledTimes(1);
});

it('rejects malformed configured application origins before forwarding', async () => {
  vi.stubEnv('DAY_APP_ORIGIN', 'http://127.0.0.1:3000/path');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await POST(
    new NextRequest('http://127.0.0.1:3000/api/day/prepare', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
    { params: Promise.resolve({ path: ['prepare'] }) },
  );
  expect(result.status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});
