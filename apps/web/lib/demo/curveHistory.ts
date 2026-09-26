import { addDays, dayNum } from './dates';
import { mulberry32 } from './rng';
import type { Curve, CurvePoint } from './types';

export const LIFE = 365;

export function listingDate(day: string): string {
  return addDays(day, -LIFE);
}

export function windowStart(day: string, today: string): string {
  const listed = listingDate(day);
  return listed > today ? today : listed;
}

export function seededHistory(
  start: string,
  endDate: string,
  endPrice: number,
  day: string,
): CurvePoint[] {
  const s = dayNum(start);
  const e = dayNum(endDate);
  const span = e - s;
  if (span <= 0 || !(endPrice > 0)) return [];
  const rnd = mulberry32(38 * 100003 + dayNum(day));
  const drift = 0.05 + rnd() * 0.12;
  const steps = Math.max(1, Math.round(span / 30));
  const pts: CurvePoint[] = [];
  for (let k = 0; k <= steps; k++) {
    const f = 1 - k / steps;
    let p =
      endPrice *
      (1 + drift * f) *
      (1 + (rnd() - 0.5) * 0.06 * Math.min(1, f * 3));
    if (k > 0 && k < steps && rnd() < 0.15) p *= 1.08 + rnd() * 0.07;
    pts.push({
      date: addDays(start, Math.round((span * k) / steps)),
      price: k === steps ? endPrice : Math.round(p),
    });
  }
  return pts;
}

export function historyPoints({
  day,
  start,
  today,
  past,
  finalPrice,
  seededOn,
  base,
  curve,
  publicPrice,
}: {
  day: string;
  start: string;
  today: string;
  past: boolean;
  finalPrice: number;
  seededOn: string;
  base: number;
  curve?: Curve;
  publicPrice: number;
}): CurvePoint[] {
  const seeded = curve
    ? seededHistory(start, seededOn, base, day)
    : seededHistory(start, day, finalPrice, day);
  const pts = [...seeded, ...((curve && curve.past) || [])];
  if (curve) pts.push(...curve.points.filter((p) => p.date < today));
  pts.push(
    past
      ? { date: day, price: finalPrice }
      : { date: today, price: publicPrice },
  );
  const byDate = new Map<string, number>();
  for (const p of pts) if (p.date >= start) byDate.set(p.date, p.price);
  return [...byDate.keys()]
    .sort()
    .map((date) => ({ date, price: byDate.get(date)! }));
}
