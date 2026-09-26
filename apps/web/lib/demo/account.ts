'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDemo } from './store';

export const ACCOUNT_KEY = 'project-tokyo:account';
export const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,40}$/;

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

export function useAccount(): string {
  const params = useSearchParams();
  const { state, ready } = useDemo();
  const [stored, setStored] = useState<string | null>(null);

  useEffect(() => {
    setStored(storedAccount());
  }, []);

  const account = pickAccount(
    params.get('account'),
    stored,
    ready && state ? state.accounts : undefined,
  );

  useEffect(() => {
    remember(account);
  }, [account]);

  return account;
}
