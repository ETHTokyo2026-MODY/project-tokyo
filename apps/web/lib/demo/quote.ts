import { TIERS } from './seed';
import type { Day, Discounts } from './types';

export type QuoteOk = {
  pct: number;
  pctText: string;
  sellers: number;
  subtotal: number;
  total: number;
  perDay: Record<string, number>;
  dayPct: Record<string, number>;
  own: boolean;
  mixed: boolean;
};

export type Quote = QuoteOk | { reason: string };

/** Highest tier at or below `n`; 0% for 1–2 days. */
export function discountPct(tiers: Discounts, n: number): number {
  return TIERS.filter((min) => min <= n).reduce(
    (pct, min) => tiers[min as keyof Discounts],
    0,
  );
}

export function quoteBlock(
  days: Pick<Day, 'date' | 'listed' | 'owner' | 'salePrice' | 'price'>[],
  viewer: string,
  tiersOf: (owner: string) => Discounts,
  today: string,
): Quote {
  const reason = days.some((d) => d.date < today)
    ? 'Includes a past day'
    : days.some((d) => !d.listed)
      ? 'Blocks must be continuous listed days'
      : null;
  if (reason) return { reason };
  const n = days.length;
  const perDay: Record<string, number> = {};
  const dayPct: Record<string, number> = {};
  const groups: Record<string, typeof days> = {};
  for (const d of days) (groups[d.owner] ||= []).push(d);
  let subtotal = 0;
  let total = 0;
  const pcts: number[] = [];
  for (const [owner, ds] of Object.entries(groups)) {
    const pct = discountPct(tiersOf(owner), n);
    const sub = ds.reduce((t, d) => t + d.salePrice!, 0);
    const tot = Math.round(sub * (1 - pct / 100));
    let left = tot;
    ds.forEach((d, i) => {
      perDay[d.date] =
        i === ds.length - 1 ? left : Math.round(d.salePrice! * (1 - pct / 100));
      left -= perDay[d.date];
      dayPct[d.date] = pct;
    });
    subtotal += sub;
    total += tot;
    pcts.push(pct);
  }
  const lo = Math.min(...pcts);
  const hi = Math.max(...pcts);
  const ownCount = days.filter((d) => d.owner === viewer).length;
  return {
    pct: hi,
    pctText: lo === hi ? `${lo}%` : `${lo}–${hi}% (per owner)`,
    sellers: pcts.length,
    subtotal,
    total,
    perDay,
    dayPct,
    own: ownCount === n,
    mixed: ownCount > 0 && ownCount < n,
  };
}
