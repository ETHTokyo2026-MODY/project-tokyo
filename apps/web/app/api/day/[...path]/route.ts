import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Same-origin bridge; RPC credentials and the mock host adapter token stay server-side. */
async function forward(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const route = path.join('/');
  const allowed =
    request.method === 'GET'
      ? /^(config|state|curve|resolve|receipt\/0x[0-9a-fA-F]{64})$/.test(route)
      : /^(prepare|webhook)$/.test(route);
  if (!allowed) return Response.json({ error: 'Not found' }, { status: 404 });
  const base = process.env.DAY_BACKEND_URL;
  if (!base)
    return Response.json(
      { error: 'Live backend is not configured' },
      { status: 503 },
    );
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
    body = await request.text();
    if (new TextEncoder().encode(body).length > 65536)
      return Response.json({ error: 'Request too large' }, { status: 413 });
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
    const url = new URL(`/${route}`, base);
    url.search = request.nextUrl.search;
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
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
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
