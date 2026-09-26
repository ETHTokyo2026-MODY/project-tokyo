'use client';

import { bidLive } from '@/lib/demo/actions';
import { money, shortDate } from '@/lib/demo/format';
import { useDemo } from '@/lib/demo/store';
import type { Asset, Bid } from '@/lib/demo/types';

function owns(asset: Asset, account: string, bid: Bid) {
  return asset.days.some(
    (d) => d.date >= bid.from && d.date <= bid.to && d.owner === account,
  );
}

export function OpenBids({
  assetId,
  from,
  to,
  account,
  today,
  busy,
  onAct,
}: {
  assetId: string;
  from: string;
  to: string;
  account: string;
  today: string;
  busy: boolean;
  onAct: (name: string, body: Record<string, unknown>, flash?: string) => void;
}) {
  const { state } = useDemo();
  if (!state) return null;
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return null;
  const bids = (state.bids ?? []).filter(
    (b) =>
      b.asset === assetId &&
      b.from <= to &&
      b.to >= from &&
      bidLive(asset, b, today) &&
      (b.buyer === account || owns(asset, account, b)),
  );
  if (!bids.length) return null;
  return (
    <div className="bids">
      {bids.map((b) => {
        const mine = b.buyer === account;
        const span =
          b.from === b.to ? '' : ` · ${shortDate(b.from)}–${shortDate(b.to)}`;
        const who = mine
          ? `Your bid ${money(b.limit)}${span}`
          : `Bid from ${state.accounts[b.buyer]?.name ?? b.buyer} ${money(b.limit)}${span}`;
        return (
          <div className="row" key={b.id}>
            <span className="note">{who}</span>
            {mine ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onAct('cancel-bid', { id: b.id }, 'Cancelled bid')
                }
              >
                Cancel
              </button>
            ) : (
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() =>
                  onAct(
                    'accept-bid',
                    { id: b.id },
                    `Accepted bid for ${money(b.limit)}`,
                  )
                }
              >
                Accept
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
