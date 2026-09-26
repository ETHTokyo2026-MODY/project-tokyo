'use client';

import { useState } from 'react';
import { money, shortDate } from '@/lib/demo/format';
import { useDemo } from '@/lib/demo/store';

export function LimitBuy({
  ask,
  resetKey,
  cash,
  busy,
  extraDisabled,
  assetId,
  from,
  to,
  account,
  onSubmit,
  onAct,
  discount,
}: {
  ask: number;
  resetKey: string;
  cash: number;
  busy: boolean;
  extraDisabled?: boolean;
  assetId: string;
  from: string;
  to: string;
  account: string;
  onSubmit: (limit: number) => void;
  onAct: (name: string, body: Record<string, unknown>, flash?: string) => void;
  discount?: string;
}) {
  return (
    <LimitForm
      key={`${resetKey}:${ask}`}
      ask={ask}
      cash={cash}
      busy={busy}
      extraDisabled={extraDisabled}
      assetId={assetId}
      from={from}
      to={to}
      account={account}
      onSubmit={onSubmit}
      onAct={onAct}
      discount={discount}
    />
  );
}

function LimitForm({
  ask,
  cash,
  busy,
  extraDisabled,
  assetId,
  from,
  to,
  account,
  onSubmit,
  onAct,
  discount,
}: {
  ask: number;
  cash: number;
  busy: boolean;
  extraDisabled?: boolean;
  assetId: string;
  from: string;
  to: string;
  account: string;
  onSubmit: (limit: number) => void;
  onAct: (name: string, body: Record<string, unknown>, flash?: string) => void;
  discount?: string;
}) {
  const { state } = useDemo();
  const mine = (state?.bids ?? []).filter(
    (b) =>
      b.asset === assetId &&
      b.buyer === account &&
      b.from <= to &&
      b.to >= from,
  );
  const [text, setText] = useState(String(ask));
  const limit = Number(text);
  const valid = Number.isInteger(limit) && limit >= 1;
  const above = valid && limit > ask;
  const need = valid && limit < ask ? limit : ask;
  const short = valid && !above && cash < need;

  return (
    <div className="limit-buy">
      <div className="row">
        <label htmlFor="limit">Limit $</label>
        <input
          id="limit"
          type="number"
          min={1}
          inputMode="numeric"
          value={text}
          disabled={busy || extraDisabled}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button
        className="buy"
        type="button"
        disabled={!valid || above || short || busy || extraDisabled}
        onClick={() => valid && onSubmit(limit)}
      >
        {short
          ? `Not enough cash · need ${money(ask)}`
          : valid
            ? `Submit buy for ${money(limit)}`
            : 'Submit buy'}
      </button>
      {discount ? <div className="note">{discount}</div> : null}
      {short ? (
        <div className="warn">
          You have {money(cash)}. List some of your days for sale to raise cash.
        </div>
      ) : above ? (
        <div className="err">Above the current price of {money(ask)}</div>
      ) : null}
      {mine.map((b) => (
        <div className="row" key={b.id}>
          <span className="note">
            Your buy {money(b.limit)}
            {b.from !== b.to
              ? ` · ${shortDate(b.from)}–${shortDate(b.to)}`
              : ''}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct('cancel-bid', { id: b.id }, 'Cancelled buy')}
          >
            Cancel
          </button>
        </div>
      ))}
    </div>
  );
}
