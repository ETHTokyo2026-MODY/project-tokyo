import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('react', () => ({
  useEffect: vi.fn(),
  useSyncExternalStore: (_s: unknown, read: () => unknown) => read(),
}));
vi.mock('./wallet', () => ({
  createWalletDiscovery: () => ({ refresh() {}, select: mocks.select }),
  WalletBatchError: class extends Error {},
}));
import {
  connectWallet,
  disconnectWallet,
  dispatch,
  useChainStore,
} from './store';
const host = `0x${'11'.repeat(20)}`,
  trader = `0x${'22'.repeat(20)}`,
  asset = `0x${'33'.repeat(20)}`;
afterEach(async () => {
  await disconnectWallet();
  vi.unstubAllGlobals();
  mocks.select.mockReset();
});
async function fixture(actor = host, receipt = 'success') {
  let booked = false;
  const sendBatch = vi.fn(async () => ['0xtransaction']);
  mocks.select.mockReturnValue({
    connect: async () => actor,
    verifySession: async () => {},
    sendBatch,
    subscribe: (listener: (value: string) => void) => {
      listener(actor);
      return () => {};
    },
    disconnect: async () => {},
    dispose: () => {},
  });
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    calls.push(url);
    let value: unknown;
    if (url.includes('/state'))
      value = {
        ready: true,
        today: 20722,
        blockNumber: '1',
        blockHash: 'hash',
        usdcBalance: '0',
        calendars: [
          {
            address: asset,
            host,
            startDay: 20722,
            endDayExclusive: 21087,
            metadataURI: JSON.stringify({
              title: 'Car',
              type: 'car',
              location: 'Tokyo',
            }),
            discountVersion: '0',
            discounts: [],
            days: [
              {
                day: 20722,
                token: trader,
                owner: trader,
                deployed: true,
                listed: true,
                saleNonce: '0',
                booked,
                listedPrice: '70000001',
                sellingPrice: '60000000',
              },
            ],
          },
        ],
      };
    else if (url.endsWith('/config'))
      value = { chainId: 11155111, factory: asset };
    else if (url.endsWith('/prepare')) {
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({
        actor,
        action: booked ? 'unbook' : 'book',
        body: {
          asset,
          day: 20722,
          expectedListedPrice: '70000001',
        },
      });
      value = { transactions: [{ to: asset, data: '0x1234', value: '0x0' }] };
    } else if (url.includes('/receipt/')) {
      if (receipt === 'success') booked = !booked;
      value = { status: receipt };
    } else throw new Error(`Unexpected request ${url}`);
    return { ok: true, json: async () => value };
  });
  vi.stubGlobal('fetch', fetcher);
  await connectWallet({ legacy: true });
  return { calls, sendBatch };
}
it('host books and unbooks via wallet transactions, then reads confirmed state without a webhook', async () => {
  const f = await fixture();
  expect(await dispatch('book', { asset, date: '2026-09-26' })).toMatchObject({
    ok: true,
  });
  expect(useChainStore().state?.assets[0].days[0].status).toBe('booked');
  expect(await dispatch('unbook', { asset, day: '2026-09-26' })).toMatchObject({
    ok: true,
  });
  expect(useChainStore().state?.assets[0].days[0].status).not.toBe('booked');
  expect(f.sendBatch).toHaveBeenCalledTimes(2);
  expect(f.calls.some((url) => url.includes('webhook'))).toBe(false);
  expect(f.calls.at(-1)).toBe(`/api/day/state?account=${host}`);
});
it('a trader owning the day cannot report a host booking', async () => {
  const f = await fixture(trader);
  expect(await dispatch('book', { asset, date: '2026-09-26' })).toMatchObject({
    ok: false,
    error: 'Only the host can report a booking',
  });
  expect(f.sendBatch).not.toHaveBeenCalled();
  expect(f.calls.some((url) => url.endsWith('/prepare'))).toBe(false);
});
it('a reverted booking receipt is not reported as a confirmed booking', async () => {
  await fixture(host, 'reverted');
  expect(await dispatch('book', { asset, date: '2026-09-26' })).toMatchObject({
    ok: false,
  });
  expect(useChainStore().state?.assets[0].days[0].status).not.toBe('booked');
  expect(useChainStore().hashes).toEqual(['0xtransaction']);
});
