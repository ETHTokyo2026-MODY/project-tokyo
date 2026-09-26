import { priceFromCurve } from './curve';
import { calendarEnd } from './dates';
import { seedDaysFor } from './seed';
import type { DemoState } from './types';

/** Append freshly seeded days after each asset's last day, up to calendarEnd. */
export function extendCalendar(
  state: DemoState,
  today: string,
  now: string,
): boolean {
  void now;
  const end = calendarEnd(today);
  if (state.assets.every((a) => a.days.at(-1)!.date >= end)) return false;
  let added = 0;
  for (const a of state.assets) {
    const last = a.days.at(-1)!.date;
    if (last >= end) continue;
    const extra = seedDaysFor(a, today).filter((d) => d.date > last);
    a.days.push(...extra);
    added += extra.length;
  }
  return added > 0;
}

/** Pay the owner of each booked, unsettled day whose date is before today. */
export function settle(state: DemoState, today: string, now: string): boolean {
  let changed = false;
  for (const a of state.assets) {
    for (const d of a.days) {
      if (d.status !== 'booked' || d.settled || d.date >= today) continue;
      state.accounts[d.owner].cash += d.price;
      Object.assign(d, { settled: true, listed: false });
      d.history.push({ type: 'payout', to: d.owner, price: d.price, at: now });
      changed = true;
    }
  }
  return changed;
}

/** Once per new day, restart each future open curve at today. */
export function rollCurves(
  state: DemoState,
  today: string,
  now: string,
): boolean {
  void now;
  if (state.curveDay === today) return false;
  for (const a of state.assets) {
    for (const d of a.days) {
      if (d.date >= today && d.status !== 'booked' && d.curve) {
        priceFromCurve(d, today);
      }
    }
  }
  state.curveDay = today;
  return true;
}

/** Run extend, settle and roll; true if any of them changed the state. */
export function tick(state: DemoState, today: string, now: string): boolean {
  const extended = extendCalendar(state, today, now) ? 1 : 0;
  const settled = settle(state, today, now) ? 1 : 0;
  const rolled = rollCurves(state, today, now) ? 1 : 0;
  return !!(extended | settled | rolled);
}
