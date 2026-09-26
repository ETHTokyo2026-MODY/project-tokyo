'use client';

import { memo, Suspense, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { MONTHS, money, shortDate, signed } from '@/lib/demo/format';
import { summaries } from '@/lib/demo/summaries';
import { useDemo } from '@/lib/demo/store';
import type { Account, Asset, Day } from '@/lib/demo/types';

const TITLE = 'Calendar · Project Tokyo (demo)';
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function Loading() {
  return (
    <main className="page">
      <h1>Calendar</h1>
      <div className="muted">Loading demo…</div>
    </main>
  );
}

const DayCell = memo(function DayCell({
  date,
  num,
  isToday,
  isPast,
  listed,
  mine,
  booked,
  price,
  salePrice,
}: {
  date: string;
  num: number;
  isToday: boolean;
  isPast: boolean;
  listed: boolean;
  mine: boolean;
  booked: boolean;
  price: number;
  salePrice: number;
}) {
  const cls = ['cell'];
  let body = null;
  if (isPast) {
    cls.push('past');
    if (price > 0) body = <div className="price">{money(price)}</div>;
  } else {
    cls.push(listed ? 'forsale' : 'unlisted');
    if (mine) cls.push('mine');
    const diff = price - salePrice;
    body = (
      <>
        <div className="price">{money(price)}</div>
        {listed ? (
          <div className="small pred">
            {money(salePrice)}{' '}
            <span className={diff < 0 ? 'loss' : 'gain'}>{signed(diff)}</span>
          </div>
        ) : null}
      </>
    );
  }
  if (isToday) cls.push('today');
  return (
    <div className={cls.join(' ')} data-date={date}>
      <div className="top">
        <span className="num">{isToday ? `Today ${num}` : num}</span>
        <span className="badges">
          {!isPast && booked ? (
            <span className="badge booked">BOOKED</span>
          ) : null}
        </span>
      </div>
      {body}
    </div>
  );
});

function months(days: Day[]): [string, Day[]][] {
  const by: Record<string, Day[]> = {};
  const order: string[] = [];
  for (const d of days) {
    const ym = d.date.slice(0, 7);
    if (!by[ym]) {
      by[ym] = [];
      order.push(ym);
    }
    by[ym].push(d);
  }
  return order.map((ym) => [ym, by[ym]]);
}

function CalendarInner() {
  const { ready, state, today } = useDemo();
  const account = useAccount();
  const params = useSearchParams();
  const assetId = params.get('asset');
  const list = useMemo(
    () => (state ? summaries(state, today) : []),
    [state, today],
  );
  const asset = assetId
    ? state?.assets.find((a) => a.id === assetId)
    : undefined;
  const meta = asset ? list.find((a) => a.id === asset.id) : undefined;
  const unknown = Boolean(assetId && ready && state && !asset);

  useEffect(() => {
    if (!asset) document.title = TITLE;
  }, [asset]);

  if (!ready || !state) return <Loading />;
  if (!assetId || !asset || !meta) {
    return (
      <main className="page">
        <h1>Calendar</h1>
        <div className="muted">
          {unknown
            ? 'Unknown asset. Pick one of these:'
            : 'Pick an asset to open its calendar.'}
        </div>
        <h2>Assets</h2>
        <div className="cards">
          {list.map((a) => (
            <a
              key={a.id}
              className="card"
              href={linkTo('/calendar', { asset: a.id }, account)}
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
                <div>Next open day</div>
                <div>
                  {a.nextOpen
                    ? `${shortDate(a.nextOpen.date)} · ${money(a.nextOpen.price)}`
                    : '—'}
                </div>
              </div>
            </a>
          ))}
        </div>
      </main>
    );
  }

  return (
    <AssetGrid
      asset={asset}
      metaName={meta.providerName}
      account={account}
      acct={state.accounts[account]}
      today={today}
    />
  );
}

function AssetGrid({
  asset,
  metaName,
  account,
  acct,
  today,
}: {
  asset: Asset;
  metaName: string;
  account: string;
  acct: Account;
  today: string;
}) {
  const pl = acct.cash - acct.startCash;
  const lockedIn = asset.days
    .filter(
      (d) => d.date >= today && d.owner === account && d.status === 'booked',
    )
    .reduce((t, d) => t + d.price, 0);
  const cheapest = Math.min(
    ...asset.days
      .filter((d) => d.date >= today && d.listed && d.owner !== account)
      .map((d) => d.salePrice!),
  );
  const scrolled = useRef(false);
  useEffect(() => {
    document.title = `${asset.title} · Calendar · Project Tokyo (demo)`;
  }, [asset.title]);
  useEffect(() => {
    if (scrolled.current) return;
    const el = document.getElementById(`m-${today.slice(0, 7)}`);
    if (!el) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'start' });
  }, [today, asset.days]);

  return (
    <div className="cal-layout">
      <main>
        <div className="stickyhead">
          <div className="crumbs">
            <a href={linkTo('/calendar', {}, account)}>Calendar</a> ›
          </div>
          <div className="ahead">
            <h1>
              {asset.title} <TypeBadge type={asset.type} />
            </h1>
            <div className="sub">
              Provided by {metaName} · {asset.location}
            </div>
          </div>
        </div>
        <div className="legend">
          <span>
            <span className="sw" style={{ border: '2px solid #f59e0b' }} />
            For sale: public price; small: sale price and gain (public − sale)
          </span>
          <span>
            <span
              className="sw"
              style={{ background: '#f3f4f6', border: '1px solid #d1d5db' }}
            />
            Not for sale, or past
          </span>
          <span>
            <span className="sw" style={{ border: '2px solid var(--mine)' }} />
            Owned by you
          </span>
          <span>
            <span className="badge booked">BOOKED</span> price locked, paid to
            the owner on the day
          </span>
        </div>
        <div id="cal">
          {months(asset.days).map(([ym, days]) => (
            <div className="month" id={`m-${ym}`} key={ym}>
              <h3>
                {MONTHS[Number(ym.slice(5)) - 1]} {ym.slice(0, 4)}
              </h3>
              <div className="cal">
                {DOWS.map((w) => (
                  <div className="dow" key={w}>
                    {w}
                  </div>
                ))}
                {Array.from({ length: (days[0].weekday + 6) % 7 }, (_, i) => (
                  <div className="cell blank" key={i} />
                ))}
                {days.map((d) => (
                  <DayCell
                    key={d.date}
                    date={d.date}
                    num={Number(d.date.slice(8))}
                    isToday={d.date === today}
                    isPast={d.date < today}
                    listed={d.listed}
                    mine={d.owner === account}
                    booked={d.status === 'booked'}
                    price={d.price}
                    salePrice={d.salePrice ?? 0}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </main>
      <aside className="panel">
        <section>
          <h2>{acct.name}</h2>
          <div className="kv">
            <div>Cash</div>
            <div>{money(acct.cash)}</div>
            <div>Profit / loss</div>
            <div className={pl > 0 ? 'pos' : pl < 0 ? 'neg' : ''}>
              {signed(pl)}
            </div>
            <div>Locked-in bookings</div>
            <div>{money(lockedIn)}</div>
          </div>
          {Number.isFinite(cheapest) && acct.cash < cheapest ? (
            <div className="warn">
              Not enough cash to buy any listed day (cheapest {money(cheapest)}
              ).
            </div>
          ) : null}
        </section>
      </aside>
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CalendarInner />
    </Suspense>
  );
}
