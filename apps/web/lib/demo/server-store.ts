import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyAction, UserError } from './actions';
import { todayTokyo } from './dates';
import { parseMode, writeMode } from './mode';
import { buildPrefillState } from './prefill';
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
    const parsed: unknown = JSON.parse(
      readFileSync(/*turbopackIgnore: true*/ demoStatePath(), 'utf8'),
    );
    if (isDemoState(parsed)) return writeMode(parsed, parseMode(parsed.mode));
  } catch {
    // missing or unreadable file → empty
  }
  return emptyState(todayTokyo());
}

function save(state: DemoState) {
  const path = demoStatePath();
  mkdirSync(/*turbopackIgnore: true*/ dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(/*turbopackIgnore: true*/ tmp, `${JSON.stringify(state)}\n`);
  renameSync(/*turbopackIgnore: true*/ tmp, path);
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

export function prefillDemoState(): Promise<DemoState> {
  return exclusive(() => {
    const next = buildPrefillState(todayTokyo(), new Date().toISOString());
    save(next);
    return structuredClone(next);
  });
}

export function dispatchDemoAction(
  name: string,
  body: Record<string, unknown>,
): Promise<{ state: DemoState; out: Record<string, unknown> }> {
  return exclusive(() => {
    if (name === 'set-mode') {
      const current = load();
      const state = {
        ...writeMode(current, parseMode(body.mode)),
        version: current.version + 1,
      };
      save(state);
      return { state: structuredClone(state), out: {} };
    }
    const today = todayTokyo();
    const now = new Date().toISOString();
    try {
      const current = load();
      const { state, out } = applyAction(current, name, body, { today, now });
      const next =
        name === 'reset' ? state : writeMode(state, parseMode(current.mode));
      save(next);
      return { state: structuredClone(next), out };
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw error;
    }
  });
}

export function demoToday(): string {
  return todayTokyo();
}
