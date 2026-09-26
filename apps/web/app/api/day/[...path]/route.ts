import { handleDayWeb } from '../../../../../backend/src/day-web.mjs';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read/prepare requests execute locally; only the durable booking signer is remote. */
async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const route = path.join('/');
  const allowed =
    request.method === 'GET'
      ? /^(config|state|curve|receipt\/0x[0-9a-fA-F]{64})$/.test(route)
      : /^(prepare|webhook)$/.test(route);
  if (!allowed) return Response.json({ error: 'Not found' }, { status: 404 });
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (request.method === 'POST') {
    // Next normalizes loopback IPs to localhost. Keep the configured public
    // origin exact; forwarded headers cannot authorize a different website.
    const appOrigin = process.env.DAY_APP_ORIGIN ?? request.nextUrl.origin;
    let validOrigin = false;
    try {
      const parsed = new URL(appOrigin);
      validOrigin =
        parsed.origin === appOrigin &&
        ['http:', 'https:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password;
    } catch {
      /* Invalid operator configuration fails closed. */
    }
    if (!validOrigin)
      return Response.json(
        { error: 'Invalid application origin configuration' },
        { status: 503 },
      );
    if (request.headers.get('origin') !== appOrigin)
      return Response.json(
        { error: 'Same-origin request required' },
        { status: 403 },
      );
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return Response.json({ error: 'JSON required' }, { status: 415 });
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    body = '';
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            return Response.json(
              { error: 'Request too large' },
              { status: 413 },
            );
          }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    headers['content-type'] = 'application/json';
    if (route === 'webhook') {
      if (!process.env.DAY_WEBHOOK_TOKEN)
        return Response.json(
          { error: 'Mock booking adapter disabled' },
          { status: 503 },
        );
      headers.authorization = `Bearer ${process.env.DAY_WEBHOOK_TOKEN}`;
    }
  }
  try {
    const url = new URL(`/${route}`, request.url);
    url.search = request.nextUrl.search;
    const init = {
      method: request.method,
      headers,
      body,
      cache: 'no-store' as const,
      signal: AbortSignal.timeout(60000),
    };
    let upstream: Response;
    if (route === 'webhook') {
      const worker = process.env.DAY_BOOKING_BACKEND_URL;
      if (!worker)
        return Response.json(
          { error: 'Mock booking adapter disabled' },
          { status: 503 },
        );
      upstream = await fetch(new URL('/webhook', worker), init);
    } else {
      upstream = await handleDayWeb(new Request(url, init));
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return Response.json(
      { error: 'Live backend is unavailable' },
      { status: 503 },
    );
  }
}

export const GET = handle;
export const POST = handle;
