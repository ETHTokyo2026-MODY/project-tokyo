'use client';

import { useId, useState } from 'react';
import { money, shortDate } from '@/lib/demo/format';
import { useDemo } from '@/lib/demo/store';
import { parseUSDC, usdText } from '@/lib/chain/model';

type Props = {
  ask: number;
  askRaw?: string;
  resetKey: string;
  cash: number;
  busy: boolean;
  extraDisabled?: boolean;
  assetId: string;
  from: string;
  to: string;
  account: string;
  onSubmit: (limit: string) => void;
  onAct: (name: string, body: Record<string, unknown>, flash?: string) => void;
  discount?: string;
};
export function LimitBuy(props: Props) {
  return (
    <LimitForm
      key={`${props.resetKey}:${props.askRaw ?? props.ask}`}
      {...props}
    />
  );
}
function LimitForm({
  ask,
  askRaw,
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
}: Props) {
  const { state, mode } = useDemo();
  const id = useId();
  const mine = (state?.bids ?? []).filter(
    (b) =>
      b.asset === assetId &&
      b.buyer === account &&
      b.from <= to &&
      b.to >= from,
  );
  const [text, setText] = useState(
    askRaw === undefined ? String(ask) : usdText(askRaw),
  );
  let raw: string | undefined;
  try {
    raw = parseUSDC(text);
  } catch {
    /* Render input validation below. */
  }
  const sampleInvalid =
    mode === 'sample' && (Number(text) !== ask || cash < ask);
  return (
    <div className="limit-buy">
      <div className="row">
        <label htmlFor={id}>Maximum total USDC</label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={text}
          disabled={busy || extraDisabled}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button
        className="buy"
        type="button"
        disabled={
          raw === undefined ||
          sampleInvalid ||
          busy ||
          extraDisabled ||
          !account
        }
        onClick={() => raw !== undefined && onSubmit(text)}
      >
        {mode === 'chain' ? 'Publish buy order' : 'Buy sample days'}
        {raw === undefined ? '' : ` · $${usdText(raw)}`}
      </button>
      {discount ? <div className="note">{discount}</div> : null}
      <div className="note">
        Current ask: ${askRaw === undefined ? String(ask) : usdText(askRaw)}.
      </div>
      {mode === 'chain' ? (
        <div className="note">
          Your maximum may be below or above the current ask. Orders share
          wallet USDC; funding and available days are checked at fill.
          Publishing does not transfer ownership.
        </div>
      ) : (
        <div className="note">
          Sample mode supports buying at the current ask only.
        </div>
      )}
      {raw === undefined ? (
        <div className="err">
          Enter a nonnegative amount with up to six decimal places.
        </div>
      ) : null}
      {Number(text) > cash ? (
        <div className="note">
          Wallet balance: {money(cash)} USDC. Fund the wallet before a fill.
        </div>
      ) : null}
      {mine.map((b) => (
        <div className="row" key={b.id}>
          <span className="note">
            Open buy ${b.maxTotal ? usdText(b.maxTotal) : b.limit}
            {b.from !== b.to
              ? ` · ${shortDate(b.from)}–${shortDate(b.to)}`
              : ''}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAct('cancel-bid', { id: b.id }, 'Cancelled buy order')
            }
          >
            Cancel
          </button>
        </div>
      ))}
    </div>
  );
}
