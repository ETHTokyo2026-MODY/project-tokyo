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
export const DATA_MODE: 'sample' | 'live' = 'sample';
export const SAMPLE_MODE = DATA_MODE === 'sample';
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
