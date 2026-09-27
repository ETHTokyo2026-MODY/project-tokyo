'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChainStore } from '@/lib/chain/store';
import { isSimulated } from '@/lib/demo/mode';

const DEFAULTS = {
  car: {
    monWed: 100,
    thuSat: 100,
    sun: 100,
    min: 40,
    title: 'e.g. 2023 Nissan Note',
    location: 'e.g. Meguro, Tokyo',
  },
  airbnb: {
    monWed: 110,
    thuSat: 150,
    sun: 120,
    min: 75,
    title: 'e.g. Shimokitazawa studio',
    location: 'e.g. Setagaya, Tokyo',
  },
  'hotel room': {
    monWed: 130,
    thuSat: 175,
    sun: 120,
    min: 85,
    title: 'e.g. Twin room, Ginza',
    location: 'e.g. Chuo, Tokyo',
  },
} as const;

type Kind = keyof typeof DEFAULTS;

export function AddAssetForm({ account }: { account: string }) {
  const { busy: walletBusy, dispatch, mode } = useChainStore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<Kind>('car');
  const [title, setTitle] = useState('');
  const [label, setLabel] = useState('');
  const [location, setLocation] = useState('');
  const [progress, setProgress] = useState('');
  const [monWed, setMonWed] = useState(String(DEFAULTS.car.monWed));
  const [thuSat, setThuSat] = useState(String(DEFAULTS.car.thuSat));
  const [sun, setSun] = useState(String(DEFAULTS.car.sun));
  const [min, setMin] = useState('');
  const [sellingPrice, setSellingPrice] = useState('60');
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const d = DEFAULTS[type];
  const note =
    'Create 365 fixed JST days, starting today. Then select days in the calendar to publish sales.';

  function prefill(next: Kind) {
    const def = DEFAULTS[next];
    if (!edited.has('monWed')) setMonWed(String(def.monWed));
    if (!edited.has('thuSat')) setThuSat(String(def.thuSat));
    if (!edited.has('sun')) setSun(String(def.sun));
  }

  return (
    <>
      <div className="h2row" id="mineHead">
        <h2>My assets</h2>
        <button
          type="button"
          id="addBtn"
          className="primary"
          aria-controls="addForm"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          + Add asset
        </button>
      </div>
      {open ? (
        <form
          id="addForm"
          autoComplete="off"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr('');
            setBusy(true);
            try {
              if (isSimulated({ mode })) {
                const out = await dispatch('create-asset', {
                  account,
                  type,
                  title,
                  location,
                  prices: { monWed, thuSat, sun },
                  min: min === '' ? null : min,
                  sellingPrice,
                });
                if (!out.ok) {
                  setErr(out.error);
                  return;
                }
                if (out.asset) {
                  router.push(
                    `/calendar?asset=${encodeURIComponent(out.asset)}&account=${encodeURIComponent(account)}`,
                  );
                }
                return;
              }
              const ensLabel =
                label.trim().toLowerCase() ||
                title
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 32);
              if (!ensLabel) {
                setErr('Enter an ENS label');
                return;
              }
              setProgress('creating days…');
              const res = await fetch('/api/ens/create', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  label: ensLabel,
                  title,
                  kind: type,
                  location,
                }),
              });
              const value = await res.json();
              if (!res.ok || !value.asset) {
                setErr(value.error ?? 'ENS create failed');
                return;
              }
              setProgress('');
              router.push(
                `/calendar?asset=${encodeURIComponent(String(value.asset))}&account=${encodeURIComponent(account)}`,
              );
            } finally {
              setBusy(false);
              setProgress('');
            }
          }}
        >
          <div className="grid">
            <label htmlFor="add-type">
              Type
              <select
                id="add-type"
                name="type"
                value={type}
                onChange={(e) => {
                  const next = e.target.value as Kind;
                  setType(next);
                  prefill(next);
                }}
              >
                {Object.keys(DEFAULTS).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="add-title">
              Title
              <input
                id="add-title"
                name="title"
                maxLength={60}
                required
                placeholder={d.title}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            {!isSimulated({ mode }) ? (
              <label htmlFor="add-label">
                ENS label
                <input
                  id="add-label"
                  name="label"
                  maxLength={32}
                  placeholder="demo-room"
                  value={label}
                  onChange={(e) => setLabel(e.target.value.toLowerCase())}
                />
                <span className="note">
                  Becomes {label || 'label'}.projecttokyo.eth
                </span>
              </label>
            ) : null}
            <label htmlFor="add-location">
              Location
              <input
                id="add-location"
                name="location"
                maxLength={60}
                required
                placeholder={d.location}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
            <label htmlFor="add-monWed">
              Mon–Wed price ($/day)
              <input
                id="add-monWed"
                name="monWed"
                type="number"
                min={1}
                step={1}
                required
                value={monWed}
                onChange={(e) => {
                  setEdited((s) => new Set(s).add('monWed'));
                  setMonWed(e.target.value);
                }}
              />
            </label>
            <label htmlFor="add-thuSat">
              Thu–Sat price ($/day)
              <input
                id="add-thuSat"
                name="thuSat"
                type="number"
                min={1}
                step={1}
                required
                value={thuSat}
                onChange={(e) => {
                  setEdited((s) => new Set(s).add('thuSat'));
                  setThuSat(e.target.value);
                }}
              />
            </label>
            <label htmlFor="add-sun">
              Sun price ($/day)
              <input
                id="add-sun"
                name="sun"
                type="number"
                min={1}
                step={1}
                required
                value={sun}
                onChange={(e) => {
                  setEdited((s) => new Set(s).add('sun'));
                  setSun(e.target.value);
                }}
              />
            </label>
            <label htmlFor="add-sellingPrice">
              Initial sale price (USDC/day)
              <input
                id="add-sellingPrice"
                name="sellingPrice"
                type="number"
                min="0.000001"
                step="0.000001"
                required
                value={sellingPrice}
                onChange={(e) => setSellingPrice(e.target.value)}
              />
              <span className="note">
                The ownership sale price is separate from the guest price above.
                Edit individual sale days in the calendar.
              </span>
            </label>
            <label htmlFor="add-min">
              Min price (optional)
              <input
                id="add-min"
                name="min"
                type="number"
                min={1}
                step={1}
                placeholder={`auto (≈2/3 of lowest), e.g. ${d.min}`}
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || walletBusy || !account}
            >
              Create asset
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setErr('');
              }}
            >
              Cancel
            </button>
            <span className="muted">{note}</span>
          </div>
          <div id="addErr" role="alert">
            {progress || err}
          </div>
        </form>
      ) : null}
    </>
  );
}
