import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/seed-fixture.json';
import { addDays, calendarEnd, weekday } from './dates';
import {
  ACCOUNTS,
  ASSETS,
  BASE,
  DEFAULT_DISCOUNTS,
  SEED,
  seedDaysFor,
  seedState,
  TIERS,
} from './seed';
import type { Day } from './types';

type FixtureAsset = (typeof fixture.fixtures)[number]['assets'][number];

function checksums(days: Day[], today: string) {
  const future = days.filter((d) => d.date >= today);
  return {
    baseSum: days.reduce((s, d) => s + d.base, 0),
    priceSum: days.reduce((s, d) => s + d.price, 0),
    saleSumFuture: future.reduce((s, d) => s + (d.salePrice ?? 0), 0),
    predictedSumFuture: future.reduce((s, d) => s + (d.predicted ?? 0), 0),
    bookedPast: days.filter((d) => d.date < today && d.status === 'booked')
      .length,
  };
}

function pastSample(d: Day) {
  return {
    date: d.date,
    weekday: d.weekday,
    base: d.base,
    status: d.status,
    price: d.price,
    owner: d.owner,
    listed: d.listed,
    history: d.history,
    settled: d.settled,
  };
}

function futureSample(d: Day) {
  return {
    date: d.date,
    weekday: d.weekday,
    base: d.base,
    status: d.status,
    owner: d.owner,
    price: d.price,
    predicted: d.predicted,
    listed: d.listed,
    salePrice: d.salePrice,
    history: d.history,
    curve: d.curve,
  };
}

function bookedSample(d: Day) {
  return {
    date: d.date,
    price: d.price,
    salePrice: d.salePrice,
    predicted: d.predicted,
    base: d.base,
  };
}

function expectAssetMatches(
  days: Day[],
  today: string,
  expected: FixtureAsset,
) {
  expect(days.length).toBe(expected.dayCount);
  expect(days[0].date).toBe(expected.first);
  expect(days.at(-1)?.date).toBe(expected.last);
  expect(checksums(days, today)).toEqual(expected.checksums);
  expect(
    days
      .filter((d) => d.date < today)
      .slice(0, 5)
      .map(pastSample),
  ).toEqual(expected.firstPastDays);
  expect(
    days
      .filter((d) => d.date >= today)
      .slice(0, 5)
      .map(futureSample),
  ).toEqual(expected.firstFutureDays);
  expect(
    days
      .filter((d) => d.date >= today && d.status === 'booked')
      .map(bookedSample),
  ).toEqual(expected.bookedFutureDays);
  expect(futureSample(days.at(-1)!)).toEqual(expected.lastDay);
}

describe('seed constants', () => {
  it('keeps the sample accounts, assets and discount table', () => {
    expect(SEED).toBe(38);
    expect(Object.keys(ACCOUNTS)).toEqual([
      'host',
      'traderA',
      'traderB',
      'kenji',
      'sakura',
      'machiya',
      'shinjukuGate',
    ]);
    expect(ASSETS.map((a) => a.id)).toEqual([
      'tesla-model-3',
      'toyota-prius',
      'mazda-cx5',
      'honda-fit',
      'asakusa-1br',
      'gion-machiya',
      'shinjuku-deluxe',
    ]);
    expect(BASE).toEqual([60, 60, 60, 60, 70, 80, 90]);
    expect(DEFAULT_DISCOUNTS).toEqual({ 3: 5, 7: 10, 14: 15, 21: 20, 30: 25 });
    expect(TIERS).toEqual([3, 7, 14, 21, 30]);
  });
});

describe.each(fixture.fixtures)('seedState($today)', ({ today, assets }) => {
  it('matches the fixture per asset', () => {
    const state = seedState(today);
    expect(state.seededOn).toBe(today);
    expect(state.curveDay).toBe(today);
    expect(state.version).toBe(0);
    expect(state.accounts.host.startCash).toBe(state.accounts.host.cash);
    expect(state.accounts.traderA).toEqual({
      name: 'Trader A',
      role: 'Trader',
      cash: 1000,
      startCash: 1000,
    });
    expect(state.assets).toHaveLength(assets.length);
    for (const [i, expected] of assets.entries()) {
      const asset = state.assets[i];
      expect(asset.id).toBe(expected.id);
      expect(asset.discounts).toEqual({});
      expectAssetMatches(asset.days, today, expected);
    }
  });
});

describe('seeded calendar rules (2026-09-26, first asset)', () => {
  const today = '2026-09-26';
  const state = seedState(today);
  const days = state.assets[0].days;
  const past = days.filter((d) => d.date < today);
  const fut = days.filter((d) => d.date >= today);

  it('runs from Jan 1 to the calendar end with continuous weekdays', () => {
    expect(days[0].date).toBe('2026-01-01');
    expect(days.at(-1)?.date).toBe(calendarEnd(today));
    expect(
      days.every((d, i) => i === 0 || d.date === addDays(days[i - 1].date, 1)),
    ).toBe(true);
    expect(days.every((d) => weekday(d.date) === d.weekday)).toBe(true);
    expect(past.length).toBeGreaterThan(0);
    expect(past.every((d, i) => d.date === days[i].date)).toBe(true);
    expect(fut.length).toBe(days.length - past.length);
  });

  it('books past days in 2-5 day runs and settles them', () => {
    const runs: number[] = [];
    let n = 0;
    for (const d of past) {
      if (d.status === 'booked') n++;
      else if (n) {
        runs.push(n);
        n = 0;
      }
    }
    expect(runs.length).toBeGreaterThan(10);
    expect(runs.every((r) => r >= 2 && r <= 5)).toBe(true);
    expect(
      past.every(
        (d) =>
          (d.status === 'booked' && d.price > 0) ||
          (d.status === 'unbooked' && d.price === 0),
      ),
    ).toBe(true);
    expect(past.every((d) => d.settled)).toBe(true);
  });

  it('lists future days from the host with salePrice at 85% of predicted', () => {
    expect(
      fut.every(
        (d) => d.owner === 'host' && d.listed && d.history.length === 0,
      ),
    ).toBe(true);
    expect(
      fut
        .filter((d) => d.status === 'open')
        .every((d) => d.salePrice === Math.round((d.predicted ?? 0) * 0.85)),
    ).toBe(true);
  });

  it('seeds 1-2 booked groups in the next month near predicted', () => {
    const bookedFut = fut.filter((d) => d.status === 'booked');
    const nextMonth = `${today.slice(0, 4)}-${String(Number(today.slice(5, 7)) + 1).padStart(2, '0')}`;
    const groups: Day[][] = [];
    let prevIdx = -9;
    for (const d of bookedFut) {
      const i = days.indexOf(d);
      if (i === prevIdx + 1) groups.at(-1)!.push(d);
      else groups.push([d]);
      prevIdx = i;
    }
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups.length).toBeLessThanOrEqual(2);
    expect(groups.every((g) => g.length >= 3 && g.length <= 5)).toBe(true);
    expect(bookedFut.every((d) => d.date.startsWith(nextMonth))).toBe(true);
    expect(
      bookedFut.every(
        (d) =>
          d.owner === 'host' &&
          d.listed &&
          (d.salePrice ?? 0) < d.price &&
          Math.abs(d.price - (d.predicted ?? 0)) <= 4 &&
          !d.settled,
      ),
    ).toBe(true);
  });

  it('gives every future day a curve from today, with two points after today', () => {
    expect(
      fut.every(
        (d) =>
          d.curve &&
          d.curve.min === 40 &&
          d.curve.points[0].date === today &&
          d.curve.points.at(-1)?.date === d.date &&
          d.curve.points.every((p) => p.price >= 40),
      ),
    ).toBe(true);
    expect(
      fut
        .filter((d) => d.status === 'open')
        .every(
          (d) =>
            d.curve?.points[0].price === d.price &&
            (d.date === today || d.curve?.points.at(-1)?.price === 40),
        ),
    ).toBe(true);
    expect(
      fut
        .filter((d) => d.status === 'open' && d.date > today)
        .every((d) => d.curve?.points.length === 2),
    ).toBe(true);
  });

  it('keeps Mon-Wed cheaper than Thu-Sat after next month', () => {
    const nextMonth = today
      .slice(0, 7)
      .replace(
        /-(\d+)/,
        (_m, x) => `-${String(Number(x) + 1).padStart(2, '0')}`,
      );
    const far = days.filter(
      (d) => d.date > today && d.date.slice(0, 7) > nextMonth,
    );
    const wkAvg = (wds: number[]) => {
      const x = far.filter((d) => wds.includes(d.weekday));
      return x.reduce((t, d) => t + d.base, 0) / x.length;
    };
    expect(
      far.every(
        (d) =>
          d.owner === 'host' &&
          d.listed &&
          d.status === 'open' &&
          d.curve?.points.length === 2,
      ),
    ).toBe(true);
    expect(wkAvg([1, 2, 3])).toBeLessThan(65);
    expect(wkAvg([4, 5, 6])).toBeGreaterThan(68);
  });

  it('owns other assets by their providers at their own price level', () => {
    const tesla = state.assets[0];
    const gion = state.assets.find((a) => a.id === 'gion-machiya')!;
    expect(
      gion.days
        .filter((d) => d.date >= today)
        .every((d) => d.owner === 'machiya'),
    ).toBe(true);
    expect(gion.days.find((d) => d.date >= today)!.price).toBeGreaterThan(
      tesla.days.find((d) => d.date >= today)!.price,
    );
  });
});

describe('seedDaysFor', () => {
  it('reseeds a built-in asset the same way as seedState', () => {
    const today = '2026-09-26';
    const state = seedState(today);
    expect(seedDaysFor(state.assets[0], today)).toEqual(state.assets[0].days);
  });
});
