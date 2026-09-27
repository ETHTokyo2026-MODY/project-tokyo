import { listEnsAssets } from '@/lib/ens/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const includeTest = new URL(request.url).searchParams.get('test') === '1';
  try {
    const assets = await listEnsAssets(includeTest);
    return Response.json({ assets });
  } catch {
    return Response.json(
      { error: 'ENS listing is unavailable' },
      { status: 502 },
    );
  }
}
