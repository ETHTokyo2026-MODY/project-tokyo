import { seedCurve } from './curve';
import { addDays, calendarEnd, weekday } from './dates';
import { makeRng } from './rng';
import type {
  Account,
  Asset,
  AssetType,
  Day,
  DemoState,
  Discounts,
} from './types';

export const SEED = 38;

export const ACCOUNTS: Record<string, Omit<Account, 'startCash'>> = {
  host: { name: 'Turo Host', role: 'Provider · Turo host', cash: 0 },
  traderA: { name: 'Trader A', role: 'Trader', cash: 1000 },
  traderB: { name: 'Trader B', role: 'Trader', cash: 1000 },
  kenji: { name: 'Kenji Drives', role: 'Provider · Turo host', cash: 0 },
  sakura: { name: 'Sakura Stays', role: 'Provider · Airbnb host', cash: 0 },
  machiya: {
    name: 'Gion Machiya Co.',
    role: 'Provider · Airbnb host',
    cash: 0,
  },
  shinjukuGate: {
    name: 'Hotel Shinjuku Gate',
    role: 'Provider · Hotel',
    cash: 0,
  },
};

export type BuiltInAssetSpec = {
  id: string;
  type: AssetType;
  title: string;
  provider: string;
  location: string;
  scale: number;
};

export const ASSETS: BuiltInAssetSpec[] = [
  {
    id: 'tesla-model-3',
    type: 'car',
    title: '2021 Tesla Model 3',
    provider: 'host',
    location: 'Shibuya, Tokyo',
    scale: 1,
  },
  {
    id: 'toyota-prius',
    type: 'car',
    title: '2020 Toyota Prius',
    provider: 'host',
    location: 'Setagaya, Tokyo',
    scale: 0.8,
  },
  {
    id: 'mazda-cx5',
    type: 'car',
    title: '2022 Mazda CX-5',
    provider: 'host',
    location: 'Shinagawa, Tokyo',
    scale: 1.15,
  },
  {
    id: 'honda-fit',
    type: 'car',
    title: '2019 Honda Fit',
    provider: 'kenji',
    location: 'Yokohama',
    scale: 0.7,
  },
  {
    id: 'asakusa-1br',
    type: 'airbnb',
    title: 'Asakusa riverside 1BR apartment',
    provider: 'sakura',
    location: 'Taito, Tokyo',
    scale: 1.9,
  },
  {
    id: 'gion-machiya',
    type: 'airbnb',
    title: 'Gion machiya townhouse',
    provider: 'machiya',
    location: 'Higashiyama, Kyoto',
    scale: 2.6,
  },
  {
    id: 'shinjuku-deluxe',
    type: 'hotel room',
    title: 'Deluxe Double room',
    provider: 'shinjukuGate',
    location: 'Shinjuku, Tokyo',
    scale: 2.1,
  },
];

export const META_KEYS = [
  'id',
  'type',
  'title',
  'provider',
  'location',
] as const;
export const TYPES: AssetType[] = ['car', 'airbnb', 'hotel room'];
export const MAX_ASSETS = 30;
export const MAX_ADDED_PER_ACCOUNT = 5;
export const DEFAULT_DISCOUNTS: Discounts = {
  3: 5,
  7: 10,
  14: 15,
  21: 20,
  30: 25,
};
export const TIERS = Object.keys(DEFAULT_DISCOUNTS).map(Number);
export const BASE = [60, 60, 60, 60, 70, 80, 90];

export type AssetSeedSpec = {
  provider: string;
  scale?: number;
  base?: number[];
  min?: number;
  seed?: number;
};

function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]])) as Pick<T, K>;
}

/** Asset 0 uses seed 38; other built-ins `38 * 1000 + idx * 7919`; custom uses `spec.seed`. */
export function seedAssetDays(
  spec: AssetSeedSpec,
  idx: number,
  today: string,
): Day[] {
  const seed = spec.seed ?? (idx === 0 ? SEED : SEED * 1000 + idx * 7919);
  const rng = makeRng(seed);
  const customBase = spec.base;
  const custom = Array.isArray(customBase);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const sc = custom ? sum(customBase) / sum(BASE) : spec.scale!;
  const B = custom ? customBase.map((v) => v / sc) : BASE;
  const min = spec.min ?? Math.round(40 * sc);
  const [y, m] = today.split('-').map(Number);
  const start = `${y}-01-01`;
  const end = calendarEnd(today);
  const later = makeRng(seed + 1);

  const days: Array<Partial<Day> & Pick<Day, 'date' | 'weekday' | 'base'>> = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const wd = weekday(d);
    days.push({
      date: d,
      weekday: wd,
      base: Math.round(
        (B[wd] + (d.startsWith(String(y)) ? rng : later).int(-3, 3)) * sc,
      ),
    });
  }

  const past = days.filter((d) => d.date < today);
  let i = rng.int(0, 2);
  past
    .slice(0, i)
    .forEach((d) => Object.assign(d, { status: 'unbooked', price: 0 }));
  while (i < past.length) {
    const run = rng.int(2, 5);
    for (let k = 0; k < run && i < past.length; k++, i++) {
      const premium = Math.round(
        (rng.next() < 0.3 ? rng.int(8, 25) : rng.int(-2, 4)) * sc,
      );
      Object.assign(past[i], {
        status: 'booked',
        price: past[i].base + premium,
      });
    }
    const gap = rng.int(1, 3);
    for (let k = 0; k < gap && i < past.length; k++, i++) {
      Object.assign(past[i], { status: 'unbooked', price: 0 });
    }
  }
  past.forEach((d) =>
    Object.assign(d, {
      owner: spec.provider,
      listed: false,
      history: [],
      settled: true,
    }),
  );

  const predictedFor = (wd: number, base: number) => {
    const booked = past.filter(
      (d) => d.weekday === wd && d.status === 'booked',
    );
    return booked.length
      ? Math.round(
          booked.reduce((s, d) => s + (d.price ?? 0), 0) / booked.length,
        )
      : base;
  };

  days
    .filter((d) => d.date >= today)
    .forEach((d) => {
      const predicted = predictedFor(d.weekday, d.base);
      Object.assign(d, {
        status: 'open',
        owner: spec.provider,
        price: Math.max(d.base, min),
        predicted,
        listed: true,
        salePrice: Math.round(predicted * 0.85),
        history: [],
      });
    });

  days
    .filter((d) => d.date >= today)
    .forEach((d) => {
      d.curve = seedCurve(d.date, d.price!, today, min);
    });

  const next =
    m < 12 ? `${y}-${String(m + 1).padStart(2, '0')}` : `${y + 1}-01`;
  const month = days.filter((d) => d.date.startsWith(next));
  if (month.length) {
    const groups = rng.int(1, 2);
    const span = Math.floor(month.length / groups);
    for (let g = 0; g < groups; g++) {
      const len = rng.int(3, 5);
      const from = g * span + rng.int(0, span - len - 1);
      month.slice(from, from + len).forEach((d) => {
        const price = d.predicted! + Math.round(rng.int(-4, 4) * sc);
        Object.assign(d, {
          status: 'booked',
          price,
          salePrice: price - Math.round(rng.int(4, 9) * sc),
        });
      });
    }
  }

  return days as Day[];
}

export function seedDaysFor(asset: Asset, today: string): Day[] {
  if (asset.custom) {
    return seedAssetDays(
      { ...asset.custom, provider: asset.provider },
      -1,
      today,
    );
  }
  const idx = ASSETS.findIndex((x) => x.id === asset.id);
  return idx < 0 ? [] : seedAssetDays(ASSETS[idx], idx, today);
}

export function seedState(today: string): DemoState {
  const accounts: Record<string, Account> = {};
  for (const [id, a] of Object.entries(ACCOUNTS)) {
    accounts[id] = {
      name: a.name,
      role: a.role,
      cash: a.cash,
      startCash: a.cash,
    };
  }
  const assets = ASSETS.map((spec, idx) => ({
    ...pick(spec, META_KEYS),
    discounts: {},
    days: seedAssetDays(spec, idx, today),
  }));
  return {
    seededOn: today,
    curveDay: today,
    version: 0,
    accounts,
    assets,
    bids: [],
  };
}
