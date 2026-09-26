import { describe, expect, it } from 'vitest';
import { applyAction, assetById, discountsFor, UserError } from './actions';
import { DEFAULT_DISCOUNTS, seedState } from './seed';
import type { DemoState } from './types';

const TODAY = '2026-09-26';
const NOW = '2026-09-26T00:00:00.000Z';
const ctx = { today: TODAY, now: NOW };

const seeded = seedState(TODAY);
const tesla = seeded.assets[0];
const future = tesla.days.filter((d) => d.date >= TODAY);
const past = tesla.days.filter((d) => d.date < TODAY);
const D = (i: number) => future[i].date;

function dayOf(state: DemoState, date: string) {
  return assetById(state)!.days.find((d) => d.date === date)!;
}

function act(
  state: DemoState,
  name: string,
  body: Record<string, unknown> = {},
) {
  return applyAction(state, name, body, ctx);
}

function err(
  state: DemoState,
  name: string,
  body: Record<string, unknown> = {},
) {
  try {
    applyAction(state, name, body, ctx);
    throw new Error(`expected ${name} to throw`);
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    return (e as UserError).message;
  }
}

describe('assetById and discountsFor', () => {
  it('treats a missing or empty id as the first asset', () => {
    expect(assetById(seeded)?.id).toBe('tesla-model-3');
    expect(assetById(seeded, '')?.id).toBe('tesla-model-3');
    expect(assetById(seeded, 'toyota-prius')?.id).toBe('toyota-prius');
    expect(assetById(seeded, 'missing')).toBeUndefined();
  });

  it('copies default discount tiers when none are saved', () => {
    const tiers = discountsFor(tesla, 'traderA');
    expect(tiers).toEqual(DEFAULT_DISCOUNTS);
    expect(tiers).not.toBe(DEFAULT_DISCOUNTS);
  });
});

describe('applyAction', () => {
  it('rejects unknown actions and assets without touching state', () => {
    expect(err(seeded, 'nope')).toBe('Unknown action');
    expect(err(seeded, 'buy', { asset: 'missing' })).toBe('Unknown asset');
    expect(seeded.version).toBe(0);
  });
});

describe('buy', () => {
  it('moves cash, records history, and unlists the day', () => {
    const price = dayOf(seeded, D(3)).salePrice!;
    const { state } = act(seeded, 'buy', { account: 'traderA', date: D(3) });
    const d = dayOf(state, D(3));
    expect(state.accounts.traderA.cash).toBe(1000 - price);
    expect(state.accounts.host.cash).toBe(price);
    expect(d).toMatchObject({
      owner: 'traderA',
      listed: false,
      history: [{ type: 'trade', from: 'host', to: 'traderA', price, at: NOW }],
    });
    expect(seeded.accounts.traderA.cash).toBe(1000);
    expect(dayOf(seeded, D(3)).owner).toBe('host');
  });

  it('rejects buying your own day, an unlisted day, and a too-expensive day', () => {
    let { state } = act(seeded, 'buy', { account: 'traderA', date: D(3) });
    expect(err(state, 'buy', { account: 'traderA', date: D(3) })).toBe(
      "You can't buy your own day",
    );
    expect(err(state, 'buy', { account: 'traderB', date: D(3) })).toBe(
      'This day is not for sale',
    );
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(3),
      price: 5000,
    }));
    const cash = state.accounts.traderB.cash;
    expect(err(state, 'buy', { account: 'traderB', date: D(3) })).toBe(
      `Not enough cash (need $5000, have $${cash})`,
    );
    expect(state.accounts.traderB.cash).toBe(cash);
    expect(dayOf(state, D(3)).owner).toBe('traderA');
  });

  it('lets the host buy a day back', () => {
    let { state } = act(seeded, 'buy', { account: 'traderA', date: D(3) });
    const price1 = dayOf(seeded, D(3)).salePrice!;
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(3),
      price: 50,
    }));
    const hostCash = state.accounts.host.cash;
    ({ state } = act(state, 'buy', { account: 'host', date: D(3) }));
    expect(dayOf(state, D(3)).owner).toBe('host');
    expect(state.accounts.host.cash).toBe(hostCash - 50);
    expect(state.accounts.traderA.cash).toBe(1000 - price1 + 50);
  });
});

describe('set-price / list / unlist', () => {
  it('rejects non-owners and invalid prices, then lets the owner set, list, unlist and relist', () => {
    let { state } = act(seeded, 'buy', { account: 'traderA', date: D(3) });
    expect(
      err(state, 'set-price', { account: 'host', date: D(3), price: 99 }),
    ).toBe('Only the owner can do that');
    expect(
      err(state, 'list', { account: 'traderB', date: D(3), price: 50 }),
    ).toBe('Only the owner can do that');
    expect(
      err(state, 'set-price', { account: 'traderA', date: D(3), price: 'abc' }),
    ).toBe('Price must be a whole number of dollars between 1 and 10000');
    ({ state } = act(state, 'set-price', {
      account: 'traderA',
      date: D(3),
      price: 120,
    }));
    expect(dayOf(state, D(3)).price).toBe(120);
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(3),
      price: 5000,
    }));
    expect(err(state, 'buy', { account: 'traderB', date: D(3) })).toMatch(
      /^Not enough cash \(need \$5000, have \$/,
    );
    ({ state } = act(state, 'unlist', { account: 'traderA', date: D(3) }));
    expect(dayOf(state, D(3)).listed).toBe(false);
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(3),
      price: 50,
    }));
    expect(dayOf(state, D(3))).toMatchObject({ listed: true, salePrice: 50 });
  });
});

describe('book / unbook', () => {
  it('locks the booked price, stays booked when resold, and rejects a second booking', () => {
    let { state } = act(seeded, 'buy', { account: 'traderB', date: D(4) });
    const pub = dayOf(state, D(4)).price;
    const cash = state.accounts.traderB.cash;
    expect(err(state, 'book', { account: 'traderA', date: D(4) })).toBe(
      'Only the owner can do that',
    );
    ({ state } = act(state, 'book', { account: 'traderB', date: D(4) }));
    expect(dayOf(state, D(4))).toMatchObject({
      status: 'booked',
      price: pub,
      history: expect.arrayContaining([
        { type: 'booking', price: pub, at: NOW, simulated: true },
      ]),
    });
    expect(state.accounts.traderB.cash).toBe(cash);
    expect(
      err(state, 'set-price', { account: 'traderB', date: D(4), price: 70 }),
    ).toBe('Booked days keep their booked price (locked)');
    expect(err(state, 'book', { account: 'traderB', date: D(4) })).toBe(
      'This day is already booked',
    );
    ({ state } = act(state, 'list', {
      account: 'traderB',
      date: D(4),
      price: 45,
    }));
    ({ state } = act(state, 'list', {
      account: 'traderB',
      date: D(4),
      price: 40,
    }));
    ({ state } = act(state, 'buy', { account: 'traderA', date: D(4) }));
    expect(dayOf(state, D(4))).toMatchObject({
      owner: 'traderA',
      status: 'booked',
    });
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(4),
      price: 50,
    }));
    ({ state } = act(state, 'unlist', { account: 'traderA', date: D(4) }));
    expect(dayOf(state, D(4)).listed).toBe(false);
  });

  it('lets the owner unbook: status open, curve price today, no money moves', () => {
    const ub = tesla.days.find(
      (d) => d.date >= TODAY && d.status === 'booked' && d.owner === 'host',
    )!;
    const hostCash = seeded.accounts.host.cash;
    expect(err(seeded, 'unbook', { account: 'traderA', day: ub.date })).toBe(
      'Only the owner can do that',
    );
    const { state } = act(seeded, 'unbook', { account: 'host', day: ub.date });
    const u = dayOf(state, ub.date);
    expect(u.status).toBe('open');
    expect(u.price).toBe(u.curve!.points[0].price);
    expect(u.curve!.points[0].date).toBe(TODAY);
    expect(state.accounts.host.cash).toBe(hostCash);
    expect(u.history.at(-1)).toEqual({
      type: 'unbook',
      price: u.price,
      at: NOW,
    });
    expect(err(state, 'unbook', { account: 'host', day: ub.date })).toBe(
      'This day is not booked',
    );
    const pastBooked = past.find((d) => d.status === 'booked')!;
    expect(
      err(state, 'unbook', { account: 'host', day: pastBooked.date }),
    ).toBe('Past days are locked');
  });
});

describe('past days', () => {
  it('rejects buy, set-price and book', () => {
    const p = past.at(-1)!.date;
    expect(err(seeded, 'buy', { account: 'traderA', date: p })).toBe(
      'Past days are locked',
    );
    expect(
      err(seeded, 'set-price', { account: 'host', date: p, price: 70 }),
    ).toBe('Past days are locked');
    expect(err(seeded, 'book', { account: 'host', date: p })).toBe(
      'Past days are locked',
    );
  });
});

describe('ranges', () => {
  function buyRange(from: number, to: number) {
    let state = seeded;
    for (let i = from; i <= to; i++) {
      const d = dayOf(state, D(i));
      if (d.owner !== 'traderA') {
        if (!d.listed) {
          state = act(state, 'list', {
            account: d.owner,
            date: D(i),
            price: d.salePrice ?? d.price,
          }).state;
        }
        state = act(state, 'buy', { account: 'traderA', date: D(i) }).state;
      }
    }
    return state;
  }

  it('bulk set-price, list and unlist own days, and rolls back a failed range', () => {
    let state = buyRange(10, 14);
    const isB = (i: number) => dayOf(state, D(i)).status === 'booked';
    if (![10, 11, 12, 13, 14].some(isB)) {
      state = act(state, 'book', { account: 'traderA', date: D(12) }).state;
    }
    expect(
      err(state, 'set-price', {
        account: 'traderA',
        date: D(10),
        to: D(14),
        price: 99,
      }),
    ).toBe('Booked days keep their booked price (locked)');
    let q = 10;
    while (isB(q) || isB(q + 1)) q++;
    ({ state } = act(state, 'set-price', {
      account: 'traderA',
      date: D(q),
      to: D(q + 1),
      price: 99,
    }));
    expect(dayOf(state, D(q)).price).toBe(99);
    expect(dayOf(state, D(q + 1)).price).toBe(99);
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(10),
      to: D(14),
      price: 70,
    }));
    expect(
      [10, 11, 12, 13, 14].every(
        (i) => dayOf(state, D(i)).listed && dayOf(state, D(i)).salePrice === 70,
      ),
    ).toBe(true);
    ({ state } = act(state, 'unlist', {
      account: 'traderA',
      date: D(10),
      to: D(14),
    }));
    expect([10, 11, 12, 13, 14].every((i) => !dayOf(state, D(i)).listed)).toBe(
      true,
    );
    expect(
      err(state, 'unlist', { account: 'traderA', date: D(10), to: D(18) }),
    ).toBe('Only the owner can do that');
    ({ state } = act(state, 'list', {
      account: 'traderA',
      date: D(q),
      to: D(q + 1),
      price: 70,
    }));
    const before = structuredClone(state);
    expect(
      err(state, 'list', {
        account: 'traderA',
        date: D(q),
        to: D(18),
        price: 1,
      }),
    ).toBe('Only the owner can do that');
    expect(state).toEqual(before);
    expect(dayOf(state, D(q)).salePrice).toBe(70);
    expect(
      err(state, 'unlist', { account: 'traderB', date: D(10), to: D(12) }),
    ).toBe('Only the owner can do that');
  });
});

describe('reset', () => {
  it('reseeds to a fresh sample, keeping version counting up', () => {
    let { state } = act(seeded, 'buy', { account: 'traderA', date: D(3) });
    ({ state } = act(state, 'buy', { account: 'traderB', date: D(4) }));
    const { state: reset } = act(state, 'reset');
    const fresh = seedState(TODAY);
    expect({ ...reset, version: 0 }).toEqual({ ...fresh, version: 0 });
    expect(reset.version).toBe(state.version + 1);
    expect(reset.version).toBeGreaterThan(fresh.version);
  });
});
