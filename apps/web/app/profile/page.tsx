'use client';

import Link from 'next/link';

import { Suspense, useEffect, useMemo } from 'react';
import { usdText } from '@/lib/chain/model';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { longDate, money, signed } from '@/lib/demo/format';
import { profile } from '@/lib/demo/profile';
import { useChainStore } from '@/lib/chain/store';

const TITLE = 'Profile · DayTrader';
const WHAT = {
  bought: 'Bought',
  sold: 'Sold',
  payout: 'Paid out (day passed)',
} as const;

function Loading() {
  return (
    <main className="page">
      <h1>Profile</h1>
      <div className="muted">Loading…</div>
    </main>
  );
}

function ProfileInner() {
  const { ready, state, today, wallet } = useChainStore();
  const account = useAccount();

  useEffect(() => {
    document.title = TITLE;
  }, []);

  const p = useMemo(
    () => (state ? profile(state, account, today) : null),
    [state, account, today],
  );

  if (!state) return <Loading />;
  if (!p)
    return (
      <main className="page">
        <h1>Profile</h1>
        <p className="muted">Connect a wallet to view your portfolio.</p>
      </main>
    );

  return (
    <main className="page">
      <h1>{p.name}</h1>
      <div className="muted">
        {p.role}
        {p.provides.length
          ? ` · provides ${p.provides.map((a) => a.title).join(', ')}`
          : ''}
      </div>
      <div className="cards" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="sub">Cash</div>
          <div className="t" style={{ fontSize: 22 }}>
            {account === wallet ? money(p.cash) : 'Unavailable'}
          </div>
        </div>
        <div className="card">
          <div className="sub">Profit / loss</div>
          <div
            className={`t ${p.pnl > 0 ? 'pos' : p.pnl < 0 ? 'neg' : ''}`}
            style={{ fontSize: 22 }}
          >
            {state.chain ? 'Unavailable' : signed(p.pnl)}
          </div>
        </div>
        <div className="card">
          <div className="sub">Days owned (upcoming)</div>
          <div className="t" style={{ fontSize: 22 }}>
            {p.daysOwned}
          </div>
        </div>
        <div className="card">
          <div className="sub">Trades</div>
          <div className="t" style={{ fontSize: 22 }}>
            {state.chain && !state.historyReady
              ? 'Unavailable'
              : p.historyCount}
          </div>
        </div>
      </div>
      <h2>Days owned</h2>
      <div className="scroll-x">
        {p.owned.length ? (
          <table className="list">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="n">Days</th>
                <th className="n">Listed for sale</th>
                <th className="n">Booked</th>
                <th className="n">Value (public prices)</th>
              </tr>
            </thead>
            <tbody>
              {p.owned.map((o) => {
                const href = linkTo('/calendar', { asset: o.asset }, account);
                return (
                  <tr
                    key={o.asset}
                    className="link"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a')) return;
                      location.href = href;
                    }}
                  >
                    <td>
                      <Link className="rowlink" href={href}>
                        <b>{o.title}</b>
                      </Link>{' '}
                      <TypeBadge type={o.type} />
                    </td>
                    <td className="n">{o.days}</td>
                    <td className="n">{o.listed}</td>
                    <td className="n">{o.booked}</td>
                    <td className="n">{money(o.value)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">No future days owned.</div>
        )}
      </div>
      <h2>Trade history</h2>
      <div className="scroll-x">
        {p.history.length ? (
          <>
            <table className="list">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Asset</th>
                  <th>Day</th>
                  <th className="n">Price</th>
                </tr>
              </thead>
              <tbody>
                {p.history.map((h, i) => (
                  <tr key={`${h.at}-${h.date}-${i}`}>
                    <td>
                      {new Date(h.at).toLocaleString('en-GB', {
                        timeZone: 'Asia/Tokyo',
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      JST
                    </td>
                    <td>
                      {WHAT[h.type]}
                      {h.block && h.block > 1 ? (
                        <span className="muted"> ({h.block}-day block)</span>
                      ) : null}
                    </td>
                    <td>{h.title}</td>
                    <td>{longDate(h.date)}</td>
                    <td className="n">
                      {h.transactionHash && h.priceRaw ? (
                        <a
                          href={`https://eth-sepolia.blockscout.com/tx/${h.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ${usdText(h.priceRaw)} USDC
                        </a>
                      ) : (
                        money(h.price)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.historyCount > p.history.length ? (
              <div className="muted">
                Showing the latest {p.history.length} of{' '}
                {state.chain && !state.historyReady
                  ? 'Unavailable'
                  : p.historyCount}
                .
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty">
            {state.chain
              ? state.historyReady
                ? 'No trades yet.'
                : 'Trade history unavailable.'
              : 'No trades yet.'}
          </div>
        )}
      </div>
    </main>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProfileInner />
    </Suspense>
  );
}
