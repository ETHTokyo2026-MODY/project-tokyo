'use client';

import { useSearchParams } from 'next/navigation';
import { viewedAccount } from '../chain/model';
import { useChainStore } from '../chain/store';

export {
  DEMO_ACCOUNT_IDS,
  DEMO_ACCOUNT_LABELS,
  DEMO_START_CASH,
  isDemoAccountId,
  readDemoAccount,
  writeDemoAccount,
  type DemoAccountId,
} from './accounts';

export function linkTo(
  path: string,
  extra: Record<string, string> = {},
  account: string,
): string {
  return `${path}?${new URLSearchParams({ ...extra, account }).toString()}`;
}

export function useAccount(): string {
  const { wallet, state, mode } = useChainStore();
  const requested = useSearchParams().get('account');
  if (mode === 'simulated') return wallet;
  return viewedAccount(requested, wallet, state?.accounts);
}
