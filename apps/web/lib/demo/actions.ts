import { DEFAULT_DISCOUNTS } from './discounts';
import type { Asset, Discounts } from './types';

/** The asset's onchain ladder, a saved per-account table, or a copy of the defaults. */
export function discountsFor(asset: Asset, accountId: string): Discounts {
  if (asset.chain)
    return Object.fromEntries(
      (asset.discountLadder ?? []).map((s) => [s.minDays, s.discountBps / 100]),
    );
  const saved = asset.discounts[accountId];
  return saved ? { ...saved } : { ...DEFAULT_DISCOUNTS };
}
