'use client';

import { useEffect, useRef } from 'react';
import { addDays } from '@/lib/demo/dates';
import { shortDate } from '@/lib/demo/format';
import type { AssetStats } from '@/lib/demo/stats';

function svgEl(
  tag: string,
  attrs: Record<string, string | number>,
  parent: SVGElement,
) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
}

function bars(
  svg: SVGSVGElement,
  labels: string[],
  groups: {
    label: string;
    color: string;
    vals: (number | null)[];
    note?: (number | null)[];
  }[],
  fmt: (v: number) => string,
) {
  svg.innerHTML = '';
  const W = svg.clientWidth || 500;
  const H = 220;
  const L = 46;
  const R = 8;
  const T = 18;
  const B = 34;
  const pw = W - L - R;
  const ph = H - T - B;
  const all = groups
    .flatMap((g) => g.vals)
    .filter((v): v is number => v != null);
  if (!all.length) {
    svgEl(
      'text',
      { x: W / 2, y: H / 2, 'text-anchor': 'middle' },
      svg,
    ).textContent = 'No data yet';
    return;
  }
  const hi = Math.ceil((Math.max(...all) * 1.15) / 10) * 10 || 10;
  const yOf = (v: number) => T + ph - (v / hi) * ph;
  for (let k = 0; k <= 4; k++) {
    const v = (hi * k) / 4;
    svgEl(
      'line',
      { x1: L, x2: L + pw, y1: yOf(v), y2: yOf(v), stroke: '#eef0f3' },
      svg,
    );
    svgEl(
      'text',
      { x: L - 5, y: yOf(v) + 4, 'text-anchor': 'end' },
      svg,
    ).textContent = fmt(v);
  }
  const bw = pw / labels.length;
  const gw = Math.min(28, (bw * 0.8) / groups.length);
  labels.forEach((lab, i) => {
    groups.forEach((g, j) => {
      const v = g.vals[i];
      if (v == null) return;
      const x = L + i * bw + (bw - gw * groups.length) / 2 + j * gw;
      svgEl(
        'rect',
        {
          x,
          y: yOf(v),
          width: gw - 2,
          height: T + ph - yOf(v),
          fill: g.color,
          rx: 2,
        },
        svg,
      );
      if (g.note && g.note[i] != null) {
        svgEl(
          'text',
          { x: x + gw / 2 - 1, y: yOf(v) - 4, 'text-anchor': 'middle' },
          svg,
        ).textContent = String(g.note[i]);
      }
    });
    if (labels.length <= 16 || i % Math.ceil(labels.length / 12) === 0) {
      svgEl(
        'text',
        { x: L + i * bw + bw / 2, y: H - 16, 'text-anchor': 'middle' },
        svg,
      ).textContent = lab;
    }
  });
  groups.forEach((g, j) => {
    svgEl(
      'rect',
      { x: L + j * 120, y: H - 10, width: 10, height: 8, fill: g.color },
      svg,
    );
    svgEl('text', { x: L + 14 + j * 120, y: H - 2 }, svg).textContent = g.label;
  });
}

export function VolumeChart({
  stats,
  by,
}: {
  stats: AssetStats;
  by: 'day' | 'week';
}) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const draw = () => {
      let rows = stats.volume[by === 'day' ? 'byDay' : 'byWeek'];
      if (by === 'day') {
        const m = Object.fromEntries(rows.map((r) => [r.start, r]));
        rows = Array.from({ length: 30 }, (_, k) =>
          addDays(stats.today, k - 29),
        ).map((d) => m[d] || { start: d, count: 0, usd: 0 });
      }
      bars(
        svg,
        rows.map((r) => shortDate(r.start)),
        [
          {
            label: '$ volume (count on top)',
            color: '#2563eb',
            vals: rows.map((r) => r.usd),
            note: rows.map((r) => (r.count ? r.count : null)),
          },
        ],
        (v) => '$' + Math.round(v),
      );
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [by, stats]);
  return (
    <div className="chart">
      <svg ref={ref} height={220} />
    </div>
  );
}

export function LeadChart({ stats }: { stats: AssetStats }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const draw = () => {
      bars(
        svg,
        stats.lead.map((b) => b.label),
        [
          {
            label: 'Public price',
            color: '#2563eb',
            vals: stats.lead.map((b) => b.publicAvg),
          },
          {
            label: 'Sale price',
            color: '#d97706',
            vals: stats.lead.map((b) => b.saleAvg),
          },
          {
            label: 'Trade price',
            color: '#111827',
            vals: stats.lead.map((b) => b.tradeAvg),
          },
        ],
        (v) => '$' + Math.round(v),
      );
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [stats]);
  return (
    <div className="chart">
      <svg ref={ref} height={220} />
    </div>
  );
}
