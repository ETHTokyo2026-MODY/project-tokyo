'use client';

import { useId, useState } from 'react';
import { money, shortDate } from '@/lib/demo/format';
import { parseWETH, useChainStore } from '@/lib/chain/store';
import { parseUSDC, usdText } from '@/lib/chain/model';
import { isSimulated } from '@/lib/demo/mode';

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
  const { state, mode } = useChainStore();
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
  const [funding, setFunding] = useState('usdc');
  const [weth, setWeth] = useState('0.001');
  const [minOutput, setMinOutput] = useState(
    askRaw === undefined ? String(ask) : usdText(askRaw),
  );
  let conversionValid = false;
  try {
    conversionValid =
      BigInt(parseWETH(weth)) > BigInt(0) &&
      BigInt(parseUSDC(minOutput)) > BigInt(0);
  } catch {}
  let raw: string | undefined;
  try {
    raw = parseUSDC(text);
  } catch {
    /* Render input validation below. */
  }
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
      {!isSimulated({ mode }) ? (
        <>
          <label htmlFor={`${id}-funding`}>Pay with</label>
          <select
            id={`${id}-funding`}
            value={funding}
            disabled={busy}
            onChange={(e) => setFunding(e.target.value)}
          >
            <option value="usdc">Wallet USDC</option>
            <option value="weth">WETH</option>
          </select>
        </>
      ) : null}
      {!isSimulated({ mode }) && funding === 'weth' ? (
        <>
          <label htmlFor={`${id}-weth`}>Exact WETH to spend</label>
          <input
            id={`${id}-weth`}
            value={weth}
            inputMode="decimal"
            disabled={busy}
            onChange={(e) => setWeth(e.target.value)}
          />
          <label htmlFor={`${id}-output`}>Minimum USDC from swap</label>
          <input
            id={`${id}-output`}
            value={minOutput}
            inputMode="decimal"
            disabled={busy}
            onChange={(e) => setMinOutput(e.target.value)}
          />
          <div className="note">
            Available USDC may fill this order before WETH is swapped.
            Otherwise, the swap and purchase succeed together; surplus USDC
            stays in your wallet. If the purchase fails, the swap reverts but
            approvals and the open order remain.
          </div>
        </>
      ) : null}
      <button
        className="buy"
        type="button"
        disabled={
          raw === undefined ||
          (funding === 'weth' && !conversionValid) ||
          busy ||
          extraDisabled ||
          !account
        }
        onClick={() =>
          raw !== undefined &&
          (funding === 'weth'
            ? onAct(
                'buy-weth',
                { asset: assetId, from, to, limit: text, weth, minOutput },
                'Funding workflow confirmed; check current ownership',
              )
            : onSubmit(text))
        }
      >
        {funding === 'weth' ? 'Prepare WETH-funded order' : 'Publish buy order'}
        {raw === undefined ? '' : ` · $${usdText(raw)}`}
      </button>
      {discount ? <div className="note">{discount}</div> : null}
      <div className="note">
        Funds stay in your wallet until a fill. Open orders share your balance
        and require available days.
      </div>
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
