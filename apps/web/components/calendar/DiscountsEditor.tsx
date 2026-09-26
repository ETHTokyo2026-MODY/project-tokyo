'use client';

import { useState } from 'react';
import { discountsFor } from '@/lib/demo/actions';
import {
  checkTiers,
  MAX_DISCOUNT_TIERS,
  rowsFromDiscounts,
} from '@/lib/demo/discounts';
import { DEFAULT_DISCOUNTS } from '@/lib/demo/seed';
import type { Asset } from '@/lib/demo/types';

export function DiscountsEditor({
  asset,
  account,
  busy,
  onAct,
}: {
  asset: Asset;
  account: string;
  busy: boolean;
  onAct: (
    name: string,
    body: Record<string, unknown>,
  ) =>
    Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}) {
  const [rows, setRows] = useState(() =>
    rowsFromDiscounts(discountsFor(asset, account)),
  );
  const [rowErrs, setRowErrs] = useState<(string | null)[]>([]);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(true);
  const touch = (next: typeof rows) => {
    setRows(next);
    setRowErrs([]);
    setMsg('');
  };

  const disabled =
    busy || saving || Boolean(asset.chain && asset.provider !== account);
  return (
    <>
      <h2>Length discounts</h2>
      <div className="note">
        The host sets one ladder for this asset. It applies to the whole
        consecutive block, across owners. Single days have no discount.
      </div>
      <div className="disc">
        {rows.map((r, i) => (
          <div key={i} className="contents">
            <input
              type="number"
              min={2}
              max={asset.chain ? 365 : undefined}
              disabled={disabled}
              step={1}
              aria-label="Minimum nights"
              value={r.nights}
              onChange={(e) =>
                touch(
                  rows.map((x, j) =>
                    j === i ? { ...x, nights: e.target.value } : x,
                  ),
                )
              }
            />
            <div>+ nights</div>
            <input
              type="number"
              min={0}
              max={asset.chain ? 100 : 90}
              step={asset.chain ? 0.01 : 1}
              disabled={disabled}
              aria-label="Percent off"
              value={r.pct}
              onChange={(e) =>
                touch(
                  rows.map((x, j) =>
                    j === i ? { ...x, pct: e.target.value } : x,
                  ),
                )
              }
            />
            <div>%</div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => touch(rows.filter((_, j) => j !== i))}
            >
              Remove
            </button>
            {rowErrs[i] ? <div className="err">{rowErrs[i]}</div> : null}
          </div>
        ))}
      </div>
      <div className="row">
        <button
          className="primary"
          type="button"
          disabled={disabled}
          onClick={async () => {
            const parsed = checkTiers(rows, Boolean(asset.chain));
            setRowErrs(parsed.rowErrs);
            if (!parsed.next) {
              setOk(false);
              setMsg(parsed.error || 'Fix the highlighted tiers');
              return;
            }
            setSaving(true);
            try {
              const out = await onAct('discounts', { tiers: parsed.next });
              setOk(out.ok);
              setMsg(
                out.ok
                  ? asset.chain
                    ? 'Saved. Sellers must republish their listings to authorize the new ladder.'
                    : 'Saved'
                  : out.error || 'Save failed',
              );
              if (out.ok) setRows(rowsFromDiscounts(parsed.next));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </button>
        <button
          type="button"
          disabled={
            disabled || (!asset.chain && rows.length >= MAX_DISCOUNT_TIERS)
          }
          onClick={() => touch([...rows, { nights: '', pct: '' }])}
        >
          Add tier
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => touch(rowsFromDiscounts(DEFAULT_DISCOUNTS))}
        >
          Reset to defaults
        </button>
      </div>
      <span
        className="note"
        style={{ color: ok ? 'var(--green)' : 'var(--red)' }}
      >
        {msg}
      </span>
    </>
  );
}
