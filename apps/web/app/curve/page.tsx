'use client';

import Link from 'next/link';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { normalizeAssetId } from '@/lib/chain/model';
import { loadCurve } from '@/lib/chain/store';
import { CurveChart } from '@/components/curve/CurveChart';
import { linkTo, useAccount } from '@/lib/demo/account';
import { curveValue } from '@/lib/demo/curve';
import { DOW, MONTHS } from '@/lib/demo/format';
import { useChainStore } from '@/lib/chain/store';
import type { Curve } from '@/lib/demo/types';
import './curve.css';

const TITLE = 'Price curve · DayTrader';
const MON = MONTHS.map((m) => m.slice(0, 3));

function label(s: string) {
  return `${MON[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8))}`;
}

function Loading() {
  return (
    <div className="curve-root">
      <header>
        <Link href="/calendar">← Calendar</Link>
        <h1>Price curve</h1>
      </header>
    </div>
  );
}

function CurveInner() {
  const { ready, state, today, dispatch, busy, wallet } = useChainStore();
  const account = useAccount();
  const params = useSearchParams();
  const assetId = normalizeAssetId(params.get('asset') ?? '');
  const dayDate = params.get('day') || '';
  const asset = state?.assets.find((a) => a.id === assetId) ?? state?.assets[0];
  const day = asset?.days.find((d) => d.date === dayDate);
  const [curve, setCurve] = useState<Curve | null>(null);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ date: string; moved: boolean } | null>(
    null,
  );
  const [frozen, setFrozen] = useState<[number, number] | null>(null);
  const [err, setErr] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [edPrice, setEdPrice] = useState('');
  const dragging = useRef(false);
  const curveRef = useRef<Curve | null>(null);
  curveRef.current = curve;

  useEffect(() => {
    document.title = TITLE;
  }, []);

  useEffect(() => {
    if (!day || dragging.current || dirtyRef.current) return;
    let active = true;
    if (asset?.chain) {
      void loadCurve(asset.id, dayDate)
        .then((next) => {
          if (!active || dirtyRef.current) return;
          setCurve(next);
        })
        .catch((e) => {
          if (active) setErr(e.message);
        });
    } else {
      const next = day.curve
        ? structuredClone(day.curve)
        : { min: 1, points: [{ date: dayDate, price: day.price }] };
      queueMicrotask(() => {
        if (active) {
          setCurve(next);
          setSelDate((s) => (next.points.some((p) => p.date === s) ? s : null));
        }
      });
    }
    return () => {
      active = false;
    };
  }, [day, dayDate, state?.version, asset?.chain, asset?.id, today]);

  const past = dayDate < today;
  const booked = day?.status === 'booked';
  const editable = Boolean(
    day &&
    !past &&
    !booked &&
    !busy &&
    account === wallet &&
    day.owner === account,
  );

  const commit = async (next: Curve) => {
    setErr('');
    const out = await dispatch('curve', {
      asset: asset?.id,
      account,
      day: dayDate,
      points: next.points,
      min: next.min,
    });
    if (!out.ok) setErr(out.error);
    else {
      dirtyRef.current = false;
      setDirty(false);
    }
  };
  const save = (next: Curve) => {
    if (asset?.chain) {
      setCurve({
        ...next,
        points: [
          { date: today, price: Math.round(curveValue(next, today)) },
          ...next.points.filter((p) => p.date > today),
        ],
      });
      dirtyRef.current = true;
      setDirty(true);
    } else void commit(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selDate &&
        document.activeElement?.tagName !== 'INPUT'
      ) {
        removePoint(selDate);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function removePoint(date: string) {
    if (
      !curve ||
      !editable ||
      date === curve.points[0].date ||
      date === dayDate
    )
      return;
    const next = {
      ...curve,
      points: curve.points.filter((p) => p.date !== date),
    };
    setCurve(next);
    if (selDate === date) setSelDate(null);
    save(next);
  }

  if (!state) return <Loading />;

  const [y, m, d] = dayDate.split('-').map(Number);
  const title = day
    ? `Price curve · ${asset?.title ?? ''} · ${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MON[m - 1]} ${d}, ${y}`
    : 'Unknown day';
  const finalPrice = day
    ? day.status === 'booked' || day.price > 0
      ? day.price
      : day.curve
        ? Math.round(curveValue(day.curve, dayDate))
        : day.base
    : 0;
  const info = !day
    ? ''
    : past
      ? `Final price: $${finalPrice}${booked ? ' (booked)' : ' (not booked)'}`
      : `Public price today: $${day.price}`;
  const note = !day
    ? ''
    : past
      ? 'This day has passed.'
      : booked
        ? `Booked at $${day.price}, price locked.`
        : editable
          ? 'Click the blue line to add a point, drag points to change price.'
          : 'Only the owner can edit this curve.';
  const sel = curve?.points.find((p) => p.date === selDate);

  return (
    <div className="curve-root">
      <header>
        <Link href={linkTo('/calendar', { asset: asset?.id ?? '' }, account)}>
          ← Calendar
        </Link>
        <h1>{title}</h1>
        <span className="muted">{info}</span>
        <label>
          Min price $
          <input
            type="number"
            min={1}
            step={1}
            value={curve?.min ?? ''}
            disabled={!editable}
            onChange={(e) => {
              if (!curve) return;
              const v = Math.round(Number(e.target.value));
              if (!(v >= 1)) return;
              const next = {
                ...curve,
                min: v,
                points: curve.points.map((p) => ({
                  ...p,
                  price: p.price < v ? v : p.price,
                })),
              };
              setCurve(next);
              save(next);
            }}
          />
        </label>
        <span
          id="editor"
          style={{ visibility: editable && sel ? 'visible' : 'hidden' }}
        >
          <b>{sel ? label(sel.date) : ''}</b> $
          <input
            type="number"
            min={1}
            step={1}
            value={edPrice || (sel ? String(sel.price) : '')}
            onFocus={() => setEdPrice(sel ? String(sel.price) : '')}
            onChange={(e) => setEdPrice(e.target.value)}
            onBlur={() => {
              if (!curve || !sel) return;
              const v = Math.round(Number(edPrice || sel.price));
              if (!(v >= curve.min)) {
                setErr(`Price can't be below the min ($${curve.min})`);
                setEdPrice(String(sel.price));
                return;
              }
              const next = {
                ...curve,
                points: curve.points.map((p) =>
                  p.date === sel.date ? { ...p, price: v } : p,
                ),
              };
              setCurve(next);
              setEdPrice('');
              save(next);
            }}
          />
          <button
            type="button"
            disabled={
              !sel || sel.date === curve?.points[0].date || sel.date === dayDate
            }
            onClick={() => sel && removePoint(sel.date)}
          >
            Remove
          </button>
        </span>
        {asset?.chain ? (
          <button
            type="button"
            disabled={!editable || !dirty || !curve}
            onClick={() => curve && void commit(curve)}
          >
            Save curve
          </button>
        ) : null}
        <span id="note">{note}</span>
        <span id="err">{err}</span>
      </header>
      {day && curve ? (
        <CurveChart
          day={day}
          dayDate={dayDate}
          today={today}
          seededOn={state.seededOn}
          curve={curve}
          editable={editable}
          selDate={selDate}
          drag={drag}
          frozen={frozen}
          onPickPoint={(date) => {
            setSelDate(date);
            dragging.current = true;
            setDrag({ date, moved: false });
          }}
          onStartDrag={(lo, hi) => setFrozen([lo, hi])}
          onAddPoint={(date, price) => {
            const next = {
              ...curve,
              points: [...curve.points, { date, price }].sort((a, b) =>
                a.date.localeCompare(b.date),
              ),
            };
            setCurve(next);
            setSelDate(date);
            save(next);
          }}
          onClearSel={() => setSelDate(null)}
          onMovePoint={(date, price, nextDate) => {
            setCurve((c) => {
              if (!c) return c;
              return {
                ...c,
                points: c.points.map((p) =>
                  p.date === date ? { date: nextDate, price } : p,
                ),
              };
            });
            setSelDate(nextDate);
            setDrag({ date: nextDate, moved: true });
          }}
          onDragEnd={() => {
            const moved = drag?.moved;
            dragging.current = false;
            setDrag(null);
            setFrozen(null);
            if (moved && curveRef.current) save(curveRef.current);
          }}
          onRemove={removePoint}
        />
      ) : (
        <div id="wrap" />
      )}
    </div>
  );
}

export default function CurvePage() {
  return (
    <Suspense fallback={<Loading />}>
      <CurveInner />
    </Suspense>
  );
}
