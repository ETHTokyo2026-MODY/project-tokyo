import type { AssetType, DemoState } from './types';

export type ProfileOwned = {
  asset: string;
  title: string;
  type: AssetType;
  days: number;
  listed: number;
  booked: number;
  value: number;
};

export type ProfileHistory = {
  asset: string;
  title: string;
  date: string;
  type: 'bought' | 'sold' | 'payout';
  price: number;
  block?: number;
  at: string;
};

export type Profile = {
  id: string;
  name: string;
  role: string;
  cash: number;
  startCash: number;
  pnl: number;
  provides: { id: string; title: string; type: AssetType }[];
  owned: ProfileOwned[];
  daysOwned: number;
  history: ProfileHistory[];
  historyCount: number;
};

export function profile(state: DemoState, id: string, today: string): Profile {
  const a = state.accounts[id];
  const owned: ProfileOwned[] = [];
  const history: ProfileHistory[] = [];
  for (const as of state.assets) {
    const fut = as.days.filter((d) => d.date >= today && d.owner === id);
    if (fut.length) {
      owned.push({
        asset: as.id,
        title: as.title,
        type: as.type,
        days: fut.length,
        listed: fut.filter((d) => d.listed).length,
        booked: fut.filter((d) => d.status === 'booked').length,
        value: fut.reduce((s, d) => s + d.price, 0),
      });
    }
    for (const d of as.days) {
      for (const h of d.history) {
        if (h.type === 'trade' && (h.to === id || h.from === id)) {
          history.push({
            asset: as.id,
            title: as.title,
            date: d.date,
            type: h.to === id ? 'bought' : 'sold',
            price: h.price,
            block: h.block || 1,
            at: h.at,
          });
        } else if (h.type === 'payout' && h.to === id) {
          history.push({
            asset: as.id,
            title: as.title,
            date: d.date,
            type: 'payout',
            price: h.price,
            at: h.at,
          });
        }
      }
    }
  }
  history.sort(
    (x, y) => y.at.localeCompare(x.at) || x.date.localeCompare(y.date),
  );
  return {
    id,
    name: a.name,
    role: a.role,
    cash: a.cash,
    startCash: a.startCash,
    pnl: a.cash - a.startCash,
    provides: state.assets
      .filter((x) => x.provider === id)
      .map((x) => ({ id: x.id, title: x.title, type: x.type })),
    owned,
    daysOwned: owned.reduce((s, o) => s + o.days, 0),
    history: history.slice(0, 300),
    historyCount: history.length,
  };
}
