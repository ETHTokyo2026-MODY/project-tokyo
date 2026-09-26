import type { Discounts } from './types';

export const MAX_DISCOUNT_TIERS = 8;
export type DraftTier = { nights: string; pct: string };

export function rowsFromDiscounts(d: Discounts): DraftTier[] {
  return Object.keys(d)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .map((n) => ({ nights: String(n), pct: String(d[n]) }));
}

export function checkTiers(rows: DraftTier[]) {
  const rowErrs = rows.map(() => null as string | null);
  if (rows.length > MAX_DISCOUNT_TIERS) {
    return { error: `At most ${MAX_DISCOUNT_TIERS} tiers`, rowErrs };
  }
  const next: Discounts = {};
  const seen = new Map<number, number>();
  for (const [i, r] of rows.entries()) {
    const nights = Number(r.nights);
    const pct = Number(r.pct);
    if (r.nights.trim() === '' || !Number.isInteger(nights) || nights < 2) {
      rowErrs[i] = 'Nights must be a whole number of 2 or more';
    } else if (r.pct.trim() === '' || !(pct >= 0 && pct <= 90)) {
      rowErrs[i] = 'Percent must be 0-90';
    } else if (seen.has(nights)) {
      rowErrs[i] = rowErrs[seen.get(nights)!] = 'Duplicate nights';
    } else {
      seen.set(nights, i);
      next[nights] = pct;
    }
  }
  const error = rowErrs.find(Boolean) ?? undefined;
  return error ? { error, rowErrs } : { next, rowErrs };
}
