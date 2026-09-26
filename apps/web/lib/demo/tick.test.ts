import { describe, expect, it } from 'vitest';
import { applyAction, assetById, UserError } from './actions';
import { addDays, dayNum } from './dates';
import { seedState } from './seed';
import { tick } from './tick';
import type { DemoState } from './types';

const TODAY = '2026-09-26';
const NOW = '2026-09-26T00:00:00.000Z';

function tesla(state: DemoState) {
  return assetById(state)!;
}

function dayOf(state: DemoState, date: string) {
  return tesla(state).days.find((d) => d.date === date)!;
}

function act(
  state: DemoState,
  name: string,
  body: Record<string, unknown>,
  today = TODAY,
  now = NOW,
) {
  return applyAction(state, name, body, { today, now }).state;
}

function runTick(state: DemoState, today: string, now = NOW) {
  const next = structuredClone(state);
  const changed = tick(next, today, now);
  return { state: next, changed };
}

describe('tick', () => {
  it('settles a booked day once, rolls curves, and extends the calendar', () => {
    let state = seedState(TODAY);
    const future = tesla(state).days.filter((d) => d.date >= TODAY);
    const bought = future[2].date;
    const seededBooked = future.find((d) => d.status === 'booked')!.date;
    const lastBooked = future.filter((d) => d.status === 'booked').at(-1)!.date;
    const far = future[40].date;
    const oldCurve = structuredClone(dayOf(state, far).curve!);

    state = act(state, 'buy', { account: 'traderA', date: bought });
    const aCash = state.accounts.traderA.cash;
    const bookedPrice = dayOf(state, bought).price;
    state = act(state, 'book', { account: 'traderA', date: bought });
    expect(state.accounts.traderA.cash).toBe(aCash);

    state = act(state, 'list', {
      account: 'traderA',
      date: bought,
      price: 30,
    });
    state = act(state, 'buy', { account: 'traderB', date: bought });
    state = act(state, 'buy', { account: 'traderB', date: seededBooked });

    const bCash = state.accounts.traderB.cash;
    const hostCash = state.accounts.host.cash;
    const afterDay = addDays(bought, 1);
    const afterNow = '2026-09-29T00:00:00.000Z';

    const first = runTick(state, afterDay, afterNow);
    state = first.state;
    const settled = dayOf(state, bought);
    const payout = settled.history.at(-1);

    expect(state.accounts.traderB.cash).toBe(bCash + bookedPrice);
    expect(settled.settled).toBe(true);
    expect(settled.listed).toBe(false);
    expect(payout).toEqual({
      type: 'payout',
      to: 'traderB',
      price: bookedPrice,
      at: afterNow,
    });
    expect(state.accounts.traderA.cash).toBe(aCash + 30);
    expect(state.accounts.host.cash).toBe(hostCash);

    const again = runTick(state, afterDay, afterNow);
    expect(again.changed).toBe(false);
    expect(again.state.accounts.traderB.cash).toBe(bCash + bookedPrice);
    expect(
      dayOf(again.state, bought).history.filter((h) => h.type === 'payout'),
    ).toHaveLength(1);

    try {
      applyAction(
        state,
        'list',
        { account: 'traderB', date: bought, price: 10 },
        { today: afterDay, now: afterNow },
      );
      throw new Error('expected list to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).message).toBe('Past days are locked');
    }

    expect(dayOf(state, seededBooked).settled).toBeFalsy();

    const rolled = dayOf(state, far);
    const [start, end] = oldCurve.points;
    const t = 1 / (dayNum(end.date) - dayNum(start.date));
    const ease = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    const want = Math.round(
      Math.max(oldCurve.min, start.price + (end.price - start.price) * ease),
    );
    expect(oldCurve.points.length).toBe(2);
    expect(rolled.curve!.points[0].date).toBe(afterDay);
    expect(rolled.price).toBe(rolled.curve!.points[0].price);
    expect(rolled.curve!.points[0].price).toBeGreaterThanOrEqual(
      rolled.curve!.min,
    );
    expect(rolled.curve!.points.slice(1)).toEqual(
      oldCurve.points.filter((p) => p.date > afterDay),
    );
    expect(rolled.curve!.past).toEqual(
      oldCurve.points.filter((p) => p.date < afterDay),
    );
    expect(rolled.price).toBe(want);

    const afterLast = addDays(lastBooked, 1);
    const hostPaid = runTick(state, afterLast);
    state = hostPaid.state;
    const hostAssets = state.assets.filter((a) => a.provider === 'host');
    const hostDays = hostAssets.flatMap((a) =>
      a.days.filter(
        (d) =>
          d.date >= TODAY &&
          d.date < afterLast &&
          d.status === 'booked' &&
          d.owner === 'host',
      ),
    );
    const paidHost = hostDays.reduce((sum, d) => sum + d.price, 0);
    expect(state.accounts.traderB.cash).toBe(
      bCash + bookedPrice + dayOf(state, seededBooked).price,
    );
    expect(paidHost).toBeGreaterThan(0);
    expect(hostDays.every((d) => d.settled)).toBe(true);
    expect(state.accounts.host.cash).toBe(hostCash + paidHost);
    expect(hostAssets).toHaveLength(3);
  });

  it('extends a 2026-09-26 seed to 2028-10-31 when ticked on 2026-10-15', () => {
    const { state } = runTick(seedState(TODAY), '2026-10-15');
    const days = tesla(state).days;
    expect(days.at(-1)!.date).toBe('2028-10-31');
    const added = days.find((d) => d.date === '2028-10-15')!;
    expect(added.owner).toBe('host');
    expect(added.listed).toBe(true);
  });
});
