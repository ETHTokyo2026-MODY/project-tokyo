'use client';
import type { ReactNode } from 'react';
import {
  DemoProvider as SampleProvider,
  useDemo as useSample,
} from './sample-store';
import {
  ChainProvider,
  useChainStore,
  type ActionResult,
} from '../chain/store';
export type DemoDispatchResult = ActionResult;
// Deployed builds always expose live wallets; the local preview mode is explicit.
export const DATA_MODE: 'sample' | 'live' = 'sample';
export const SAMPLE_MODE =
  process.env.NODE_ENV !== 'production' && DATA_MODE === 'sample';
export function DemoProvider({ children }: { children: ReactNode }) {
  return SAMPLE_MODE ? (
    <SampleProvider>{children}</SampleProvider>
  ) : (
    <ChainProvider>{children}</ChainProvider>
  );
}
export function useDemo() {
  const sample = useSample();
  const chain = useChainStore();
  return SAMPLE_MODE
    ? {
        ...sample,
        wallet: '',
        busy: false,
        error: '',
        progress: '',
        hashes: [] as string[],
        mode: 'sample' as const,
      }
    : { ...chain, mode: 'chain' as const };
}
