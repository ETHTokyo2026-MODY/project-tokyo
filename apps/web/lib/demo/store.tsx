'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { applyAction, UserError } from './actions';
import { todayTokyo } from './dates';
import { seedState } from './seed';
import { decodeState, loadState, saveState, STORAGE_KEY } from './storage';
import { tick } from './tick';
import type { DemoState } from './types';

export type DemoDispatchResult =
  | ({ ok: true; version: number } & Record<string, unknown>)
  | { ok: false; error: string };

export type DemoStoreValue = {
  ready: boolean;
  state: DemoState | null;
  today: string;
  dispatch: (
    name: string,
    body?: Record<string, unknown>,
  ) => DemoDispatchResult;
  reset: () => DemoDispatchResult;
};

type Snapshot = {
  ready: boolean;
  state: DemoState | null;
  today: string;
};

const CHANNEL = 'project-tokyo';
const TICK_MS = 15_000;
const serverSnap: Snapshot = { ready: false, state: null, today: '' };

let snap: Snapshot = { ready: false, state: null, today: '' };
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let started = 0;
let boot = 0;

function emit(next: Snapshot) {
  snap = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snap;
}

function getServerSnapshot() {
  return serverSnap;
}

function persist(state: DemoState) {
  void saveState(state).then(() => {
    try {
      channel?.postMessage(state);
    } catch {
      // channel may already be closed
    }
  });
}

function adopt(incoming: DemoState) {
  if (snap.state && incoming.version < snap.state.version) return;
  emit({ ready: true, state: incoming, today: todayTokyo() });
}

function runTick() {
  if (!snap.ready || !snap.state) return;
  const today = todayTokyo();
  const now = new Date().toISOString();
  if (!tick(snap.state, today, now)) {
    if (today !== snap.today) emit({ ...snap, today });
    return;
  }
  snap.state.version += 1;
  emit({ ready: true, state: snap.state, today });
  persist(snap.state);
}

function dispatch(
  name: string,
  body: Record<string, unknown> = {},
): DemoDispatchResult {
  if (!snap.ready || !snap.state) return { ok: false, error: 'Not ready' };
  const today = todayTokyo();
  const now = new Date().toISOString();
  if (tick(snap.state, today, now)) {
    snap.state.version += 1;
    emit({ ready: true, state: snap.state, today });
    persist(snap.state);
  }
  try {
    const { state, out } = applyAction(snap.state, name, body, { today, now });
    emit({ ready: true, state, today });
    persist(state);
    return { ok: true, version: state.version, ...out };
  } catch (e) {
    if (e instanceof UserError) return { ok: false, error: e.message };
    throw e;
  }
}

function reset() {
  return dispatch('reset');
}

async function bootStore() {
  const my = ++boot;
  const today = todayTokyo();
  const now = new Date().toISOString();
  let state = await loadState();
  let fresh = false;
  if (!state) {
    state = seedState(today);
    fresh = true;
  }
  const changed = tick(state, today, now);
  if (my !== boot) return;
  if (fresh || changed) persist(state);
  emit({ ready: true, state, today });
}

function onStorage(e: StorageEvent) {
  if (e.key !== STORAGE_KEY || e.newValue == null) return;
  void decodeState(e.newValue).then((s) => {
    if (s) adopt(s);
  });
}

function onMessage(e: MessageEvent<DemoState>) {
  const s = e.data;
  if (!s || typeof s.version !== 'number' || !Array.isArray(s.assets)) return;
  adopt(s);
}

function onVisibility() {
  if (document.visibilityState === 'visible') runTick();
}

function startStore() {
  started += 1;
  if (started !== 1) return;
  void bootStore();
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener('message', onMessage);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
  }
  intervalId = setInterval(runTick, TICK_MS);
}

function stopStore() {
  started -= 1;
  if (started > 0) return;
  boot += 1;
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onVisibility);
  }
  if (channel) {
    channel.removeEventListener('message', onMessage);
    channel.close();
    channel = null;
  }
}

export function DemoProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    startStore();
    return () => stopStore();
  }, []);
  return children;
}

export function useDemo(): DemoStoreValue {
  const snapNow = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  return {
    ready: snapNow.ready,
    state: snapNow.state,
    today: snapNow.today,
    dispatch,
    reset,
  };
}
