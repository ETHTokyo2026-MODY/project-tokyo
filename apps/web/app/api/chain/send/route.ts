import { createPublicClient, defineChain, http } from 'viem';
import { sepolia } from 'viem/chains';
import { dayWebConfig } from '../../../../../backend/src/day-web.mjs';
import { sameOrigin } from '@/lib/chain/origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rpcUrl() {
  const config = dayWebConfig();
  return (
    process.env.DAY_RPC_URL ??
    (config.chainId === sepolia.id
      ? (sepolia.rpcUrls.default.http[0] as string)
      : null)
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return Response.json(
      { error: 'Same-origin request required' },
      { status: 403 },
    );
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'JSON required' }, { status: 415 });
  }
  let body: { raw?: unknown };
  try {
    body = (await request.json()) as { raw?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (
    typeof body.raw !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(body.raw)
  ) {
    return Response.json({ error: 'Invalid raw transaction' }, { status: 400 });
  }
  const url = rpcUrl();
  if (!url) {
    return Response.json({ error: 'RPC is not configured' }, { status: 503 });
  }
  const config = dayWebConfig();
  const client = createPublicClient({
    chain: defineChain({
      id: config.chainId,
      name: 'DayTrader chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    }),
    transport: http(url, { timeout: 20_000, retryCount: 1 }),
  });
  try {
    const hash = await client.sendRawTransaction({
      serializedTransaction: body.raw as `0x${string}`,
    });
    return Response.json({ hash });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Broadcast failed',
      },
      { status: 502 },
    );
  }
}
