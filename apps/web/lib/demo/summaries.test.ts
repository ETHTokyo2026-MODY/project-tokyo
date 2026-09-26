import { describe, expect, it } from 'vitest';
import { summaries } from './summaries';
import type { DemoState, Day } from './types';

const TODAY = '2026-09-26';
const HOST = '0xhost';
const TRADER = '0xtrader';

function day(
  date: string,
  extra: Partial<Day> & Pick<Day, 'owner' | 'status'>,
): Day {
  return {
    date,
    weekday: 0,
    base: 100,
    price: 100,
    listed: extra.listed ?? extra.status === 'open',
    salePrice: extra.salePrice ?? 80,
    history: extra.history ?? [],
    ...extra,
  };
}

function state(days: Day[]): DemoState {
  return {
    chain: true,
    seededOn: TODAY,
    curveDay: TODAY,
    version: 1,
    accounts: {
      [HOST]: { name: 'Host', role: 'Host', cash: 0, startCash: 0 },
      [TRADER]: { name: 'Trader', role: 'Trader', cash: 10, startCash: 10 },
    },
    assets: [
      {
        chain: true,
        id: '0xasset',
        type: 'car',
        title: 'Car',
        provider: HOST,
        location: 'Tokyo',
        discounts: {},
        days,
      },
    ],
  };
}

describe('summaries', () => {
  it('counts listed, booked, and next open days from chain state', () => {
    const got = summaries(
      state([
        day('2026-09-25', { owner: HOST, status: 'booked', listed: false }),
        day('2026-09-26', {
          owner: HOST,
          status: 'open',
          listed: true,
          salePrice: 80,
        }),
        day('2026-09-27', {
          owner: HOST,
          status: 'booked',
          listed: true,
          salePrice: 90,
        }),
        day('2026-09-28', {
          owner: HOST,
          status: 'open',
          listed: true,
          salePrice: 70,
        }),
      ]),
      TODAY,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: '0xasset',
      futureDays: 3,
      forSale: 3,
      bookedFuture: 1,
      nextOpen: { date: '2026-09-26', price: 100 },
      cheapestSale: 70,
      othersOwn: 0,
      pctBooked: 100,
    });
  });

  it('updates byAccount, forSale and othersOwn after a trade', () => {
    const beforeState = state([
      day('2026-09-26', {
        owner: HOST,
        status: 'open',
        listed: true,
        salePrice: 80,
      }),
      day('2026-09-27', {
        owner: HOST,
        status: 'open',
        listed: true,
        salePrice: 90,
      }),
    ]);
    const afterState = state([
      day('2026-09-26', {
        owner: TRADER,
        status: 'open',
        listed: false,
        salePrice: 80,
        history: [
          {
            type: 'trade',
            from: HOST,
            to: TRADER,
            price: 80,
            at: '2026-09-26T00:00:00.000Z',
          },
        ],
      }),
      day('2026-09-27', {
        owner: HOST,
        status: 'open',
        listed: true,
        salePrice: 90,
      }),
    ]);
    const before = summaries(beforeState, TODAY)[0];
    const after = summaries(afterState, TODAY)[0];
    expect(after.forSale).toBe(before.forSale - 1);
    expect(after.byAccount[TRADER]).toMatchObject({
      owned: 1,
      paid: 80,
      trades: 1,
    });
    expect(after.byAccount[HOST].received).toBe(80);
    expect(after.byAccount[HOST].trades).toBe(1);
    expect(after.byAccount[HOST].owned).toBe(before.byAccount[HOST].owned - 1);
    expect(after.othersOwn).toBe(1);
    expect(before.othersOwn).toBe(0);
  });
});
