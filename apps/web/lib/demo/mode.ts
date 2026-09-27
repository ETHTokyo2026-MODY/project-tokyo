/** Flip to `'real'` to restore the Sepolia/wallet path. */
export const DEMO_MODE: 'simulated' | 'real' = 'simulated';

export const SIMULATED = DEMO_MODE === 'simulated';

export const DEMO_ACCOUNT_KEY = 'project-tokyo:demo-account';

export const DEMO_ACCOUNT_IDS = ['host', 'traderA', 'traderB'] as const;

export type DemoAccountId = (typeof DEMO_ACCOUNT_IDS)[number];

export const DEMO_ACCOUNT_LABELS: Record<DemoAccountId, string> = {
  host: 'Host',
  traderA: 'Trader A',
  traderB: 'Trader B',
};

export const DEMO_START_CASH = 1000;

export function isDemoAccountId(id: string): id is DemoAccountId {
  return (DEMO_ACCOUNT_IDS as readonly string[]).includes(id);
}

export function readDemoAccount(): DemoAccountId {
  if (typeof sessionStorage === 'undefined') return 'host';
  try {
    const stored = sessionStorage.getItem(DEMO_ACCOUNT_KEY);
    return stored && isDemoAccountId(stored) ? stored : 'host';
  } catch {
    return 'host';
  }
}

export function writeDemoAccount(id: DemoAccountId) {
  try {
    sessionStorage.setItem(DEMO_ACCOUNT_KEY, id);
  } catch {
    // private mode / quota
  }
}
