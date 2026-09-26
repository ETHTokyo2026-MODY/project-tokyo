import { tokyoDay } from '@/lib/ens/dates';
import { listEnsAssets } from '@/lib/ens/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const includeTest = new URL(request.url).searchParams.get('test') === '1';
  try {
    const assets = await listEnsAssets(includeTest);
    return Response.json({
      assets,
      ready: true,
      today: tokyoDay(Math.floor(Date.now() / 1000)),
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'ENS listing failed',
      },
      { status: 502 },
    );
  }
}
