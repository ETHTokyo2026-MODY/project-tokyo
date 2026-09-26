'use client';

import { useState } from 'react';
import { money } from '@/lib/demo/format';

export function LimitBuy({
  ask,
  resetKey,
  cash,
  busy,
  extraDisabled,
  onSubmit,
}: {
  ask: number;
  resetKey: string;
  cash: number;
  busy: boolean;
  extraDisabled?: boolean;
  onSubmit: (limit: number) => void;
}) {
  return (
    <LimitForm
      key={`${resetKey}:${ask}`}
      ask={ask}
      cash={cash}
      busy={busy}
      extraDisabled={extraDisabled}
      onSubmit={onSubmit}
    />
  );
}

function LimitForm({
  ask,
  cash,
  busy,
  extraDisabled,
  onSubmit,
}: {
  ask: number;
  cash: number;
  busy: boolean;
  extraDisabled?: boolean;
  onSubmit: (limit: number) => void;
}) {
  const [text, setText] = useState(String(ask));
  const limit = Number(text);
  const valid = Number.isInteger(limit) && limit >= 1;
  const below = valid && limit < ask;
  const short = valid && !below && cash < ask;

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
        disabled={!valid || below || short || busy || extraDisabled}
        onClick={() => valid && onSubmit(limit)}
      >
        {short
          ? `Not enough cash · need ${money(ask)}`
          : valid
            ? `Submit buy for ${money(limit)}`
            : 'Submit buy'}
      </button>
      {short ? (
        <div className="warn">
          You have {money(cash)}. List some of your days for sale to raise cash.
        </div>
      ) : below ? (
        <div className="err">Below the current price</div>
      ) : null}
    </div>
  );
}
