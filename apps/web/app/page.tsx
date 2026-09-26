'use client';

import { useEffect, useMemo } from 'react';
import { Screener } from '@/components/dashboard/Screener';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { money, signed } from '@/lib/demo/format';
import { summaries } from '@/lib/demo/summaries';
import { useDemo } from '@/lib/demo/store';
import './dash.css';
import './screener.css';

const TITLE = 'Dashboard · Project Tokyo (demo)';

export default function DashboardPage() {
  const { ready, state, today } = useDemo();
  const accountId = useAccount();

  useEffect(() => {
    document.title = TITLE;
  }, []);

  const list = useMemo(
    () => (state ? summaries(state, today) : []),
    [state, today],
  );
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
  const provided = list.filter((a) => a.provider === accountId);
  const holding = list.filter(
    (a) =>
      a.provider !== accountId &&
      a.byAccount[accountId] &&
      (a.byAccount[accountId].owned || a.byAccount[accountId].trades),
  );
  const pos = (id: string) =>
    list.find((a) => a.id === id)?.byAccount[accountId] || {
      owned: 0,
      listed: 0,
      booked: 0,
      value: 0,
      paid: 0,
      received: 0,
      trades: 0,
    };

  return (
    <main className="page">
      <h1>Dashboard</h1>
      <div className="muted">
        {acct.name} · {acct.role} · cash {money(acct.cash)} · P/L{' '}
        <span className={pl >= 0 ? 'pos' : 'neg'}>{signed(pl)}</span>
      </div>
      <div className="h2row" id="mineHead">
        <h2>My assets</h2>
      </div>
      <div className="scroll-x">
        {!provided.length && !holding.length ? (
          <div className="empty">
            You don&apos;t provide any assets or own any days yet. Pick an asset
            below to buy days, or add your own with &quot;+ Add asset&quot;.
          </div>
        ) : null}
        {provided.length ? (
          <table className="list">
            <thead>
              <tr>
                <th>Asset you provide</th>
                <th>Location</th>
                <th className="n">Days still yours</th>
                <th className="n">For sale</th>
                <th className="n">Booked</th>
                <th className="n">Days sold</th>
                <th className="n">Received</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {provided.map((a) => {
                const p = pos(a.id);
                const href = linkTo('/calendar', { asset: a.id }, accountId);
                return (
                  <tr
                    key={a.id}
                    className="link"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a,button')) return;
                      location.href = href;
                    }}
                  >
                    <td>
                      <a className="rowlink" href={href}>
                        <b>{a.title}</b>
                      </a>{' '}
                      <TypeBadge type={a.type} />
                    </td>
                    <td>{a.location}</td>
                    <td className="n">
                      {p.owned} / {a.futureDays}
                    </td>
                    <td className="n">{p.listed}</td>
                    <td className="n">{p.booked}</td>
                    <td className="n">{a.futureDays - p.owned}</td>
                    <td className="n">{money(p.received)}</td>
                    <td />
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {holding.length ? (
          <table className="list" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Asset where you own days</th>
                <th>Provider</th>
                <th className="n">Days owned</th>
                <th className="n">For sale</th>
                <th className="n">Booked</th>
                <th className="n">Value (public prices)</th>
                <th className="n">Paid</th>
                <th className="n">Received</th>
                <th className="n">Realized P/L</th>
              </tr>
            </thead>
            <tbody>
              {holding.map((a) => {
                const p = pos(a.id);
                const rpl = p.received - p.paid;
                const href = linkTo('/calendar', { asset: a.id }, accountId);
                return (
                  <tr
                    key={a.id}
                    className="link"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a')) return;
                      location.href = href;
                    }}
                  >
                    <td>
                      <a className="rowlink" href={href}>
                        <b>{a.title}</b>
                      </a>{' '}
                      <TypeBadge type={a.type} />
                    </td>
                    <td>{a.providerName}</td>
                    <td className="n">{p.owned}</td>
                    <td className="n">{p.listed}</td>
                    <td className="n">{p.booked}</td>
                    <td className="n">{money(p.value)}</td>
                    <td className="n">{money(p.paid)}</td>
                    <td className="n">{money(p.received)}</td>
                    <td className={`n ${rpl >= 0 ? 'pos' : 'neg'}`}>
                      {signed(rpl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
      <h2>All assets</h2>
      <Screener assets={list} account={accountId} />
    </main>
  );
}
