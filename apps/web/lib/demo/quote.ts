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
