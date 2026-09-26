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
const response = () => ({
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
});
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
  const fetcher = vi.fn().mockResolvedValue(response());
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

it('unsubscribes before replacing the session and disconnect clears its identity', async () => {
  const first = wallet(),
    second = wallet(other);
  mocks.select.mockReturnValueOnce(first).mockReturnValueOnce(second);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
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
