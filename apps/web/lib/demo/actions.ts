import { DEFAULT_DISCOUNTS, checkTiers } from './discounts';
import { isHost } from './seed';
import {
  MAX_ADDED_PER_ACCOUNT,
  MAX_ASSETS,
  TYPES,
  emptyState,
  seedDaysFor,
} from './seed';
import { quoteBlock } from './quote';
import { hashSeed } from './rng';
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

/** The asset's onchain ladder, a saved per-account table, or a copy of the defaults. */
export function discountsFor(asset: Asset, accountId: string): Discounts {
  if (asset.chain)
    return Object.fromEntries(
      (asset.discountLadder ?? []).map((s) => [s.minDays, s.discountBps / 100]),
    );
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
  if (!Number.isFinite(n) || n <= 0 || n > 10000) {
    fail('Price must be a positive number up to 10000');
  }
  return Math.round(n * 1e6) / 1e6;
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

function limitOf(body: Record<string, unknown>, fallback: number): number {
  if (body.limit === undefined || body.limit === null || body.limit === '') {
    return fallback;
  }
  return checkPrice(body.limit);
}

function fillDays(
  state: DemoState,
  days: Day[],
  buyer: string,
  perDay: Record<string, number>,
  now: string,
  block?: number,
) {
  const groups = new Map<string, Day[]>();
  for (const d of days) {
    if (!groups.has(d.owner)) groups.set(d.owner, []);
    groups.get(d.owner)!.push(d);
  }
  let total = 0;
  for (const [seller, ds] of groups) {
    const tot = ds.reduce((s, d) => s + perDay[d.date], 0);
    total += tot;
    state.accounts[seller].cash += tot;
    ds.forEach((d) => {
      d.history.push({
        type: 'trade',
        from: seller,
        to: buyer,
        price: perDay[d.date],
        ...(block ? { block } : {}),
        at: now,
      });
      d.owner = buyer;
      d.listed = false;
    });
  }
  state.accounts[buyer].cash -= total;
}

function quoteCost(
  asset: Asset,
  days: Day[],
  buyer: string,
  today: string,
): { total: number; perDay: Record<string, number> } {
  if (days.length === 1) {
    const price = days[0].salePrice!;
    return { total: price, perDay: { [days[0].date]: price } };
  }
  const q = quoteBlock(
    days,
    buyer,
    (owner) => discountsFor(asset, owner),
    today,
  );
  if ('reason' in q) return fail('Blocks must be continuous listed days');
  return { total: q.total, perDay: q.perDay };
}

function daysForBid(asset: Asset, bid: NonNullable<DemoState['bids']>[number]) {
  return range(asset, bid.from, bid.to);
}

function tryFillBid(
  state: DemoState,
  asset: Asset,
  bid: NonNullable<DemoState['bids']>[number],
  ctx: ActionCtx,
): boolean {
  const days = daysForBid(asset, bid);
  if (
    days.some((d) => d.date < ctx.today || !d.listed || d.owner === bid.buyer)
  ) {
    return false;
  }
  const { total, perDay } = quoteCost(asset, days, bid.buyer, ctx.today);
  const buyer = state.accounts[bid.buyer];
  if (!buyer || buyer.cash < total || bid.limit < total) return false;
  fillDays(
    state,
    days,
    bid.buyer,
    perDay,
    ctx.now,
    days.length > 1 ? days.length : undefined,
  );
  return true;
}

function matchBids(state: DemoState, asset: Asset, ctx: ActionCtx) {
  const bids = state.bids ?? [];
  const kept: NonNullable<DemoState['bids']> = [];
  for (const bid of bids) {
    if (bid.asset !== asset.id) {
      kept.push(bid);
      continue;
    }
    if (!tryFillBid(state, asset, bid, ctx)) kept.push(bid);
  }
  state.bids = kept;
}

function restBid(
  state: DemoState,
  asset: Asset,
  buyer: string,
  from: string,
  to: string,
  limit: number,
) {
  state.bids = state.bids ?? [];
  state.bids.push({
    id: `bid-${state.version + 1}-${state.bids.length}`,
    asset: asset.id,
    buyer,
    from,
    to,
    limit,
  });
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
    const price = d.salePrice!;
    const limit = limitOf(body, price);
    if (limit < price) {
      restBid(state, asset, account, d.date, d.date, limit);
      return { message: `Open buy for $${limit}` };
    }
    const buyer = state.accounts[account];
    if (buyer.cash < price) {
      fail(`Not enough cash (need $${price}, have $${buyer.cash})`);
    }
    fillDays(state, [d], account, { [d.date]: price }, ctx.now);
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
    const { total, perDay } = quoteCost(asset, days, account, ctx.today);
    const limit = limitOf(body, total);
    if (limit < total) {
      restBid(
        state,
        asset,
        account,
        days[0].date,
        days[days.length - 1].date,
        limit,
      );
      return { message: `Open buy for $${limit}` };
    }
    const buyer = state.accounts[account];
    if (buyer.cash < total) {
      fail(`Not enough cash (need $${total}, have $${buyer.cash})`);
    }
    fillDays(state, days, account, perDay, ctx.now, days.length);
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
    const low = days.find((d) => d.curve && p < d.curve.min);
    if (low)
      fail(`Price can't be below the day's minimum ($${low.curve!.min})`);
    days.forEach((d) => {
      d.price = p;
      if (d.curve) d.curve.points[0].price = p;
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
    matchBids(state, asset, ctx);
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
      (body.date as string) || (body.day as string),
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
      (body.day as string) || (body.date as string),
      ctx.today,
    );
    if (d.status !== 'booked') fail('This day is not booked');
    d.status = 'open';
    d.history.push({ type: 'unbook', price: d.price, at: ctx.now });
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
  'cancel-bid'(state, _asset, body) {
    const account = checkAccount(state, body.account as string);
    const id = String(body.id ?? '');
    const bids = state.bids ?? [];
    const bid = bids.find((b) => b.id === id);
    if (!bid || bid.buyer !== account) fail('Open order is unavailable');
    state.bids = bids.filter((b) => b.id !== id);
  },
  'create-asset'(state, _asset, body, ctx) {
    const account = checkAccount(state, body.account as string);
    if (!isHost(account)) fail('Only the host can create assets');
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
      if (v === '' || v == null || !Number.isFinite(n) || n < 1 || n > 10000) {
        fail(`${what} price must be a number between 1 and 10000`);
      }
      return Math.round(n);
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
    const selling =
      body.sellingPrice === undefined ||
      body.sellingPrice === null ||
      body.sellingPrice === ''
        ? Math.round(lowest * 0.6) || 1
        : checkPrice(body.sellingPrice);
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
    const asset: Asset = {
      id,
      type: type as Asset['type'],
      title: t,
      provider: account,
      location: loc,
      discounts: {},
      custom,
      days: [],
    };
    asset.days = seedDaysFor(asset, ctx.today, selling);
    state.assets.push(asset);
    return { asset: id };
  },
  reset(state, _asset, _body, ctx) {
    Object.assign(state, emptyState(ctx.today));
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
  const found = assetById(
    next,
    typeof raw === 'string' || raw == null ? raw : String(raw),
  );
  if (
    !found &&
    name !== 'create-asset' &&
    name !== 'reset' &&
    name !== 'cancel-bid'
  ) {
    throw new UserError('Unknown asset');
  }
  const asset =
    found ??
    ({
      id: '',
      type: 'car',
      title: '',
      provider: '',
      location: '',
      discounts: {},
      days: [],
    } satisfies Asset);
  const out = action(next, asset, body, ctx) ?? {};
  next.version += 1;
  return { state: next, out };
}
