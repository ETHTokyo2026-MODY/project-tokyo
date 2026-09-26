'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { CurveChart } from '@/components/curve/CurveChart';
import { linkTo, useAccount } from '@/lib/demo/account';
import { curveValue } from '@/lib/demo/curve';
import { DOW, MONTHS } from '@/lib/demo/format';
import { useDemo } from '@/lib/demo/store';

const TITLE = 'Price curve · Project Tokyo (demo)';
const MON = MONTHS.map((m) => m.slice(0, 3));

function Loading() {
  return (
    <div className="curve-root">
      <header>
        <a href="/calendar">← Calendar</a>
        <h1>Price curve</h1>
      </header>
    </div>
  );
}

function CurveInner() {
  const { ready, state, today } = useDemo();
  const account = useAccount();
  const params = useSearchParams();
  const assetId = params.get('asset') || '';
  const dayDate = params.get('day') || '';
  const asset = state?.assets.find((a) => a.id === assetId) ?? state?.assets[0];
  const day = asset?.days.find((d) => d.date === dayDate);

  useEffect(() => {
    document.title = TITLE;
  }, []);

  if (!ready || !state) return <Loading />;

  const [y, m, d] = dayDate.split('-').map(Number);
  const title = day
    ? `Price curve · ${asset?.title ?? ''} · ${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MON[m - 1]} ${d}, ${y}`
    : 'Unknown day';
  const booked = day?.status === 'booked';
  const past = dayDate < today;
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
        : day.owner === account
          ? 'Click the blue line to add a point, drag points to change price.'
          : 'Only the owner can edit this curve.';
  const curve = day?.curve
    ? day.curve
    : day
      ? { min: 1, points: [{ date: dayDate, price: day.price }] }
      : null;

  return (
    <div className="curve-root">
      <header>
        <a href={linkTo('/calendar', { asset: asset?.id ?? '' }, account)}>
          ← Calendar
        </a>
        <h1>{title}</h1>
        <span className="muted">{info}</span>
        <label>
          Min price $ <input type="number" value={curve?.min ?? ''} disabled />
        </label>
        <span id="editor" />
        <span id="note">{note}</span>
        <span id="err" />
      </header>
      {day && curve ? (
        <CurveChart
          day={day}
          dayDate={dayDate}
          today={today}
          seededOn={state.seededOn}
          curve={curve}
          editable={false}
          selDate={null}
          drag={null}
          frozen={null}
          onPickPoint={() => {}}
          onStartDrag={() => {}}
          onAddPoint={() => {}}
          onClearSel={() => {}}
          onMovePoint={() => {}}
          onDragEnd={() => {}}
          onRemove={() => {}}
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
