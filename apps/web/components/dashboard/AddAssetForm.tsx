'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { calendarEnd } from '@/lib/demo/dates';
import { MONTHS } from '@/lib/demo/format';
import { useDemo } from '@/lib/demo/store';

const DEFAULTS = {
  car: {
    monWed: 60,
    thuSat: 80,
    sun: 65,
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

export function AddAssetForm({
  account,
  today,
}: {
  account: string;
  today: string;
}) {
  const { dispatch } = useDemo();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<Kind>('car');
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [monWed, setMonWed] = useState(String(DEFAULTS.car.monWed));
  const [thuSat, setThuSat] = useState(String(DEFAULTS.car.thuSat));
  const [sun, setSun] = useState(String(DEFAULTS.car.sun));
  const [min, setMin] = useState('');
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const d = DEFAULTS[type];
  const note = useMemo(() => {
    const end = calendarEnd(today);
    const a = `${MONTHS[0].slice(0, 3)} ${today.slice(0, 4)}`;
    const b = `${MONTHS[Number(end.slice(5, 7)) - 1].slice(0, 3)} ${end.slice(0, 4)}`;
    return `You become the provider. A full calendar (${a} – ${b}) is seeded like the other assets (sample data); your future days are listed for sale.`;
  }, [today]);

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
          onSubmit={(e) => {
            e.preventDefault();
            setErr('');
            setBusy(true);
            const out = dispatch('create-asset', {
              account,
              type,
              title,
              location,
              prices: {
                monWed: monWed === '' ? '' : Number(monWed),
                thuSat: thuSat === '' ? '' : Number(thuSat),
                sun: sun === '' ? '' : Number(sun),
              },
              min: min === '' ? null : Number(min),
            });
            if (!out.ok) {
              setErr(out.error);
              setBusy(false);
              return;
            }
            const id = String(out.asset);
            router.push(
              `/calendar?asset=${encodeURIComponent(id)}&account=${encodeURIComponent(account)}`,
            );
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
                max={10000}
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
                max={10000}
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
                max={10000}
                step={1}
                required
                value={sun}
                onChange={(e) => {
                  setEdited((s) => new Set(s).add('sun'));
                  setSun(e.target.value);
                }}
              />
            </label>
            <label htmlFor="add-min">
              Min price (optional)
              <input
                id="add-min"
                name="min"
                type="number"
                min={1}
                max={10000}
                step={1}
                placeholder={`auto (≈2/3 of lowest), e.g. ${d.min}`}
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
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
            {err}
          </div>
        </form>
      ) : null}
    </>
  );
}
