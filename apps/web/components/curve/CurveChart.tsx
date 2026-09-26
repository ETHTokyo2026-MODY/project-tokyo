'use client';

import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { curveValue, curveValueX } from '@/lib/demo/curve';
import {
  historyPoints,
  listingDate,
  windowStart,
} from '@/lib/demo/curveHistory';
import { addDays, dayNum } from '@/lib/demo/dates';
import type { Curve, Day } from '@/lib/demo/types';

const MON = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const label = (s: string) =>
  `${MON[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8))}`;

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

type Geo = {
  first: string;
  N: number;
  iT: number;
  L: number;
  pw: number;
  T: number;
  ph: number;
  lo: number;
  hi: number;
  xOf: (i: number) => number;
  yOf: (p: number) => number;
  valueAt: (i: number) => number;
  iAt: (x: number) => number;
  priceAt: (py: number) => number;
  guide: SVGLineElement;
  dot: SVGCircleElement;
};

export function CurveChart({
  day,
  dayDate,
  today,
  seededOn,
  curve,
  editable,
  selDate,
  drag,
  frozen,
  onPickPoint,
  onStartDrag,
  onAddPoint,
  onClearSel,
  onMovePoint,
  onDragEnd,
  onRemove,
}: {
  day: Day;
  dayDate: string;
  today: string;
  seededOn: string;
  curve: Curve;
  editable: boolean;
  selDate: string | null;
  drag: { date: string; moved: boolean } | null;
  frozen: [number, number] | null;
  onPickPoint: (date: string) => void;
  onStartDrag: (lo: number, hi: number) => void;
  onAddPoint: (date: string, price: number) => void;
  onClearSel: () => void;
  onMovePoint: (date: string, price: number, nextDate: string) => void;
  onDragEnd: () => void;
  onRemove: (date: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const geoRef = useRef<Geo | null>(null);
  const past = dayDate < today;
  const booked = day.status === 'booked';

  const draw = useCallback(() => {
    const svg = svgRef.current;
    const tip = tipRef.current;
    if (!svg) return;
    svg.innerHTML = '';
    svg.classList.toggle('edit', editable);
    const finalPrice =
      day.status === 'booked' || day.price > 0
        ? day.price
        : day.curve
          ? Math.round(curveValue(day.curve, dayDate))
          : day.base;
    const listed = day.token ? curve.points[0].date : listingDate(dayDate);
    const first = day.token
      ? curve.points[0].date
      : windowStart(dayDate, today);
    const N = dayNum(dayDate) - dayNum(first);
    const s0 = dayNum(first);
    const iT = past ? N : dayNum(today) - s0;
    const hist = {
      min: 0,
      points: day.token
        ? curve.points
        : historyPoints({
            day: dayDate,
            start: first,
            today,
            past,
            finalPrice,
            seededOn,
            base: day.base,
            curve: day.curve,
            publicPrice: day.price,
          }),
    };
    const c =
      booked && !day.token
        ? {
            min: 0,
            points: [
              { date: today, price: day.price },
              { date: dayDate, price: day.price },
            ],
          }
        : curve;
    const valueAt = (i: number) =>
      i < iT || past ? curveValueX(hist, s0 + i) : curveValueX(c, s0 + i);
    const futPts = past ? [] : c.points;
    const W = svg.clientWidth;
    const H = svg.clientHeight;
    const L = 64;
    const R = 36;
    const T = 30;
    const B = 44;
    const pw = W - L - R;
    const ph = H - T - B;
    let lo: number;
    let hi: number;
    if (drag && frozen) [lo, hi] = frozen;
    else {
      const all = [...hist.points, ...futPts].map((p) => p.price);
      const top = Math.max(...all, c.min + 10);
      lo = Math.max(
        0,
        Math.floor(
          (Math.min(past || booked ? Infinity : c.min, ...all) - 15) / 10,
        ) * 10,
      );
      hi = Math.ceil((top * 1.12) / 10) * 10;
    }
    const xOf = (i: number) => L + (N ? (i / N) * pw : pw / 2);
    const yOf = (p: number) => T + ((hi - p) / (hi - lo)) * ph;
    const g = svgEl('g', { class: 'grid' }, svg);
    const ax = svgEl('g', { class: 'axis' }, svg);
    const step = [5, 10, 20, 25, 50, 100, 200, 500].find(
      (s) => (hi - lo) / s <= 8,
    )!;
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      svgEl('line', { x1: L, x2: L + pw, y1: yOf(p), y2: yOf(p) }, g);
      svgEl(
        'text',
        { x: L - 8, y: yOf(p) + 4, 'text-anchor': 'end' },
        ax,
      ).textContent = '$' + p;
    }
    const pxMonth = pw / Math.max(1, N / 30.4);
    const every = pxMonth >= 70 ? 1 : pxMonth >= 36 ? 2 : 3;
    let [my, mm] = first.split('-').map(Number);
    let shown = 0;
    for (;;) {
      mm++;
      if (mm > 12) {
        mm = 1;
        my++;
      }
      const ds = `${my}-${String(mm).padStart(2, '0')}-01`;
      const i = dayNum(ds) - s0;
      if (i > N) break;
      if ((my * 12 + mm) % every) continue;
      svgEl('line', { x1: xOf(i), x2: xOf(i), y1: T, y2: T + ph }, g);
      svgEl(
        'text',
        { x: xOf(i), y: T + ph + 20, 'text-anchor': 'middle' },
        ax,
      ).textContent = MON[mm - 1] + (shown++ === 0 || mm === 1 ? ' ' + my : '');
    }
    const y = Number(dayDate.slice(0, 4));
    svgEl(
      'text',
      { x: L + pw / 2, y: T + ph + 40, 'text-anchor': 'middle' },
      ax,
    ).textContent = day.token
      ? `Authored public-price curve through ${label(dayDate)}, ${y}; booking history is not indexed`
      : listed > today
        ? `listing price on each day from today until ${label(dayDate)}, ${y} (listed ${label(listed)}, ${listed.slice(0, 4)}: no history yet)`
        : `listing price on each day, from listing (${label(first)}, ${first.slice(0, 4)}) until ${label(dayDate)}, ${y}`;
    if (!past && !booked) {
      svgEl(
        'line',
        {
          class: 'minline',
          x1: xOf(iT),
          x2: L + pw,
          y1: yOf(c.min),
          y2: yOf(c.min),
        },
        svg,
      );
      svgEl(
        'text',
        {
          x: Math.min(xOf(iT) + 6, L + pw - 60),
          y: yOf(c.min) - 6,
          'text-anchor': 'start',
          fill: '#dc2626',
          'font-size': 13,
        },
        svg,
      ).textContent = `min $${c.min}`;
    }
    const path = (i0: number, i1: number, fn: (i: number) => number) => {
      const n = Math.max(
        2,
        Math.min(Math.round((xOf(i1) - xOf(i0)) / 2), (i1 - i0) * 12 || 2),
      );
      let dA = '';
      for (let k = 0; k <= n; k++) {
        const iF = i0 + ((i1 - i0) * k) / n;
        dA +=
          (k ? 'L' : 'M') + xOf(iF).toFixed(1) + ',' + yOf(fn(iF)).toFixed(1);
      }
      return dA;
    };
    const histD = path(0, iT, (i) => curveValueX(hist, s0 + i));
    svgEl(
      'path',
      {
        d: histD + `L${xOf(iT)},${T + ph}L${xOf(0)},${T + ph}Z`,
        fill: 'rgba(107,114,128,.07)',
      },
      svg,
    );
    svgEl('path', { class: 'curve past', d: histD }, svg);
    if (!past) {
      const futD = path(iT, N, (i) => curveValueX(c, s0 + i));
      svgEl(
        'path',
        {
          d: futD + `L${xOf(N)},${T + ph}L${xOf(iT)},${T + ph}Z`,
          fill: 'rgba(37,99,235,.07)',
        },
        svg,
      );
      svgEl(
        'path',
        { class: 'curve' + (booked ? ' locked' : ''), d: futD },
        svg,
      );
      if (editable) svgEl('path', { class: 'hit', d: futD, id: 'hit' }, svg);
      svgEl(
        'line',
        {
          class: 'todayline',
          'pointer-events': 'none',
          x1: xOf(iT),
          x2: xOf(iT),
          y1: T - 8,
          y2: T + ph,
        },
        svg,
      );
      svgEl(
        'text',
        {
          class: 'todaylbl',
          x: xOf(iT),
          y: T - 12,
          'text-anchor': iT > N - 4 ? 'end' : iT < 4 ? 'start' : 'middle',
        },
        svg,
      ).textContent = 'Today';
    }
    if (!past && !booked) {
      for (const p of futPts) {
        const i = dayNum(p.date) - s0;
        svgEl(
          'circle',
          {
            class: 'pt' + (p.date === selDate ? ' sel' : ''),
            cx: xOf(i),
            cy: yOf(p.price),
            r: editable ? 6 : 4,
            'data-date': p.date,
          },
          svg,
        );
      }
    }
    const guide = svgEl(
      'line',
      {
        x1: 0,
        x2: 0,
        y1: T,
        y2: T + ph,
        stroke: '#9ca3af',
        'stroke-dasharray': '3 3',
        visibility: 'hidden',
        'pointer-events': 'none',
      },
      svg,
    ) as SVGLineElement;
    const dot = svgEl(
      'circle',
      {
        r: 5,
        fill: '#111827',
        visibility: 'hidden',
        'pointer-events': 'none',
      },
      svg,
    ) as SVGCircleElement;
    geoRef.current = {
      first,
      N,
      iT,
      L,
      pw,
      T,
      ph,
      lo,
      hi,
      xOf,
      yOf,
      valueAt,
      iAt: (x) => (N ? ((x - L) / pw) * N : 0),
      priceAt: (py) => hi - ((py - T) / ph) * (hi - lo),
      guide,
      dot,
    };
    void tip;
  }, [
    booked,
    curve,
    day,
    dayDate,
    drag,
    editable,
    frozen,
    past,
    seededOn,
    selDate,
    today,
  ]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  const localXY = (e: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const showTip = (
    x: number,
    y: number,
    date: string,
    price: number,
    hist?: boolean,
  ) => {
    const tip = tipRef.current;
    const svg = svgRef.current;
    const geo = geoRef.current;
    if (!tip || !svg || !geo) return;
    tip.textContent = `${label(date)}, ${date.slice(0, 4)} · $${price}${hist ? ' (past)' : ''}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 12, svg.clientWidth - 190) + 'px';
    tip.style.top = Math.max(0, y - 34) + 'px';
    geo.guide.setAttribute('x1', String(x));
    geo.guide.setAttribute('x2', String(x));
    geo.guide.setAttribute('visibility', 'visible');
    geo.dot.setAttribute('cx', String(x));
    geo.dot.setAttribute('cy', String(y));
    geo.dot.setAttribute('visibility', 'visible');
  };

  const hideTip = () => {
    const tip = tipRef.current;
    const geo = geoRef.current;
    if (tip) tip.style.display = 'none';
    if (geo) {
      geo.guide.setAttribute('visibility', 'hidden');
      geo.dot.setAttribute('visibility', 'hidden');
    }
  };

  return (
    <div id="wrap">
      <svg
        id="chart"
        ref={svgRef}
        className={editable ? 'edit' : undefined}
        onPointerDown={(e) => {
          if (!editable || e.button !== 0) return;
          const [x] = localXY(e);
          const t = e.target as SVGElement;
          if (t.classList.contains('pt')) {
            const date = t.getAttribute('data-date')!;
            onPickPoint(date);
            const geo = geoRef.current;
            if (geo) onStartDrag(geo.lo, geo.hi);
            svgRef.current?.setPointerCapture(e.pointerId);
          } else if (t.id === 'hit') {
            const geo = geoRef.current;
            if (!geo) return;
            const i = Math.round(geo.iAt(x));
            const date = addDays(geo.first, i);
            if (i <= geo.iT || i >= geo.N) return;
            if (curve.points.some((p) => p.date === date)) return;
            onAddPoint(date, Math.round(curveValue(curve, date)));
          } else onClearSel();
        }}
        onPointerMove={(e) => {
          const [x, y] = localXY(e);
          const geo = geoRef.current;
          if (drag) {
            const geo = geoRef.current;
            if (!geo) return;
            const idx = curve.points.findIndex((p) => p.date === drag.date);
            const p = curve.points[idx];
            if (!p) return;
            const price = Math.min(
              10000,
              Math.max(curve.min, Math.round(geo.priceAt(y))),
            );
            let date = p.date;
            if (idx > 0 && idx < curve.points.length - 1) {
              const loN = dayNum(curve.points[idx - 1].date) + 1;
              const hiN = dayNum(curve.points[idx + 1].date) - 1;
              const n = Math.min(
                hiN,
                Math.max(loN, Math.round(dayNum(geo.first) + geo.iAt(x))),
              );
              date = new Date(n * 864e5).toISOString().slice(0, 10);
            }
            if (price !== p.price || date !== p.date) {
              onMovePoint(drag.date, price, date);
            }
            showTip(x, y, date, price);
            return;
          }
          if (!geo) return;
          const i = Math.round(geo.iAt(x));
          if (x < geo.L - 10 || x > geo.L + geo.pw + 10 || i < 0 || i > geo.N) {
            hideTip();
            return;
          }
          const v = geo.valueAt(i);
          showTip(
            geo.xOf(i),
            geo.yOf(v),
            addDays(geo.first, i),
            Math.round(v),
            i < geo.iT,
          );
        }}
        onPointerUp={() => onDragEnd()}
        onPointerLeave={() => {
          if (!drag) hideTip();
        }}
        onContextMenu={(e) => {
          const t = e.target as SVGElement;
          if (t.classList.contains('pt')) {
            e.preventDefault();
            onRemove(t.getAttribute('data-date')!);
          }
        }}
      />
      <div id="tip" ref={tipRef} />
    </div>
  );
}
