import { addDays, dayNum } from './dates';
import type { Asset, AssetType } from './types';

const avg = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const LEAD: [number, number, string][] = [
  [0, 7, '0–7 days'],
  [8, 30, '8–30'],
  [31, 90, '31–90'],
  [91, 180, '91–180'],
  [181, 365, '181–365'],
  [366, 1e9, '366+'],
];
const bucketOf = (n: number) =>
  LEAD.findIndex(([lo, hi]) => n >= lo && n <= hi);
const tokyoDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(
    new Date(iso),
  );

export type StatsTrade = {
  asset: string;
  date: string;
  day: string;
  price: number;
  lead: number;
  block: number;
};

export type VolumeRow = { start: string; count: number; usd: number };

export type AssetStats = {
  scope: string;
  assets: { id: string; title: string; type: AssetType }[];
  today: string;
  first: string;
  series: {
    predicted: (number | null)[];
    listed: (number | null)[];
    actual: (number | null)[];
    sale: (number | null)[];
  };
  trades: StatsTrade[];
  volume: { byDay: VolumeRow[]; byWeek: VolumeRow[] };
  kpis: {
    pastDays: number;
    pastBooked: number;
    pctBooked: number | null;
    avgBooked: number | null;
    avgListDiscountPct: number | null;
    listedDays: number;
    tradeCount: number;
    tradeVolume: number;
    avgTradePrice: number | null;
    blockTradeShare: number | null;
    avgLeadDays: number | null;
    closedPositions: number;
    avgGain: number | null;
  };
  lead: {
    label: string;
    publicAvg: number | null;
    saleAvg: number | null;
    tradeAvg: number | null;
    days: number;
    trades: number;
  }[];
};

export function assetStats(
  assets: Asset[],
  today: string,
  scope: string,
): AssetStats {
  const first = assets.reduce(
    (m, a) => (a.days[0].date < m ? a.days[0].date : m),
    assets[0].days[0].date,
  );
  const last = assets.reduce(
    (m, a) => (a.days.at(-1)!.date > m ? a.days.at(-1)!.date : m),
    assets[0].days.at(-1)!.date,
  );
  const n = dayNum(last) - dayNum(first) + 1;
  const acc: Record<string, [number, number][]> = {
    predicted: [],
    listed: [],
    actual: [],
    sale: [],
  };
  for (const k in acc) acc[k] = Array.from({ length: n }, () => [0, 0]);
  const add = (k: string, i: number, v: number | null | undefined) => {
    if (v != null) {
      acc[k][i][0] += v;
      acc[k][i][1]++;
    }
  };
  const trades: StatsTrade[] = [];
  const gains: number[] = [];
  let pastDays = 0;
  let pastBooked = 0;
  const booked: number[] = [];
  const listDisc: number[] = [];
  const leadPub = LEAD.map(() => [] as number[]);
  const leadSale = LEAD.map(() => [] as number[]);
  const leadTrade = LEAD.map(() => [] as number[]);
  for (const a of assets) {
    const past = a.days.filter((d) => d.date < today);
    const model = [0, 1, 2, 3, 4, 5, 6].map((wd) => {
      const b = past
        .filter((d) => d.weekday === wd && d.status === 'booked')
        .map((d) => d.price);
      return b.length
        ? avg(b)
        : avg(a.days.filter((d) => d.weekday === wd).map((d) => d.base));
    });
    for (const d of a.days) {
      const i = dayNum(d.date) - dayNum(first);
      const fut = d.date >= today;
      add('predicted', i, fut && d.predicted ? d.predicted : model[d.weekday]);
      if (fut && d.status !== 'booked') add('listed', i, d.price);
      if (d.status === 'booked') add('actual', i, d.price);
      if (fut && d.listed) add('sale', i, d.salePrice);
      if (!fut) {
        pastDays++;
        if (d.status === 'booked') {
          pastBooked++;
          booked.push(d.price);
        }
      }
      if (fut && d.status !== 'booked') {
        const b = bucketOf(dayNum(d.date) - dayNum(today));
        leadPub[b].push(d.price);
        if (d.listed) {
          leadSale[b].push(d.salePrice!);
          listDisc.push((d.price - d.salePrice!) / d.price);
        }
      }
      const cost: Record<string, number> = {};
      for (const h of d.history) {
        if (h.type === 'trade') {
          const day = tokyoDate(h.at);
          const lead = dayNum(d.date) - dayNum(day);
          trades.push({
            asset: a.id,
            date: d.date,
            day,
            price: h.price,
            lead,
            block: h.block || 1,
          });
          leadTrade[bucketOf(Math.max(0, lead))].push(h.price);
          if (cost[h.from] != null) {
            gains.push(h.price - cost[h.from]);
            delete cost[h.from];
          }
          cost[h.to] = h.price;
        } else if (h.type === 'payout' && cost[h.to] != null) {
          gains.push(h.price - cost[h.to]);
          delete cost[h.to];
        }
      }
    }
  }
  const series = {
    predicted: acc.predicted.map(([s, c]) => (c ? r1(s / c) : null)),
    listed: acc.listed.map(([s, c]) => (c ? r1(s / c) : null)),
    actual: acc.actual.map(([s, c]) => (c ? r1(s / c) : null)),
    sale: acc.sale.map(([s, c]) => (c ? r1(s / c) : null)),
  };
  const byDay: Record<string, VolumeRow> = {};
  const byWeek: Record<string, VolumeRow> = {};
  for (const t of trades) {
    const w = addDays(
      t.day,
      -((new Date(t.day + 'T00:00:00Z').getUTCDay() + 6) % 7),
    );
    for (const [m, key] of [
      [byDay, t.day],
      [byWeek, w],
    ] as const) {
      m[key] ||= { start: key, count: 0, usd: 0 };
      m[key].count++;
      m[key].usd += t.price;
    }
  }
  const rows = (m: Record<string, VolumeRow>) =>
    Object.keys(m)
      .sort()
      .map((k) => ({ ...m[k], start: k }));
  const vol = trades.reduce((s, t) => s + t.price, 0);
  return {
    scope,
    assets: assets.map((a) => ({ id: a.id, title: a.title, type: a.type })),
    today,
    first,
    series,
    trades: trades.sort((x, y) =>
      (x.day + x.date).localeCompare(y.day + y.date),
    ),
    volume: { byDay: rows(byDay), byWeek: rows(byWeek) },
    kpis: {
      pastDays,
      pastBooked,
      pctBooked: pastDays ? r1((100 * pastBooked) / pastDays) : null,
      avgBooked: r1(avg(booked)),
      avgListDiscountPct: r1(listDisc.length ? 100 * avg(listDisc)! : null),
      listedDays: listDisc.length,
      tradeCount: trades.length,
      tradeVolume: vol,
      avgTradePrice: r1(avg(trades.map((t) => t.price))),
      blockTradeShare: trades.length
        ? r1((100 * trades.filter((t) => t.block >= 3).length) / trades.length)
        : null,
      avgLeadDays: r1(avg(trades.map((t) => t.lead))),
      closedPositions: gains.length,
      avgGain: r1(avg(gains)),
    },
    lead: LEAD.map(([, , label], b) => ({
      label,
      publicAvg: r1(avg(leadPub[b])),
      saleAvg: r1(avg(leadSale[b])),
      tradeAvg: r1(avg(leadTrade[b])),
      days: leadPub[b].length,
      trades: leadTrade[b].length,
    })),
  };
}
