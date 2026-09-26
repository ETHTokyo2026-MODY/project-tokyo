'use client';

import type { ChangeEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ACCOUNT_KEY, linkTo, useAccount } from '@/lib/demo/account';
import { useDemo } from '@/lib/demo/store';

const TABS: { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/profile', label: 'Profile' },
  { href: '/stats', label: 'Stats' },
];

const FALLBACK_ACCOUNTS: [string, string][] = [
  ['host', 'Turo Host'],
  ['traderA', 'Trader A'],
  ['traderB', 'Trader B'],
  ['kenji', 'Kenji Drives'],
  ['sakura', 'Sakura Stays'],
  ['machiya', 'Gion Machiya Co.'],
  ['shinjukuGate', 'Hotel Shinjuku Gate'],
];

function accountEntries(
  accounts?: Record<string, { name: string }>,
): [string, string][] {
  if (!accounts) return FALLBACK_ACCOUNTS;
  return Object.entries(accounts).map(([id, a]) => [id, a.name]);
}

export function Nav() {
  const account = useAccount();
  const { ready, state } = useDemo();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (pathname === '/curve') return null;
  const tabs = TABS;
  const entries = accountEntries(ready && state ? state.accounts : undefined);
  const options = entries.some(([id]) => id === account)
    ? entries
    : ([[account, account], ...entries] as [string, string][]);

  function onAccountChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    try {
      localStorage.setItem(ACCOUNT_KEY, next);
    } catch {
      // ignore quota / private mode
    }
    const q = new URLSearchParams(searchParams.toString());
    q.set('account', next);
    window.location.search = q.toString();
  }

  return (
    <nav id="nav" aria-label="Main">
      <span className="brand">
        Project Tokyo<small>demo · sample data</small>
      </span>
      {tabs.map((tab) => {
        const on = pathname === tab.href;
        return (
          <a
            key={tab.href}
            className={on ? 'tab on' : 'tab'}
            href={linkTo(tab.href, {}, account)}
            aria-current={on ? 'page' : undefined}
          >
            {tab.label}
          </a>
        );
      })}
      <label className="who" htmlFor="account">
        Viewing as{' '}
        <select id="account" value={account} onChange={onAccountChange}>
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}
