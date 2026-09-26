'use client';

import { useEffect, useRef, useState } from 'react';
import { discountsFor } from '@/lib/demo/actions';
import { TIERS } from '@/lib/demo/seed';
import type { Asset, Discounts } from '@/lib/demo/types';

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
  ) => { ok: boolean; error?: string };
}) {
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(true);
  const refs = useRef<Record<number, HTMLInputElement | null>>({});
  const saved = discountsFor(asset, account);

  useEffect(() => {
    if (dirty) return;
    for (const t of TIERS) {
      const el = refs.current[t];
      if (el && document.activeElement !== el) {
        el.value = String(saved[t as keyof Discounts]);
      }
    }
  }, [dirty, saved]);

  return (
    <details>
      <summary>Length discounts</summary>
      <div className="note">
        Your discount on this asset when someone buys a block of your listed
        days (1-2 days: no discount).
      </div>
      <div className="disc">
        {TIERS.map((t) => (
          <div key={t} className="contents">
            <div>{t}+ nights</div>
            <input
              ref={(el) => {
                refs.current[t] = el;
              }}
              type="number"
              min={0}
              max={90}
              step={1}
              defaultValue={saved[t as keyof Discounts]}
              onInput={() => {
                setDirty(true);
                setMsg('');
              }}
            />
            <div>%</div>
          </div>
        ))}
      </div>
      <div className="row">
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={() => {
            const tiers: Record<number, string> = {};
            for (const t of TIERS) {
              tiers[t] = refs.current[t]?.value ?? '';
            }
            const out = onAct('discounts', { tiers });
            if (out.ok) {
              setDirty(false);
              setOk(true);
              setMsg('Saved');
            } else {
              setOk(false);
              setMsg(out.error || 'Save failed');
            }
          }}
        >
          Save
        </button>
        <span
          className="note"
          style={{ color: ok ? 'var(--green)' : 'var(--red)' }}
        >
          {msg}
        </span>
      </div>
    </details>
  );
}
