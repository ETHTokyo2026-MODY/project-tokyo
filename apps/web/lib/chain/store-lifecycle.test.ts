import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('react', () => ({
  useEffect: vi.fn(),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock('./wallet', () => ({
  createWalletDiscovery: () => ({ refresh() {}, select: mocks.select }),
  WalletBatchError: class extends Error {},
}));
import {
  connectWallet,
  disconnectWallet,
  refreshChain,
  switchNetwork,
  useChainStore,
} from './store';

const account = `0x${'11'.repeat(20)}`;
const other = `0x${'22'.repeat(20)}`;
const response = (url?: string) => {
  if (url && String(url).includes('/api/ens/')) {
    return { ok: true, json: async () => ({ assets: [] }) };
  }
  return {
    ok: true,
    json: async () => ({
      ready: true,
      today: 20722,
      blockNumber: '1',
      blockHash: 'hash',
      calendars: [],
      history: [],
      usdcBalance: '1000000',
    }),
  };
};
function wallet(selected = account) {
  const listeners = new Set<(account: string | null) => void>();
  return {
    account: selected as string | null,
    connect: vi.fn(async () => selected),
    subscribe(listener: (account: string | null) => void) {
      listeners.add(listener);
      listener(this.account);
      return () => listeners.delete(listener);
    },
    change(value: string | null) {
      this.account = value;
      for (const listener of listeners) listener(value);
    },
    switchToSepolia: vi.fn(async function (this: {
      change: (value: string) => void;
    }) {
      this.change(selected);
    }),
    dispose: vi.fn(function (this: { change: (value: null) => void }) {
      this.change(null);
    }),
    disconnect: vi.fn(async function (this: { change: (value: null) => void }) {
      this.change(null);
    }),
    listeners,
  };
}
afterEach(async () => {
  await disconnectWallet();
  mocks.select.mockReset();
  vi.unstubAllGlobals();
});

it('invalidates pending reads immediately on wallet change and refreshes after explicit network recovery', async () => {
  const next = wallet();
  mocks.select.mockReturnValue(next);
  const fetcher = vi.fn(async (url: string) => response(url));
  vi.stubGlobal('fetch', fetcher);
  await connectWallet({ legacy: true });
  expect(useChainStore()).toMatchObject({
    wallet: account,
    ready: true,
    hasWalletSession: true,
  });
  let finish!: (value: ReturnType<typeof response>) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = refreshChain();
  next.change(null);
  expect(useChainStore()).toMatchObject({
    wallet: '',
    state: null,
    ready: false,
    hasWalletSession: true,
  });
  finish(response());
  await pending;
  await vi.waitFor(() =>
    expect(useChainStore()).toMatchObject({
      wallet: '',
      ready: true,
    }),
  );
  expect(useChainStore().state?.accounts).not.toHaveProperty(account);
  expect(fetcher).toHaveBeenLastCalledWith('/api/day/state', expect.anything());
  await switchNetwork();
  expect(next.switchToSepolia).toHaveBeenCalledOnce();
  expect(useChainStore()).toMatchObject({
    wallet: account,
    ready: true,
    hasWalletSession: true,
  });
  expect(fetcher).toHaveBeenLastCalledWith(
    `/api/day/state?account=${account}`,
    expect.anything(),
  );
});

const ensAsset = {
  label: 'car',
  name: 'car.projecttokyo.eth',
  rentalAsset: `0x${'33'.repeat(20)}`,
  host: account,
  title: 'Car',
  kind: 'car',
  location: 'Tokyo',
  startDay: 20722,
  endDayExclusive: 20723,
  days: [
    {
      day: 20722,
      date: '2026-09-26',
      token: `0x${'44'.repeat(20)}`,
      owner: account,
      deployed: false,
      listed: true,
      booked: false,
      listedPrice: '80000000',
      sellingPrice: '1000001',
    },
  ],
};

it('is ready from ENS calendars while the Sepolia index is still catching up', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (String(url).includes('/api/ens/')) {
      return {
        ok: true,
        json: async () => ({ ready: true, today: 20722, assets: [ensAsset] }),
      };
    }
    return { ok: true, json: async () => ({ ready: false, indexing: true }) };
  });
  vi.stubGlobal('fetch', fetcher);
  await refreshChain();
  expect(useChainStore()).toMatchObject({
    ready: true,
    today: '2026-09-26',
    error: '',
  });
  expect(useChainStore().state?.historyReady).toBe(false);
  expect(useChainStore().state?.bids).toEqual([]);
  expect(useChainStore().state?.assets[0]).toMatchObject({
    title: 'Car',
    ensName: 'car.projecttokyo.eth',
  });
  expect(useChainStore().state?.assets[0].days[0]).toMatchObject({
    owner: account,
    listed: true,
    salePrice: 1.000001,
    status: 'open',
  });
});

it('merges open orders and trades once the index becomes ready', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (String(url).includes('/api/ens/')) {
      return {
        ok: true,
        json: async () => ({ ready: true, today: 20722, assets: [ensAsset] }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        ready: true,
        today: 20722,
        blockNumber: '9',
        blockHash: 'hash',
        calendars: [],
        history: [
          {
            asset: ensAsset.rentalAsset,
            day: 20722,
            token: ensAsset.days[0].token,
            buyer: other,
            seller: account,
            payment: '1234567',
            transactionHash: `0x${'99'.repeat(32)}`,
            blockNumber: 8,
            logIndex: 0,
            timestamp: '1790380800',
            bidHash: 'bid',
            askHash: 'ask',
            rangeLength: 1,
          },
        ],
        bids: [
          {
            hash: 'open-bid',
            buyer: other,
            asset: ensAsset.rentalAsset,
            startDay: 20722,
            endDayExclusive: 20723,
            maxTotal: '2000000',
            nonce: '1',
          },
        ],
        usdcBalance: '0',
      }),
    };
  });
  vi.stubGlobal('fetch', fetcher);
  await refreshChain();
  expect(useChainStore().state?.historyReady).toBe(true);
  expect(useChainStore().state?.bids?.[0]).toMatchObject({
    id: 'open-bid',
    limit: 2,
  });
  expect(useChainStore().state?.assets[0].days[0].settlements).toEqual([
    expect.objectContaining({
      buyer: other,
      seller: account,
      priceRaw: '1234567',
    }),
  ]);
});

it('unsubscribes before replacing the session and disconnect clears its identity', async () => {
  const first = wallet(),
    second = wallet(other);
  mocks.select.mockReturnValueOnce(first).mockReturnValueOnce(second);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => response(url)),
  );
  await connectWallet({ legacy: true });
  first.dispose.mockImplementation(() => {
    expect(first.listeners.size).toBe(0);
    first.change(null);
  });
  await connectWallet({ legacy: true });
  expect(first.dispose).toHaveBeenCalledOnce();
  first.change(null);
  expect(useChainStore()).toMatchObject({ wallet: other, ready: true });
  await disconnectWallet();
  expect(second.disconnect).toHaveBeenCalledOnce();
  expect(second.listeners.size).toBe(0);
  expect(useChainStore()).toMatchObject({
    wallet: '',
    ready: true,
    hasWalletSession: false,
  });
  expect(useChainStore().state?.accounts).not.toHaveProperty(other);
  second.change(other);
  expect(useChainStore().wallet).toBe('');
});
