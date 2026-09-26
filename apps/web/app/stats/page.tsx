'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LeadChart, VolumeChart } from '@/components/stats/BarCharts';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { money, signed } from '@/lib/demo/format';
import { assetStats } from '@/lib/demo/stats';
import { summaries } from '@/lib/demo/summaries';
import { useDemo } from '@/lib/demo/store';
import '../stats.css';

const TITLE = 'Stats · Project Tokyo (demo)';

function Loading() {
  return (
    <main className="page">
      <h1>Stats</h1>
      <div className="muted">Loading demo…</div>
    </main>
  );
}

function StatsInner() {
  const { ready, state, today } = useDemo();
  const account = useAccount();
  const params = useSearchParams();
  const assetQ = params.get('asset');
  const [volBy, setVolBy] = useState<'day' | 'week'>('day');

  useEffect(() => {
    document.title = TITLE;
  }, []);

  const list = useMemo(
    () => (state ? summaries(state, today) : []),
    [state, today],
  );
  const scopeAssets = useMemo(() => {
    if (!state || !assetQ) return null;
    if (assetQ === 'all') return state.assets;
    const one = state.assets.find((a) => a.id === assetQ);
    return one ? [one] : [];
  }, [assetQ, state]);
  const stats = useMemo(
    () =>
      scopeAssets && scopeAssets.length
        ? assetStats(scopeAssets, today, assetQ!)
        : null,
    [assetQ, scopeAssets, today],
  );

  if (!ready || !state) return <Loading />;

  if (!assetQ) {
    return (
      <main className="page">
        <h1>Stats</h1>
        <div className="muted">
          Pick an asset (or all assets) to see prices, trading volume and other
          numbers.
        </div>
        <h2>Assets</h2>
        <div className="cards">
          <a
            className="card"
            href={linkTo('/stats', { asset: 'all' }, account)}
          >
            <div className="t">All assets</div>
            <div className="sub">
              {list.length} assets · averages across assets
            </div>
          </a>
          {list.map((a) => (
            <a
              key={a.id}
              className="card"
              href={linkTo('/stats', { asset: a.id }, account)}
            >
              <div className="t">
                {a.title} <TypeBadge type={a.type} />
              </div>
              <div className="sub">
                {a.providerName} · {a.location}
              </div>
              <div className="kv">
                <div>Days for sale</div>
                <div>{a.forSale}</div>
                <div>Booked (future)</div>
                <div>{a.bookedFuture}</div>
              </div>
            </a>
          ))}
        </div>
      </main>
    );
  }

  if (!stats) {
    return (
      <main className="page">
        <h1>Unknown asset</h1>
      </main>
    );
  }

  const one = stats.assets.length === 1 ? stats.assets[0] : null;
  const k = stats.kpis;
  const f = (v: number | null, pre = '', post = '') =>
    v == null ? '—' : pre + v + post;
  return (
    <main className="page stats-page">
      <div className="crumbs">
        <a href={linkTo('/stats', {}, account)}>Stats</a> ›{' '}
        {one ? one.title : 'All assets'}
      </div>
      <h1>
        {one ? (
          <>
            {one.title} <TypeBadge type={one.type} />
          </>
        ) : (
          'All assets'
        )}
      </h1>
      <div className="muted">
        {one
          ? 'Prices per day of the calendar. Everything here is demo data.'
          : `Averages across ${stats.assets.length} assets (mixed price levels). Everything here is demo data.`}
      </div>
      <h2>Key numbers</h2>
      <div className="kpis">
        <div className="kpi">
          <div className="l">Past days booked</div>
          <div className="v">{f(k.pctBooked, '', '%')}</div>
          <div className="h">
            {k.pastBooked} of {k.pastDays} days
          </div>
        </div>
        <div className="kpi">
          <div className="l">Avg booked price</div>
          <div className="v">
            {k.avgBooked == null ? '—' : money(k.avgBooked)}
          </div>
          <div className="h">past booked days</div>
        </div>
        <div className="kpi">
          <div className="l">Avg listing discount</div>
          <div className="v">{f(k.avgListDiscountPct, '', '%')}</div>
          <div className="h">
            sale vs public price, {k.listedDays} listed days
          </div>
        </div>
        <div className="kpi">
          <div className="l">Trades</div>
          <div className="v">{k.tradeCount}</div>
          <div className="h">volume {money(k.tradeVolume)}</div>
        </div>
        <div className="kpi">
          <div className="l">Avg trade price</div>
          <div className="v">
            {k.avgTradePrice == null ? '—' : money(k.avgTradePrice)}
          </div>
          <div className="h">
            {k.tradeCount
              ? `bought on avg ${k.avgLeadDays} days before the date`
              : ''}
          </div>
        </div>
        <div className="kpi">
          <div className="l">Block trades</div>
          <div className="v">{f(k.blockTradeShare, '', '%')}</div>
          <div className="h">share of trades in 3+ day blocks</div>
        </div>
        <div className="kpi">
          <div className="l">Avg gain per closed trade</div>
          <div className="v">{k.avgGain == null ? '—' : signed(k.avgGain)}</div>
          <div className="h">{k.closedPositions} resold or paid out</div>
        </div>
      </div>
      <div className="two" style={{ marginTop: 12 }}>
        <div className="stat-panel">
          <div className="controls">
            <b>Trade volume</b>
            <label>
              <select
                value={volBy}
                onChange={(e) => setVolBy(e.target.value as 'day' | 'week')}
              >
                <option value="day">per day</option>
                <option value="week">per week</option>
              </select>
            </label>
          </div>
          <VolumeChart stats={stats} by={volBy} />
        </div>
        <div className="stat-panel">
          <div className="controls">
            <b>Price vs days before the date</b>
          </div>
          <LeadChart stats={stats} />
        </div>
      </div>
      <h2>Onchain (1inch) — coming soon</h2>
      <div className="stat-panel soon">
        <div className="muted" style={{ marginBottom: 8 }}>
          No onchain integration yet. The plan is 1inch Aqua / SwapVM on
          Sepolia. These are placeholders, not data.
        </div>
        <div className="kv">
          <div>Aqua liquidity for these days</div>
          <div className="muted">— not connected</div>
          <div>SwapVM orders</div>
          <div className="muted">— not connected</div>
          <div>Onchain trade volume</div>
          <div className="muted">— not connected</div>
          <div>Network</div>
          <div className="muted">Sepolia (planned)</div>
        </div>
      </div>
      <div className="foot">
        How the lines are made: <b>Predicted</b> = the demo&apos;s model
        (average booked price of past days on the same weekday; future days use
        the stored prediction). <b>Listed</b> = today&apos;s public price from
        each day&apos;s price curve. <b>Actual</b> = booked prices.{' '}
        <b>Trade prices</b> = what traders paid, at the day&apos;s date.
        Comparison tools are{' '}
        <b>sample lines generated from our predicted price</b> with simple
        tool-flavoured rules; they are not data from, or endorsed by, these
        tools. Tools chosen as the most-used dynamic pricing tools for
        short-term rentals and Turo&apos;s own pricing:{' '}
        <a
          href="https://www.hostfully.com/blog/airbnb-pricing-tools/"
          target="_blank"
          rel="noopener"
        >
          Hostfully: Smart Pricing vs PriceLabs vs Beyond vs Wheelhouse
        </a>
        ,{' '}
        <a
          href="https://revenuenaire.com/airbnb-dynamic-pricing-tools/"
          target="_blank"
          rel="noopener"
        >
          Revenuenaire comparison 2026
        </a>
        ,{' '}
        <a
          href="https://help.turo.com/en_us/setting-your-vehicle-price-S12VrVlVc"
          target="_blank"
          rel="noopener"
        >
          Turo help: dynamic pricing
        </a>
        .
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
