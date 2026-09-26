'use client';

import { useEffect } from 'react';
import { useAccount } from '@/lib/demo/account';
import { money, signed } from '@/lib/demo/format';
import { useDemo } from '@/lib/demo/store';

const TITLE = 'Dashboard · Project Tokyo (demo)';

export default function DashboardPage() {
  const { ready, state } = useDemo();
  const accountId = useAccount();

  useEffect(() => {
    document.title = TITLE;
  }, []);

  const acct = ready && state ? state.accounts[accountId] : undefined;
  if (!acct) {
    return (
      <main className="page">
        <h1>Dashboard</h1>
        <div className="muted">Loading demo…</div>
      </main>
    );
  }

  const pl = acct.cash - acct.startCash;
  return (
    <main className="page">
      <h1>Dashboard</h1>
      <div className="muted">
        {acct.name} · {acct.role} · cash {money(acct.cash)} · P/L{' '}
        <span className={pl >= 0 ? 'pos' : 'neg'}>{signed(pl)}</span>
      </div>
    </main>
  );
}
