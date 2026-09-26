import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
} from 'viem';
import { dayAssetAbi, dayFactoryAbi, tokyoDay } from './day-protocol.mjs';
import { StoredSubmission } from './submission.mjs';

const protocol = 'day-booking-v1';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const reporterAbi = parseAbi([
  'function bookingRelayers(address reporter) view returns (bool)',
]);
const bookingEvent = parseAbi([
  'event BookingChanged(uint32 indexed day,bool booked,uint128 listedPrice)',
]);
function uint(value, bits) {
  if (!(
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ))
    throw new Error('Booking values must be exact unsigned integers');
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bits))
    throw new Error('Booking integer out of range');
  return n;
}
function address(value) {
  const result = getAddress(value);
  if (result === zeroAddress) throw new Error('Zero booking address');
  return result;
}

/**
 * Mock trusted host-adapter reporter. A host field is checked against the asset,
 * but is not HTTP authentication: callers must already be trusted by the adapter.
 * Use a separately configured reporter wallet, not the marketplace taker wallet.
 */
export class DayBookingReporter {
  #tail = Promise.resolve();
  constructor(
    db,
    client,
    wallet,
    { chainId, factory, maxRecovery = 16, confirmations = 0 },
  ) {
    if (
      !Number.isSafeInteger(maxRecovery) ||
      maxRecovery < 1 ||
      !Number.isSafeInteger(confirmations) ||
      confirmations < 0
    )
      throw new Error('Invalid booking recovery configuration');
    this.db = db;
    this.client = client;
    this.wallet = wallet;
    this.chainId = chainId;
    this.factory = address(factory);
    this.maxRecovery = maxRecovery;
    this.confirmations = confirmations;
    this.sender = wallet.account.address.toLowerCase();
    this.submissions = new StoredSubmission(db, client, wallet, {
      chainId,
      kind: 'ordinary',
    });
  }

  #serial(action) {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }

  /** Stable adapter event IDs make retries idempotent; a reversal requires its own event ID. */
  report(input) {
    return this.#serial(() => this.#report(input));
  }

  /** Recover at most maxRecovery pending nonce slots, retaining exact signed bytes and fees. */
  recover() {
    return this.#serial(() => this.#recover());
  }

  #request(input) {
    if (
      !input ||
      typeof input.eventId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.eventId) ||
      typeof input.booked !== 'boolean'
    )
      throw new Error('Booking event ID and boolean status required');
    const request = {
      eventId: input.eventId,
      host: address(input.host),
      asset: address(input.asset),
      day: Number(uint(input.day, 32)),
      booked: input.booked,
      expectedListedPrice: uint(input.expectedListedPrice, 128).toString(),
    };
    const id = keccak256(
      toHex(
        `${protocol}:${this.chainId}:${this.factory.toLowerCase()}:${this.sender}:${request.host.toLowerCase()}:${request.eventId}`,
      ),
    );
    const data = encodeFunctionData({
      abi: dayAssetAbi,
      functionName: 'setBooked',
      args: [request.day, request.booked, BigInt(request.expectedListedPrice)],
    });
    return {
      id,
      request,
      data,
      payload: JSON.stringify({ protocol, factory: this.factory, request }),
    };
  }

  #saved(job) {
    let payload;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      /* Fail closed below. */
    }
    if (
      job.kind !== 'ordinary' ||
      payload?.protocol !== protocol ||
      !same(payload.factory, this.factory) ||
      !job.unsigned
    )
      throw new Error('Unsupported saved booking submission');
    const call = this.#request(payload.request);
    if (
      call.id !== job.id ||
      call.payload !== job.payload ||
      job.bid_hash !== call.id ||
      job.ask_hash !== keccak256(call.data)
    )
      throw new Error('Saved booking request differs from its exact call');
    return call;
  }

  async #validate(call) {
    if ((await this.client.getChainId()) !== this.chainId)
      throw new Error('Wrong booking chain');
    const block = await this.client.getBlock();
    if (block?.number === undefined || !block.hash)
      throw new Error('Missing booking block');
    const { request } = call;
    const read = (target, abi, functionName, args = []) =>
      this.client.readContract({
        address: target,
        abi,
        functionName,
        args,
        blockNumber: block.number,
      });
    if (!(await read(this.factory, dayFactoryAbi, 'isAsset', [request.asset])))
      throw new Error('Unknown booking asset');
    const [host, start, end] = await Promise.all([
      read(request.asset, dayAssetAbi, 'host'),
      read(request.asset, dayAssetAbi, 'startDay'),
      read(request.asset, dayAssetAbi, 'endDayExclusive'),
    ]);
    if (!same(host, request.host))
      throw new Error('Booking host does not own this asset');
    if (
      Number(end) - Number(start) !== 365 ||
      request.day < Number(start) ||
      request.day >= Number(end) ||
      request.day < tokyoDay(block.timestamp)
    )
      throw new Error('Booking day is outside the live calendar');
    if (
      !same(host, this.sender) &&
      !(await read(request.asset, reporterAbi, 'bookingRelayers', [
        this.sender,
      ]))
    )
      throw new Error('Reporter is not authorized by this host');
    const state = await read(request.asset, dayAssetAbi, 'dayState', [
      request.day,
    ]);
    if (
      state.booked === request.booked ||
      BigInt(state.listedPrice) !== BigInt(request.expectedListedPrice)
    )
      throw new Error('Booking status or expected current price differs');
    if (
      !same(
        (await this.client.getBlock({ blockNumber: block.number }))?.hash,
        block.hash,
      )
    )
      throw new Error('Booking state changed during reorg');
    return this.client.simulateContract({
      address: request.asset,
      abi: dayAssetAbi,
      functionName: 'setBooked',
      args: [request.day, request.booked, BigInt(request.expectedListedPrice)],
      account: this.wallet.account,
    });
  }

  async #status(job, receipt, call) {
    const result = {
      eventId: call.request.eventId,
      hash: job.tx_hash,
      state: 'pending',
    };
    if (!receipt) return result;
    if (
      !same(receipt.transactionHash, job.tx_hash) ||
      !same(receipt.from, this.sender) ||
      !same(receipt.to, call.request.asset)
    )
      throw new Error('Booking receipt differs from saved transaction');
    const canonical = await this.client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (
      !same(canonical?.hash, receipt.blockHash) ||
      (await this.client.getBlockNumber()) - receipt.blockNumber <
        BigInt(this.confirmations)
    )
      return result;
    if (receipt.status === 'reverted') return { ...result, state: 'reverted' };
    if (receipt.status !== 'success')
      throw new Error('Unknown booking receipt status');
    const logs = parseEventLogs({
      abi: bookingEvent,
      eventName: 'BookingChanged',
      strict: true,
      logs: receipt.logs.filter((log) => same(log.address, call.request.asset)),
    });
    if (
      logs.length !== 1 ||
      logs[0].args.day !== call.request.day ||
      logs[0].args.booked !== call.request.booked ||
      (call.request.booked &&
        logs[0].args.listedPrice !== BigInt(call.request.expectedListedPrice))
    )
      throw new Error('Receipt lacks the expected booking event');
    // Unbooking emits the resumed curve price, which can differ from the frozen booking price.
    if (
      !same(
        (await this.client.getBlock({ blockNumber: receipt.blockNumber }))
          ?.hash,
        receipt.blockHash,
      )
    )
      return result;
    return { ...result, state: 'confirmed' };
  }

  async #submit(call, existing) {
    if (existing && !existing.raw) await this.#validate(call);
    const { job, receipt } = await this.submissions.submit({
      id: call.id,
      bidHash: call.id,
      askHash: keccak256(call.data),
      to: call.request.asset,
      data: call.data,
      payload: call.payload,
      simulate: () => this.#validate(call),
    });
    return this.#status(
      job,
      receipt ?? (await this.submissions.receipt(job.tx_hash)),
      call,
    );
  }

  async #recover() {
    if ((await this.client.getChainId()) !== this.chainId)
      throw new Error('Wrong booking chain');
    const nonce = await this.client.getTransactionCount({
      address: this.sender,
      blockTag: 'latest',
    });
    const stranded = this.db
      .prepare(
        'SELECT id FROM submissions WHERE sender=? AND nonce<? AND raw IS NULL LIMIT 1',
      )
      .get(this.sender, nonce);
    if (stranded)
      throw new Error(
        'An unsigned booking nonce was consumed outside this reporter',
      );
    // Mined jobs are checked again when their event ID is retried. This bounded query
    // recovers outstanding nonce slots without scanning an unbounded event history.
    const jobs = this.db
      .prepare(
        'SELECT * FROM submissions WHERE sender=? AND nonce>=? ORDER BY nonce LIMIT ?',
      )
      .all(this.sender, nonce, this.maxRecovery + 1);
    const calls = jobs.map((job) => this.#saved(job));
    const results = [];
    for (let i = 0; i < Math.min(jobs.length, this.maxRecovery); i++) {
      const status = await this.#submit(calls[i], jobs[i]);
      results.push(status);
      if (status.state === 'pending') return { complete: false, results };
    }
    return { complete: jobs.length <= this.maxRecovery, results };
  }

  async #report(input) {
    const call = this.#request(input);
    const existing = this.submissions.get(call.id);
    if (existing && this.#saved(existing).payload !== call.payload)
      throw new Error('Conflicting booking event ID');
    const recovery = await this.#recover();
    if (!recovery.complete) {
      const current = this.submissions.get(call.id);
      if (current?.tx_hash) return { hash: current.tx_hash };
      throw new Error('Earlier booking submission requires recovery');
    }
    const status = await this.#submit(call, this.submissions.get(call.id));
    if (status.state === 'reverted')
      throw new Error(
        'Booking transaction reverted; reread state and use a new event ID',
      );
    return { hash: status.hash };
  }
}
