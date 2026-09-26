import { encodeFunctionData, getAddress, hashTypedData, parseAbi } from 'viem';

export const inventorySupplyAbi = parseAbi([
  'function pools(bytes32) view returns (address supplier,uint32 startDay,uint32 endDay,uint32 capacity)',
  'function issued(bytes32,uint32) view returns (uint256)',
  'function consumed(bytes32,uint32) view returns (uint256)',
  'function publishDay(bytes32 pool,uint32 day,bytes32 terms,uint256 target)',
]);
export const scheduleTypes = {
  Schedule: [
    { name: 'supplier', type: 'address' },
    { name: 'pool', type: 'bytes32' },
    { name: 'terms', type: 'bytes32' },
    { name: 'startDay', type: 'uint32' },
    { name: 'endDay', type: 'uint32' },
    { name: 'weekdays', type: 'uint8' },
    { name: 'target', type: 'uint32' },
  ],
};
export const supplyDomain = ({ chainId, inventory }) => ({
  name: 'RentalSupply',
  version: '1',
  chainId,
  verifyingContract: inventory,
});

// Service dates are UTC calendar dates, not elapsed local-time nights.
export function serviceDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('invalid service date');
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    throw new Error('invalid service date');
  return ms / 86_400_000;
}

export class SupplyBook {
  constructor(store, client, config) {
    this.db = store.db;
    this.client = client;
    this.config = {
      chainId: config.chainId,
      inventory: getAddress(config.inventory),
    };
    this.domain = supplyDomain(this.config);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS supply_schedules(hash TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supply_days(pool TEXT NOT NULL,day INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(pool,day));`);
    const key = 'supply_deployment';
    const value = JSON.stringify(this.config);
    const prior = this.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get(key);
    if (prior && prior.value !== value)
      throw new Error('supply deployment mismatch');
    this.db
      .prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)')
      .run(key, value);
  }

  async publish({ schedule, signature }) {
    if (
      !schedule ||
      Object.keys(schedule).sort().join() !==
        scheduleTypes.Schedule.map((x) => x.name)
          .sort()
          .join()
    )
      throw new Error('invalid schedule');
    const s = { ...schedule, supplier: getAddress(schedule.supplier) };
    for (const key of ['pool', 'terms']) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(s[key]))
        throw new Error('invalid schedule');
      s[key] = s[key].toLowerCase();
    }
    for (const key of ['startDay', 'endDay', 'weekdays', 'target']) {
      if (!Number.isInteger(s[key]) || s[key] < 0 || s[key] > 0xffffffff)
        throw new Error('invalid schedule');
    }
    if (
      s.startDay >= s.endDay ||
      s.endDay - s.startDay > 90 ||
      s.weekdays < 1 ||
      s.weekdays > 127 ||
      !s.target
    )
      throw new Error('invalid recurrence');
    if (
      !(await this.client.verifyTypedData({
        address: s.supplier,
        domain: this.domain,
        types: scheduleTypes,
        primaryType: 'Schedule',
        message: s,
        signature,
      }))
    )
      throw new Error('invalid supplier signature');
    const hash = hashTypedData({
      domain: this.domain,
      types: scheduleTypes,
      primaryType: 'Schedule',
      message: s,
    });
    const prior = this.db
      .prepare('SELECT payload FROM supply_schedules WHERE hash=?')
      .get(hash);
    if (prior) return JSON.parse(prior.payload);
    const block = await this.client.getBlock();
    const [supplier, start, end, capacity] = await this.client.readContract({
      address: this.config.inventory,
      abi: inventorySupplyAbi,
      functionName: 'pools',
      args: [s.pool],
      blockNumber: block.number,
    });
    if (
      getAddress(supplier) !== s.supplier ||
      s.startDay < Number(start) ||
      s.endDay > Number(end) ||
      s.target > Number(capacity) ||
      s.startDay <= Number(block.timestamp / 86400n)
    )
      throw new Error('unauthorized or unavailable supply');
    const days = [];
    for (let day = s.startDay; day < s.endDay; day++) {
      // Unix epoch was Thursday; bit 0 is Sunday.
      if (s.weekdays & (1 << ((day + 4) % 7))) days.push(day);
    }
    if (!days.length) throw new Error('empty recurrence');
    const result = { hash, schedule: s, signature, days };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO supply_schedules VALUES(?,?)')
        .run(hash, JSON.stringify(result));
      const insert = this.db.prepare('INSERT INTO supply_days VALUES(?,?,?)');
      for (const day of days) insert.run(s.pool, day, hash);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (String(error).includes('UNIQUE'))
        throw new Error('overlapping immutable supply schedule');
      throw error;
    }
    return result;
  }

  async reconcile(hash) {
    const row = this.db
      .prepare('SELECT payload FROM supply_schedules WHERE hash=?')
      .get(hash);
    if (!row) throw new Error('schedule not found');
    const { schedule: s, days } = JSON.parse(row.payload);
    const block = await this.client.getBlock();
    const slots = [];
    for (const day of days) {
      const read = (functionName) =>
        this.client.readContract({
          address: this.config.inventory,
          abi: inventorySupplyAbi,
          functionName,
          args: [s.pool, day],
          blockNumber: block.number,
        });
      const [issued, consumed] = await Promise.all([
        read('issued'),
        read('consumed'),
      ]);
      const target = BigInt(s.target);
      slots.push({
        day,
        issued: String(issued),
        consumed: String(consumed),
        outstanding: String(issued - consumed),
        target: s.target,
        transaction:
          issued < target && day > Number(block.timestamp / 86400n)
            ? {
                account: s.supplier,
                to: this.config.inventory,
                data: encodeFunctionData({
                  abi: inventorySupplyAbi,
                  functionName: 'publishDay',
                  args: [s.pool, day, s.terms, target],
                }),
              }
            : null,
      });
    }
    if (
      (await this.client.getBlock({ blockNumber: block.number })).hash !==
      block.hash
    )
      throw new Error('supply snapshot reorganized');
    return {
      hash,
      blockNumber: String(block.number),
      blockHash: block.hash,
      slots,
    };
  }
}
