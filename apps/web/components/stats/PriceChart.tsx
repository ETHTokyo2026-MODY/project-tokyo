'use client';

import { useEffect, useRef } from 'react';
import { addDays, dayNum } from '@/lib/demo/dates';
import { longDate, money, MONTHS } from '@/lib/demo/format';
import { LINES, smooth, TOOLS, toolSeries } from '@/lib/demo/statsChart';
import type { AssetStats } from '@/lib/demo/stats';

const MON = MONTHS.map((m) => m.slice(0, 3));

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

export function PriceChart({
  stats,
  range,
  doSmooth,
  lineOn,
  toolOn,
}: {
  stats: AssetStats;
  range: string;
  doSmooth: boolean;
  lineOn: Record<string, boolean>;
  toolOn: Record<string, boolean>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const tip = tipRef.current;
    if (!svg || !tip) return;
    const draw = () => {
      svg.innerHTML = '';
      const W = svg.clientWidth || 1000;
      const H = 380;
      const L = 52;
      const R = 14;
      const T = 12;
      const B = 30;
      const pw = W - L - R;
      const ph = H - T - B;
      const x0 = range === 'next' ? dayNum(stats.today) : dayNum(stats.first);
      const x1 =
        range === 'year'
          ? dayNum(stats.today) + 90
          : range === 'next'
            ? dayNum(stats.today) + 365
            : dayNum(stats.first) + stats.series.predicted.length - 1;
      const i0 = x0 - dayNum(stats.first);
      const i1 = x1 - dayNum(stats.first);
      const types = new Set(stats.assets.map((a) => a.type));
      const series: {
        label: string;
        color: string;
        dash?: string;
        vals: (number | null)[];
      }[] = [];
      for (const l of LINES) {
        if (l.key !== 'trades' && lineOn[l.key]) {
          series.push({
            label: l.label,
            color: l.color,
            dash: 'dash' in l ? l.dash : undefined,
            vals: smooth(
              stats.series[l.key as 'predicted' | 'listed' | 'actual' | 'sale'],
              doSmooth,
            ),
          });
        }
      }
      for (const t of TOOLS) {
        if (toolOn[t.id] && t.types.some((x) => types.has(x))) {
          series.push({
            label: `${t.name} (sample data, not from ${t.name})`,
            color: t.color,
            dash: '2 3',
            vals: smooth(toolSeries(t, stats), doSmooth),
          });
        }
      }
      const dots = lineOn.trades
        ? stats.trades.filter(
            (t) => dayNum(t.date) >= x0 && dayNum(t.date) <= x1,
          )
        : [];
      const ys = [
        ...series.flatMap((s) =>
          s.vals.slice(i0, i1 + 1).filter((v): v is number => v != null),
        ),
        ...dots.map((d) => d.price),
      ];
      const lo = ys.length
        ? Math.max(0, Math.floor((Math.min(...ys) * 0.9) / 10) * 10)
        : 0;
      const hi = ys.length
        ? Math.ceil((Math.max(...ys) * 1.08) / 10) * 10
        : 100;
      const xOf = (x: number) => L + ((x - x0) / Math.max(1, x1 - x0)) * pw;
      const yOf = (v: number) => T + ((hi - v) / (hi - lo || 1)) * ph;
      const g = svgEl('g', { class: 'grid' }, svg);
      const step =
        [5, 10, 20, 25, 50, 100, 200].find((s) => (hi - lo) / s <= 7) || 500;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        svgEl('line', { x1: L, x2: L + pw, y1: yOf(v), y2: yOf(v) }, g);
        svgEl(
          'text',
          { x: L - 6, y: yOf(v) + 4, 'text-anchor': 'end' },
          svg,
        ).textContent = '$' + v;
      }
      const months = (x1 - x0) / 30.4;
      const every = months <= 14 ? 1 : months <= 28 ? 2 : 3;
      let d = new Date(x0 * 864e5);
      d = new Date(
        Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth() + (d.getUTCDate() === 1 ? 0 : 1),
          1,
        ),
      );
      let first = true;
      while (d.getTime() / 864e5 <= x1) {
        if (d.getUTCMonth() % every === 0) {
          const x = xOf(d.getTime() / 864e5);
          svgEl('line', { x1: x, x2: x, y1: T, y2: T + ph }, g);
          svgEl(
            'text',
            { x, y: H - 10, 'text-anchor': 'middle' },
            svg,
          ).textContent =
            MON[d.getUTCMonth()] +
            (first || d.getUTCMonth() === 0 ? ' ' + d.getUTCFullYear() : '');
          first = false;
        }
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      }
      const tx = dayNum(stats.today);
      if (tx >= x0 && tx <= x1) {
        svgEl(
          'line',
          {
            x1: xOf(tx),
            x2: xOf(tx),
            y1: T,
            y2: T + ph,
            stroke: '#111827',
            'stroke-dasharray': '4 4',
          },
          svg,
        );
        svgEl(
          'text',
          { x: xOf(tx) + 4, y: T + 12, fill: '#111827', 'font-weight': 700 },
          svg,
        ).textContent = 'Today';
      }
      for (const s of series) {
        let dA = '';
        let pen = false;
        for (
          let i = Math.max(0, i0);
          i <= Math.min(i1, s.vals.length - 1);
          i++
        ) {
          const v = s.vals[i];
          if (v == null) {
            pen = false;
            continue;
          }
          dA +=
            (pen ? 'L' : 'M') +
            xOf(dayNum(stats.first) + i).toFixed(1) +
            ',' +
            yOf(v).toFixed(1);
          pen = true;
        }
        svgEl(
          'path',
          {
            d: dA,
            fill: 'none',
            stroke: s.color,
            'stroke-width': 2,
            'stroke-dasharray': s.dash || '',
          },
          svg,
        );
      }
      for (const t of dots) {
        svgEl(
          'circle',
          {
            cx: xOf(dayNum(t.date)),
            cy: yOf(t.price),
            r: 3.5,
            fill: '#111827',
            opacity: 0.75,
          },
          svg,
        );
      }
      const guide = svgEl(
        'line',
        { y1: T, y2: T + ph, stroke: '#9ca3af', visibility: 'hidden' },
        svg,
      );
      svg.onmousemove = (e) => {
        const r = svg.getBoundingClientRect();
        const x = e.clientX - r.left;
        const dx = Math.round(x0 + ((x - L) / pw) * (x1 - x0));
        if (x < L || x > L + pw) {
          guide.setAttribute('visibility', 'hidden');
          tip.style.display = 'none';
          return;
        }
        const i = dx - dayNum(stats.first);
        const date = addDays(stats.first, i);
        guide.setAttribute('x1', String(xOf(dx)));
        guide.setAttribute('x2', String(xOf(dx)));
        guide.setAttribute('visibility', 'visible');
        const rows = series
          .map((s) =>
            s.vals[i] != null
              ? `<span style="color:${s.color}">■</span> ${s.label}: ${money(s.vals[i]!)}`
              : '',
          )
          .filter(Boolean);
        const tr = stats.trades
          .filter((t) => t.date === date)
          .map((t) => `● trade ${money(t.price)} (${t.lead} days before)`);
        tip.innerHTML = `<b>${longDate(date)}</b><br>${[...rows, ...tr].join('<br>') || 'no data'}`;
        tip.style.display = 'block';
        tip.style.left = Math.min(x + 12, W - 330) + 'px';
        tip.style.top = '8px';
      };
      svg.onmouseleave = () => {
        guide.setAttribute('visibility', 'hidden');
        tip.style.display = 'none';
      };
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [doSmooth, lineOn, range, stats, toolOn]);

  return (
    <div className="chart" id="priceChart">
      <svg ref={svgRef} height={380} />
      <div className="tip" ref={tipRef} />
    </div>
  );
}
