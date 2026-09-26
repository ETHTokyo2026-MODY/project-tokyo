'use client';

import { Suspense, useEffect } from 'react';
import { useChainStore } from '@/lib/chain/store';

const TITLE = 'Stats · ProjectTokyo';

function Loading() {
  return (
    <main className="page">
      <h1>Stats</h1>
      <div className="muted">Loading…</div>
    </main>
  );
}

function StatsInner() {
  const { ready, state } = useChainStore();

  useEffect(() => {
    document.title = TITLE;
  }, []);

  if (!ready || !state) return <Loading />;
  return (
    <main className="page">
      <h1>Stats</h1>
      <div className="muted">
        Charts and profit statistics are unavailable. Confirmed trade prices
        are shown per day in the calendar and in Profile.
      </div>
    </main>
  );
}

export default function StatsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <StatsInner />
    </Suspense>
  );
}
