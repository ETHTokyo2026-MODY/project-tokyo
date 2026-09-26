'use client';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { parseUnits } from 'viem';
import type { DemoState } from '../demo/types';
import {
  normalizeAssetId,
  chainState,
  dayDate,
  exactDay,
  parseUSDC,
  usdText,
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
export type ActionResult =
  | { ok: true; version: number; asset?: string; message?: string }
  | { ok: false; error: string };
type Snapshot = {
  ready: boolean;
  state: DemoState | null;
  today: string;
  wallet: string;
  hasWalletSession: boolean;
  busy: boolean;
  error: string;
  progress: string;
  hashes: string[];
};
const initial: Snapshot = {
  ready: false,
  state: null,
  today: '',
  wallet: '',
  hasWalletSession: false,
  busy: false,
  error: '',
  progress: '',
  hashes: [],
};
let snapshot = initial;
const listeners = new Set<() => void>();
let discovery: ReturnType<typeof createWalletDiscovery> | undefined;
let session: WalletSession | undefined;
let unsubscribeSession: (() => void) | undefined;
let walletRefresh: Promise<void> = Promise.resolve();
let generation = 0;
const emit = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
};
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
export async function refreshChain(): Promise<void> {
  const revision = ++generation;
  try {
    const result = await api<ChainSnapshot>(
      `state${snapshot.wallet ? `?account=${snapshot.wallet}` : ''}`,
    );
    if (revision !== generation) return;
    if (!result.ready) {
      emit({
        ready: false,
        error: 'The Sepolia index is catching up. Refresh shortly.',
      });
      return;
    }
    emit({
      ready: true,
      state: chainState(result, snapshot.wallet),
      today: dayDate(result.today),
      error: '',
    });
  } catch (error) {
    if (revision === generation)
      emit({
        ready: false,
        error:
          error instanceof Error
            ? error.message
            : 'Could not load Sepolia state',
      });
  }
}
export async function connectWallet(selection: WalletSelection): Promise<void> {
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
        error: account
          ? ''
          : 'Wallet connection changed. Reconnect or select Sepolia.',
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
  discovery ??= createWalletDiscovery();
  discovery.refresh();
  return discovery.list();
}
export async function switchNetwork() {
  if (!session) throw new Error('Connect a wallet first');
  if (snapshot.busy) throw new Error('Wait for the current wallet action');
  emit({ busy: true });
  try {
    await session.switchToSepolia();
    await walletRefresh;
  } finally {
    emit({ busy: false });
  }
}
export async function disconnectWallet(): Promise<void> {
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
export async function dispatch(
  name: string,
  body: Record<string, unknown> = {},
): Promise<ActionResult> {
  if (snapshot.busy)
    return { ok: false, error: 'A wallet action is already in progress' };
  if (!snapshot.ready)
    return {
      ok: false,
      error: 'Wait for a current chain snapshot before acting',
    };
  if (!session || !snapshot.wallet)
    return { ok: false, error: 'Connect your wallet first' };
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
      throw new Error('Backend must use Sepolia');
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

    await refreshChain();
    const message =
      name === 'create-asset'
        ? 'Asset created. Listing authorization required: publish each sale range from the calendar.'
        : name === 'discounts'
          ? 'Discounts saved. Existing sale authorizations are invalid; sellers must republish listings.'
          : name === 'buy' || name === 'buy-block'
            ? 'Buy order published. Ownership changes only after an onchain fill.'
            : name === 'list'
              ? 'Sale published. Wallet tokens remain yours until filled.'
              : 'Confirmed on Sepolia.';
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
export function ChainProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    discovery ??= createWalletDiscovery();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!snapshot.busy) await refreshChain();
      if (!stopped) timer = setTimeout(poll, 8000);
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
    reset: async (): Promise<ActionResult> => ({
      ok: false,
      error: 'Onchain state cannot be reset',
    }),
  };
}
