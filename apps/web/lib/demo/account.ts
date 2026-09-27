'use client';

import { useSearchParams } from 'next/navigation';
import { viewedAccount } from '../chain/model';
import { useChainStore } from '../chain/store';
import { DEMO_MODE } from './mode';

export function linkTo(
  path: string,
  extra: Record<string, string> = {},
  account: string,
): string {
  return `${path}?${new URLSearchParams({ ...extra, account }).toString()}`;
}

export function useAccount(): string {
  const { wallet, state } = useChainStore();
  if (DEMO_MODE === 'simulated') return wallet;
  return viewedAccount(
    useSearchParams().get('account'),
    wallet,
    state?.accounts,
  );
}
