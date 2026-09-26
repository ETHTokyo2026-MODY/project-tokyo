'use client';

import Link from 'next/link';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo } from '@/lib/demo/account';
import { money, shortDate } from '@/lib/demo/format';
import type { AssetSummary } from '@/lib/demo/summaries';
import type { AssetType } from '@/lib/demo/types';

const TYPES: AssetType[] = ['car', 'airbnb', 'hotel room'];
const PERIODS = { '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };
const pct = (v: number) => `${v}%`;
const usd = (v: number) =>
  Number.isInteger(v) ? money(v) : `$${v.toFixed(1)}`;
const signedUsd = (v: number) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + usd(Math.abs(v));
const signedPct = (v: number) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + `${Math.abs(v)}%`;

type Period = keyof typeof PERIODS;
type Metric = {
  key: string;
  label: string;
  text?: boolean;
  period?: boolean;
  sign?: boolean;
  tip: string;
  get: (a: AssetSummary, p: Period) => number | string | null;
  fmt: (v: number | string) => string | ReactNode;
  detail?: (a: AssetSummary) => string;
};

const METRICS: Metric[] = [
  {
    key: 'type',
    label: 'Type',
    text: true,
    get: (a) => a.type,
    fmt: (v) => <TypeBadge type={v as AssetType} />,
    tip: 'Car, Airbnb or hotel room',
  },
  {
    key: 'nextOpen',
    label: 'Next open day',
    get: (a) => (a.nextOpen ? a.nextOpen.price : null),
    fmt: (v) => money(v as number),
    detail: (a) => (a.nextOpen ? shortDate(a.nextOpen.date) : ''),
    tip: 'Public price of the next future day that is not booked',
  },
  {
    key: 'cheapestSale',
    label: 'Cheapest sale',
    get: (a) => a.cheapestSale,
    fmt: (v) => money(v as number),
    tip: 'Lowest sale price among the days listed for sale',
  },
  {
    key: 'forSale',
    label: 'Listed days',
    get: (a) => a.forSale,
    fmt: String,
    tip: 'Future days listed for sale (by anyone)',
  },
  {
    key: 'bookedFuture',
    label: 'Future bookings',
    get: (a) => a.bookedFuture,
    fmt: String,
    tip: 'Future days already booked (simulated bookings)',
  },
  {
    key: 'pctBooked',
    label: '% past booked',
    get: (a) => a.pctBooked,
    fmt: (v) => pct(v as number),
    tip: 'Booked past days ÷ all past days this year',
  },
  {
    key: 'avgListDiscountPct',
    label: 'Avg listing discount',
    get: (a) => a.avgListDiscountPct,
    fmt: (v) => pct(v as number),
    tip: 'Average (public price − sale price) ÷ public price over listed, not-booked future days',
  },
  {
    key: 'volCount',
    label: 'Trades',
    get: (a, p) => a.volume[p].count,
    fmt: String,
    period: true,
    tip: 'Number of day purchases on this asset in the selected period',
  },
  {
    key: 'volUsd',
    label: 'Volume $',
    get: (a, p) => a.volume[p].usd,
    fmt: (v) => money(v as number),
    period: true,
    tip: 'Total $ paid for day purchases on this asset in the selected period',
  },
  {
    key: 'avgMarginPct',
    label: 'Avg margin %',
    get: (a) => a.avgMarginPct,
    fmt: (v) => signedPct(v as number),
    sign: true,
    tip: 'Closed positions only (all time)',
  },
  {
    key: 'avgProfit',
    label: 'Avg profit $',
    get: (a) => a.avgProfit,
    fmt: (v) => signedUsd(v as number),
    sign: true,
    tip: 'Closed positions only (all time)',
  },
];

const NUMERIC = METRICS.filter((m) => !m.text);

function readState(params: URLSearchParams) {
  const types = params.has('types')
    ? params
        .get('types')!
        .split(',')
        .filter((t): t is AssetType => TYPES.includes(t as AssetType))
    : TYPES.slice();
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const m of NUMERIC) {
    for (const side of ['min', 'max'] as const) {
      const v = params.get(`${side}_${m.key}`);
      if (v !== null && v !== '' && Number.isFinite(Number(v))) {
        (side === 'min' ? min : max)[m.key] = Number(v);
      }
    }
  }
  return {
    q: params.get('q') || '',
    period: (PERIODS[params.get('period') as Period]
      ? params.get('period')
      : '30d') as Period,
    has: params.get('has') === '1',
    view: params.get('view') === 'table' ? 'table' : 'cards',
    sort: METRICS.some((m) => m.key === params.get('sort'))
      ? params.get('sort')!
      : '',
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    types,
    min,
    max,
  };
}

export function Screener({
  assets,
  account,
}: {
  assets: AssetSummary[];
  account: string;
}) {
  const available = (m: Metric) =>
    !['volCount', 'volUsd', 'avgMarginPct', 'avgProfit'].includes(m.key);
  const params = useSearchParams();
  const [S, setS] = useState(() => readState(params));

  useEffect(() => {
    const q = new URLSearchParams(params.toString());
    for (const k of [...q.keys()]) {
      if (/^(q|types|period|has|view|sort|dir|min_.*|max_.*)$/.test(k)) {
        q.delete(k);
      }
    }
    if (S.q) q.set('q', S.q);
    if (S.types.length !== TYPES.length) q.set('types', S.types.join(','));
    if (S.period !== '30d') q.set('period', S.period);
    if (S.has) q.set('has', '1');
    if (S.view !== 'cards') q.set('view', S.view);
    if (S.sort) {
      q.set('sort', S.sort);
      q.set('dir', S.dir);
    }
    for (const [k, v] of Object.entries(S.min)) q.set(`min_${k}`, String(v));
    for (const [k, v] of Object.entries(S.max)) q.set(`max_${k}`, String(v));
    q.set('account', account);
    const next = location.pathname + '?' + q.toString().replace(/\+/g, '%20');
    if (next !== location.pathname + location.search) {
      history.replaceState(null, '', next);
    }
  }, [S, account, params]);

  const update = (patch: Partial<typeof S> | ((s: typeof S) => typeof S)) => {
    setS((prev) =>
      typeof patch === 'function' ? patch(prev) : { ...prev, ...patch },
    );
  };

  const active =
    (S.types.length !== TYPES.length ? 1 : 0) +
    (S.has ? 1 : 0) +
    Object.keys(S.min).length +
    Object.keys(S.max).length;

  const rows = useMemo(() => {
    const words = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = assets.filter((a) => {
      const hay =
        `${a.title} ${a.location} ${a.providerName} ${a.type}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
      if (!S.types.includes(a.type)) return false;
      for (const m of NUMERIC) {
        if (['volCount', 'volUsd', 'avgMarginPct', 'avgProfit'].includes(m.key))
          continue;
        const v = m.get(a, S.period);
        if (S.min[m.key] != null && (v == null || (v as number) < S.min[m.key]))
          return false;
        if (S.max[m.key] != null && (v == null || (v as number) > S.max[m.key]))
          return false;
      }
      return true;
    });
    const m = METRICS.find((x) => x.key === S.sort);
    if (m) {
      const k = S.dir === 'desc' ? -1 : 1;
      list = list.slice().sort((x, y) => {
        const a = m.get(x, S.period);
        const b = m.get(y, S.period);
        if (a == null || b == null)
          return (a == null ? 1 : 0) - (b == null ? 1 : 0);
        return (
          (typeof a === 'string'
            ? a.localeCompare(b as string)
            : (a as number) - (b as number)) * k ||
          x.title.localeCompare(y.title)
        );
      });
    }
    return list;
  }, [S, assets]);

  const cell = (m: Metric, a: AssetSummary) => {
    if (!available(m)) return <span className="muted">Not indexed</span>;
    const v = m.get(a, S.period);
    if (v == null) return <span className="muted">—</span>;
    const cls = m.sign
      ? (v as number) > 0
        ? 'pos'
        : (v as number) < 0
          ? 'neg'
          : ''
      : '';
    return (
      <span className={cls}>
        {m.fmt(v)}
        {m.detail ? (
          <>
            {' '}
            <span className="muted small">{m.detail(a)}</span>
          </>
        ) : null}
      </span>
    );
  };

  const show = [
    'nextOpen',
    'forSale',
    'cheapestSale',
    'bookedFuture',
    'volCount',
    'avgMarginPct',
  ].map((k) => METRICS.find((m) => m.key === k)!);

  return (
    <div>
      <div className="scr-bar">
        <input
          id="scrQ"
          type="search"
          placeholder="Search title, location, provider, type"
          value={S.q}
          onChange={(e) => update({ q: e.target.value })}
        />
        <label>
          Period{' '}
          <select
            disabled
            value={S.period}
            onChange={(e) => update({ period: e.target.value as Period })}
          >
            {Object.entries(PERIODS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <span className="seg">
          <button
            type="button"
            className={S.view === 'cards' ? 'on' : ''}
            aria-pressed={S.view === 'cards'}
            onClick={() => update({ view: 'cards' })}
          >
            Cards
          </button>
          <button
            type="button"
            className={S.view === 'table' ? 'on' : ''}
            aria-pressed={S.view === 'table'}
            onClick={() => update({ view: 'table' })}
          >
            Table
          </button>
        </span>
        <button
          type="button"
          onClick={() =>
            update({
              q: '',
              types: TYPES.slice(),
              period: '30d',
              has: false,
              sort: '',
              dir: 'asc',
              min: {},
              max: {},
              view: S.view,
            })
          }
        >
          Reset
        </button>
        <span className="muted">
          {rows.length} of {assets.length} assets
        </span>
      </div>
      <details id="scrFilters" open={active > 0 || undefined}>
        <summary>
          Filters{' '}
          {active ? <span className="muted">({active} active)</span> : null}
        </summary>
        <div className="scr-f">
          <div className="scr-types">
            {TYPES.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={S.types.includes(t)}
                  onChange={() =>
                    update({
                      types: TYPES.filter((x) =>
                        x === t ? !S.types.includes(x) : S.types.includes(x),
                      ),
                    })
                  }
                />{' '}
                {t}
              </label>
            ))}
            <label title="Only assets with at least one trade (all time)">
              <input
                type="checkbox"
                disabled
                checked={false}
                onChange={(e) => update({ has: e.target.checked })}
              />{' '}
              has trades
            </label>
          </div>
          <div className="scr-grid">
            {NUMERIC.filter(available).map((m) => (
              <label key={m.key} title={m.tip}>
                <span>
                  {m.label}
                  {m.period ? <span className="muted"> (period)</span> : null}
                </span>
                <input
                  type="number"
                  placeholder="min"
                  value={S.min[m.key] ?? ''}
                  onChange={(e) =>
                    update((prev) => {
                      const min = { ...prev.min };
                      if (
                        e.target.value === '' ||
                        !Number.isFinite(Number(e.target.value))
                      )
                        delete min[m.key];
                      else min[m.key] = Number(e.target.value);
                      return { ...prev, min };
                    })
                  }
                />
                <input
                  type="number"
                  placeholder="max"
                  value={S.max[m.key] ?? ''}
                  onChange={(e) =>
                    update((prev) => {
                      const max = { ...prev.max };
                      if (
                        e.target.value === '' ||
                        !Number.isFinite(Number(e.target.value))
                      )
                        delete max[m.key];
                      else max[m.key] = Number(e.target.value);
                      return { ...prev, max };
                    })
                  }
                />
              </label>
            ))}
          </div>
        </div>
      </details>
      {!rows.length ? (
        <div className="empty">
          No assets match. Change the search or filters, or press Reset.
        </div>
      ) : S.view === 'table' ? (
        <div className="scr-wrap">
          <table className="list scr-table">
            <thead>
              <tr>
                <th>Asset</th>
                {METRICS.map((m) => (
                  <th
                    key={m.key}
                    className={`${m.text ? '' : 'n'} sortable${S.sort === m.key ? ' sorted' : ''}`}
                    title={m.tip}
                    aria-sort={
                      S.sort === m.key
                        ? S.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="thbtn"
                      onClick={() =>
                        update({
                          sort: m.key,
                          dir:
                            S.sort === m.key
                              ? S.dir === 'asc'
                                ? 'desc'
                                : 'asc'
                              : m.text
                                ? 'asc'
                                : 'desc',
                        })
                      }
                    >
                      {m.label}
                      {S.sort === m.key ? (S.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.id}
                  className="link"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a')) return;
                    location.href = linkTo(
                      '/calendar',
                      { asset: a.id },
                      account,
                    );
                  }}
                >
                  <td>
                    <Link
                      className="rowlink"
                      href={linkTo('/calendar', { asset: a.id }, account)}
                    >
                      <b>{a.title}</b>
                    </Link>
                    {a.provider === account ? (
                      <span className="mine-tag"> yours</span>
                    ) : null}
                    <div className="muted small">
                      {a.providerName} · {a.location}
                    </div>
                  </td>
                  {METRICS.map((m) => (
                    <td key={m.key} className={m.text ? '' : 'n'}>
                      {cell(m, a)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cards">
          {rows.map((a) => (
            <Link
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
                {show.map((m) => (
                  <div key={m.key} className="contents">
                    <div title={m.tip}>
                      {m.label}
                      {m.period ? (
                        <span className="muted small"> ({S.period})</span>
                      ) : null}
                    </div>
                    <div>{cell(m, a)}</div>
                  </div>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
