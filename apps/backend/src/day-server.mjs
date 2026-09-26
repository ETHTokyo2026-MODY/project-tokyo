import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { decodeEventLog, getAddress, verifyMessage } from 'viem';
import { bookingMessage } from './day-booking-auth.mjs';
import { readDayAsset } from './day-catalog.mjs';
import { prepareDayAction } from './day-commands.mjs';
import {
  dayAssetAbi,
  dayFactoryAbi,
  dayRouterAbi,
  dayTokenAbi,
  decodeDayPublication,
  officialAquaAbi,
  tokyoDay,
} from './day-protocol.mjs';

const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

/** Derive actual per-day payments from complete canonical settlement events. */
export async function readDayTradeHistory({
  client,
  index,
  config,
  calendars,
  asks,
  blockNumber,
}) {
  const readEvents = (name) => {
    const result = [];
    let before;
    while (true) {
      const page = index.events(name, 1000, before);
      result.push(
        ...page.filter(
          (event) =>
            same(event.address, config.router) &&
            BigInt(event.blockNumber) <= blockNumber,
        ),
      );
      if (page.length < 1000) return result;
      before = page.at(-1);
    }
  };
  const tokens = new Map();
  for (const calendar of calendars)
    for (const day of calendar.days)
      if (day.token)
        tokens.set(day.token.toLowerCase(), {
          asset: calendar.address,
          day: day.day,
        });
  const key = (event) =>
    `${event.transactionHash.toLowerCase()}:${event.args.bidHash.toLowerCase()}`;
  const settlements = new Map(
    readEvents('Settled').map((event) => [key(event), { event, days: [] }]),
  );
  for (const event of readEvents('DaySettled')) {
    const settlement = settlements.get(key(event));
    const position = tokens.get(event.args.token.toLowerCase());
    if (
      !settlement ||
      !position ||
      !same(position.asset, settlement.event.args.asset) ||
      event.blockNumber !== settlement.event.blockNumber ||
      !same(event.blockHash, settlement.event.blockHash) ||
      event.logIndex >= settlement.event.logIndex
    )
      continue;
    settlement.days.push({ event, position });
  }
  const history = [];
  const blocks = new Map();
  for (const { event: settled, days } of settlements.values()) {
    if (
      !days.length ||
      new Set(days.map(({ position }) => position.day)).size !== days.length ||
      days.reduce((sum, { event }) => sum + BigInt(event.args.payment), 0n) !==
        BigInt(settled.args.total)
    )
      continue;
    let block = blocks.get(settled.blockNumber);
    if (!block) {
      block = await client.getBlock({
        blockNumber: BigInt(settled.blockNumber),
      });
      blocks.set(settled.blockNumber, block);
    }
    if (!same(block.hash, settled.blockHash))
      throw new Error('Trade history changed during reorg');
    for (const { event, position } of days) {
      const ask = asks.get(event.args.askHash.toLowerCase());
      const authenticated =
        ask &&
        same(ask.strategy.asset, position.asset) &&
        Number(ask.strategy.day) === position.day &&
        (ask.blockNumber < event.blockNumber ||
          (ask.blockNumber === event.blockNumber &&
            ask.logIndex < event.logIndex));
      history.push({
        asset: position.asset.toLowerCase(),
        day: position.day,
        token: event.args.token.toLowerCase(),
        buyer: settled.args.buyer.toLowerCase(),
        seller: authenticated ? ask.strategy.seller.toLowerCase() : null,
        payment: BigInt(event.args.payment).toString(),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        timestamp: block.timestamp.toString(),
        bidHash: event.args.bidHash,
        askHash: event.args.askHash,
        rangeLength: days.length,
      });
    }
  }
  return history.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
}

/** The HTTP surface reads chain data and prepares unsigned calls. The optional mock booking adapter owns a separate reporter signer. */
export function createDayServer({
  client,
  index,
  config,
  bookingReporter,
  webhookToken,
}) {
  const pending = new Set();
  const handle = async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(json(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/config') {
        return reply(200, {
          chainId: config.chainId,
          factory: config.factory,
          router: config.router,
          aqua: config.aqua,
          usdc: config.usdc,
          bookingReporter: config.bookingReporter ?? null,
          conversion: config.conversion ?? null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/curve') {
        const asset = getAddress(url.searchParams.get('asset'));
        const day = Number(url.searchParams.get('day'));
        if (!Number.isSafeInteger(day) || day < 0 || day >= 2 ** 32)
          throw new Error('Invalid day');
        const block = await client.getBlock();
        const read = (address, abi, functionName, args) =>
          client.readContract({
            address,
            abi,
            functionName,
            args,
            blockNumber: block.number,
          });
        if (!(await read(config.factory, dayFactoryAbi, 'isAsset', [asset])))
          throw new Error('Unknown asset');
        const [minimum, points] = await read(asset, dayAssetAbi, 'curve', [
          day,
        ]);
        if (
          !same(
            (await client.getBlock({ blockNumber: block.number })).hash,
            block.hash,
          )
        )
          throw new Error('Curve changed during reorg');
        return reply(200, { minimum, points });
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        await index.sync();
        const readiness = await index.readiness();
        if (!readiness.ready)
          return reply(200, { ready: false, indexing: true });
        const assets = new Set();
        let before;
        while (true) {
          const page = index.events('AssetCreated', 1000, before);
          for (const event of page) {
            if (same(event.address, config.factory))
              assets.add(getAddress(event.args.asset));
          }
          if (page.length < 1000) break;
          before = page.at(-1);
        }
        const blockNumber = BigInt(readiness.tip.number);
        const calendars = [];
        for (const asset of assets)
          calendars.push(
            await readDayAsset(client, {
              factory: config.factory,
              asset,
              blockNumber,
            }),
          );
        const account = url.searchParams.get('account');
        const wallet = account ? getAddress(account) : null;
        const usdcBalance = wallet
          ? await client.readContract({
              address: config.usdc,
              abi: dayTokenAbi,
              functionName: 'balanceOf',
              args: [wallet],
              blockNumber,
            })
          : null;
        const block = await client.getBlock({ blockNumber });
        const calendarBounds = new Map(
          calendars.map((calendar) => [
            calendar.address.toLowerCase(),
            calendar,
          ]),
        );
        const bids = [];
        const asks = new Map();
        const seen = new Set();
        before = undefined;
        while (true) {
          const page = index.events('Shipped', 1000, before);
          for (const event of page) {
            if (!same(event.address, config.aqua)) continue;
            let publication;
            try {
              publication = decodeDayPublication(event.args, config);
            } catch {
              continue;
            }
            if (publication.kind === 'ask') {
              if (BigInt(event.blockNumber) <= blockNumber)
                asks.set(publication.hash, {
                  strategy: publication.strategy,
                  blockNumber: event.blockNumber,
                  logIndex: event.logIndex,
                });
              continue;
            }
            if (publication.kind !== 'bid' || seen.has(publication.hash))
              continue;
            seen.add(publication.hash);
            const bid = publication.strategy;
            if (wallet && !same(bid.buyer, wallet)) continue;
            if (
              BigInt(bid.deadline) < block.timestamp ||
              bid.startDay < tokyoDay(block.timestamp)
            )
              continue;
            const calendar = calendarBounds.get(bid.asset.toLowerCase());
            if (
              !calendar ||
              bid.startDay < calendar.startDay ||
              bid.endDayExclusive > calendar.endDayExclusive
            )
              continue;
            const [used, balance] = await Promise.all([
              client.readContract({
                address: config.router,
                abi: dayRouterAbi,
                functionName: 'used',
                args: [bid.buyer, bid.nonce],
                blockNumber,
              }),
              client.readContract({
                address: config.aqua,
                abi: officialAquaAbi,
                functionName: 'rawBalances',
                args: [bid.buyer, config.router, publication.hash, config.usdc],
                blockNumber,
              }),
            ]);
            if (
              !used &&
              Number(balance[1]) > 0 &&
              Number(balance[1]) < 255 &&
              BigInt(balance[0]) >= bid.maxTotal
            )
              bids.push({ hash: publication.hash, ...bid, status: 'open' });
          }
          if (page.length < 1000) break;
          before = page.at(-1);
        }
        const history = await readDayTradeHistory({
          client,
          index,
          config,
          calendars,
          asks,
          blockNumber,
        });
        const after = await client.getBlock({ blockNumber });
        if (
          !same(after.hash, block.hash) ||
          !same(block.hash, readiness.tip.hash) ||
          !same(index.tip()?.hash, readiness.tip.hash)
        )
          return reply(200, { ready: false, indexing: true });
        return reply(200, {
          ready: true,
          chainId: config.chainId,
          blockNumber,
          blockHash: block.hash,
          today: tokyoDay(block.timestamp),
          calendars,
          bids,
          history,
          wallet,
          usdcBalance,
          revenue: 'External booking reports are not funded USDC payouts.',
        });
      }
      if (
        req.method === 'GET' &&
        /^\/receipt\/0x[0-9a-fA-F]{64}$/.test(url.pathname)
      ) {
        const hash = url.pathname.split('/').at(-1);
        let receipt;
        try {
          receipt = await client.getTransactionReceipt({ hash });
        } catch (error) {
          if (error.name === 'TransactionReceiptNotFoundError')
            return reply(200, { status: 'pending' });
          throw error;
        }
        const block = await client.getBlock({
          blockNumber: receipt.blockNumber,
        });
        if (!same(block.hash, receipt.blockHash))
          return reply(200, { status: 'pending' });
        if (
          (await client.getBlockNumber({ cacheTime: 0 })) <
          receipt.blockNumber + BigInt(index.confirmations ?? 0)
        )
          return reply(200, { status: 'pending' });
        let asset;
        for (const log of receipt.logs) {
          if (!same(log.address, config.factory)) continue;
          try {
            const decoded = decodeEventLog({ abi: dayFactoryAbi, ...log });
            if (decoded.eventName === 'AssetCreated')
              asset = decoded.args.asset;
          } catch {
            /* Other factory events do not identify a newly created asset. */
          }
        }
        return reply(200, {
          status: receipt.status,
          transactionHash: hash,
          blockNumber: receipt.blockNumber,
          asset,
        });
      }
      if (
        req.method === 'POST' &&
        ['/prepare', '/webhook'].includes(url.pathname)
      ) {
        if (url.pathname === '/webhook') {
          if (!bookingReporter || !webhookToken)
            return reply(503, { error: 'Mock booking adapter disabled' });
          const actual = Buffer.from(req.headers.authorization ?? '');
          const expected = Buffer.from(`Bearer ${webhookToken}`);
          if (
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected)
          )
            return reply(401, { error: 'Unauthorized adapter' });
        }
        if (!req.headers['content-type']?.startsWith('application/json'))
          return reply(415, { error: 'JSON required' });
        req.setEncoding('utf8');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 65536)
            return reply(413, { error: 'Request too large' });
        }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          return reply(400, { error: 'Invalid JSON' });
        }
        if (url.pathname === '/webhook') {
          let authorized = false;
          try {
            authorized = await verifyMessage({
              address: getAddress(input.host),
              message: bookingMessage({
                ...input,
                chainId: config.chainId,
                factory: config.factory,
              }),
              signature: input.signature,
            });
          } catch {
            // Missing, malformed or mismatched signatures never reach the signer.
          }
          if (!authorized)
            return reply(401, { error: 'Invalid host booking signature' });
          return reply(200, await bookingReporter.report(input));
        }
        let publications;
        if (input.action === 'prepare-conversion' && config.conversion) {
          await index.sync();
          const readiness = await index.readiness();
          if (!readiness.ready)
            return reply(503, { error: 'The chain index is catching up' });
          const unique = new Map();
          let before;
          while (true) {
            const page = index.events('Shipped', 1000, before);
            for (const event of page) {
              if (!same(event.address, config.aqua)) continue;
              try {
                const publication = decodeDayPublication(event.args, config);
                unique.set(publication.hash, publication);
              } catch {
                /* Foreign or malformed strategies are not funding evidence. */
              }
            }
            if (page.length < 1000) break;
            before = page.at(-1);
          }
          publications = [...unique.values()];
        }
        const result = await prepareDayAction(
          client,
          config,
          input.actor,
          input.action,
          input.body,
          { publications },
        );
        return reply(200, result);
      }
      reply(404, { error: 'Not found' });
    } catch (error) {
      // Never reflect RPC URLs, credentials or arbitrary nested provider errors.
      const safe =
        error instanceof Error &&
        /^[A-Za-z0-9 ,:()._-]{1,160}$/.test(error.message)
          ? error.message
          : 'Unable to read or prepare this chain operation';
      reply(400, { error: safe });
    }
  };
  const server = createServer((req, res) => {
    const work = handle(req, res);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => res.destroy());
  });
  // A disconnected socket can leave an async chain operation running.
  server.drain = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  return server;
}
