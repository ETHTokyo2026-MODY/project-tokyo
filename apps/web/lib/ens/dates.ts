/** Days since 1970-01-01 UTC. Tokyo service day is (timestamp + 9h) / 86400. */
export function tokyoDay(timestampSec: number): number {
  return Math.floor((timestampSec + 9 * 3600) / 86400);
}

export function dateLabel(day: number): string {
  const [y, m, d] = civilFromDays(day);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDateLabel(label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) throw new Error('invalid date');
  const year = Number(label.slice(0, 4));
  const month = Number(label.slice(5, 7));
  const dom = Number(label.slice(8, 10));
  const z = daysFromCivil(year, month, dom);
  if (dateLabel(z) !== label) throw new Error('invalid date');
  return z;
}

function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2 ? 1 : 0;
  return [y, m, d];
}

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
