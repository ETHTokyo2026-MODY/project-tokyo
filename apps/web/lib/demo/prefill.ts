import { applyAction, type ActionCtx } from './actions';
import { writeMode } from './mode';
import { emptyState } from './seed';
import type { DemoState } from './types';

export const PREFILL_TITLE = '2022 Toyota Prius';
export const PREFILL_LOCATION = 'Shibuya, Tokyo';
export const PREFILL_DATES = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
] as const;

function run(
  state: DemoState,
  name: string,
  body: Record<string, unknown>,
  ctx: ActionCtx,
): DemoState {
  return applyAction(state, name, body, ctx).state;
}

/** Wipe to Simulated start balances, then replay the live-demo car trades. */
export function buildPrefillState(today: string, now: string): DemoState {
  const ctx: ActionCtx = { today, now };
  let state = emptyState(today);

  const created = applyAction(
    state,
    'create-asset',
    {
      account: 'host',
      type: 'car',
      title: PREFILL_TITLE,
      location: PREFILL_LOCATION,
      prices: { monWed: 100, thuSat: 100, sun: 100 },
      min: 40,
      sellingPrice: 60,
    },
    ctx,
  );
  state = created.state;
  const asset = String(created.out.asset ?? '');
  const days = state.assets[0]?.days ?? [];
  const last = days[days.length - 1]?.date;
  if (!asset || !last) {
    throw new Error('Prefill could not create the demo car');
  }
  for (const date of PREFILL_DATES) {
    if (!days.some((d) => d.date === date)) {
      throw new Error(`Prefill needs ${date} in the 365-day horizon`);
    }
  }

  // create-asset lists every future host day at $100, for sale at $60.
  state = run(
    state,
    'buy',
    { account: 'traderA', asset, date: PREFILL_DATES[1] },
    ctx,
  );
  state = run(
    state,
    'buy',
    { account: 'traderA', asset, date: PREFILL_DATES[2] },
    ctx,
  );
  state = run(
    state,
    'list',
    {
      account: 'traderA',
      asset,
      date: PREFILL_DATES[1],
      to: PREFILL_DATES[2],
      price: 62,
    },
    ctx,
  );

  state = run(
    state,
    'buy',
    { account: 'traderB', asset, date: PREFILL_DATES[2] },
    ctx,
  );
  state = run(
    state,
    'list',
    { account: 'traderB', asset, date: PREFILL_DATES[2], price: 65 },
    ctx,
  );

  return writeMode(state, 'simulated');
}
