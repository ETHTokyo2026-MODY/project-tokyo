'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDemo } from './store';

export const ACCOUNT_KEY = 'project-tokyo:account';
export const ACCOUNT_RE = /^(?:0x[0-9a-fA-F]{40}|[A-Za-z0-9_-]{1,40})$/;

function storedAccount(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function remember(account: string) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ACCOUNT_KEY, account);
  } catch {
    // ignore quota / private mode
  }
}

/** Resolve ?account= (if valid), else the remembered id, else host. */
export function pickAccount(
  query: string | null,
  stored: string | null,
  accounts?: Record<string, unknown>,
): string {
  let id = query || stored || 'host';
  if (!ACCOUNT_RE.test(id)) id = 'host';
  if (accounts && !accounts[id]) id = 'host';
  return id;
}

export function linkTo(
  path: string,
  extra: Record<string, string> = {},
  account: string,
): string {
  return `${path}?${new URLSearchParams({ ...extra, account }).toString()}`;
}

function subscribeStoredAccount(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ACCOUNT_KEY && event.key !== null) return;
    onStoreChange();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function useAccount(): string {
  const params = useSearchParams();
  const { state, ready, wallet, mode } = useDemo();
  const stored = useSyncExternalStore(
    subscribeStoredAccount,
    storedAccount,
    () => null,
  );
  const account = pickAccount(
    params.get('account'),
    stored,
    ready && state ? state.accounts : undefined,
  );

  useEffect(() => {
    if (mode === 'sample') remember(account);
  }, [account, mode]);

  return mode === 'chain' ? wallet : account;
}
