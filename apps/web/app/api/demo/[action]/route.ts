import { UserError } from '@/lib/demo/actions';
import {
  demoToday,
  dispatchDemoAction,
  readDemoState,
  resetDemoState,
} from '@/lib/demo/server-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStore = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function payload(state: ReturnType<typeof readDemoState>) {
  return { state, today: demoToday(), version: state.version };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  if (action !== 'state') {
    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: noStore },
    );
  }
  return Response.json(payload(readDemoState()), { headers: noStore });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  if (action === 'reset') {
    const state = resetDemoState();
    return Response.json({ ok: true, ...payload(state) }, { headers: noStore });
  }
  if (action !== 'action') {
    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: noStore },
    );
  }
  let body: { name?: string; body?: Record<string, unknown> };
  try {
    body = (await request.json()) as {
      name?: string;
      body?: Record<string, unknown>;
    };
  } catch {
    return Response.json(
      { ok: false, error: 'Invalid JSON' },
      { status: 400, headers: noStore },
    );
  }
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) {
    return Response.json(
      { ok: false, error: 'Missing action' },
      { status: 400, headers: noStore },
    );
  }
  try {
    const { state, out } = dispatchDemoAction(name, body.body ?? {});
    return Response.json(
      { ok: true, ...payload(state), ...out },
      { headers: noStore },
    );
  } catch (error) {
    const message =
      error instanceof UserError ? error.message : 'Action failed';
    return Response.json(
      { ok: false, error: message },
      { status: error instanceof UserError ? 400 : 500, headers: noStore },
    );
  }
}
