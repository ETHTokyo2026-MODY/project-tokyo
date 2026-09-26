import { dayNum } from './dates';
import type { Curve, Day } from './types';

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Curve value at a fractional day number, clamped at min. */
export function curveValueX(curve: Curve, x: number): number {
  const pts = curve.points;
  const n = pts.length;
  if (n === 1 || x <= dayNum(pts[0].date)) {
    return Math.max(curve.min, pts[0].price);
  }
  if (x >= dayNum(pts[n - 1].date)) {
    return Math.max(curve.min, pts[n - 1].price);
  }
  let i = 0;
  while (x > dayNum(pts[i + 1].date)) i++;
  const x0 = dayNum(pts[i].date);
  const x1 = dayNum(pts[i + 1].date);
  const t = (x - x0) / (x1 - x0);
  return Math.max(
    curve.min,
    pts[i].price + (pts[i + 1].price - pts[i].price) * easeInOut(t),
  );
}

export function curveValue(curve: Curve, date: string): number {
  return curveValueX(curve, dayNum(date));
}

export function seedCurve(
  date: string,
  startPrice: number,
  today: string,
  min = 40,
): Curve {
  const start = Math.max(min, startPrice);
  if (date === today) return { min, points: [{ date, price: start }] };
  return {
    min,
    points: [
      { date: today, price: start },
      { date, price: min },
    ],
  };
}

/** Restart the curve at today, move earlier points to `past`, set `day.price`. */
export function priceFromCurve(day: Day, today: string): void {
  const curve = day.curve;
  if (!curve) return;
  const v = Math.round(curveValue(curve, today));
  const gone = curve.points.filter((p) => p.date < today);
  if (gone.length) curve.past = [...(curve.past || []), ...gone];
  curve.points = [
    { date: today, price: v },
    ...curve.points.filter((p) => p.date > today),
  ];
  day.price = v;
}
