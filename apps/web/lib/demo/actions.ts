import { priceFromCurve } from './curve';
import { checkTiers } from './discounts';
import { quoteBlock } from './quote';
import { hashSeed } from './rng';
import {
  DEFAULT_DISCOUNTS,
  MAX_ADDED_PER_ACCOUNT,
  MAX_ASSETS,
  seedDaysFor,
  seedState,
  TYPES,
} from './seed';
import type { Asset, Day, DemoState, Discounts } from './types';

export class UserError extends Error {}

const fail = (msg: string): never => {
  throw new UserError(msg);
};

/** Missing or empty id is the first asset; unknown id is `undefined`. */
export function assetById(
  state: DemoState,
  id?: string | null,
): Asset | undefined {
  if (id == null || id === '') return state.assets[0];
  return state.assets.find((a) => a.id === id);
}

/** The account's saved tiers on that asset, or a copy of the defaults. */
export function discountsFor(asset: Asset, accountId: string): Discounts {
  const saved = asset.discounts[accountId];
  return saved ? { ...saved } : { ...DEFAULT_DISCOUNTS };
}

function getDay(asset: Asset, date: string): Day {
  return asset.days.find((d) => d.date === date) || fail('Unknown day');
}

function checkAccount(state: DemoState, account: string): string {
  if (!state.accounts[account]) fail('Unknown account');
  return account;
}

function checkPrice(price: unknown): number {
  const n = Number(price);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    fail('Price must be a whole number of dollars between 1 and 10000');
  }
  return n;
}

/** Optional limit; omitted means take the ask. Never charge more than the ask. */
function fillAtAsk(ask: number, limit: unknown): number {
  if (limit == null || limit === '') return ask;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 100000) {
    fail('Limit must be a whole number of dollars between 1 and 100000');
  }
  if (n < ask) fail(`Limit $${n} is below the asking price of $${ask}`);
  return ask;
}

function futureDay(asset: Asset, date: string, today: string): Day {
  const d = getDay(asset, date);
  if (d.date < today) fail('Past days are locked');
  return d;
}

function ownedDay(
  asset: Asset,
  account: string,
  date: string,
  today: string,
): Day {
  const d = futureDay(asset, date, today);
  if (d.owner !== account) fail('Only the owner can do that');
  return d;
}

/** Inclusive, either order; `to` defaults to `from`. */
function range(asset: Asset, from: string, to = from): Day[] {
  if (from > to) [from, to] = [to, from];
  getDay(asset, from);
  getDay(asset, to);
  return asset.days.filter((d) => d.date >= from && d.date <= to);
}

function ownedRange(
  asset: Asset,
  account: string,
  from: string,
  to: string | undefined,
  today: string,
): Day[] {
  return range(asset, from, to).map((d) =>
    ownedDay(asset, account, d.date, today),
  );
}

export type ActionCtx = { today: string; now: string };

type ActionFn = (
  state: DemoState,
  asset: Asset,
  body: Record<string, unknown>,
  ctx: ActionCtx,
) => Record<string, unknown> | void;

const actions: Record<string, ActionFn> = {
  buy(state, asset, body, ctx) {
    const account = checkAccount(state, body.account as string);
    const d = futureDay(asset, body.date as string, ctx.today);
    if (d.owner === account) fail("You can't buy your own day");
    if (!d.listed) fail('This day is not for sale');
    const price = fillAtAsk(d.salePrice!, body.limit);
    const buyer = state.accounts[account];
    if (buyer.cash < price) {
      fail(`Not enough cash (need $${price}, have $${buyer.cash})`);
    }
    buyer.cash -= price;
    state.accounts[d.owner].cash += price;
    d.history.push({
      type: 'trade',
      from: d.owner,
      to: account,
      price,
      at: ctx.now,
    });
    d.owner = account;
    d.listed = false;
  },
  'buy-block'(state, asset, body, ctx) {
    const account = checkAccount(state, body.account as string);
    const days = range(asset, body.from as string, body.to as string);
    if (days.some((d) => d.date < ctx.today || !d.listed)) {
      fail('Blocks must be continuous listed days');
    }
    if (days.some((d) => d.owner === account)) {
      fail('Block includes your own days');
    }
    const q = quoteBlock(
      days,
      account,
      (owner) => discountsFor(asset, owner),
      ctx.today,
    );
    if ('reason' in q) return fail('Blocks must be continuous listed days');
    const total = fillAtAsk(q.total, body.limit);
    const buyer = state.accounts[account];
    if (buyer.cash < total) {
      fail(`Not enough cash (need $${total}, have $${buyer.cash})`);
    }
    buyer.cash -= total;
    const groups = new Map<string, Day[]>();
    for (const d of days) {
      if (!groups.has(d.owner)) groups.set(d.owner, []);
      groups.get(d.owner)!.push(d);
    }
    for (const [seller, ds] of groups) {
      const tot = ds.reduce((s, d) => s + q.perDay[d.date], 0);
      state.accounts[seller].cash += tot;
      ds.forEach((d) => {
        d.history.push({
          type: 'trade',
          from: seller,
          to: account,
          price: q.perDay[d.date],
          block: days.length,
          at: ctx.now,
        });
        d.owner = account;
        d.listed = false;
      });
    }
  },
  'set-price'(state, asset, body, ctx) {
    const p = checkPrice(body.price);
    const days = ownedRange(
      asset,
      checkAccount(state, body.account as string),
      body.date as string,
      body.to as string | undefined,
      ctx.today,
    );
    if (days.some((d) => d.status === 'booked')) {
      fail('Booked days keep their booked price (locked)');
    }
    const low = days.find((d) => p < d.curve!.min);
    if (low)
      fail(`Price can't be below the day's minimum ($${low.curve!.min})`);
    days.forEach((d) => {
      d.price = p;
      d.curve!.points[0].price = p;
    });
  },
  list(state, asset, body, ctx) {
    const p = checkPrice(body.price);
    ownedRange(
      asset,
      checkAccount(state, body.account as string),
      body.date as string,
      body.to as string | undefined,
      ctx.today,
    ).forEach((d) => {
      d.salePrice = p;
      d.listed = true;
    });
  },
  unlist(state, asset, body, ctx) {
    ownedRange(
      asset,
      checkAccount(state, body.account as string),
      body.date as string,
      body.to as string | undefined,
      ctx.today,
    ).forEach((d) => {
      d.listed = false;
    });
  },
  book(state, asset, body, ctx) {
    const d = ownedDay(
      asset,
      checkAccount(state, body.account as string),
      body.date as string,
      ctx.today,
    );
    if (d.status === 'booked') fail('This day is already booked');
    d.status = 'booked';
    d.history.push({
      type: 'booking',
      price: d.price,
      at: ctx.now,
      simulated: true,
    });
  },
  unbook(state, asset, body, ctx) {
    const d = ownedDay(
      asset,
      checkAccount(state, body.account as string),
      body.day as string,
      ctx.today,
    );
    if (d.status !== 'booked') fail('This day is not booked');
    d.status = 'open';
    priceFromCurve(d, ctx.today);
    d.history.push({ type: 'unbook', price: d.price, at: ctx.now });
  },
  curve(state, asset, body, ctx) {
    const d = ownedDay(
      asset,
      checkAccount(state, body.account as string),
      body.day as string,
      ctx.today,
    );
    if (d.status === 'booked') {
      fail('Booked days keep their booked price (locked)');
    }
    const mn = Number(body.min);
    if (!Number.isInteger(mn) || mn < 1 || mn > 10000) {
      fail('Min price must be a whole number of dollars between 1 and 10000');
    }
    const raw = body.points;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 400) {
      fail('Points must be a list');
    }
    const pts = (raw as { date?: unknown; price?: unknown }[])
      .map((p) => ({
        date: String(p && p.date),
        price: checkPrice(p && p.price),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const day = body.day as string;
    for (const [i, p] of pts.entries()) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
        p.date < ctx.today ||
        p.date > day
      ) {
        fail(`Point dates must be between ${ctx.today} and ${day}`);
      }
      if (i && p.date === pts[i - 1].date) fail('Only one point per date');
      if (p.price < mn) fail(`Point prices can't be below the min ($${mn})`);
    }
    if (pts[0].date !== ctx.today || pts.at(-1)!.date !== day) {
      fail('The curve needs points on today and on the day itself');
    }
    d.curve = { ...d.curve, min: mn, points: pts };
    d.price = pts[0].price;
  },
  discounts(state, asset, body) {
    const account = checkAccount(state, body.account as string);
    const tiers = body.tiers;
    if (tiers == null || typeof tiers !== 'object' || Array.isArray(tiers)) {
      fail('Tiers must be a map of nights to percent');
    }
    const rows = Object.entries(tiers as Record<string, unknown>).map(
      ([nights, pct]) => ({ nights, pct: pct == null ? '' : String(pct) }),
    );
    const parsed = checkTiers(rows);
    asset.discounts[account] =
      parsed.next ?? fail(parsed.error || 'Invalid tiers');
  },
  'create-asset'(state, _asset, body, ctx) {
    const account = checkAccount(state, body.account as string);
    const type = body.type as string;
    if (!TYPES.includes(type as (typeof TYPES)[number])) {
      fail(`Type must be one of: ${TYPES.join(', ')}`);
    }
    const text = (v: unknown, what: string, lo: number, hi: number) => {
      const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
      if (t.length < lo || t.length > hi) {
        fail(`${what} must be ${lo}-${hi} characters`);
      }
      if (/[\u0000-\u001f\u007f]/.test(t)) {
        fail(`${what} contains invalid characters`);
      }
      return t;
    };
    const t = text(body.title, 'Title', 3, 60);
    const loc = text(body.location, 'Location', 2, 60);
    const p = (body.prices || {}) as Record<string, unknown>;
    const price = (v: unknown, what: string) => {
      const n = Number(v);
      if (v === '' || v == null || !Number.isInteger(n) || n < 1 || n > 10000) {
        fail(
          `${what} price must be a whole number of dollars between 1 and 10000`,
        );
      }
      return n;
    };
    const mw = price(p.monWed, 'Mon–Wed');
    const ts = price(p.thuSat, 'Thu–Sat');
    const su = price(p.sun, 'Sun');
    const lowest = Math.min(mw, ts, su);
    let mn = Math.max(1, Math.round((lowest * 2) / 3));
    const min = body.min;
    if (min !== undefined && min !== null && min !== '') {
      mn = Number(min);
      if (!Number.isInteger(mn) || mn < 1) {
        fail('Min price must be a whole number of dollars (at least 1)');
      }
      if (mn > lowest) {
        fail(`Min price can't be above your lowest weekday price ($${lowest})`);
      }
    }
    if (
      state.assets.filter((a) => a.custom && a.provider === account).length >=
      MAX_ADDED_PER_ACCOUNT
    ) {
      fail(`You can add at most ${MAX_ADDED_PER_ACCOUNT} assets`);
    }
    if (state.assets.length >= MAX_ASSETS) {
      fail(`The demo holds at most ${MAX_ASSETS} assets`);
    }
    if (
      state.assets.some(
        (a) =>
          a.title.toLowerCase() === t.toLowerCase() && a.provider === account,
      )
    ) {
      fail('You already have an asset with this title');
    }
    const slug =
      t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40)
        .replace(/-$/, '') || 'asset';
    let id = slug;
    for (let i = 2; state.assets.some((a) => a.id === id); i++) {
      id = `${slug}-${i}`;
    }
    const custom = {
      base: [su, mw, mw, mw, ts, ts, ts],
      min: mn,
      seed: hashSeed(id + '|' + account),
      createdAt: ctx.now,
    };
    const asset = {
      id,
      type: type as Asset['type'],
      title: t,
      provider: account,
      location: loc,
      discounts: {},
      custom,
      days: [] as Day[],
    };
    asset.days = seedDaysFor(asset, ctx.today);
    state.assets.push(asset);
    return { asset: id };
  },
  'delete-asset'(state, asset, body) {
    if (!body.asset) fail('Say which asset to delete');
    const account = checkAccount(state, body.account as string);
    if (asset.provider !== account)
      fail('Only the provider can delete this asset');
    if (!asset.custom) fail("The demo's seeded assets can't be deleted");
    const others = asset.days.filter((d) => d.owner !== account).length;
    if (others) {
      fail(
        `Can't delete: other accounts own ${others} day${others === 1 ? '' : 's'} of this asset`,
      );
    }
    state.assets = state.assets.filter((a) => a !== asset);
    return { deleted: asset.id };
  },
  reset(state, _asset, _body, ctx) {
    Object.assign(state, seedState(ctx.today), { version: state.version });
  },
};

export function applyAction(
  state: DemoState,
  name: string,
  body: Record<string, unknown>,
  ctx: ActionCtx,
): { state: DemoState; out: Record<string, unknown> } {
  const action = actions[name];
  if (!action) throw new UserError('Unknown action');
  const next = structuredClone(state);
  const raw = body.asset;
  const asset = assetById(
    next,
    typeof raw === 'string' || raw == null ? raw : String(raw),
  );
  if (!asset) throw new UserError('Unknown asset');
  const out = action(next, asset, body, ctx) ?? {};
  next.version += 1;
  return { state: next, out };
}
