'use client';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { parseUnits } from 'viem';
import {
  readDemoAccount,
  writeDemoAccount,
  type DemoAccountId,
} from '../demo/accounts';
import { parseMode, readMode, writeAppMode, type AppMode } from '../demo/mode';
import type { DemoState } from '../demo/types';
import {
  normalizeAssetId,
  chainState,
  dayDate,
  exactDay,
  parseUSDC,
  usdText,
  viewedAccount,
  type ChainCalendar,
  type ChainSnapshot,
} from './model';
import {
  createWalletDiscovery,
  WalletBatchError,
  type PreparedTransaction,
  type WalletSelection,
  type WalletSession,
  type FundingTypedData,
} from './wallet';
import {
  createGeneratedWallet,
  GeneratedWalletSession,
  listSavedWallets,
  persistWallet,
  readSessionWallet,
  type SavedWallet,
} from './generated-wallet';
export type ActionResult =
  | { ok: true; version: number; asset?: string; message?: string }
  | { ok: false; error: string };
type Snapshot = {
  mode: AppMode;
  ready: boolean;
  state: DemoState | null;
  today: string;
  wallet: string;
  hasWalletSession: boolean;
  busy: boolean;
  error: string;
  progress: string;
  hashes: string[];
  eth: string;
  generated: boolean;
};
const initial: Snapshot = {
  mode: 'simulated',
  ready: false,
  state: null,
  today: '',
  wallet: 'host',
  hasWalletSession: true,
  busy: false,
  error: '',
  progress: '',
  hashes: [],
  eth: '',
  generated: false,
};
type EnsAssetPayload = {
  assets: {
    label: string;
    name: string;
    rentalAsset: string;
    host: string;
    title: string;
    kind: string;
    location: string;
    startDay: number;
    endDayExclusive: number;
    days: {
      day: number;
      date: string;
      token: string;
      owner: string;
      deployed: boolean;
      listed: boolean;
      booked: boolean;
      listedPrice: string;
      sellingPrice: string;
    }[];
  }[];
};
let snapshot: Snapshot = {
  ...initial,
  wallet: typeof window === 'undefined' ? 'host' : readDemoAccount(),
};
const listeners = new Set<() => void>();
let discovery: ReturnType<typeof createWalletDiscovery> | undefined;
type ActiveSession = WalletSession | GeneratedWalletSession;
let session: ActiveSession | undefined;
let ensCache: { at: number; assets: EnsAssetPayload['assets'] } | undefined;
let unsubscribeSession: (() => void) | undefined;
let walletRefresh: Promise<void> = Promise.resolve();
let generation = 0;
const emit = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
};
const simulated = () => snapshot.mode === 'simulated';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/day/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value.error === 'string'
        ? value.error
        : `Request failed (${response.status})`,
    );
  return value;
}

async function loadEnsAssets(force = false) {
  if (!force && ensCache && Date.now() - ensCache.at < 20_000)
    return ensCache.assets;
  const response = await fetch('/api/ens/assets', { cache: 'no-store' });
  const value = (await response.json()) as EnsAssetPayload & { error?: string };
  if (!response.ok)
    throw new Error(value.error ?? `Asset list failed (${response.status})`);
  const assets = (value.assets ?? []).filter(
    (a) => !a.label.startsWith('testasset'),
  );
  ensCache = { at: Date.now(), assets };
  return assets;
}

function ensCalendars(assets: EnsAssetPayload['assets']): ChainCalendar[] {
  return assets.map((a) => ({
    address: a.rentalAsset,
    host: a.host,
    startDay: a.startDay,
    endDayExclusive: a.endDayExclusive,
    metadataURI: JSON.stringify({
      title: a.title,
      type: a.kind,
      location: a.location,
    }),
    discounts: [],
    discountVersion: '0',
    ensLabel: a.label,
    ensName: a.name,
    days: a.days.map((d) => ({
      day: d.day,
      token: d.token,
      owner: d.owner,
      deployed: d.deployed,
      listed: d.listed,
      saleNonce: '0',
      booked: d.booked,
      listedPrice: d.listedPrice,
      sellingPrice: d.sellingPrice,
    })),
  }));
}

function tokyoToday() {
  return Math.floor((Date.now() / 1000 + 32400) / 86400);
}

function formatEth(wei?: string) {
  if (wei == null || wei === '') return '';
  try {
    const n = BigInt(wei);
    const unit = BigInt('1000000000000000000');
    const whole = n / unit;
    const frac = (n % unit).toString().padStart(18, '0').slice(0, 4);
    return `${whole}.${frac}`.replace(/\.0+$/, (m) =>
      m === '.0000' ? '0' : m,
    );
  } catch {
    return '';
  }
}

async function readFaucetBalances(address: string) {
  const response = await fetch(
    `/api/faucet?address=${encodeURIComponent(address)}`,
    { cache: 'no-store' },
  );
  const value = (await response.json()) as {
    ethBalance?: string;
    usdcBalance?: string;
  };
  if (!response.ok) return null;
  return value;
}

function applySnapshot(
  result: Partial<ChainSnapshot> & { calendars: ChainCalendar[] },
  wallet: string,
) {
  const today = result.today ?? tokyoToday();
  emit({
    ready: true,
    state: chainState(
      {
        ready: true,
        today,
        calendars: result.calendars,
        bids: result.bids,
        history: result.history,
        usdcBalance: result.usdcBalance,
        ethBalance: result.ethBalance,
        blockNumber: result.blockNumber ?? '0',
        blockHash: result.blockHash ?? '',
      },
      wallet,
    ),
    today: dayDate(today),
    error: '',
    eth: formatEth(result.ethBalance),
  });
}

async function refreshDemo(): Promise<void> {
  const revision = ++generation;
  try {
    const response = await fetch('/api/demo/state', { cache: 'no-store' });
    const value = (await response.json()) as {
      state?: DemoState;
      today?: string;
      error?: string;
    };
    if (revision !== generation) return;
    if (!response.ok || !value.state) {
      emit({
        ready: false,
        error: value.error ?? 'Could not load simulated state',
      });
      return;
    }
    emit({
      mode: readMode(value.state),
      ready: true,
      state: value.state,
      today: value.today ?? '',
      wallet: readDemoAccount(),
      hasWalletSession: true,
      error: '',
    });
  } catch (error) {
    if (revision === generation)
      emit({
        ready: false,
        error:
          error instanceof Error
            ? error.message
            : 'Could not load simulated state',
      });
  }
}

export function setDemoAccount(id: DemoAccountId) {
  if (!simulated()) return;
  writeDemoAccount(id);
  emit({ wallet: id });
}

export async function setAppMode(mode: AppMode): Promise<void> {
  const next = parseMode(mode);
  const result = await writeAppMode(next);
  if (result.mode === 'simulated') {
    emit({
      mode: 'simulated',
      ready: true,
      state: (result.state as DemoState | null) ?? snapshot.state,
      wallet: readDemoAccount(),
      hasWalletSession: true,
      error: '',
      progress: '',
    });
    return;
  }
  restoreGeneratedWallet();
  emit({
    mode: 'demo',
    wallet: session ? snapshot.wallet : '',
    hasWalletSession: Boolean(session),
    ready: false,
    state: null,
    error: '',
    progress: '',
  });
  void refreshChainOnly().then(() => {
    if (snapshot.mode === 'demo') emit({ mode: 'demo' });
  });
}

export async function refreshChain(forceEns = false): Promise<void> {
  if (simulated()) return refreshDemo();
  return refreshChainOnly(forceEns);
}

async function refreshChainOnly(forceEns = false): Promise<void> {
  const revision = ++generation;
  try {
    const [ensResult, stateResult] = await Promise.allSettled([
      loadEnsAssets(forceEns),
      api<ChainSnapshot>(
        `state${snapshot.wallet ? `?account=${snapshot.wallet}` : ''}`,
      ),
    ]);
    if (revision !== generation) return;
    const ens =
      ensResult.status === 'fulfilled'
        ? ensResult.value
        : (ensCache?.assets ?? []);
    const result =
      stateResult.status === 'fulfilled' ? stateResult.value : null;
    const fromEns = ensCalendars(ens);
    if (!result?.ready) {
      if (snapshot.generated && snapshot.wallet && !result?.usdcBalance) {
        const funded = await readFaucetBalances(snapshot.wallet).catch(
          () => null,
        );
        if (funded && revision === generation) {
          emit({ eth: formatEth(funded.ethBalance) });
          if (fromEns.length) {
            applySnapshot(
              {
                calendars: fromEns,
                usdcBalance: funded.usdcBalance,
                ethBalance: funded.ethBalance,
              },
              snapshot.wallet,
            );
            return;
          }
        }
      }
      if (fromEns.length) {
        applySnapshot({ calendars: fromEns, ...result }, snapshot.wallet);
        return;
      }
      emit({
        ready: false,
        error: 'Market data is still loading. Refresh shortly.',
      });
      return;
    }
    const byAddr = new Map(fromEns.map((c) => [c.address.toLowerCase(), c]));
    const calendars = result.calendars.map((c) => {
      const extra = byAddr.get(c.address.toLowerCase());
      if (!extra) return c;
      return {
        ...c,
        ensLabel: extra.ensLabel,
        ensName: extra.ensName,
        metadataURI: extra.metadataURI || c.metadataURI,
      };
    });
    const known = new Set(calendars.map((c) => c.address.toLowerCase()));
    for (const c of fromEns) {
      if (!known.has(c.address.toLowerCase())) calendars.push(c);
    }
    applySnapshot({ ...result, calendars }, snapshot.wallet);
  } catch (error) {
    if (revision === generation)
      emit({
        ready: false,
        error:
          error instanceof Error ? error.message : 'Could not load market data',
      });
  }
}
export async function connectWallet(selection: WalletSelection): Promise<void> {
  if (simulated()) return;
  if (snapshot.busy) throw new Error('Wait for the current wallet action');
  discovery ??= createWalletDiscovery();
  discovery.refresh();
  const next = discovery.select(selection);
  emit({ busy: true });
  try {
    await next.connect();
    unsubscribeSession?.();
    session?.dispose();
    session = next;
    unsubscribeSession = next.subscribe((account) => {
      if (session !== next) return;
      generation++;
      emit({
        wallet: account ?? '',
        hasWalletSession: true,
        ready: false,
        state: null,
        today: '',
        generated: false,
        error: account
          ? ''
          : 'Wallet connection changed. Reconnect or switch network.',
      });
      walletRefresh = refreshChain();
    });
    await walletRefresh;
  } catch (error) {
    next.dispose();
    throw error;
  } finally {
    emit({ busy: false });
  }
}
export function walletChoices() {
  if (simulated()) return [];
  discovery ??= createWalletDiscovery();
  return discovery.list();
}
export function subscribeWalletChoices(listener: () => void) {
  if (simulated()) return () => {};
  discovery ??= createWalletDiscovery();
  return discovery.subscribe(listener);
}

export async function switchNetwork() {
  if (simulated()) return;
  if (!session) throw new Error('Connect a wallet first');
  if (snapshot.busy) throw new Error('Wait for the current wallet action');
  emit({ busy: true });
  try {
    await session.switchToSepolia?.();
    await walletRefresh;
  } finally {
    emit({ busy: false });
  }
}
export async function disconnectWallet(): Promise<void> {
  if (simulated()) return;
  if (snapshot.busy) throw new Error('Wait for the current wallet action');
  const previous = session;
  if (!previous) return;
  unsubscribeSession?.();
  unsubscribeSession = undefined;
  session = undefined;
  generation++;
  emit({
    wallet: '',
    hasWalletSession: false,
    generated: false,
    eth: '',
    state: null,
    ready: false,
    today: '',
    error: '',
    progress: '',
    busy: true,
  });
  try {
    await previous.disconnect();
  } finally {
    await refreshChain();
    emit({ busy: false });
  }
}

function attachSession(next: ActiveSession, generated: boolean) {
  unsubscribeSession?.();
  session?.dispose();
  session = next;
  unsubscribeSession = next.subscribe((account) => {
    if (session !== next) return;
    generation++;
    emit({
      wallet: account ?? '',
      hasWalletSession: true,
      generated,
      ready: false,
      state: null,
      today: '',
      error: account ? '' : 'Wallet session ended. Generate or connect again.',
    });
    walletRefresh = refreshChain();
  });
}

export function savedGeneratedWallets(): SavedWallet[] {
  return listSavedWallets();
}

export function restoreGeneratedWallet(): boolean {
  const saved = readSessionWallet();
  if (!saved) return false;
  attachSession(new GeneratedWalletSession(saved), true);
  emit({
    wallet: saved.address,
    hasWalletSession: true,
    generated: true,
  });
  return true;
}

async function fundGeneratedWallet(address: string) {
  const response = await fetch('/api/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
    cache: 'no-store',
  });
  const value = (await response.json()) as {
    error?: string;
    ethBalance?: string;
    usdcBalance?: string;
  };
  if (response.status === 503) {
    emit({
      error:
        value.error ??
        'Demo faucet is not configured. Set DEMO_FAUCET_PRIVATE_KEY.',
    });
    return;
  }
  if (!response.ok)
    throw new Error(value.error ?? 'Could not fund the generated wallet');
  if (value.ethBalance) emit({ eth: formatEth(value.ethBalance) });
}

export async function generateWallet(): Promise<void> {
  if (simulated()) return;
  if (snapshot.busy) throw new Error('Wait for the current wallet action');
  emit({ busy: true, error: '', progress: 'Creating a demo wallet' });
  try {
    const wallet = createGeneratedWallet();
    attachSession(new GeneratedWalletSession(wallet), true);
    emit({
      wallet: wallet.address,
      hasWalletSession: true,
      generated: true,
      progress: 'Funding the new wallet',
    });
    await fundGeneratedWallet(wallet.address);
    await refreshChain(true);
    emit({ progress: snapshot.error ? '' : 'Wallet ready' });
  } catch (error) {
    emit({
      error:
        error instanceof Error ? error.message : 'Could not create a wallet',
      progress: '',
    });
  } finally {
    emit({ busy: false });
  }
}

export async function selectGeneratedWallet(address: string): Promise<void> {
  if (simulated()) return;
  if (snapshot.busy) throw new Error('Wait for the current wallet action');
  const saved = listSavedWallets().find(
    (item) => item.address === address.toLowerCase(),
  );
  if (!saved) throw new Error('Saved wallet is unavailable');
  persistWallet(saved);
  emit({ busy: true, error: '', progress: 'Switching wallet' });
  try {
    attachSession(new GeneratedWalletSession(saved), true);
    emit({
      wallet: saved.address,
      hasWalletSession: true,
      generated: true,
    });
    await refreshChain(true);
  } finally {
    emit({ busy: false, progress: '' });
  }
}

type Receipt = { status: 'pending' | 'success' | 'reverted'; asset?: string };
export async function waitForReceipt(hash: string): Promise<Receipt> {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const result = await api<Receipt>(`receipt/${hash}`);
    if (result.status === 'reverted')
      throw new Error(`Transaction reverted: ${hash}`);
    if (result.status === 'success') return result;
    if (result.status !== 'pending')
      throw new Error('Invalid transaction receipt status');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    `Still awaiting confirmation for ${hash}. Check the transaction before submitting again.`,
  );
}
const randomSalt = () =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, '0')).join('')}`;
export function parseWETH(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)
  )
    throw new Error('Enter exact WETH with up to eighteen decimal places');
  const raw = parseUnits(value, 18);
  if (raw <= BigInt(0) || raw >= BigInt(1) << BigInt(256))
    throw new Error('WETH input must be positive and bounded');
  return raw.toString();
}
export function command(name: string, body: Record<string, unknown>) {
  const asset = String(body.asset ?? '').toLowerCase();
  if (name === 'create-asset') {
    const prices = body.prices as Record<string, unknown>;
    const values = [
      prices.sun,
      prices.monWed,
      prices.monWed,
      prices.monWed,
      prices.thuSat,
      prices.thuSat,
      prices.thuSat,
    ].map(parseUSDC);
    const lowest = values.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    const minimum =
      body.min === null || body.min === ''
        ? (
            ((BigInt(lowest) * BigInt(2)) / BigInt(3) / BigInt(1000000) ||
              BigInt(1)) * BigInt(1000000)
          ).toString()
        : parseUSDC(body.min);
    return {
      action: name,
      body: {
        salt: randomSalt(),
        metadataURI: JSON.stringify({
          title: body.title,
          type: body.type,
          location: body.location,
        }),
        defaults: {
          minimum,
          listedPrices: values,
          sellingPrices:
            body.sellingPrice === undefined
              ? values
              : Array(7).fill(parseUSDC(body.sellingPrice)),
        },
        discounts: [],
      },
    };
  }
  if (name === 'book' || name === 'unbook') {
    const item = snapshot.state?.assets.find((item) => item.id === asset);
    if (!item || item.provider !== snapshot.wallet)
      throw new Error('Only the host can report a booking');
    const date = String(body.day ?? body.date);
    const day = item.days.find((day) => day.date === date);
    if (!day || day.listedPriceRaw === undefined)
      throw new Error('Booking day or current price is unavailable');
    return {
      action: name,
      body: {
        asset,
        day: exactDay(date),
        expectedListedPrice: day.listedPriceRaw,
      },
    };
  }
  if (name === 'cancel-bid') {
    const bid = snapshot.state?.bids?.find((item) => item.id === body.id);
    if (!bid?.nonce || bid.buyer !== snapshot.wallet)
      throw new Error('Open order is unavailable for this wallet');
    return { action: name, body: { nonce: bid.nonce, buyer: snapshot.wallet } };
  }
  if (name === 'authorize-reporter') return { action: name, body: { asset } };
  if (name === 'discounts')
    return {
      action: name,
      body: {
        asset,
        discounts: Object.entries(body.tiers as Record<string, number>)
          .map(([n, percent]) => ({
            minDays: Number(n),
            discountBps: Math.round(percent * 100),
          }))
          .sort((a, b) => a.minDays - b.minDays),
      },
    };
  if (name === 'curve')
    return {
      action: name,
      body: {
        asset,
        day: exactDay(body.day),
        minimum: parseUSDC(body.min),
        points: (body.points as { date: string; price: number }[]).map((p) => ({
          day: exactDay(p.date),
          price: parseUSDC(p.price),
        })),
      },
    };
  const startDay = exactDay(body.from ?? body.date ?? body.day);
  const endDayExclusive =
    exactDay(body.to ?? body.from ?? body.date ?? body.day) + 1;
  const base = { asset, startDay, endDayExclusive };
  if (name === 'buy' || name === 'buy-block' || name === 'buy-weth') {
    const salt = randomSalt();
    return {
      action: name === 'buy-weth' ? 'prepare-conversion' : 'publish-bid',
      body: {
        ...base,
        maxTotal: parseUSDC(body.limit),
        nonce: BigInt(salt).toString(),
        deadline:
          name === 'buy-weth'
            ? String(Math.floor(Date.now() / 1000) + 900)
            : '1099511627775',
        ...(name === 'buy-weth'
          ? {
              maxInput: parseWETH(body.weth),
              minOutput: parseUSDC(body.minOutput),
              fundingNonce: BigInt(randomSalt()).toString(),
            }
          : {}),
        salt,
      },
    };
  }
  if (name === 'list')
    return {
      action: name,
      body: {
        ...base,
        sellingPrice: parseUSDC(body.price),
        askSalt: randomSalt(),
      },
    };
  if (name === 'set-price')
    return {
      action: name,
      body: { ...base, listedPrice: parseUSDC(body.price) },
    };
  if (name === 'unlist') return { action: name, body: base };
  throw new Error('This action is available only in sample mode');
}
export async function sendConfirmed(
  transactions: PreparedTransaction[],
  wallet: Pick<WalletSession, 'sendBatch'>,
  onHash: (hash: string) => void,
  receipt = waitForReceipt,
): Promise<string | undefined> {
  let asset: string | undefined;
  for (const tx of transactions) {
    const [hash] = await wallet.sendBatch([tx]);
    onHash(hash);
    const confirmed = await receipt(hash);
    asset = confirmed.asset ? normalizeAssetId(confirmed.asset) : asset;
  }
  return asset;
}
async function dispatchDemo(
  name: string,
  body: Record<string, unknown>,
): Promise<ActionResult> {
  if (snapshot.busy)
    return { ok: false, error: 'An action is already in progress' };
  emit({ busy: true, error: '', progress: '' });
  try {
    const response = await fetch('/api/demo/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        body: { ...body, account: snapshot.wallet },
      }),
      cache: 'no-store',
    });
    const value = (await response.json()) as ActionResult & {
      state?: DemoState;
      today?: string;
      asset?: string;
      message?: string;
    };
    if (!response.ok || !value.ok) {
      const error = value.ok === false ? value.error : 'Action failed';
      emit({ error, progress: '' });
      return { ok: false, error };
    }
    emit({
      ready: true,
      state: value.state ?? snapshot.state,
      today: value.today ?? snapshot.today,
      error: '',
      progress: value.message ?? '',
    });
    return {
      ok: true,
      version: value.state?.version ?? snapshot.state?.version ?? 0,
      asset: value.asset,
      message: value.message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action failed';
    emit({ error: message, progress: '' });
    return { ok: false, error: message };
  } finally {
    emit({ busy: false });
  }
}

export async function dispatch(
  name: string,
  body: Record<string, unknown> = {},
): Promise<ActionResult> {
  if (simulated()) return dispatchDemo(name, body);
  const requested =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location?.search ?? '').get('account');
  if (
    viewedAccount(requested, snapshot.wallet, snapshot.state?.accounts) !==
    snapshot.wallet
  )
    return {
      ok: false,
      error: 'This is a public view. Connect that account’s wallet to act.',
    };
  if (snapshot.busy)
    return { ok: false, error: 'A wallet action is already in progress' };
  if (!snapshot.ready)
    return {
      ok: false,
      error: 'Wait for a current chain snapshot before acting',
    };
  if (!session || !snapshot.wallet)
    return { ok: false, error: 'Generate or connect a wallet first' };
  emit({ busy: true, error: '', progress: 'Preparing action', hashes: [] });
  let fundingPublished = false;
  let conversionSubmitted = false;
  const actingWallet = snapshot.wallet;
  try {
    await session.verifySession();
    const config = await api<{
      chainId: number | string;
      factory: string;
      conversion?: { converter: string };
    }>('config');
    if (Number(config.chainId) !== 11155111)
      throw new Error('Backend must use the DayTrader test network');
    const request = command(name, body);
    const result = await api<{
      transactions: PreparedTransaction[];
      asset?: string;
      funding?: { typedData: FundingTypedData; [key: string]: unknown };
    }>('prepare', { actor: snapshot.wallet, ...request });
    emit({
      progress: `Confirm ${result.transactions.length} wallet transaction(s), one at a time`,
    });
    const created =
      (await sendConfirmed(result.transactions, session, (hash) =>
        emit({
          hashes: [...snapshot.hashes, hash],
          progress: 'Waiting for confirmation before the next wallet request',
        }),
      )) ?? result.asset;
    if (name === 'buy-weth') {
      fundingPublished = true;
      if (!config.conversion || !result.funding)
        throw new Error(
          'Conversion configuration or funding request is unavailable',
        );
      emit({ progress: 'Sign the exact WETH funding intent in your wallet' });
      const signature = await session.signFunding(
        result.funding.typedData,
        config.conversion.converter,
      );
      const execution = await api<{ transactions: PreparedTransaction[] }>(
        'prepare',
        {
          actor: snapshot.wallet,
          action: 'execute-conversion',
          body: { ...result.funding, signature },
        },
      );
      emit({
        progress: 'Confirm atomic WETH conversion and purchase in your wallet',
      });
      await sendConfirmed(execution.transactions, session, (hash) => {
        conversionSubmitted = true;
        emit({
          hashes: [...snapshot.hashes, hash],
          progress: 'Waiting for conversion and purchase confirmation',
        });
      });
    }

    ensCache = undefined;
    await refreshChain(true);
    const message =
      name === 'create-asset'
        ? 'Asset created. Listing authorization required: publish each sale range from the calendar.'
        : name === 'discounts'
          ? 'Discounts saved. Existing sale authorizations are invalid; sellers must republish listings.'
          : name === 'buy' || name === 'buy-block'
            ? 'Buy order published. Ownership changes only after an onchain fill.'
            : name === 'list'
              ? 'Sale published. Wallet tokens remain yours until filled.'
              : 'Confirmed onchain.';
    emit({ progress: message });
    return {
      ok: true,
      version: snapshot.state?.version ?? 0,
      asset: created ? normalizeAssetId(created) : undefined,
      message,
    };
  } catch (error) {
    if (error instanceof WalletBatchError && error.hashes.length)
      emit({ hashes: [...snapshot.hashes, ...error.hashes] });
    if (name === 'buy-weth') {
      await refreshChain();
      const asset = snapshot.state?.assets.find(
        (a) => a.id === String(body.asset).toLowerCase(),
      );
      const days = asset?.days.filter(
        (d) =>
          d.date >= String(body.from) && d.date <= String(body.to ?? body.from),
      );
      if (
        fundingPublished &&
        !conversionSubmitted &&
        snapshot.ready &&
        snapshot.wallet === actingWallet &&
        days?.length ===
          exactDay(body.to ?? body.from) - exactDay(body.from) + 1 &&
        days.every((d) => d.owner === actingWallet)
      ) {
        const message =
          'The published USDC order filled and these days are now yours. No WETH conversion transaction was submitted.';
        emit({ progress: message, error: '' });
        return { ok: true, version: snapshot.state?.version ?? 0, message };
      }
    }
    const message =
      (error instanceof Error ? error.message : 'Wallet action failed') +
      (name === 'buy-weth'
        ? ' WETH conversion was not confirmed. The published USDC order may remain open or have filled; check ownership and cancel it if unwanted.'
        : '');
    emit({ error: message, progress: '' });
    return { ok: false, error: message };
  } finally {
    emit({ busy: false });
  }
}
export async function loadCurve(asset: string, date: string) {
  if (simulated()) {
    const day = snapshot.state?.assets
      .find((item) => item.id === asset)
      ?.days.find((item) => item.date === date);
    return {
      min: day?.curve?.min ?? 1,
      points: day?.curve?.points ?? [{ date, price: day?.price ?? 1 }],
    };
  }
  const result = await api<{
    minimum: string;
    points: { day: number; price: string }[];
  }>(`curve?asset=${asset}&day=${exactDay(date)}`);
  return {
    min: Number(usdText(result.minimum)),
    points: result.points.map((point) => ({
      date: dayDate(point.day),
      price: Number(usdText(point.price)),
    })),
  };
}
async function resetDemo(): Promise<ActionResult> {
  try {
    const response = await fetch('/api/demo/reset', {
      method: 'POST',
      cache: 'no-store',
    });
    const value = (await response.json()) as ActionResult & {
      state?: DemoState;
      today?: string;
      error?: string;
    };
    if (!response.ok || !value.ok) {
      return {
        ok: false,
        error: value.ok === false ? value.error : 'Reset failed',
      };
    }
    emit({
      mode: readMode(value.state),
      ready: true,
      state: value.state ?? null,
      today: value.today ?? '',
      wallet: readDemoAccount(),
      hasWalletSession: true,
      error: '',
      progress: 'Demo reset',
    });
    return {
      ok: true,
      version: value.state?.version ?? 0,
      message: 'Demo reset',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Reset failed',
    };
  }
}

async function prefillDemo(): Promise<ActionResult> {
  try {
    const response = await fetch('/api/demo/prefill', {
      method: 'POST',
      cache: 'no-store',
    });
    const value = (await response.json()) as ActionResult & {
      state?: DemoState;
      today?: string;
      error?: string;
    };
    if (!response.ok || !value.ok) {
      return {
        ok: false,
        error: value.ok === false ? value.error : 'Prefill failed',
      };
    }
    emit({
      mode: readMode(value.state),
      ready: true,
      state: value.state ?? null,
      today: value.today ?? '',
      wallet: readDemoAccount(),
      hasWalletSession: true,
      error: '',
      progress: 'Demo prefilled',
    });
    return {
      ok: true,
      version: value.state?.version ?? 0,
      message: 'Demo prefilled',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Prefill failed',
    };
  }
}

export function ChainProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastChain = 0;
    const poll = async () => {
      if (snapshot.busy) {
        if (!stopped) timer = setTimeout(poll, 1500);
        return;
      }
      const response = await fetch('/api/demo/state', { cache: 'no-store' });
      const value = (await response.json()) as {
        state?: DemoState;
        today?: string;
        error?: string;
      };
      if (stopped) return;
      const mode = readMode(value.state);
      if (mode === 'simulated') {
        if (value.state) {
          emit({
            mode,
            ready: true,
            state: value.state,
            today: value.today ?? '',
            wallet: readDemoAccount(),
            hasWalletSession: true,
            error: '',
          });
        }
      } else {
        if (snapshot.mode !== 'demo') {
          restoreGeneratedWallet();
          emit({
            mode: 'demo',
            wallet: session ? snapshot.wallet : '',
            hasWalletSession: Boolean(session),
            ready: false,
            state: null,
            error: '',
          });
        }
        discovery ??= createWalletDiscovery();
        if (Date.now() - lastChain > 4000 || !snapshot.ready) {
          lastChain = Date.now();
          await refreshChainOnly();
          emit({ mode: 'demo' });
        } else {
          emit({ mode: 'demo' });
        }
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      generation++;
    };
  }, []);
  return children;
}
export function useChainStore() {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => initial,
  );
  return {
    ...state,
    dispatch,
    reset: resetDemo,
    prefill: prefillDemo,
  };
}
