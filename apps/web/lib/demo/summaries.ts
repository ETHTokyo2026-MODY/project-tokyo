import type { Asset, AssetType, DemoState } from './types';

export type AccountPosition = {
  owned: number;
  listed: number;
  booked: number;
  value: number;
  paid: number;
  received: number;
  trades: number;
};

export type AssetSummary = {
  id: string;
  type: AssetType;
  title: string;
  provider: string;
  location: string;
  providerName: string;
  futureDays: number;
  forSale: number;
  bookedFuture: number;
  nextOpen: { date: string; price: number } | null;
  cheapestSale: number | null;
  byAccount: Record<string, AccountPosition>;
  custom: boolean;
  othersOwn: number;
  volume: Record<'7d' | '30d' | 'all', { count: number; usd: number }>;
  closedCount: number;
  avgProfit: number | null;
  avgMarginPct: number | null;
  pctBooked: number | null;
  avgListDiscountPct: number | null;
};

function round1(x: number | null): number | null {
  return x == null ? null : Math.round(x * 10) / 10;
}

export function screenerMetrics(a: Asset, today: string, nowMs = Date.now()) {
  const volume = {
    '7d': { count: 0, usd: 0 },
    '30d': { count: 0, usd: 0 },
    all: { count: 0, usd: 0 },
  };
  const closed: [number, number][] = [];
  let past = 0;
  let booked = 0;
  const disc: number[] = [];
  for (const d of a.days) {
    if (d.date < today) {
      past++;
      if (d.status === 'booked') booked++;
    } else if (d.listed && d.status !== 'booked' && d.price > 0) {
      disc.push((d.price - d.salePrice!) / d.price);
    }
    const cost: Record<string, number> = {};
    for (const h of d.history) {
      if (h.type === 'trade') {
        const age = (nowMs - Date.parse(h.at)) / 864e5;
        for (const [k, days] of [
          ['7d', 7],
          ['30d', 30],
          ['all', Infinity],
        ] as const) {
          if (age <= days) {
            volume[k].count++;
            volume[k].usd += h.price;
          }
        }
        if (cost[h.from] != null) {
          closed.push([cost[h.from], h.price]);
          delete cost[h.from];
        }
        cost[h.to] = h.price;
      } else if (h.type === 'payout' && cost[h.to] != null) {
        closed.push([cost[h.to], h.price]);
        delete cost[h.to];
      }
    }
  }
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  return {
    volume,
    closedCount: closed.length,
    avgProfit: round1(avg(closed.map(([b, e]) => e - b))),
    avgMarginPct: round1(
      avg(closed.filter(([b]) => b > 0).map(([b, e]) => (100 * (e - b)) / b)),
    ),
    pctBooked: past ? round1((100 * booked) / past) : null,
    avgListDiscountPct: disc.length ? round1(100 * avg(disc)!) : null,
  };
}

function emptyPosition(): AccountPosition {
  return {
    owned: 0,
    listed: 0,
    booked: 0,
    value: 0,
    paid: 0,
    received: 0,
    trades: 0,
  };
}

/** Per-asset counts and positions. Callers memoize on `state.version` and today. */
export function summaries(
  state: DemoState,
  today: string,
  nowMs = Date.now(),
): AssetSummary[] {
  return state.assets.map((a) => {
    const fut = a.days.filter((d) => d.date >= today);
    const next = fut.find((d) => d.status === 'open');
    const listed = fut.filter((d) => d.listed);
    const by: Record<string, AccountPosition> = {};
    const acc = (id: string) => (by[id] ||= emptyPosition());
    for (const d of fut) {
      const x = acc(d.owner);
      x.owned++;
      x.value += d.price;
      if (d.listed) x.listed++;
      if (d.status === 'booked') x.booked++;
    }
    for (const d of a.days) {
      for (const h of d.history) {
        if (h.type === 'trade') {
          acc(h.to).paid += h.price;
          acc(h.to).trades++;
          acc(h.from).received += h.price;
          acc(h.from).trades++;
        } else if (h.type === 'payout') acc(h.to).received += h.price;
      }
    }
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      provider: a.provider,
      location: a.location,
      providerName: state.accounts[a.provider].name,
      futureDays: fut.length,
      forSale: listed.length,
      bookedFuture: fut.filter((d) => d.status === 'booked').length,
      nextOpen: next ? { date: next.date, price: next.price } : null,
      cheapestSale: listed.length
        ? Math.min(...listed.map((d) => d.salePrice!))
        : null,
      byAccount: by,
      custom: !!a.custom,
      othersOwn: a.days.filter((d) => d.owner !== a.provider).length,
      ...screenerMetrics(a, today, nowMs),
    };
  });
}
