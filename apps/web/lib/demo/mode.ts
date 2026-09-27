/** Runtime Simulated vs Demo switch. Default Simulated. Easy to hook into. */

export const APP_MODES = ['simulated', 'demo'] as const;

export type AppMode = (typeof APP_MODES)[number];

export const DEFAULT_APP_MODE: AppMode = 'simulated';

export const APP_MODE_LABELS: Record<AppMode, string> = {
  simulated: 'Simulated',
  demo: 'Demo',
};

export function parseMode(value: unknown): AppMode {
  return value === 'demo' ? 'demo' : DEFAULT_APP_MODE;
}

export function readMode(
  state: { mode?: unknown } | null | undefined,
): AppMode {
  return parseMode(state?.mode);
}

export function isSimulated(
  state: { mode?: unknown } | null | undefined,
): boolean {
  return readMode(state) === 'simulated';
}

export function writeMode<T extends { mode?: AppMode }>(
  state: T,
  mode: AppMode,
): T {
  return { ...state, mode };
}

/** Persist the shared mode on the server store. Every window picks this up. */
export async function writeAppMode(mode: AppMode): Promise<{
  mode: AppMode;
  state: { mode?: unknown } | null;
}> {
  const response = await fetch('/api/demo/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'set-mode', body: { mode: parseMode(mode) } }),
    cache: 'no-store',
  });
  const value = (await response.json()) as {
    ok?: boolean;
    error?: string;
    state?: { mode?: unknown };
  };
  if (!response.ok || value.ok === false) {
    throw new Error(value.error ?? 'Could not set mode');
  }
  return { mode: readMode(value.state), state: value.state ?? null };
}
