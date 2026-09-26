import { createEnsAsset } from '@/lib/ens/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json(
      { error: 'Same-origin request required' },
      { status: 403 },
    );
  }
  let body: {
    label?: string;
    title?: string;
    kind?: string;
    location?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON required' }, { status: 415 });
  }
  const label = (body.label ?? '').trim().toLowerCase();
  const title = (body.title ?? '').trim();
  const kind = (body.kind ?? '').trim();
  const location = (body.location ?? '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    return Response.json({ error: 'Invalid ENS label' }, { status: 400 });
  }
  if (!title || !kind || !location) {
    return Response.json(
      { error: 'title, kind and location required' },
      { status: 400 },
    );
  }
  if (!process.env.PROJECTTOKYO_DEPLOYER_KEY?.trim()) {
    return Response.json(
      { error: 'PROJECTTOKYO_DEPLOYER_KEY is not set' },
      { status: 503 },
    );
  }
  try {
    const created = await createEnsAsset({ label, title, kind, location });
    return Response.json({
      ok: true,
      label,
      name: `${label}.projecttokyo.eth`,
      asset: created.asset,
      startDay: created.startDay,
      endDay: created.endDay,
      hashes: created.hashes,
      stoppedAt: created.stoppedAt ?? null,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'ENS create failed',
      },
      { status: 502 },
    );
  }
}
