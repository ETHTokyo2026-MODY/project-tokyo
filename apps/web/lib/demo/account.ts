'use client';

import { useSearchParams } from 'next/navigation';
import { viewedAccount } from '../chain/model';
import { useChainStore } from '../chain/store';

export function linkTo(
  path: string,
  extra: Record<string, string> = {},
  account: string,
): string {
  return `${path}?${new URLSearchParams({ ...extra, account }).toString()}`;
}

export function useAccount(): string {
  const { wallet, state } = useChainStore();
  return viewedAccount(
    useSearchParams().get('account'),
    wallet,
    state?.accounts,
  );
}
