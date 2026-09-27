import { applyAction, UserError } from './actions';
import { todayTokyo } from './dates';
import { emptyState } from './seed';
import type { DemoState } from './types';

type Box = { state: DemoState };

const GLOBAL_KEY = '__projectTokyoDemoStore';

function box(): Box {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Box };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { state: emptyState(todayTokyo()) };
  return g[GLOBAL_KEY]!;
}

export function readDemoState(): DemoState {
  return structuredClone(box().state);
}

export function resetDemoState(): DemoState {
  const next = emptyState(todayTokyo());
  box().state = next;
  return structuredClone(next);
}

export function dispatchDemoAction(
  name: string,
  body: Record<string, unknown>,
): { state: DemoState; out: Record<string, unknown> } {
  const today = todayTokyo();
  const now = new Date().toISOString();
  try {
    const { state, out } = applyAction(box().state, name, body, { today, now });
    box().state = state;
    return { state: structuredClone(state), out };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw error;
  }
}

export function demoToday(): string {
  return todayTokyo();
}
