import { encodeFunctionData, getAddress, zeroAddress, zeroHash } from 'viem';
import {
  approveDayFunding,
  dayAssetAbi,
  dayFactoryAbi,
  dayRouterAbi,
  dayTokenAbi,
  hashDayStrategy,
  officialAquaAbi,
  shipDayStrategy,
  tokyoDay,
} from './day-protocol.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function uint(value, bits, label) {
  if (!(
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ))
    throw new Error(`${label} must be an exact unsigned integer`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= 1n << BigInt(bits))
    throw new Error(`${label} exceeds uint${bits}`);
  return parsed;
}
const day = (value) => Number(uint(value, 32, 'day'));
const address = (value) => {
  const result = getAddress(value);
  if (result === zeroAddress) throw new Error('Zero address is not allowed');
  return result;
};
function salt(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value))
    throw new Error('An explicit bytes32 salt is required');
  return value.toLowerCase();
}
function price(value, minimum = 1000000n) {
  const result = uint(value, 128, 'listed price');
  if (result < minimum || result % 1000000n)
    throw new Error('Booking prices require whole USD at or above minimum');
  return result;
}
function discounts(value) {
  if (!Array.isArray(value))
    throw new Error('Explicit discount ladder required');
  const steps = value.map((step) => ({
    minDays: Number(uint(step.minDays, 16, 'minimum days')),
    discountBps: Number(uint(step.discountBps, 16, 'discount basis points')),
  }));
  if (
    steps.some(
      (step, i) =>
        step.minDays < 2 ||
        step.minDays > 365 ||
        step.discountBps > 10000 ||
        (i > 0 && steps[i - 1].minDays >= step.minDays),
    )
  )
    throw new Error('Invalid discount ladder');
  return steps;
}
const json = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
const tx = (to, abi, functionName, args) => ({
  to,
  data: encodeFunctionData({ abi, functionName, args }),
  value: '0x0',
});

/** Unsigned wallet steps at one canonical block. Publication neither escrows nor guarantees funds. */
export async function prepareDayAction(client, config, actor, action, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Action body required');
  const supported = [
    'create-asset',
    'list',
    'unlist',
    'set-price',
    'curve',
    'discounts',
    'book',
    'unbook',
    'buy',
    'publish-bid',
    'cancel-bid',
    'authorize-reporter',
  ];
  if (!supported.includes(action)) throw new Error('Unknown day action');
  const chainId = uint(config.chainId, 256, 'chain ID');
  if (!chainId || BigInt(await client.getChainId()) !== chainId)
    throw new Error('Wrong action chain');
  const factory = address(config.factory),
    router = address(config.router),
    aqua = address(config.aqua),
    usdc = address(config.usdc),
    sender = address(actor);
  const block = await client.getBlock();
  if (block?.number === undefined || !/^0x[0-9a-f]{64}$/i.test(block.hash))
    throw new Error('Missing canonical block');
  const read = (target, abi, functionName, args = []) =>
    client.readContract({
      address: target,
      abi,
      functionName,
      args,
      blockNumber: block.number,
    });
  const [actualFactory, actualAqua, actualUsdc, decimals] = await Promise.all([
    read(router, dayRouterAbi, 'FACTORY'),
    read(router, dayRouterAbi, 'AQUA'),
    read(router, dayRouterAbi, 'USDC'),
    read(usdc, dayTokenAbi, 'decimals'),
  ]);
  if (
    !same(factory, actualFactory) ||
    !same(aqua, actualAqua) ||
    !same(usdc, actualUsdc) ||
    Number(decimals) !== 6
  )
    throw new Error('Action deployment configuration differs from router');
  const transactions = [];
  const result = { transactions };
  const finish = async () => {
    if (
      !same(
        (await client.getBlock({ blockNumber: block.number }))?.hash,
        block.hash,
      )
    )
      throw new Error('Action state changed during reorg');
    return json(result);
  };
  if (action === 'create-asset') {
    if (typeof body.metadataURI !== 'string' || !body.defaults)
      throw new Error('Metadata URI and defaults required');
    const hostSalt = salt(body.salt),
      minimum = price(body.defaults.minimum);
    const defaults = { minimum };
    for (const field of ['listedPrices', 'sellingPrices']) {
      if (
        !Array.isArray(body.defaults[field]) ||
        body.defaults[field].length !== 7
      )
        throw new Error(
          'Defaults require seven Sunday-through-Saturday prices',
        );
      defaults[field] = body.defaults[field].map((value) => {
        const parsed =
          field === 'listedPrices'
            ? price(value, minimum)
            : uint(value, 128, 'selling price');
        if (!parsed) throw new Error('Selling price must be positive');
        return parsed;
      });
    }
    const steps = discounts(body.discounts);
    if (
      !same(
        await read(factory, dayFactoryAbi, 'assets', [sender, hostSalt]),
        zeroAddress,
      )
    )
      throw new Error('Host salt already identifies an asset');
    transactions.push(
      tx(factory, dayFactoryAbi, 'createAsset', [
        hostSalt,
        body.metadataURI,
        defaults,
        steps,
      ]),
    );
    return finish();
  }
  if (action === 'cancel-bid') {
    const nonce = uint(body.nonce, 256, 'nonce');
    if (body.buyer !== undefined && !same(address(body.buyer), sender))
      throw new Error('Buyer must be the wallet actor');
    if (!(await read(router, dayRouterAbi, 'used', [sender, nonce])))
      transactions.push(tx(router, dayRouterAbi, 'cancel', [nonce]));
    return finish();
  }
  const asset = address(body.asset);
  result.asset = asset;
  if (!(await read(factory, dayFactoryAbi, 'isAsset', [asset])))
    throw new Error('Unknown factory asset');
  const [host, first, end] = await Promise.all([
    read(asset, dayAssetAbi, 'host'),
    read(asset, dayAssetAbi, 'startDay'),
    read(asset, dayAssetAbi, 'endDayExclusive'),
  ]);
  if (day(end) - day(first) !== 365)
    throw new Error('Unexpected asset horizon');
  if (action === 'authorize-reporter') {
    if (!same(host, sender))
      throw new Error('Only the host may authorize a reporter');
    const reporter = address(config.bookingReporter);
    transactions.push(
      tx(asset, dayAssetAbi, 'setBookingRelayer', [reporter, true]),
    );
    return finish();
  }
  if (action === 'discounts') {
    if (!same(host, sender))
      throw new Error('Only the host may change discounts');
    transactions.push(
      tx(asset, dayAssetAbi, 'setDiscountLadder', [discounts(body.discounts)]),
    );
    return finish();
  }
  const single = ['curve', 'book', 'unbook'].includes(action);
  const start = day(single ? body.day : body.startDay),
    stop = single ? start + 1 : day(body.endDayExclusive);
  const today = tokyoDay(block.timestamp);
  if (
    start < Number(first) ||
    start < today ||
    stop > Number(end) ||
    stop <= start
  )
    throw new Error(
      'Range must be consecutive live days within the fixed 365-day calendar',
    );
  const states = [];
  for (let cursor = start; cursor < stop; cursor += 64) {
    const last = Math.min(cursor + 64, stop);
    const page = await read(asset, dayAssetAbi, 'rangeState', [cursor, last]);
    if (page.length !== last - cursor) throw new Error('Incomplete day state');
    states.push(...page);
  }
  if (action === 'book' || action === 'unbook') {
    if (!same(host, sender))
      throw new Error('Only the host may plan a booking');
    const expected = uint(
        body.expectedListedPrice,
        128,
        'expected listed price',
      ),
      booked = action === 'book';
    if (
      states[0].booked === booked ||
      BigInt(states[0].listedPrice) !== expected
    )
      throw new Error('Booking status or expected current price differs');
    transactions.push(
      tx(asset, dayAssetAbi, 'setBooked', [start, booked, expected]),
    );
    return finish();
  }
  const publish = async (kind, strategy, token, amount, deployed = true) => {
    const strategyHash = hashDayStrategy(kind, strategy);
    const [remaining, count] = await read(
      aqua,
      officialAquaAbi,
      'rawBalances',
      [sender, router, strategyHash, token],
    );
    if (
      Number(count) === 255 ||
      (Number(count) > 0 && BigInt(remaining) < amount)
    )
      throw new Error('Strategy was docked or depleted; provide a fresh salt');
    const allowance = deployed
      ? await read(token, dayTokenAbi, 'allowance', [sender, aqua])
      : 0n;
    if (BigInt(allowance) < amount)
      transactions.push({
        ...approveDayFunding({ token, aqua, amount }),
        value: '0x0',
      });
    if (Number(count) === 0)
      transactions.push({
        ...shipDayStrategy({ aqua, kind, strategy, token }),
        value: '0x0',
      });
  };
  if (action === 'buy' || action === 'publish-bid') {
    if (body.buyer !== undefined && !same(address(body.buyer), sender))
      throw new Error('Buyer must be the wallet actor');
    if (states.some((state) => same(state.owner, sender)))
      throw new Error('Buyer already owns a requested day');
    const nonce = uint(body.nonce, 256, 'nonce'),
      deadline = uint(body.deadline, 40, 'deadline');
    if (
      deadline < block.timestamp ||
      (await read(router, dayRouterAbi, 'used', [sender, nonce]))
    )
      throw new Error('Bid nonce is closed or deadline expired');
    const strategy = {
      buyer: sender,
      chainId,
      app: router,
      asset,
      startDay: start,
      endDayExclusive: stop,
      maxTotal: uint(body.maxTotal, 248, 'Aqua budget cap'),
      nonce,
      deadline: Number(deadline),
      salt: salt(body.salt),
    };
    await publish('bid', strategy, usdc, strategy.maxTotal);
    result.strategy = strategy;
    return finish();
  }
  if (states.some((state) => !same(state.owner, sender)))
    throw new Error('Wallet does not own every requested day');
  if (action === 'unlist') {
    for (let i = 0; i < states.length;) {
      let j = i + 1;
      while (
        j < states.length &&
        BigInt(states[j].sellingPrice) === BigInt(states[i].sellingPrice)
      )
        j++;
      transactions.push(
        tx(asset, dayAssetAbi, 'setListing', [
          start + i,
          start + j,
          false,
          BigInt(states[i].sellingPrice),
        ]),
      );
      i = j;
    }
  } else if (action === 'set-price') {
    if (states.some((state) => state.booked))
      throw new Error('Booked days lock the public price');
    const listedPrice = price(body.listedPrice);
    for (let i = 0; i < states.length; i++) {
      const [minimum] = await read(asset, dayAssetAbi, 'curve', [start + i]);
      price(listedPrice, BigInt(minimum));
    }
    transactions.push(
      tx(asset, dayAssetAbi, 'setListedPrice', [start, stop, listedPrice]),
    );
  } else if (action === 'curve') {
    if (states[0].booked) throw new Error('Booked days lock the public price');
    const minimum = price(body.minimum);
    if (!Array.isArray(body.points) || !body.points.length)
      throw new Error('Curve points required');
    const points = body.points.map((point) => ({
      day: day(point.day),
      price: price(point.price, minimum),
    }));
    if (
      points[0].day !== today ||
      points.at(-1).day !== start ||
      points.some((point, i) => i > 0 && point.day <= points[i - 1].day)
    )
      throw new Error(
        'Curve must increase in date from today through the service day',
      );
    transactions.push(
      tx(asset, dayAssetAbi, 'setCurve', [start, minimum, points]),
    );
  } else if (action === 'list') {
    const sellingPrice = uint(body.sellingPrice, 128, 'selling price');
    if (!sellingPrice) throw new Error('Selling price must be positive');
    const version = await read(asset, dayAssetAbi, 'discountVersion'),
      askSalt = salt(body.askSalt ?? zeroHash);
    result.strategy = [];
    for (let i = 0; i < states.length; i++) {
      const state = states[i],
        serviceDay = start + i,
        token = address(state.token);
      if (!state.deployed)
        transactions.push(tx(asset, dayAssetAbi, 'materialize', [serviceDay]));
      const strategy = {
        seller: sender,
        chainId,
        app: router,
        asset,
        day: serviceDay,
        saleNonce: uint(state.saleNonce, 64, 'sale nonce'),
        discountVersion: uint(version, 64, 'discount version'),
        salt: askSalt,
      };
      await publish('ask', strategy, token, 1n, state.deployed);
      result.strategy.push(strategy);
    }
    transactions.push(
      tx(asset, dayAssetAbi, 'setListing', [start, stop, true, sellingPrice]),
    );
  }
  return finish();
}
