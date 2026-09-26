import { describe, expect, it } from 'vitest';
import {
  curveValue,
  curveValueX,
  easeInOut,
  priceFromCurve,
  seedCurve,
} from './curve';
import { dayNum } from './dates';
import type { Curve, Day } from './types';

function sampleDay(curve: Curve, extra: Partial<Day> = {}): Day {
  return {
    date: '2026-10-10',
    weekday: 6,
    base: 80,
    status: 'open',
    owner: 'host',
    price: 80,
    listed: true,
    history: [],
    curve,
    ...extra,
  };
}

describe('curve', () => {
  it('eases 0, 0.5 and 1 to themselves', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(1)).toBe(1);
  });

  it('clamps to the end points and to min', () => {
    const curve: Curve = {
      min: 50,
      points: [
        { date: '2026-10-01', price: 80 },
        { date: '2026-10-11', price: 30 },
      ],
    };
    expect(curveValue(curve, '2026-09-20')).toBe(80);
    expect(curveValue(curve, '2026-10-20')).toBe(50);
  });

  it('follows the ease in the middle of a segment', () => {
    const curve: Curve = {
      min: 40,
      points: [
        { date: '2026-10-01', price: 80 },
        { date: '2026-10-11', price: 40 },
      ],
    };
    expect(curveValue(curve, '2026-10-06')).toBe(60);
    const x = dayNum('2026-10-01') + 2.5;
    expect(curveValueX(curve, x)).toBe(80 + (40 - 80) * easeInOut(0.25));
  });

  it('never returns a value below min', () => {
    const curve: Curve = {
      min: 50,
      points: [
        { date: '2026-10-01', price: 80 },
        { date: '2026-10-11', price: 30 },
      ],
    };
    const start = dayNum('2026-10-01');
    const end = dayNum('2026-10-11');
    for (let x = start; x <= end; x += 0.25) {
      expect(curveValueX(curve, x)).toBeGreaterThanOrEqual(50);
    }
  });

  it('uses the single point, clamped at min', () => {
    expect(
      curveValue(
        { min: 40, points: [{ date: '2026-10-01', price: 70 }] },
        '2026-12-01',
      ),
    ).toBe(70);
    expect(
      curveValue(
        { min: 40, points: [{ date: '2026-10-01', price: 20 }] },
        '2026-09-01',
      ),
    ).toBe(40);
  });

  it('seeds one point on today and two points otherwise', () => {
    expect(seedCurve('2026-09-26', 88, '2026-09-26', 40)).toEqual({
      min: 40,
      points: [{ date: '2026-09-26', price: 88 }],
    });
    expect(seedCurve('2026-10-01', 20, '2026-09-26', 40)).toEqual({
      min: 40,
      points: [
        { date: '2026-09-26', price: 40 },
        { date: '2026-10-01', price: 40 },
      ],
    });
  });

  it('moves past points into past and sets the rounded price', () => {
    const day = sampleDay({
      min: 40,
      past: [{ date: '2026-09-01', price: 90 }],
      points: [
        { date: '2026-09-20', price: 100 },
        { date: '2026-10-10', price: 40 },
      ],
    });
    priceFromCurve(day, '2026-09-26');
    const v = Math.round(
      curveValue(
        {
          min: 40,
          points: [
            { date: '2026-09-20', price: 100 },
            { date: '2026-10-10', price: 40 },
          ],
        },
        '2026-09-26',
      ),
    );
    expect(day.price).toBe(v);
    expect(day.curve?.past).toEqual([
      { date: '2026-09-01', price: 90 },
      { date: '2026-09-20', price: 100 },
    ]);
    expect(day.curve?.points).toEqual([
      { date: '2026-09-26', price: v },
      { date: '2026-10-10', price: 40 },
    ]);
  });
});
