import { describe, expect, it } from 'vitest';
import { discountsFor } from './actions';
import { checkTiers, DEFAULT_DISCOUNTS } from './discounts';
import { discountPct, quoteBlock } from './quote';
import type { Asset } from './types';

const TODAY = '2026-09-26';

function chainAsset(ladder: { minDays: number; discountBps: number }[]): Asset {
  return {
    chain: true,
    id: '0xabc',
    type: 'car',
    title: 'Car',
    provider: '0xhost',
    location: 'Tokyo',
    discounts: {},
    discountLadder: ladder,
    days: [],
  };
}

describe('discountsFor', () => {
  it('reads the onchain discount ladder as percents', () => {
    expect(
      discountsFor(
        chainAsset([
          { minDays: 3, discountBps: 500 },
          { minDays: 7, discountBps: 1000 },
        ]),
        '0xwallet',
      ),
    ).toEqual({ 3: 5, 7: 10 });
  });

  it('returns an empty table when the chain asset has no ladder', () => {
    expect(discountsFor(chainAsset([]), '0xwallet')).toEqual({});
  });
});

describe('discount quotes', () => {
  it('quotes custom length-discount tiers', () => {
    expect([1, 2, 3, 7].map((n) => discountPct(DEFAULT_DISCOUNTS, n))).toEqual([
      0, 0, 5, 10,
    ]);
    expect(discountPct({ 2: 8, 10: 18 }, 9)).toBe(8);
    expect(discountPct({}, 14)).toBe(0);
    const d = {
      listed: true,
      owner: 'host',
      salePrice: 100,
      price: 120,
    };
    expect(
      quoteBlock(
        [
          { date: '2026-09-27', ...d },
          { date: '2026-09-28', ...d },
        ],
        'traderA',
        () => ({ 2: 50 }),
        TODAY,
      ),
    ).toMatchObject({ pct: 50, total: 100 });
  });

  it('rejects invalid draft tiers', () => {
    expect(
      checkTiers([
        { nights: '3', pct: '5' },
        { nights: '3', pct: '10' },
      ]),
    ).toMatchObject({ error: 'Duplicate nights' });
  });
});
