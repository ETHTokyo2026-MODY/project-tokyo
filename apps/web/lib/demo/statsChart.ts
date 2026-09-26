import { addDays, dayNum } from './dates';
import { mulberry32 } from './rng';
import type { AssetType } from './types';
import type { AssetStats } from './stats';

export type Tool = {
  id: string;
  name: string;
  types: AssetType[];
  color: string;
  rule: (
    p: number,
    t: { i: number; wd: number; doy: number; lead: number; r: number },
  ) => number;
};

export const TOOLS: Tool[] = [
  {
    id: 'pricelabs',
    name: 'PriceLabs',
    types: ['airbnb', 'hotel room'],
    color: '#7c3aed',
    rule: (p, t) =>
      p *
      (1 +
        0.06 * Math.sin((2 * Math.PI * (t.doy - 80)) / 365) +
        (t.wd === 5 || t.wd === 6 ? 0.05 : 0)) *
      (t.lead >= 0 && t.lead < 7 ? 0.9 : 1),
  },
  {
    id: 'wheelhouse',
    name: 'Wheelhouse',
    types: ['airbnb', 'hotel room'],
    color: '#0891b2',
    rule: (p, t) =>
      p *
      (1.03 + 0.04 * Math.sin((2 * Math.PI * (t.doy - 120)) / 365)) *
      (t.r < 0.04 ? 1.25 : 1),
  },
  {
    id: 'beyond',
    name: 'Beyond',
    types: ['airbnb', 'hotel room'],
    color: '#db2777',
    rule: (p, t) => p * (1.02 + 0.03 * Math.sin((2 * Math.PI * t.i) / 30)),
  },
  {
    id: 'smart',
    name: 'Airbnb Smart Pricing',
    types: ['airbnb'],
    color: '#e11d48',
    rule: (p) => p * 0.84,
  },
  {
    id: 'turo',
    name: 'Turo dynamic pricing',
    types: ['car'],
    color: '#0d9488',
    rule: (p, t) =>
      p *
      (0.97 + 0.05 * Math.sin((2 * Math.PI * (t.doy - 150)) / 365)) *
      (t.lead >= 0 && t.lead <= 1 ? 1.05 : 1),
  },
];

export const LINES = [
  {
    key: 'predicted',
    label: 'Predicted (demo model)',
    color: '#6b7280',
    dash: '6 4',
    on: true,
  },
  {
    key: 'listed',
    label: 'Listed price (curve today)',
    color: '#2563eb',
    on: true,
  },
  {
    key: 'sale',
    label: 'Sale price (for trading)',
    color: '#d97706',
    on: false,
  },
  {
    key: 'actual',
    label: 'Actual booked price',
    color: '#16a34a',
    on: true,
  },
  {
    key: 'trades',
    label: 'Trade prices (dots)',
    color: '#111827',
    on: true,
  },
] as const;

export function hash(s: string): number {
  return [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
}

export function toolSeries(tool: Tool, stats: AssetStats): (number | null)[] {
  const rnd = mulberry32(hash(tool.id + stats.scope));
  return stats.series.predicted.map((p, i) => {
    const date = addDays(stats.first, i);
    const dt = new Date(date + 'T00:00:00Z');
    const t = {
      i,
      wd: dt.getUTCDay(),
      doy: dayNum(date) - dayNum(date.slice(0, 4) + '-01-01'),
      lead: dayNum(date) - dayNum(stats.today),
      r: rnd(),
    };
    const noise = 1 + (rnd() - 0.5) * 0.04;
    return p == null ? null : Math.round(tool.rule(p, t) * noise * 10) / 10;
  });
}

export function smooth(
  vals: (number | null)[],
  on: boolean,
): (number | null)[] {
  if (!on) return vals;
  return vals.map((v, i) => {
    let s = 0;
    let c = 0;
    for (let k = i - 3; k <= i + 3; k++) {
      if (vals[k] != null) {
        s += vals[k]!;
        c++;
      }
    }
    return c && (v != null || c >= 3) ? s / c : null;
  });
}
