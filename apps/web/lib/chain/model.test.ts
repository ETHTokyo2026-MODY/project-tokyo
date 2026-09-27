import { describe, expect, it } from 'vitest';
import {
  bookingMessage,
  chainState,
  dayDate,
  exactDay,
  parseUSDC,
  rangeQuote,
  usdText,
  viewedAccount,
  type ChainSnapshot,
} from './model';
import { demoPersonas } from './personas';

const host = `0x${'11'.repeat(20)}`,
  trader = `0x${'22'.repeat(20)}`;
const start = exactDay('2026-09-26');
const snapshot: ChainSnapshot = {
  ready: true,
  today: start,
  usdcBalance: '10000001',
  blockNumber: '50',
  blockHash: `0x${'aa'.repeat(32)}`,
  calendars: [
    {
      address: `0x${'33'.repeat(20)}`,
      host,
      startDay: start,
      endDayExclusive: start + 365,
      metadataURI: JSON.stringify({
        title: 'Car',
        type: 'car',
        location: 'Tokyo',
      }),
      discountVersion: '2',
      discounts: [{ minDays: 2, discountBps: 3333 }],
      days: Array.from({ length: 365 }, (_, i) => ({
        day: start + i,
        token: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        owner: i === 1 ? trader : host,
        deployed: false,
        listed: true,
        saleNonce: '0',
        booked: i === 0,
        listedPrice: '80000000',
        sellingPrice: '1000001',
      })),
    },
  ],
  bids: [
    {
      hash: 'canonical-hash',
      buyer: trader,
      asset: `0x${'33'.repeat(20)}`,
      startDay: start,
      endDayExclusive: start + 2,
      maxTotal: '1234567',
      nonce: '1234',
    },
  ],
};
describe('chain UI mapping (unit)', () => {
  it('keeps the three public demo roles available before their first trade', () => {
    const accounts = chainState({ ...snapshot, calendars: [] }, '').accounts;
    expect(demoPersonas.map(({ label }) => label)).toEqual([
      'Host',
      'Trader A',
      'Trader B',
    ]);
    for (const persona of demoPersonas) {
      expect(accounts[persona.address].name).toBe(persona.label);
      expect(viewedAccount(persona.address, '', accounts)).toBe(persona.address);
    }
  });
  it('preserves six-decimal amounts without binary floating-point conversion', () => {
    for (const [value, raw] of [
      ['0', '0'],
      ['1.000001', '1000001'],
      ['9007199254740993.123456', '9007199254740993123456'],
    ]) {
      expect(parseUSDC(value)).toBe(raw);
      expect(usdText(raw)).toBe(value);
    }
    for (const value of ['-1', '1e6', '0.0000001', '1.', '', NaN, Infinity])
      expect(() => parseUSDC(value)).toThrow();
  });
  it('uses chain days and ownership without generating history, cash, or extra calendar days', () => {
    const mapped = chainState(snapshot, trader),
      asset = mapped.assets[0];
    expect(asset.days).toHaveLength(365);
    expect(asset.days.at(-1)?.date).toBe(dayDate(start + 364));
    expect(asset.days[0]).toMatchObject({
      owner: host,
      status: 'booked',
      history: [],
      sellingPriceRaw: '1000001',
    });
    expect(mapped.accounts[trader].cash).toBe(10.000001);
    expect(mapped.accounts[host].cash).toBe(0);
    expect(mapped.bids?.[0]).toMatchObject({
      id: 'canonical-hash',
      maxTotal: '1234567',
      nonce: '1234',
      to: dayDate(start + 1),
    });
  });
  it('applies the asset ladder across owners and floors every day separately', () => {
    const asset = chainState(snapshot, '').assets[0];
    const quote = rangeQuote(
      asset,
      [dayDate(start), dayDate(start + 1)],
      '',
      dayDate(start),
    );
    expect(quote).toMatchObject({
      rawTotal: '1333400',
      sellers: 2,
      pct: 33.33,
    });
    expect(
      rangeQuote(
        asset,
        [dayDate(start), dayDate(start + 2)],
        '',
        dayDate(start),
      ),
    ).toHaveProperty('reason');
    expect(
      rangeQuote(asset, [dayDate(start)], '', dayDate(start + 1)),
    ).toHaveProperty('reason');
  });
  it('allows fully discounted zero-price fills and rejects impossible dates', () => {
    const asset = chainState(snapshot, '').assets[0];
    asset.discountLadder = [{ minDays: 2, discountBps: 10000 }];
    expect(
      rangeQuote(
        asset,
        [dayDate(start), dayDate(start + 1)],
        '',
        dayDate(start),
      ),
    ).toHaveProperty('rawTotal', '0');
    expect(() => exactDay('2026-02-30')).toThrow();
  });
});

it('pins the host booking signature text and all domain fields', () => {
  expect(
    bookingMessage(
      { chainId: 11155111, factory: `0x${'AB'.repeat(20)}` },
      {
        eventId: '0x01',
        host,
        asset: trader,
        day: 20722,
        booked: true,
        expectedListedPrice: '65000000',
      },
    ),
  ).toBe(
    [
      'ProjectTokyo booking v1',
      'chainId:11155111',
      `factory:0x${'ab'.repeat(20)}`,
      `host:${host}`,
      `asset:${trader}`,
      'eventId:0x01',
      'day:20722',
      'booked:true',
      'expectedListedPrice:65000000',
    ].join('\n'),
  );
});

it('maps only canonical settlement history with exact prices and unknown sellers preserved', () => {
  const event = {
    asset: snapshot.calendars[0].address,
    day: start,
    token: snapshot.calendars[0].days[0].token,
    buyer: trader,
    seller: null,
    payment: '1234567',
    transactionHash: `0x${'99'.repeat(32)}`,
    blockNumber: 49,
    logIndex: 2,
    timestamp: '1790380800',
    bidHash: 'bid',
    askHash: 'ask',
    rangeLength: 2,
  };
  const mapped = chainState({ ...snapshot, history: [event] }, trader);
  expect(mapped.historyReady).toBe(true);
  expect(mapped.assets[0].days[0].settlements).toEqual([
    {
      buyer: trader,
      seller: null,
      priceRaw: '1234567',
      price: 1.234567,
      at: new Date(1790380800000).toISOString(),
      transactionHash: event.transactionHash,
      rangeLength: 2,
    },
  ]);
  expect(mapped.assets[0].days[1].settlements).toEqual([]);
  expect(chainState(snapshot, trader).historyReady).toBe(false);
});

it('resolves a known public persona without changing the connected wallet', () => {
  const accounts = chainState(snapshot, trader).accounts;
  expect(viewedAccount(host.toUpperCase(), trader, accounts)).toBe(host);
  expect(viewedAccount('0xunknown', trader, accounts)).toBe(trader);
  expect(viewedAccount(null, trader, accounts)).toBe(trader);
});
