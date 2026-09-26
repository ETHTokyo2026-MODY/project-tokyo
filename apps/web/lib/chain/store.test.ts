import { describe, expect, it, vi } from 'vitest';
import {
  command,
  connectWallet,
  dispatch,
  refreshChain,
  sendConfirmed,
} from './store';
import { normalizeAssetId } from './model';
import { WalletBatchError } from './wallet';
const txs = [
  { to: `0x${'11'.repeat(20)}`, data: '0x1234' },
  { to: `0x${'22'.repeat(20)}`, data: '0x5678' },
];
// Unit mocks: no browser wallet or deployed chain is exercised here.
describe('wallet confirmation sequencing (unit)', () => {
  it('waits for each successful receipt before requesting the next signature', async () => {
    const events: string[] = [];
    let confirm!: () => void;
    const firstReceipt = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const wallet = {
      sendBatch: vi.fn(async () => {
        const hash = `hash${events.filter((e) => e.startsWith('send')).length + 1}`;
        events.push(`send:${hash}`);
        return [hash];
      }),
    };
    const receipt = vi.fn(async (hash: string) => {
      events.push(`wait:${hash}`);
      if (hash === 'hash1') await firstReceipt;
      return { status: 'success' as const };
    });
    const done = sendConfirmed(
      txs,
      wallet,
      (hash) => events.push(`retain:${hash}`),
      receipt,
    );
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledTimes(1));
    expect(wallet.sendBatch).toHaveBeenCalledTimes(1);
    confirm();
    await done;
    expect(events).toEqual([
      'send:hash1',
      'retain:hash1',
      'wait:hash1',
      'send:hash2',
      'retain:hash2',
      'wait:hash2',
    ]);
  });
  it('stops on a rejected next signature and retains the earlier hash', async () => {
    const retained: string[] = [];
    const wallet = {
      sendBatch: vi
        .fn()
        .mockResolvedValueOnce(['first'])
        .mockRejectedValueOnce(new WalletBatchError(new Error('Rejected'), [])),
    };
    await expect(
      sendConfirmed(
        txs,
        wallet,
        (hash) => retained.push(hash),
        async () => ({ status: 'success' }),
      ),
    ).rejects.toThrow('Rejected');
    expect(retained).toEqual(['first']);
  });
  it('does not request approval after failed materialization receipt', async () => {
    const retained: string[] = [];
    const wallet = { sendBatch: vi.fn(async () => ['first']) };
    await expect(
      sendConfirmed(
        txs,
        wallet,
        (hash) => retained.push(hash),
        async () => {
          throw new Error('reverted');
        },
      ),
    ).rejects.toThrow('reverted');
    expect(wallet.sendBatch).toHaveBeenCalledTimes(1);
    expect(retained).toEqual(['first']);
  });
});
describe('UI command mapping (unit)', () => {
  it('creates seven weekday defaults and descriptive metadata', () => {
    const result = command('create-asset', {
      title: 'Car',
      type: 'car',
      location: 'Tokyo',
      prices: { sun: '65', monWed: '60', thuSat: '80' },
      min: '40',
    });
    expect(result.body).toMatchObject({
      metadataURI: JSON.stringify({
        title: 'Car',
        type: 'car',
        location: 'Tokyo',
      }),
      defaults: {
        minimum: '40000000',
        listedPrices: [
          '65000000',
          '60000000',
          '60000000',
          '60000000',
          '80000000',
          '80000000',
          '80000000',
        ],
      },
      discounts: [],
    });
  });
  it('publishes a budget without restricting it against the ask or wallet balance', () => {
    for (const limit of ['0', '0.000001', '100000.123456']) {
      const result = command('buy-block', {
        asset: txs[0].to,
        from: '2026-09-26',
        to: '2026-09-27',
        limit,
      });
      expect(result).toMatchObject({
        action: 'publish-bid',
        body: {
          maxTotal:
            limit === '0' ? '0' : limit === '0.000001' ? '1' : '100000123456',
        },
      });
    }
  });
  it('preserves sale precision and refuses sample-only mutation commands', () => {
    expect(
      command('list', {
        asset: txs[0].to,
        date: '2026-09-26',
        price: '1.000001',
      }),
    ).toMatchObject({ body: { sellingPrice: '1000001' } });
    expect(() => command('reset', {})).toThrow();
  });
});

it('normalizes a checksummed creation receipt for calendar navigation and deep links', async () => {
  const checksummed = '0xAbCdEf1234567890aBcDeF1234567890AbCdEf12';
  const id = await sendConfirmed(
    [txs[0]],
    { sendBatch: async () => ['hash'] },
    () => {},
    async () => ({ status: 'success', asset: checksummed }),
  );
  const indexed = { id: checksummed.toLowerCase() };
  const destination = new URL(`/calendar?asset=${id}`, 'https://example.test');
  expect(normalizeAssetId(destination.searchParams.get('asset')!)).toBe(
    indexed.id,
  );
  expect(normalizeAssetId(checksummed)).toBe(indexed.id);
  expect(normalizeAssetId('sampleAssetA')).toBe('sampleAssetA');
});

it('keeps initial guest prices independent from ownership selling prices', () => {
  expect(
    command('create-asset', {
      title: 'Car',
      type: 'car',
      location: 'Tokyo',
      prices: { sun: '100', monWed: '100', thuSat: '100' },
      min: '40',
      sellingPrice: '60.000001',
    }),
  ).toMatchObject({
    body: {
      defaults: {
        minimum: '40000000',
        listedPrices: Array(7).fill('100000000'),
        sellingPrices: Array(7).fill('60000001'),
      },
    },
  });
});

it('blocks actions after a previously ready index becomes unavailable', async () => {
  const account = `0x${'11'.repeat(20)}`;
  const target = Object.assign(new EventTarget(), {
    ethereum: {
      request: vi.fn(async ({ method }: { method: string }) =>
        method === 'eth_chainId' ? '0xaa36a7' : [account],
      ),
      on: () => {},
      removeListener: () => {},
    },
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ready: true,
        today: 20722,
        blockNumber: '1',
        blockHash: 'hash',
        calendars: [],
        usdcBalance: '0',
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: false, indexing: true }),
    });
  vi.stubGlobal('window', target);
  vi.stubGlobal('fetch', fetcher);
  try {
    await connectWallet({ legacy: true });
    await refreshChain();
    await expect(
      dispatch('list', { asset: account, date: '2026-09-26', price: '1' }),
    ).resolves.toEqual({
      ok: false,
      error: 'Wait for a current chain snapshot before acting',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      target.ethereum.request.mock.calls.every(
        ([request]) => request.method !== 'eth_sendTransaction',
      ),
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('maps exact WETH and USDC funding bounds without floating point', () => {
  const result = command('buy-weth', {
    asset: txs[0].to,
    from: '2026-09-26',
    to: '2026-09-27',
    limit: '120.000001',
    weth: '0.000000000000000001',
    minOutput: '119.123456',
  });
  expect(result).toMatchObject({
    action: 'prepare-conversion',
    body: { maxInput: '1', maxTotal: '120000001', minOutput: '119123456' },
  });
  expect(() =>
    command('buy-weth', {
      asset: txs[0].to,
      from: '2026-09-26',
      limit: '1',
      weth: '1.0000000000000000001',
      minOutput: '1',
    }),
  ).toThrow('eighteen');
});

it('confirms funding approvals before native typed consent and simulates before sending conversion (unit)', async () => {
  vi.resetModules();
  const live = await import('./store');
  const account = txs[0].to,
    converter = txs[1].to;
  const events: string[] = [];
  let sent = 0;
  const provider = {
    on: () => {},
    removeListener: () => {},
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts')
        return [account];
      if (method === 'eth_sendTransaction') {
        events.push(`send${++sent}`);
        return `0x${String(sent).padStart(64, '0')}`;
      }
      if (method === 'eth_signTypedData_v4') {
        events.push('funding-signature');
        return `0x${'ab'.repeat(65)}`;
      }
      throw new Error(method);
    }),
  };
  const typedData = {
    domain: {
      name: 'DayAtomicConverter',
      version: '1',
      chainId: '11155111',
      verifyingContract: converter,
    },
    types: { FundingIntent: [{ name: 'buyer', type: 'address' }] },
    primaryType: 'FundingIntent',
    message: {
      buyer: account,
      recipient: account,
      executor: converter,
      chainId: '11155111',
    },
  };
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { ethereum: provider }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: { body?: string }) => {
      let value;
      if (path.endsWith('config'))
        value = {
          chainId: 11155111,
          factory: account,
          conversion: { converter },
        };
      else if (path.includes('receipt/')) {
        events.push(`receipt${sent}`);
        value = { status: 'success' };
      } else if (path.endsWith('prepare')) {
        const request = JSON.parse(options!.body!);
        events.push(request.action);
        value =
          request.action === 'prepare-conversion'
            ? { transactions: txs, funding: { typedData } }
            : { transactions: [{ ...txs[0], gas: '0x100000' }] };
      } else
        value = {
          ready: true,
          today: 20722,
          blockNumber: '1',
          blockHash: 'hash',
          calendars: [],
          usdcBalance: '0',
        };
      return { ok: true, json: async () => value };
    }),
  );
  try {
    await live.connectWallet({ legacy: true });
    const result = await live.dispatch('buy-weth', {
      asset: account,
      from: '2026-09-26',
      to: '2026-09-27',
      limit: '120',
      weth: '0.001',
      minOutput: '120',
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      'prepare-conversion',
      'send1',
      'receipt1',
      'send2',
      'receipt2',
      'funding-signature',
      'execute-conversion',
      'send3',
      'receipt3',
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('refreshes public market data after disconnect and rejects walletless mutations', async () => {
  vi.resetModules();
  const store = await import('./store');
  const account = `0x${'11'.repeat(20)}`;
  const request = vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_chainId' ? '0xaa36a7' : [account],
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      ethereum: { request, on: () => {}, removeListener: () => {} },
    }),
  );
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ready: true,
      today: 20722,
      blockNumber: '1',
      blockHash: 'hash',
      calendars: [],
      usdcBalance: '0',
    }),
  }));
  vi.stubGlobal('fetch', fetcher);
  try {
    await store.connectWallet({ legacy: true });
    await store.disconnectWallet();
    expect(fetcher.mock.calls.at(-1)).toEqual([
      '/api/day/state',
      expect.any(Object),
    ]);
    await expect(store.dispatch('list', {})).resolves.toMatchObject({
      ok: false,
      error: 'Connect your wallet first',
    });
    expect(
      request.mock.calls.some(
        ([call]) => call.method === 'eth_sendTransaction',
      ),
    ).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
