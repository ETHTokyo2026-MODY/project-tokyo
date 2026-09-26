import { describe, expect, it } from 'vitest';
import { applyAction } from './actions';
import fixture from './__fixtures__/seed-fixture.json';
import { seedState } from './seed';
import { summaries } from './summaries';

const TODAY = '2026-09-26';
const NOW = '2026-09-26T00:00:00.000Z';

describe('summaries', () => {
  it('matches fixture fields on a fresh 2026-09-26 seed', () => {
    const { assets } = fixture.fixtures.find((f) => f.today === TODAY)!;
    const got = summaries(seedState(TODAY), TODAY);
    expect(got).toHaveLength(assets.length);
    for (const [i, expected] of assets.entries()) {
      expect(got[i]).toMatchObject(expected.summary);
    }
    expect(got[0]).toMatchObject({
      id: 'tesla-model-3',
      futureDays: 736,
      forSale: 736,
      bookedFuture: 8,
      nextOpen: { date: '2026-09-26', price: 88 },
      cheapestSale: 49,
    });
  });

  it('updates byAccount, forSale and othersOwn after a buy', () => {
    const seeded = seedState(TODAY);
    const tesla = seeded.assets[0];
    const day = tesla.days.find((d) => d.date >= TODAY && d.listed)!;
    const price = day.salePrice!;
    const before = summaries(seeded, TODAY)[0];
    const { state } = applyAction(
      seeded,
      'buy',
      { account: 'traderA', asset: tesla.id, date: day.date },
      { today: TODAY, now: NOW },
    );
    const after = summaries(state, TODAY)[0];
    expect(after.forSale).toBe(before.forSale - 1);
    expect(after.byAccount.traderA).toMatchObject({
      owned: 1,
      paid: price,
      trades: 1,
    });
    expect(after.byAccount.host.received).toBe(price);
    expect(after.byAccount.host.trades).toBe(1);
    expect(after.byAccount.host.owned).toBe(before.byAccount.host.owned - 1);
    expect(after.othersOwn).toBe(1);
    expect(before.othersOwn).toBe(0);
  });
});
