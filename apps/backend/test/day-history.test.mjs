import assert from 'node:assert/strict';
import test from 'node:test';
import { readDayTradeHistory } from '../src/day-server.mjs';
import { encodeDayStrategy, hashDayStrategy } from '../src/day-protocol.mjs';

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const config = { router: address(1), aqua: address(7), chainId: 11155111 };
const asset = address(2),
  buyer = address(3),
  seller = address(4);
function fixture(count = 1) {
  const events = [],
    publications = [],
    bidHashes = [],
    calls = [],
    asks = new Map();
  const calendars = [
    {
      address: asset,
      days: [
        { day: 20000, token: address(5) },
        { day: 20001, token: address(6) },
      ],
    },
  ];
  for (let i = 0; i < count; i++) {
    const bid = {
      buyer,
      chainId: 11155111n,
      app: config.router,
      asset,
      startDay: 20000,
      endDayExclusive: 20002,
      maxTotal: 70000001n,
      nonce: BigInt(i),
      deadline: 1900000000,
      salt: hash(i),
    };
    const bidHash = hashDayStrategy('bid', bid);
    bidHashes.push(bidHash);
    publications.push({
      address: config.aqua,
      name: 'Shipped',
      blockNumber: 9,
      blockHash: hash(9),
      transactionHash: hash(90000 + i),
      logIndex: i,
      args: {
        maker: buyer,
        app: config.router,
        strategyHash: bidHash,
        strategy: encodeDayStrategy('bid', bid),
      },
    });
    const common = {
      address: config.router,
      transactionHash: hash(i + 1),
      blockNumber: 10,
      blockHash: hash(10),
    };
    events.push(
      {
        ...common,
        name: 'DaySettled',
        logIndex: i * 3,
        args: {
          bidHash,
          askHash: hash(100000 + i),
          token: address(5),
          payment: '70000001',
        },
      },
      {
        ...common,
        name: 'DaySettled',
        logIndex: i * 3 + 1,
        args: {
          bidHash,
          askHash: hash(200000 + i),
          token: address(6),
          payment: '0',
        },
      },
      {
        ...common,
        name: 'Settled',
        logIndex: i * 3 + 2,
        args: { bidHash, buyer, asset, total: '70000001' },
      },
    );
    asks.set(hash(100000 + i), {
      strategy: { asset, day: 20000, seller },
      blockNumber: 9,
      logIndex: 0,
    });
  }
  return {
    events,
    publications,
    bidHashes,
    calls,
    asks,
    calendars,
    config,
    blockNumber: 10n,
    client: {
      getBlock: async () => ({ hash: hash(10), timestamp: 1728000000n }),
    },
    index: {
      events(name, limit, before) {
        calls.push({ name, limit, before });
        return [...events, ...publications]
          .filter(
            (event) =>
              event.name === name &&
              (!before ||
                event.blockNumber < before.blockNumber ||
                (event.blockNumber === before.blockNumber &&
                  event.logIndex < before.logIndex)),
          )
          .sort(
            (a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex,
          )
          .slice(0, limit);
      },
    },
  };
}

test('trade history preserves actual per-day payment, zero fills and authenticated seller', async () => {
  const f = fixture();
  const history = await readDayTradeHistory(f);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], {
    asset,
    day: 20000,
    token: address(5),
    buyer,
    seller,
    payment: '70000001',
    transactionHash: hash(1),
    blockNumber: 10,
    logIndex: 0,
    timestamp: '1728000000',
    bidHash: f.bidHashes[0],
    askHash: hash(100000),
    rangeLength: 2,
  });
  assert.equal(history[1].payment, '0');
  assert.equal(history[1].seller, null);
});

test('history scans every cursor page and emits chronological rows without overlap', async () => {
  const f = fixture(1002);
  const history = await readDayTradeHistory(f);
  assert.equal(history.length, 2004);
  assert.equal(
    new Set(
      history.map((event) => `${event.transactionHash}:${event.logIndex}`),
    ).size,
    2004,
  );
  assert.equal(history[0].logIndex, 0);
  assert.equal(history.at(-1).logIndex, 3004);
  assert.ok(f.calls.some((call) => call.name === 'Settled' && call.before));
  assert.ok(f.calls.some((call) => call.name === 'Shipped' && call.before));
  assert.ok(
    f.calls.filter((call) => call.name === 'DaySettled' && call.before)
      .length >= 2,
  );
});

test('orphan, foreign, unpaired and incomplete settlements do not become trade history', async () => {
  for (const mutate of [
    (f) => {
      f.events.length = 2;
    },
    (f) => {
      f.events[2].transactionHash = hash(999);
    },
    (f) => {
      f.events[2].args.asset = address(999);
    },
    (f) => {
      f.events[2].args.total = '90000000';
    },
    (f) => {
      f.events.forEach((event) => {
        event.address = address(999);
      });
    },
    (f) => {
      f.blockNumber = 9n;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.deepEqual(await readDayTradeHistory(f), []);
  }
  const f = fixture();
  f.events.length = 0;
  assert.deepEqual(await readDayTradeHistory(f), []);
});

test('missing, later or mismatched ask evidence leaves seller unknown', async () => {
  for (const change of [
    { strategy: { asset: address(999), day: 20000, seller } },
    { strategy: { asset, day: 20001, seller } },
    { blockNumber: 11 },
    { blockNumber: 10, logIndex: 1 },
  ]) {
    const f = fixture();
    f.asks.set(hash(100000), { ...f.asks.get(hash(100000)), ...change });
    assert.equal((await readDayTradeHistory(f))[0].seller, null);
  }
});

test('settlement timestamp must come from its canonical block', async () => {
  const f = fixture();
  f.client.getBlock = async () => ({ hash: hash(999), timestamp: 1728000000n });
  await assert.rejects(readDayTradeHistory(f), /reorg/);
});

test('missing zero-payment days never become complete range history', async () => {
  for (const allZero of [false, true]) {
    const f = fixture();
    if (allZero) {
      f.events[0].args.payment = '0';
      f.events[2].args.total = '0';
    }
    assert.equal((await readDayTradeHistory(f)).length, 2);
    f.events.splice(1, 1);
    assert.deepEqual(await readDayTradeHistory(f), []);
  }
});

test('history requires an earlier authenticated bid for its buyer and exact range', async () => {
  const changes = [
    (f) => {
      f.publications.length = 0;
    },
    (f) => {
      f.publications[0].address = address(999);
    },
    (f) => {
      f.publications[0].args.maker = address(999);
    },
    (f) => {
      f.publications[0].args.strategyHash = hash(999);
    },
    (f) => {
      f.publications[0].args.strategy = '0x';
    },
    (f) => {
      f.publications[0].blockNumber = 11;
    },
    (f) => {
      f.publications[0].blockNumber = 10;
      f.publications[0].logIndex = 3;
    },
    (f) => {
      f.publications[0].blockNumber = 10;
      f.publications[0].blockHash = hash(999);
    },
    (f) => {
      f.events[2].args.buyer = address(999);
    },
    (f) => {
      f.calendars[0].days[1].day = 20002;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.deepEqual(await readDayTradeHistory(f), []);
  }
});

test('a bid published earlier in the settlement block remains valid history', async () => {
  const f = fixture();
  const publication = f.publications[0];
  publication.blockNumber = 10;
  publication.blockHash = hash(10);
  publication.logIndex = 0;
  for (const event of f.events) event.logIndex++;
  assert.equal((await readDayTradeHistory(f)).length, 2);
});
