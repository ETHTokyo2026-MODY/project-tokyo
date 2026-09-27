import { addDays, todayTokyo, weekday } from './dates';
import {
  DEMO_ACCOUNT_LABELS,
  DEMO_START_CASH,
  type DemoAccountId,
} from './mode';
import type { Asset, AssetType, Day, DemoState } from './types';

export const TYPES: AssetType[] = ['car', 'airbnb', 'hotel room'];
export const MAX_ASSETS = 30;
export const MAX_ADDED_PER_ACCOUNT = 5;
export const HORIZON_DAYS = 365;

export function emptyState(today = todayTokyo()): DemoState {
  const accounts = {
    host: {
      name: DEMO_ACCOUNT_LABELS.host,
      role: 'Host',
      cash: 0,
      startCash: 0,
    },
    traderA: {
      name: DEMO_ACCOUNT_LABELS.traderA,
      role: 'Trader',
      cash: DEMO_START_CASH,
      startCash: DEMO_START_CASH,
    },
    traderB: {
      name: DEMO_ACCOUNT_LABELS.traderB,
      role: 'Trader',
      cash: DEMO_START_CASH,
      startCash: DEMO_START_CASH,
    },
  } satisfies DemoState['accounts'];
  return {
    seededOn: today,
    curveDay: today,
    version: 0,
    accounts,
    assets: [],
    bids: [],
  };
}

export function seedDaysFor(
  asset: Pick<Asset, 'provider' | 'custom'>,
  today: string,
  sellingPrice?: number,
): Day[] {
  const base = asset.custom?.base ?? [100, 100, 100, 100, 100, 100, 100];
  const min = asset.custom?.min ?? 1;
  const sale =
    sellingPrice ??
    Math.max(min, Math.round(base.reduce((a, b) => a + b, 0) / base.length));
  const days: Day[] = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const date = addDays(today, i);
    const wd = weekday(date);
    const price = Math.max(min, base[wd] ?? base[0]);
    days.push({
      date,
      weekday: wd,
      base: price,
      status: 'open',
      owner: asset.provider,
      price,
      predicted: price,
      listed: true,
      salePrice: sale,
      history: [],
      curve: { min, points: [{ date, price }] },
    });
  }
  return days;
}

export function isHost(account: string): account is DemoAccountId {
  return account === 'host';
}
