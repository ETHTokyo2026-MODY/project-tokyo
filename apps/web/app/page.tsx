'use client';

import Link from 'next/link';

import { useEffect, useMemo } from 'react';
import { AddAssetForm } from '@/components/dashboard/AddAssetForm';
import { Screener } from '@/components/dashboard/Screener';
import { EnsName } from '@/components/EnsName';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { DEMO_MODE } from '@/lib/demo/mode';
import { usdText } from '@/lib/chain/model';
import { money, shortDate, signed } from '@/lib/demo/format';
import { summaries } from '@/lib/demo/summaries';
import { useChainStore } from '@/lib/chain/store';
import './dash.css';
import './screener.css';
import './add.css';

const TITLE = 'Dashboard · DayTrader';

export default function DashboardPage() {
  const { ready, state, today, dispatch, busy, wallet } = useChainStore();
  const accountId = useAccount();
  const readOnly = accountId !== wallet;

  useEffect(() => {
    document.title = TITLE;
  }, []);

  const list = useMemo(
    () => (state ? summaries(state, today) : []),
    [state, today],
  );
  const acct = state?.accounts[accountId];
  if (!state) {
    return (
      <main className="page">
        <h1>Dashboard</h1>
        <div className="muted">Loading…</div>
      </main>
    );
  }

  if (!acct)
    return (
      <main className="page">
        <h1>Dashboard</h1>
        <p className="muted">Connect a wallet to trade or add an asset.</p>
        <h2>All assets</h2>
        <Screener assets={list} account={accountId} />
      </main>
    );

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
      {!readOnly && (DEMO_MODE === 'real' || accountId === 'host') ? (
        <AddAssetForm account={accountId} />
      ) : null}
      <div className="scroll-x">
        {!provided.length && !holding.length ? (
          <div className="empty">No assets or days owned yet.</div>
        ) : null}
        {provided.length ? (
          <table className="list">
            <thead>
              <tr>
                <th>Asset you provide</th>
                <th>Location</th>
                <th className="n">Days still yours</th>
                <th className="n">Listed for sale</th>
                <th className="n">Booked</th>
                <th className="n">Owned by others</th>
                <th className="n">Received</th>
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
                      <Link
                        className="rowlink"
                        href={linkTo('/asset', { asset: a.id }, accountId)}
                      >
                        <b>{a.title}</b>
                      </Link>{' '}
                      <TypeBadge type={a.type} />
                      {a.ensName ? (
                        <div>
                          <EnsName name={a.ensName} address={a.id} />
                        </div>
                      ) : null}
                    </td>
                    <td>{a.location}</td>
                    <td className="n">
                      {p.owned} / {a.futureDays}
                    </td>
                    <td className="n">{p.listed}</td>
                    <td className="n">{p.booked}</td>
                    <td className="n">{a.futureDays - p.owned}</td>
                    <td className="n">
                      {state?.chain ? 'Unavailable' : money(p.received)}
                    </td>
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
                <th className="n">Listed for sale</th>
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
                      <Link
                        className="rowlink"
                        href={linkTo('/asset', { asset: a.id }, accountId)}
                      >
                        <b>{a.title}</b>
                      </Link>{' '}
                      <TypeBadge type={a.type} />
                      {a.ensName ? (
                        <div>
                          <EnsName name={a.ensName} address={a.id} />
                        </div>
                      ) : null}
                    </td>
                    <td>{a.providerName}</td>
                    <td className="n">{p.owned}</td>
                    <td className="n">{p.listed}</td>
                    <td className="n">{p.booked}</td>
                    <td className="n">{money(p.value)}</td>
                    <td className="n">
                      {state?.chain ? 'Unavailable' : money(p.paid)}
                    </td>
                    <td className="n">
                      {state?.chain ? 'Unavailable' : money(p.received)}
                    </td>
                    <td className={`n ${rpl >= 0 ? 'pos' : 'neg'}`}>
                      {state?.chain ? 'Unavailable' : signed(rpl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
      {state?.chain && !readOnly ? (
        <section>
          <h2>Open buy orders</h2>
          {state.bids?.length ? (
            state.bids.map((bid) => (
              <div className="row" key={bid.id}>
                <Link
                  href={linkTo('/calendar', { asset: bid.asset }, accountId)}
                >
                  {state.assets.find((a) => a.id === bid.asset)?.title ??
                    bid.asset}{' '}
                  · {shortDate(bid.from)}–{shortDate(bid.to)}
                </Link>
                <span>Maximum ${usdText(bid.maxTotal!)}</span>
                <button
                  type="button"
                  disabled={busy || !ready}
                  onClick={async () => {
                    await dispatch('cancel-bid', { id: bid.id });
                  }}
                >
                  Cancel order
                </button>
              </div>
            ))
          ) : (
            <div className="empty">No open buy orders for this wallet.</div>
          )}
        </section>
      ) : null}
      <h2>All assets</h2>
      <Screener assets={list} account={accountId} />
    </main>
  );
}
