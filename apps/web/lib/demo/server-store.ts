import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyAction, UserError } from './actions';
import { todayTokyo } from './dates';
import { emptyState } from './seed';
import type { DemoState } from './types';

export const DEFAULT_DEMO_STATE_PATH = '/tmp/projecttokyo-demo.json';

type Gate = { queue: Promise<unknown> };

const GATE_KEY = '__projectTokyoDemoLock';

function gate(): Gate {
  const g = globalThis as typeof globalThis & { [GATE_KEY]?: Gate };
  if (!g[GATE_KEY]) g[GATE_KEY] = { queue: Promise.resolve() };
  return g[GATE_KEY]!;
}

async function exclusive<T>(fn: () => T): Promise<T> {
  const lock = gate();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = lock.queue;
  lock.queue = next;
  await prev;
  try {
    return fn();
  } finally {
    release();
  }
}

export function demoStatePath(): string {
  const fromEnv = process.env.DEMO_STATE_PATH?.trim();
  return fromEnv || DEFAULT_DEMO_STATE_PATH;
}

function isDemoState(value: unknown): value is DemoState {
  if (!value || typeof value !== 'object') return false;
  const state = value as DemoState;
  return (
    typeof state.version === 'number' &&
    typeof state.seededOn === 'string' &&
    state.accounts != null &&
    typeof state.accounts === 'object' &&
    Array.isArray(state.assets)
  );
}

function load(): DemoState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(demoStatePath(), 'utf8'));
    if (isDemoState(parsed)) return parsed;
  } catch {
    // missing or unreadable file → empty
  }
  return emptyState(todayTokyo());
}

function save(state: DemoState) {
  const path = demoStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

export function readDemoState(): Promise<DemoState> {
  return exclusive(() => structuredClone(load()));
}

export function resetDemoState(): Promise<DemoState> {
  return exclusive(() => {
    const next = emptyState(todayTokyo());
    save(next);
    return structuredClone(next);
  });
}

export function dispatchDemoAction(
  name: string,
  body: Record<string, unknown>,
): Promise<{ state: DemoState; out: Record<string, unknown> }> {
  return exclusive(() => {
    const today = todayTokyo();
    const now = new Date().toISOString();
    try {
      const { state, out } = applyAction(load(), name, body, { today, now });
      save(state);
      return { state: structuredClone(state), out };
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw error;
    }
  });
}

export function demoToday(): string {
  return todayTokyo();
}
