'use client';

import { useChainStore } from '../chain/store';

export function linkTo(
  path: string,
  extra: Record<string, string> = {},
  account: string,
): string {
  return `${path}?${new URLSearchParams({ ...extra, account }).toString()}`;
}

export function useAccount(): string {
  return useChainStore().wallet;
}
