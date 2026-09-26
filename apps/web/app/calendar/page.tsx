'use client';

import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { BlockPanel } from '@/components/calendar/BlockPanel';
import { LimitBuy } from '@/components/calendar/LimitBuy';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { discountsFor } from '@/lib/demo/actions';
import { addDays } from '@/lib/demo/dates';
import {
  historyLine,
  money,
  MONTHS,
  shortDate,
  signed,
  weekdayDate,
} from '@/lib/demo/format';
import { quoteBlock } from '@/lib/demo/quote';
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
  selected,
  tabIndex,
  price,
  salePrice,
  disc,
  onPick,
}: {
  date: string;
  num: number;
  isToday: boolean;
  isPast: boolean;
  listed: boolean;
  mine: boolean;
  booked: boolean;
  selected: boolean;
  tabIndex: number;
  price: number;
  salePrice: number;
  disc?: number;
  onPick: (date: string, shift: boolean) => void;
}) {
  const cls = ['cell'];
  let body = null;
  if (isPast) {
    cls.push('past');
    if (price > 0) body = <div className="price">{money(price)}</div>;
  } else {
    cls.push(listed ? 'forsale' : 'unlisted');
    if (mine) cls.push('mine');
    const cost = disc ?? salePrice;
    const diff = price - cost;
    body = (
      <>
        {disc !== undefined ? (
          <div className="price blk">
            <s>{money(salePrice)}</s>{' '}
            <span className="dprice">{money(disc)}</span>
          </div>
        ) : (
          <div className="price">{money(price)}</div>
        )}
        {listed ? (
          <div className="small pred">
            {disc !== undefined ? '' : `${money(salePrice)} `}
            <span className={diff < 0 ? 'loss' : 'gain'}>{signed(diff)}</span>
          </div>
        ) : null}
      </>
    );
  }
  if (isToday) cls.push('today');
  if (selected) cls.push('sel');
  return (
    <div
      className={cls.join(' ')}
      data-date={date}
      role="button"
      tabIndex={tabIndex}
      aria-pressed={selected}
      onClick={(e) => onPick(date, e.shiftKey)}
    >
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

function pred(d: Day): number {
  return d.status === 'booked' ? d.price : (d.predicted ?? 0);
}

function KeepInput({
  id,
  dataKey,
  value,
  disabled,
  inputRef,
}: {
  id: string;
  dataKey: string;
  value: number;
  disabled?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  useEffect(() => {
    const el = inputRef.current;
    if (!el || document.activeElement === el) return;
    el.value = String(value);
  }, [value, inputRef]);
  return (
    <input
      key={dataKey}
      id={id}
      ref={inputRef}
      data-key={dataKey}
      type="number"
      min={1}
      defaultValue={value}
      disabled={disabled}
    />
  );
}

function Flash({ text, token }: { text: string; token: number }) {
  if (!text) return <div id="flash" role="status" />;
  return (
    <div key={token} id="flash" role="status" className="show">
      {text}
    </div>
  );
}

function History({ day, account }: { day: Day; account: string }) {
  return (
    <>
      <h2 style={{ marginTop: 8 }}>Trade history</h2>
      {day.history.length ? (
        <ol className="hist">
          {day.history.map((h, i) => (
            <li key={`${h.type}-${h.at}-${i}`}>{historyLine(h, account)}</li>
          ))}
        </ol>
      ) : (
        <div className="note">Never sold.</div>
      )}
    </>
  );
}

function OwnerControls({
  d,
  booked,
  busy,
  onAct,
}: {
  d: Day;
  booked: boolean;
  busy: boolean;
  onAct: (name: string, body: Record<string, unknown>) => void;
}) {
  const priceRef = useRef<HTMLInputElement>(null);
  const saleRef = useRef<HTMLInputElement>(null);
  const sale = d.listed ? d.salePrice! : Math.round(pred(d) * 0.85);
  return (
    <>
      <div className="note">
        {booked
          ? 'Booked: the price is locked. Whoever owns the day when it arrives gets paid.'
          : 'You set the price renters see and keep the booking result.'}
      </div>
      <div className="row">
        <KeepInput
          id="price"
          dataKey={d.date}
          value={d.price}
          disabled={booked}
          inputRef={priceRef}
        />
        <button
          className="primary"
          type="button"
          disabled={booked || busy}
          onClick={() =>
            onAct('set-price', {
              date: d.date,
              price: Number(priceRef.current?.value),
            })
          }
        >
          Set public price
        </button>
      </div>
      <div className="row">
        <KeepInput
          id="salePrice"
          dataKey={d.date}
          value={sale}
          disabled={busy}
          inputRef={saleRef}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onAct('list', {
              date: d.date,
              price: Number(saleRef.current?.value),
            })
          }
        >
          {d.listed ? 'Update sale price' : 'List for sale'}
        </button>
        {d.listed ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct('unlist', { date: d.date })}
          >
            Unlist
          </button>
        ) : null}
      </div>
      {booked ? (
        <button
          className="markbooked on"
          type="button"
          disabled={busy}
          onClick={() => onAct('unbook', { day: d.date })}
        >
          ✓ Booked · Undo
        </button>
      ) : (
        <button
          className="markbooked"
          type="button"
          disabled={busy}
          onClick={() => onAct('book', { date: d.date })}
        >
          Mark as Booked
        </button>
      )}
    </>
  );
}

function TradeBody({
  d,
  assetId,
  account,
  cash,
  today,
  busy,
  onAct,
}: {
  d: Day;
  assetId: string;
  account: string;
  cash: number;
  today: string;
  busy: boolean;
  onAct: (name: string, body: Record<string, unknown>, flash?: string) => void;
}) {
  const title = weekdayDate(d.date, d.weekday);
  const mine = d.owner === account;
  const booked = d.status === 'booked';
  let rows: ReactNode;
  let controls: ReactNode = null;

  if (d.date < today) {
    rows = (
      <>
        <div>Result</div>
        <div>{booked ? `Booked at ${money(d.price)}` : 'Not booked ($0)'}</div>
      </>
    );
    controls = <div className="note">🔒 Locked: final result.</div>;
  } else if (mine) {
    rows = (
      <>
        {booked ? (
          <>
            <div>Status</div>
            <div>Booked</div>
          </>
        ) : null}
        <div>{booked ? 'Booked price' : 'Public price'}</div>
        <div>
          {money(d.price)}
          {booked ? ' 🔒' : ''}
        </div>
        {d.listed ? (
          <>
            <div>Sale price</div>
            <div>{money(d.salePrice!)}</div>
          </>
        ) : null}
        <div>{booked ? 'Paid to owner on' : 'Predicted if booked'}</div>
        <div>{booked ? title : money(pred(d))}</div>
      </>
    );
    controls = (
      <OwnerControls d={d} booked={booked} busy={busy} onAct={onAct} />
    );
  } else if (d.listed) {
    const gain = d.price - d.salePrice!;
    rows = (
      <>
        <div>Status</div>
        <div>
          {booked ? 'Booked · ' : ''}
          For sale
        </div>
        <div>{booked ? 'Booked price' : 'Public price'}</div>
        <div>{money(d.price)}</div>
        <div>Sale price</div>
        <div>{money(d.salePrice!)}</div>
        {booked ? null : (
          <>
            <div>Predicted if booked</div>
            <div>{money(pred(d))}</div>
          </>
        )}
        <div>Potential gain</div>
        <div className={gain >= 0 ? 'pos' : 'neg'}>{signed(gain)}</div>
      </>
    );
    controls = (
      <LimitBuy
        ask={d.salePrice!}
        resetKey={d.date}
        cash={cash}
        busy={busy}
        assetId={assetId}
        from={d.date}
        to={d.date}
        account={account}
        onAct={onAct}
        onSubmit={(limit) =>
          onAct(
            'buy',
            { date: d.date, limit },
            limit < d.salePrice!
              ? `Open buy for ${money(limit)}`
              : `Bought ${shortDate(d.date)} for ${money(d.salePrice!)}`,
          )
        }
      />
    );
  } else {
    rows = (
      <>
        {booked ? (
          <>
            <div>Status</div>
            <div>Booked</div>
          </>
        ) : null}
        <div>{booked ? 'Booked price' : 'Public price'}</div>
        <div>{money(d.price)}</div>
      </>
    );
  }

  return (
    <>
      <h2>Trading · {title}</h2>
      <div className="kv">{rows}</div>
      <a
        className="curvelink"
        href={linkTo('/curve', { asset: assetId, day: d.date }, account)}
        target="_blank"
        rel="noreferrer"
      >
        Price curve →
      </a>
      {controls}
      <History day={d} account={account} />
    </>
  );
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
  const { dispatch, reset } = useDemo();
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [kbd, setKbd] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState({ text: '', token: 0 });
  const pending = useRef(false);
  const calRef = useRef<HTMLDivElement>(null);
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
  const [lo, hi] =
    anchor && focus
      ? ([...[anchor, focus].sort()] as [string, string])
      : ([null, null] as [string | null, string | null]);
  const selDays =
    lo && hi ? asset.days.filter((d) => d.date >= lo && d.date <= hi) : [];
  const quote =
    selDays.length > 1
      ? quoteBlock(
          selDays,
          account,
          (owner) => discountsFor(asset, owner),
          today,
        )
      : null;
  const blockPrice =
    quote && !('reason' in quote)
      ? Object.fromEntries(
          Object.entries(quote.perDay).filter(([dt]) => quote.dayPct[dt] > 0),
        )
      : {};
  const tabStop = kbd || focus || today;

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

  const pick = useCallback(
    (date: string, shift: boolean) => {
      if (shift && anchor) {
        const [a, b] = [anchor, date].sort();
        const range = asset.days.filter((d) => d.date >= a && d.date <= b);
        if (
          range.length > 1 &&
          range.some((d) => d.date < today || !d.listed)
        ) {
          setFocus(anchor);
          setFlash((f) => ({
            text: 'Blocks must be continuous listed days',
            token: f.token + 1,
          }));
        } else setFocus(date);
      } else {
        setAnchor(date);
        setFocus(date);
      }
      setKbd(date);
      setError('');
    },
    [anchor, asset.days, today],
  );

  useEffect(() => {
    if (!kbd) return;
    const el = calRef.current?.querySelector(
      `.cell[data-date="${kbd}"]`,
    ) as HTMLElement | null;
    el?.focus({ preventScroll: true });
  }, [kbd]);

  const onAct = useCallback(
    (name: string, body: Record<string, unknown>, done?: string) => {
      if (pending.current) return { ok: false as const, error: 'Busy' };
      pending.current = true;
      setBusy(true);
      setError('');
      const out = dispatch(name, { asset: asset.id, account, ...body });
      pending.current = false;
      setBusy(false);
      if (!out.ok) {
        setError(out.error);
        return out;
      }
      if (done) setFlash((f) => ({ text: done, token: f.token + 1 }));
      return out;
    },
    [account, asset.id, dispatch],
  );

  const onReset = () => {
    if (!confirm('Master reset: restore the initial sample data?')) return;
    setAnchor(null);
    setFocus(null);
    setKbd(null);
    setError('');
    reset();
  };

  const onCalKeyDown = (e: ReactKeyboardEvent) => {
    const cell = (e.target as HTMLElement).closest('[data-date]');
    if (!cell) return;
    const date = (cell as HTMLElement).dataset.date!;
    const step = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
        string,
        number
      >
    )[e.key];
    if (step) {
      const next = addDays(date, step);
      if (!asset.days.some((d) => d.date === next)) return;
      e.preventDefault();
      setKbd(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(date, e.shiftKey);
    } else if (e.key === ' ') e.preventDefault();
  };

  const onCalKeyUp = (e: ReactKeyboardEvent) => {
    if (e.key !== ' ') return;
    const cell = (e.target as HTMLElement).closest('[data-date]');
    if (cell) pick((cell as HTMLElement).dataset.date!, e.shiftKey);
  };

  return (
    <div className="cal-layout">
      <Flash key={flash.token} text={flash.text} token={flash.token} />
      <main
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault();
        }}
      >
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
        <div
          id="cal"
          ref={calRef}
          onKeyDown={onCalKeyDown}
          onKeyUp={onCalKeyUp}
        >
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
                    selected={Boolean(lo && hi && d.date >= lo && d.date <= hi)}
                    tabIndex={d.date === tabStop ? 0 : -1}
                    price={d.price}
                    salePrice={d.salePrice ?? 0}
                    disc={blockPrice[d.date]}
                    onPick={pick}
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
        <section id="trade" className={busy ? 'busy' : undefined}>
          <div className="hint">Shift-click to select a block of days</div>
          {selDays.length > 1 && quote ? (
            <BlockPanel
              assetId={asset.id}
              days={selDays}
              account={account}
              today={today}
              cash={acct.cash}
              quote={quote}
              busy={busy}
              onAct={onAct}
            />
          ) : selDays.length === 1 ? (
            <TradeBody
              d={selDays[0]}
              assetId={asset.id}
              account={account}
              cash={acct.cash}
              today={today}
              busy={busy}
              onAct={onAct}
            />
          ) : (
            <>
              <h2>Trading</h2>
              <div className="note">Click a day on the calendar.</div>
            </>
          )}
          <div className="err">{error}</div>
        </section>
        <button className="reset" type="button" onClick={onReset}>
          Master reset
        </button>
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
