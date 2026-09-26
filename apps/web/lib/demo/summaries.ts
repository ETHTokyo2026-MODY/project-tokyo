import type { AssetType, DemoState } from './types';

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
};

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
export function summaries(state: DemoState, today: string): AssetSummary[] {
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
    };
  });
}
