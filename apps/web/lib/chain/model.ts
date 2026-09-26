import type { Asset, AssetType, DemoState } from '../demo/types';
import { dayNum } from '../demo/dates';

export function parseUSDC(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text))
    throw new Error('Enter USD with up to six decimal places');
  const [whole, fraction = ''] = text.split('.');
  return (
    BigInt(whole) * BigInt(1000000) +
    BigInt(fraction.padEnd(6, '0'))
  ).toString();
}
export function usdText(raw: string): string {
  const n = BigInt(raw);
  return `${n / BigInt(1000000)}${n % BigInt(1000000) ? `.${(n % BigInt(1000000)).toString().padStart(6, '0').replace(/0+$/, '')}` : ''}`;
}
export const dayDate = (day: number) =>
  new Date(day * 86400000).toISOString().slice(0, 10);
export function exactDay(date: unknown): number {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('Select a calendar day');
  const n = dayNum(date);
  if (!Number.isInteger(n) || dayDate(n) !== date)
    throw new Error('Invalid calendar date');
  return n;
}
export type ChainDay = {
  day: number;
  token: string;
  owner: string;
  deployed: boolean;
  listed: boolean;
  saleNonce: string;
  booked: boolean;
  listedPrice: string;
  sellingPrice: string;
};
export type ChainCalendar = {
  address: string;
  host: string;
  startDay: number;
  endDayExclusive: number;
  metadataURI: string;
  discounts: { minDays: number; discountBps: number }[];
  discountVersion: string;
  days: ChainDay[];
};
export type ChainTrade = {
  asset: string;
  day: number;
  token: string;
  buyer: string;
  seller: string | null;
  payment: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: string;
  bidHash: string;
  askHash: string;
  rangeLength: number;
};
export type ChainSnapshot = {
  history?: ChainTrade[];
  ready: boolean;
  indexing?: boolean;
  today: number;
  calendars: ChainCalendar[];
  wallet?: string;
  usdcBalance?: string;
  blockNumber: string;
  blockHash: string;
  bids?: {
    id?: string;
    hash?: string;
    buyer: string;
    asset: string;
    startDay: number;
    endDayExclusive: number;
    maxTotal: string;
    nonce: string;
  }[];
};

export function chainState(snapshot: ChainSnapshot, wallet: string): DemoState {
  const accounts: DemoState['accounts'] = {};
  const addAccount = (id: string) => {
    accounts[id] ??= {
      name: id ? `${id.slice(0, 6)}…${id.slice(-4)}` : 'Connect a wallet',
      role: 'Trader',
      cash: 0,
      startCash: 0,
    };
  };
  addAccount(wallet);
  accounts[wallet].cash = Number(usdText(snapshot.usdcBalance ?? '0'));
  const assets: Asset[] = snapshot.calendars.map((calendar) => {
    let meta: { title?: string; type?: AssetType; location?: string } = {};
    try {
      meta = JSON.parse(calendar.metadataURI);
    } catch {
      /* URI-only metadata has no fetched description. */
    }
    const provider = calendar.host.toLowerCase();
    addAccount(provider);
    accounts[provider].role = 'Host';
    const days = calendar.days.map((d) => {
      const owner = d.owner.toLowerCase();
      addAccount(owner);
      return {
        date: dayDate(d.day),
        weekday: (d.day + 4) % 7,
        base: Number(usdText(d.listedPrice)),
        price: Number(usdText(d.listedPrice)),
        salePrice: Number(usdText(d.sellingPrice)),
        listedPriceRaw: d.listedPrice,
        sellingPriceRaw: d.sellingPrice,
        token: d.token,
        owner,
        listed: d.listed && d.day >= snapshot.today,
        status: d.booked ? ('booked' as const) : ('open' as const),
        history: [],
        settlements: snapshot.history
          ?.filter(
            (h) =>
              h.asset.toLowerCase() === calendar.address.toLowerCase() &&
              h.day === d.day,
          )
          .map((h) => ({
            buyer: h.buyer.toLowerCase(),
            seller: h.seller?.toLowerCase() ?? null,
            priceRaw: h.payment,
            price: Number(usdText(h.payment)),
            at: new Date(Number(h.timestamp) * 1000).toISOString(),
            transactionHash: h.transactionHash,
            rangeLength: h.rangeLength,
          })),
      };
    });
    return {
      chain: true,
      id: calendar.address.toLowerCase(),
      provider,
      title: typeof meta?.title === 'string' ? meta.title : calendar.address,
      type: ['car', 'airbnb', 'hotel room'].includes(meta?.type ?? '')
        ? meta.type!
        : 'car',
      location: typeof meta?.location === 'string' ? meta.location : '',
      discounts: {},
      discountLadder: calendar.discounts,
      days,
    };
  });
  return {
    chain: true,
    historyReady: Array.isArray(snapshot.history),
    assets,
    accounts,
    version: Number(snapshot.blockNumber),
    seededOn: dayDate(snapshot.today),
    curveDay: dayDate(snapshot.today),
    bids: (snapshot.bids ?? []).map((b) => ({
      id: b.id ?? b.hash ?? `${b.buyer}:${b.nonce}`,
      asset: b.asset.toLowerCase(),
      buyer: b.buyer.toLowerCase(),
      from: dayDate(b.startDay),
      to: dayDate(b.endDayExclusive - 1),
      limit: Number(usdText(b.maxTotal)),
      maxTotal: b.maxTotal,
      nonce: b.nonce,
    })),
  };
}

export function rangeQuote(
  asset: Asset,
  dates: string[],
  account: string,
  today: string,
) {
  const days = dates.map((date) => asset.days.find((d) => d.date === date)!);
  if (
    !days.length ||
    days.some(
      (d, i) =>
        !d ||
        d.date < today ||
        !d.listed ||
        (i > 0 && exactDay(d.date) !== exactDay(days[i - 1].date) + 1),
    )
  )
    return { reason: 'Choose consecutive listed days' };
  let bps = 0;
  for (const step of asset.discountLadder ?? [])
    if (step.minDays <= days.length) bps = step.discountBps;
  let subtotal = BigInt(0),
    total = BigInt(0);
  const perDay: Record<string, number> = {},
    dayPct: Record<string, number> = {};
  for (const d of days) {
    const raw = BigInt(d.sellingPriceRaw!);
    const paid = (raw * BigInt(10000 - bps)) / BigInt(10000);
    subtotal += raw;
    total += paid;
    perDay[d.date] = Number(usdText(paid.toString()));
    dayPct[d.date] = bps / 100;
  }
  const own = days.filter((d) => d.owner === account).length;
  return {
    pct: bps / 100,
    pctText: `${bps / 100}%`,
    sellers: new Set(days.map((d) => d.owner)).size,
    subtotal: Number(usdText(subtotal.toString())),
    total: Number(usdText(total.toString())),
    rawTotal: total.toString(),
    perDay,
    dayPct,
    own: own === days.length,
    mixed: own > 0 && own < days.length,
  };
}

export type BookingRequest = {
  eventId: string;
  host: string;
  asset: string;
  day: number;
  booked: boolean;
  expectedListedPrice: string;
};
/** Exact EIP-191 plaintext shared with the backend booking verifier; no trailing newline. */
export function bookingMessage(
  config: { chainId: number | string; factory: string },
  request: BookingRequest,
): string {
  return [
    'ProjectTokyo booking v1',
    `chainId:${BigInt(config.chainId)}`,
    `factory:${config.factory.toLowerCase()}`,
    `host:${request.host.toLowerCase()}`,
    `asset:${request.asset.toLowerCase()}`,
    `eventId:${request.eventId}`,
    `day:${BigInt(request.day)}`,
    `booked:${request.booked ? 'true' : 'false'}`,
    `expectedListedPrice:${BigInt(request.expectedListedPrice)}`,
  ].join('\n');
}

/** URLs may contain checksummed addresses; sample asset identifiers retain their case. */
export const normalizeAssetId = (value: string): string =>
  /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value;
