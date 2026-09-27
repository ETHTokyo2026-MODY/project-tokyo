import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWalletDiscovery,
  PREFERRED_WALLET_RDNS,
  SEPOLIA_CHAIN_ID,
  WalletBatchError,
  WalletSession,
  type WalletProvider,
} from './wallet';

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

// Provider mocks only: these tests are not evidence of real extension/browser interaction.
const account = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const tx = { to: other, data: '0x1234' };
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
type Request = Parameters<WalletProvider['request']>[0];
type Listener = (...args: unknown[]) => void;

class MockProvider implements WalletProvider {
  accounts = [account];
  chain = SEPOLIA_CHAIN_ID;
  sends = 0;
  onSend?: (n: number) => unknown | Promise<unknown>;
  onRead?: (method: string) => void;
  listeners = new Map<string, Set<Listener>>();
  request = vi.fn(async ({ method, params }: Request): Promise<unknown> => {
    this.onRead?.(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts')
      return [...this.accounts];
    if (method === 'eth_chainId') return this.chain;
    if (method === 'wallet_switchEthereumChain') {
      this.chain = (params?.[0] as { chainId: string }).chainId;
      this.emit('chainChanged', this.chain);
      return null;
    }
    if (method === 'eth_signTypedData_v4') return `0x${'ab'.repeat(65)}`;
    if (method === 'personal_sign') return `0x${'ab'.repeat(65)}`;
    if (method === 'eth_sendTransaction') {
      this.sends++;
      return this.onSend ? this.onSend(this.sends) : hash(this.sends);
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeListener(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, value?: unknown) {
    const payload =
      value ??
      (event === 'accountsChanged'
        ? [...this.accounts]
        : event === 'chainChanged'
          ? this.chain
          : { code: 4900, message: 'Disconnected' });
    for (const listener of [...(this.listeners.get(event) ?? [])])
      listener(payload);
  }
}

function announce(
  target: EventTarget,
  provider: MockProvider,
  n = 1,
  rdns = PREFERRED_WALLET_RDNS,
) {
  target.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: {
        info: {
          uuid: uuid(n),
          name: `Wallet ${n}`,
          rdns,
          icon: 'data:image/png;base64,',
        },
        provider,
      },
    }),
  );
}

function discover(target: EventTarget & { ethereum?: WalletProvider }) {
  vi.stubGlobal('window', target);
  return createWalletDiscovery();
}

describe('native wallet discovery (unit)', () => {
  it('requests announcements, retains late providers, and never connects automatically', () => {
    const target = new EventTarget();
    const preferred = new MockProvider();
    const alternate = new MockProvider();
    target.addEventListener('eip6963:requestProvider', () =>
      announce(target, alternate, 2, 'example.wallet'),
    );
    const discovery = discover(target);
    announce(target, preferred);
    announce(target, preferred);
    expect(discovery.list().map((p) => p.rdns)).toEqual([
      PREFERRED_WALLET_RDNS,
      'example.wallet',
    ]);
    discovery.select({ rdns: PREFERRED_WALLET_RDNS });
    expect(preferred.request).not.toHaveBeenCalled();
    expect(alternate.request).not.toHaveBeenCalled();
    discovery.dispose();
    expect(() => discovery.select({ uuid: uuid(1) })).toThrow('closed');
  });

  it('updates subscribers for late wallets and removes its listener', () => {
    const target = new EventTarget();
    const discovery = discover(target);
    const changed = vi.fn();
    const stop = discovery.subscribe(changed);
    const provider = new MockProvider();
    announce(target, provider);
    announce(target, provider);
    expect(changed).toHaveBeenCalledTimes(1);
    announce(target, new MockProvider());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(discovery.list()).toHaveLength(1);
    stop();
    announce(target, provider, 2);
    expect(changed).toHaveBeenCalledTimes(1);
    discovery.dispose();
    announce(target, provider, 3);
    expect(discovery.list()).toHaveLength(0);
    expect(() => discovery.refresh()).toThrow('closed');
  });

  it('requires explicit legacy selection and never falls back from an absent RDNS', async () => {
    const legacy = new MockProvider();
    const discovery = discover(
      Object.assign(new EventTarget(), { ethereum: legacy }),
    );
    expect(() => discovery.select({ rdns: PREFERRED_WALLET_RDNS })).toThrow(
      'unavailable',
    );
    expect(legacy.request).not.toHaveBeenCalled();
    await discovery.select({ legacy: true }).connect();
    expect(legacy.request).toHaveBeenCalledWith({
      method: 'eth_requestAccounts',
    });
  });

  it('rejects ambiguous RDNS while mipd keeps the first announcement for a UUID', () => {
    const target = new EventTarget();
    const discovery = discover(target);
    const first = new MockProvider();
    announce(target, first, 1);
    announce(target, new MockProvider(), 2);
    expect(() => discovery.select({ rdns: PREFERRED_WALLET_RDNS })).toThrow(
      'ambiguous',
    );
    expect(discovery.select({ uuid: uuid(2) })).toBeInstanceOf(WalletSession);
    announce(target, new MockProvider(), 1);
    expect(discovery.list()).toHaveLength(2);
    expect(discovery.select({ uuid: uuid(1) })).toBeInstanceOf(WalletSession);
    expect(first.request).not.toHaveBeenCalled();
  });

  it('lists every announcement and checks provider capabilities only on selection', () => {
    const target = new EventTarget();
    const discovery = discover(target);
    announce(target, new MockProvider(), 1);
    announce(
      target,
      { request: vi.fn() } as unknown as MockProvider,
      2,
      'wallet.two',
    );
    expect(discovery.list().map((wallet) => wallet.name)).toEqual([
      'Wallet 1',
      'Wallet 2',
    ]);
    expect(() => discovery.select({ uuid: uuid(2) })).toThrow(
      'required provider events',
    );
  });
});

describe('native wallet session (unit)', () => {
  it('requires explicit connection and checks account/chain for every zero-ETH transaction', async () => {
    const p = new MockProvider();
    const session = new WalletSession(p);
    await expect(session.sendBatch([tx])).rejects.toThrow('Connect');
    expect(p.request).not.toHaveBeenCalled();
    expect(await session.connect()).toBe(account);
    expect(session.account).toBe(account);
    p.request.mockClear();
    expect(await session.sendBatch([tx, tx])).toEqual([hash(1), hash(2)]);
    expect(p.sends).toBe(2);
    expect(p.request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [
        { ...tx, from: account, value: '0x0', chainId: SEPOLIA_CHAIN_ID },
      ],
    });
  });

  it('stops on rejection and preserves hashes and the provider error', async () => {
    const p = new MockProvider();
    const rejection = Object.assign(new Error('User rejected request'), {
      code: 4001,
    });
    p.onSend = (n) => {
      if (n === 2) throw rejection;
      return hash(n);
    };
    const session = new WalletSession(p);
    await session.connect();
    const result = await session
      .sendBatch([tx, tx, tx])
      .catch((error) => error);
    expect(result).toBeInstanceOf(WalletBatchError);
    expect(result.hashes).toEqual([hash(1)]);
    expect(result.message).toMatch(/reject/i);
    expect(p.sends).toBe(2);
  });

  it.each(['accountsChanged', 'chainChanged', 'disconnect'])(
    'stops after %s, retaining a hash returned during the change',
    async (event) => {
      const p = new MockProvider();
      const session = new WalletSession(p);
      await session.connect();
      p.onSend = (n) => {
        p.emit(event);
        return hash(n);
      };
      await expect(session.sendBatch([tx, tx])).rejects.toMatchObject({
        hashes: [hash(1)],
      });
      expect(p.sends).toBe(1);
      await expect(session.sendBatch([tx])).rejects.toThrow('changed');
      expect(p.sends).toBe(1);
    },
  );

  it('rejects a silent account mismatch and account changes during preflight', async () => {
    const p = new MockProvider();
    const session = new WalletSession(p);
    await session.connect();
    p.accounts = [other];
    await expect(session.sendBatch([tx])).rejects.toThrow('account changed');
    expect(p.sends).toBe(0);
    p.accounts = [account];
    await session.connect();
    p.onRead = (method) => {
      if (method === 'eth_chainId') p.emit('accountsChanged', [other]);
    };
    await expect(session.sendBatch([tx])).rejects.toThrow('changed');
    expect(p.sends).toBe(0);
  });

  it('rejects the wrong chain without switching automatically and accepts an explicit switch', async () => {
    const p = new MockProvider();
    p.chain = '0x1';
    const session = new WalletSession(p);
    await session.connect();
    await expect(session.sendBatch([tx])).rejects.toThrow('Sepolia');
    expect(
      p.request.mock.calls.some(
        ([r]) => r.method === 'wallet_switchEthereumChain',
      ),
    ).toBe(false);
    await session.switchToSepolia();
    expect(await session.sendBatch([tx])).toEqual([hash(1)]);
  });

  it.each([
    { ...tx, from: other },
    { ...tx, value: '0x1' },
    { ...tx, value: '1' },
    { ...tx, to: 'bad' },
    { ...tx, data: '0x123' },
    { ...tx, nonce: '0x0' },
  ])(
    'rejects unsafe prepared data before any batch prompt: %j',
    async (invalid) => {
      const p = new MockProvider();
      const session = new WalletSession(p);
      await session.connect();
      await expect(session.sendBatch([tx, invalid])).rejects.toBeInstanceOf(
        WalletBatchError,
      );
      expect(p.sends).toBe(0);
    },
  );

  it('snapshots transaction data, serializes prompts and rejects concurrent batches', async () => {
    const p = new MockProvider();
    const session = new WalletSession(p);
    await session.connect();
    let release!: (value: string) => void;
    p.onSend = (n) =>
      n === 1
        ? new Promise<string>((resolve) => {
            release = resolve;
          })
        : hash(n);
    const pendingTx = { ...tx };
    const running = session.sendBatch([tx, pendingTx]);
    await vi.waitFor(() => expect(p.sends).toBe(1));
    pendingTx.data = '0xffff';
    await expect(session.sendBatch([tx])).rejects.toThrow('in progress');
    expect(p.sends).toBe(1);
    release(hash(1));
    expect(await running).toEqual([hash(1), hash(2)]);
    const sends = p.request.mock.calls.filter(
      ([r]) => r.method === 'eth_sendTransaction',
    );
    expect(sends[1][0].params?.[0]).toMatchObject({ data: '0x1234' });
  });

  it('rejects invalid hashes and cleans up provider listeners on disposal', async () => {
    const p = new MockProvider();
    const session = new WalletSession(p);
    await session.connect();
    p.onSend = () => 'not a hash';
    await expect(session.sendBatch([tx])).rejects.toMatchObject({ hashes: [] });
    session.dispose();
    expect(
      [...p.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
    await expect(session.connect()).rejects.toThrow('closed');
  });
});

describe('native message consent (unit)', () => {
  it('asks personal_sign for the connected account and exact UTF-8 message', async () => {
    const provider = new MockProvider(),
      session = new WalletSession(provider);
    await session.connect();
    await expect(session.signMessage('ProjectTokyo booking')).resolves.toBe(
      `0x${'ab'.repeat(65)}`,
    );
    const encoded = `0x${Array.from(new TextEncoder().encode('ProjectTokyo booking'), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    expect(provider.request).toHaveBeenCalledWith({
      method: 'personal_sign',
      params: [encoded, account],
    });
  });
  it('rejects signing on a changed account or the wrong chain', async () => {
    const provider = new MockProvider(),
      session = new WalletSession(provider);
    await session.connect();
    provider.chain = '0x1';
    await expect(session.signMessage('booking')).rejects.toThrow();
    expect(
      provider.request.mock.calls.some(
        ([arg]) => arg.method === 'personal_sign',
      ),
    ).toBe(false);
  });
});

describe('wallet UI lifecycle', () => {
  it('invalidates stale ownership on account changes and publishes explicit reconnection', async () => {
    const provider = new MockProvider();
    const session = new WalletSession(provider);
    const changed = vi.fn();
    session.subscribe(changed);
    await session.connect();
    expect(changed).toHaveBeenLastCalledWith(account);
    provider.accounts = [other];
    provider.emit('accountsChanged', [other]);
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(session.account).toBeNull();
    await session.connect();
    expect(changed).toHaveBeenLastCalledWith(other);
    await session.disconnect();
    expect(changed).toHaveBeenLastCalledWith(null);
    await expect(session.sendBatch([tx])).rejects.toThrow('closed');
  });
});

describe('funding typed data (provider unit)', () => {
  const funding = () => ({
    domain: {
      name: 'DayAtomicConverter',
      version: '1',
      chainId: '11155111',
      verifyingContract: other,
    },
    types: {
      FundingIntent: [
        { name: 'buyer', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'executor', type: 'address' },
        { name: 'chainId', type: 'uint256' },
      ],
    },
    primaryType: 'FundingIntent',
    message: {
      buyer: account,
      recipient: account,
      executor: other,
      chainId: '11155111',
    },
  });
  it('uses native typed-data consent and rejects a foreign buyer before prompting', async () => {
    const p = new MockProvider();
    const wallet = new WalletSession(p);
    await wallet.connect();
    expect(await wallet.signFunding(funding(), other)).toBe(
      `0x${'ab'.repeat(65)}`,
    );
    expect(
      p.request.mock.calls.some(([r]) => r.method === 'eth_signTypedData_v4'),
    ).toBe(true);
    p.request.mockClear();
    const bad = funding();
    bad.message.buyer = other;
    await expect(wallet.signFunding(bad, other)).rejects.toThrow(
      'selected wallet',
    );
    expect(
      p.request.mock.calls.some(([r]) => r.method === 'eth_signTypedData_v4'),
    ).toBe(false);
    wallet.dispose();
  });
  it('rejects account changes during funding consent and gas above the cap', async () => {
    const p = new MockProvider();
    const wallet = new WalletSession(p);
    await wallet.connect();
    await expect(
      wallet.sendBatch([{ ...tx, gas: '0x1000001' }]),
    ).rejects.toThrow('gas');
    expect(p.sends).toBe(0);
    p.onRead = (method) => {
      if (method === 'eth_signTypedData_v4') {
        p.accounts = [other];
        p.emit('accountsChanged');
      }
    };
    await expect(wallet.signFunding(funding(), other)).rejects.toThrow();
    wallet.dispose();
  });
});
