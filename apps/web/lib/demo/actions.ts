import { priceFromCurve } from './curve';
import { quoteBlock } from './quote';
import { DEFAULT_DISCOUNTS, seedState, TIERS } from './seed';
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
    const price = d.salePrice!;
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
    const buyer = state.accounts[account];
    if (buyer.cash < q.total) {
      fail(`Not enough cash (need $${q.total}, have $${buyer.cash})`);
    }
    buyer.cash -= q.total;
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
  discounts(state, asset, body) {
    const account = checkAccount(state, body.account as string);
    const tiers = body.tiers as Record<string, unknown> | undefined;
    const next: Discounts = { ...DEFAULT_DISCOUNTS };
    for (const min of TIERS) {
      const raw = tiers ? tiers[min] : undefined;
      const v = Number(raw);
      if (raw == null || raw === '' || !Number.isFinite(v) || v < 0 || v > 90) {
        fail(`Discount for ${min}+ days must be 0-90%`);
      }
      next[min as keyof Discounts] = v;
    }
    asset.discounts[account] = next;
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
