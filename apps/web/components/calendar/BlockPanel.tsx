'use client';

import { useRef, type ReactNode } from 'react';
import { usdText } from '@/lib/chain/model';
import { LimitBuy } from '@/components/calendar/LimitBuy';
import { money, shortDate, signed } from '@/lib/demo/format';
import { discountLine, type Quote } from '@/lib/demo/quote';
import type { Day } from '@/lib/demo/types';

function KeepInput({
  id,
  dataKey,
  value,
}: {
  id: string;
  dataKey: string;
  value: number | string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      key={dataKey}
      id={id}
      ref={ref}
      data-key={dataKey}
      type="number"
      min={0}
      step="0.000001"
      defaultValue={value}
    />
  );
}

export function BlockPanel({
  assetId,
  days,
  account,
  today,
  cash,
  quote,
  busy,
  onAct,
}: {
  assetId: string;
  days: Day[];
  account: string;
  today: string;
  cash: number;
  quote: Quote;
  busy: boolean;
  onAct: (name: string, body: Record<string, unknown>, flash?: string) => void;
}) {
  const n = days.length;
  const from = days[0].date;
  const to = days[n - 1].date;
  const key = from + '_' + to;
  let body: ReactNode;

  if (days.every((d) => d.date >= today && d.owner === account)) {
    const listed = days.filter((d) => d.listed).length;
    const booked = days.filter((d) => d.status === 'booked').length;
    const q = 'reason' in quote ? null : quote;
    body = (
      <>
        {q ? (
          <>
            <div className="kv">
              <div>Days</div>
              <div>{n}</div>
              <div>Sum of sale prices</div>
              <div>{money(q.subtotal)}</div>
              <div>Asset length discount</div>
              <div>{q.pct}%</div>
              <div>Block total (buyer pays)</div>
              <div>{money(q.total)}</div>
            </div>
          </>
        ) : null}
        <div className="kv" style={{ marginTop: 6 }}>
          <div>Status</div>
          <div>All owned by you</div>
          <div>Listed for sale</div>
          <div>
            {listed} of {n}
          </div>
          <div>Booked</div>
          <div>
            {booked} of {n}
          </div>
        </div>
        {booked ? (
          <div className="note">
            Includes booked days (price locked), so no bulk price change.
          </div>
        ) : (
          <div className="row">
            <KeepInput
              id="bulkPrice"
              dataKey={key}
              value={
                days[0].listedPriceRaw
                  ? usdText(days[0].listedPriceRaw)
                  : days[0].price
              }
            />
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() =>
                onAct('set-price', {
                  date: from,
                  to,
                  price: (
                    document.getElementById('bulkPrice') as HTMLInputElement
                  )?.value,
                })
              }
            >
              Set public price for all
            </button>
          </div>
        )}
        <div className="row">
          <KeepInput
            id="bulkSale"
            dataKey={key}
            value={
              days[0].sellingPriceRaw
                ? usdText(days[0].sellingPriceRaw)
                : (days[0].salePrice ?? days[0].price)
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAct('list', {
                date: from,
                to,
                price: (document.getElementById('bulkSale') as HTMLInputElement)
                  ?.value,
              })
            }
          >
            List all at this price each
          </button>
        </div>
        <div className="row">
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct('unlist', { date: from, to })}
          >
            Unlist all
          </button>
        </div>
      </>
    );
  } else if ('reason' in quote) {
    body = (
      <div className="note">Can&apos;t buy this block: {quote.reason}.</div>
    );
  } else {
    const { subtotal, total } = quote;
    const publicSum = days.reduce((s, d) => s + d.price, 0);
    body = (
      <>
        <div className="kv">
          <div>Days</div>
          <div>{n}</div>
          <div>Sum of sale prices</div>
          <div>{money(subtotal)}</div>
          {quote.sellers > 1 ? (
            <>
              <div>Owners</div>
              <div>{quote.sellers}</div>
            </>
          ) : null}
          <div>Block total</div>
          <div>{money(total)}</div>
          <div>Sum of public prices</div>
          <div>{money(publicSum)}</div>
          <div>Public minus sale price</div>
          <div className={publicSum - total >= 0 ? 'pos' : 'neg'}>
            {signed(publicSum - total)}
          </div>
        </div>
        {quote.mixed ? (
          <>
            <div className="note">Block includes your own days.</div>
            <div className="note">{discountLine(n, quote)}</div>
          </>
        ) : (
          <LimitBuy
            ask={total}
            askRaw={quote.rawTotal}
            resetKey={key}
            cash={cash}
            busy={busy}
            assetId={assetId}
            from={from}
            to={to}
            account={account}
            onAct={onAct}
            discount={discountLine(n, quote)}
            onSubmit={(limit) =>
              onAct(
                'buy-block',
                { from, to, limit },
                Number(limit) < total
                  ? `Open buy for ${money(Number(limit))}`
                  : `Bought ${n} days (${shortDate(from)} – ${shortDate(to)})`,
              )
            }
          />
        )}
      </>
    );
  }

  return (
    <>
      <h2>
        Block · {shortDate(from)} – {shortDate(to)} ({n} days)
      </h2>
      {body}
    </>
  );
}
