export const MONTHS_AHEAD = 24;

export function todayTokyo(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(
    now,
  );
}

export function toUTC(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmt(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  const dt = toUTC(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt);
}

/** 0 = Sun … 6 = Sat */
export function weekday(s: string): number {
  return toUTC(s).getUTCDay();
}

/** UTC days since epoch */
export function dayNum(s: string): number {
  return toUTC(s).getTime() / 864e5;
}

/** Last day of the month 24 months after today's month. */
export function calendarEnd(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return fmt(new Date(Date.UTC(y, m + MONTHS_AHEAD, 0)));
}
