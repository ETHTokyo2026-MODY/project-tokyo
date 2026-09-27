import { createStore } from 'mipd';
import {
  connect,
  createConfig,
  disconnect as disconnectConnector,
  getWalletClient,
  http,
  injected,
  switchChain,
} from '@wagmi/core';
import { type Address, type EIP1193Provider, type Hex } from 'viem';
import { sepolia } from 'viem/chains';

// Native provider interfaces: https://eips.ethereum.org/EIPS/eip-1193
// Discovery: https://eips.ethereum.org/EIPS/eip-6963
export const SEPOLIA_CHAIN_ID = '0xaa36a7';
export const PREFERRED_WALLET_RDNS = 'org.uniswap.app';

type Listener = (...args: unknown[]) => void;
export type WalletProvider = {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
};
export type WalletChoice = { uuid: string; name: string; rdns: string };
export type WalletSelection =
  { uuid: string } | { rdns: string } | { legacy: true };
export type PreparedTransaction = {
  to: string;
  data: string;
  from?: string;
  value?: string;
  gas?: string;
};
export type FundingTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: string | number;
    verifyingContract: string;
  };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, string>;
};
type WalletWindow = EventTarget & { ethereum?: unknown };

function isProvider(value: unknown): value is WalletProvider {
  if (!value || typeof value !== 'object') return false;
  const p = value as WalletProvider;
  return (
    typeof p.request === 'function' &&
    typeof p.on === 'function' &&
    typeof p.removeListener === 'function'
  );
}

function address(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new Error('Invalid wallet or transaction address');
  }
  return value.toLowerCase();
}

function firstAccount(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Connect an account in the selected wallet');
  return address(value[0]);
}

function assertSepolia(chain: unknown): void {
  if (
    typeof chain !== 'string' ||
    !/^0x[0-9a-f]+$/i.test(chain) ||
    BigInt(chain) !== BigInt(SEPOLIA_CHAIN_ID)
  ) {
    throw new Error(
      'Select the DayTrader test network in the wallet before sending',
    );
  }
}

/** A submitted hash survives rejection or wallet changes later in the batch. */
export class WalletBatchError extends Error {
  readonly hashes: string[];
  readonly cause: unknown;

  constructor(cause: unknown, hashes: string[]) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Wallet transaction request failed',
    );
    this.name = 'WalletBatchError';
    this.hashes = [...hashes];
    this.cause = cause;
  }
}

/** Call connect, switch and sendBatch only from an explicit user action in the UI. */
export class WalletSession {
  private selectedAccount: string | null = null;
  private changed = false;
  private revision = 0;
  private busy = false;
  private disposed = false;
  private readonly subscribers = new Set<(account: string | null) => void>();
  private readonly notify = () => {
    for (const listener of this.subscribers) listener(this.account);
  };
  private readonly onChange = () => {
    this.changed = true;
    this.revision++;
    this.notify();
  };

  private readonly connectorListeners = new Map<string, Set<Listener>>();
  private readonly config;

  constructor(private readonly provider: WalletProvider) {
    // Wagmi owns connector lifecycle; track its listeners so a replaced session
    // cannot remain attached to a wallet or prompt again after disposal.
    const scoped = {
      request: (request: Parameters<WalletProvider['request']>[0]) => {
        if (
          request.method === 'eth_sendTransaction' ||
          request.method === 'wallet_sendTransaction'
        ) {
          this.assertUnchanged();
          const transaction = request.params?.[0] as Record<string, unknown>;
          return provider.request({
            ...request,
            params: [{ ...transaction, chainId: SEPOLIA_CHAIN_ID }],
          });
        }
        return provider.request(request);
      },
      on: (event: string, listener: Listener) => {
        if (this.disposed) return;
        const listeners =
          this.connectorListeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        this.connectorListeners.set(event, listeners);
        provider.on(event, listener);
      },
      removeListener: (event: string, listener: Listener) => {
        this.connectorListeners.get(event)?.delete(listener);
        provider.removeListener(event, listener);
      },
    } as unknown as EIP1193Provider;
    this.config = createConfig({
      chains: [sepolia],
      connectors: [
        injected({
          shimDisconnect: false,
          target: {
            id: 'selected-wallet',
            name: 'Selected wallet',
            provider: scoped,
          },
        }),
      ],
      transports: { [sepolia.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: null,
    });
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect'])
      provider.on(event, this.onChange);
  }

  get account(): string | null {
    return this.changed || this.disposed ? null : this.selectedAccount;
  }

  /** UI consumers clear stale ownership controls immediately when this emits null. */
  subscribe(listener: (account: string | null) => void): () => void {
    this.assertOpen();
    this.subscribers.add(listener);
    listener(this.account);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Explicit UI disconnect; disposal alone never requests wallet permission changes. */
  async disconnect(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await disconnectConnector(this.config, {
          connector: this.config.connectors[0],
        });
      } finally {
        this.dispose();
      }
    });
  }

  /** Requests native account consent. It neither switches chains nor submits transactions. */
  async connect(): Promise<string> {
    return this.exclusive(async () => {
      // Reconnecting is explicit, including after an account/network change.
      this.config.setState((state) => ({
        ...state,
        current: null,
        connections: new Map(),
        status: 'disconnected',
      }));
      const connected = await connect(this.config, {
        connector: this.config.connectors[0],
      });
      const selected = firstAccount(connected.accounts);
      const revision = this.revision;
      const current = firstAccount(
        await this.provider.request({ method: 'eth_accounts' }),
      );
      if (revision !== this.revision || current !== selected)
        throw new Error('Wallet account changed while connecting');
      this.assertOpen();
      this.selectedAccount = selected;
      this.changed = false;
      this.notify();
      return selected;
    });
  }

  /** Verify the connected account and network before a server action. */
  async verifySession(): Promise<void> {
    await this.exclusive(() => this.assertReady());
  }

  /** Explicit native network consent; never called automatically from sendBatch. */
  async switchToSepolia(): Promise<void> {
    return this.exclusive(async () => {
      await switchChain(this.config, {
        connector: this.config.connectors[0],
        chainId: sepolia.id,
      });
      const revision = this.revision;
      assertSepolia(await this.provider.request({ method: 'eth_chainId' }));
      if (this.selectedAccount) {
        const current = firstAccount(
          await this.provider.request({ method: 'eth_accounts' }),
        );
        if (current !== this.selectedAccount)
          throw new Error('Wallet account changed; connect again');
      }
      this.assertOpen();
      if (revision !== this.revision)
        throw new Error('Wallet changed while switching networks');
      this.changed = false;
      this.notify();
    });
  }

  /** Each request goes through the extension. Hashes mean submission, not confirmed execution. */
  async sendBatch(
    transactions: readonly PreparedTransaction[],
  ): Promise<string[]> {
    const hashes: string[] = [];
    try {
      return await this.exclusive(async () => {
        if (!this.selectedAccount)
          throw new Error('Connect the selected wallet first');
        if (!Array.isArray(transactions) || transactions.length === 0)
          throw new Error('No transactions to send');
        // Snapshot and validate the whole batch before requesting the first signature.
        const prepared = transactions.map((tx) => this.prepare(tx));
        for (const tx of prepared) {
          await this.assertReady();
          const client = await getWalletClient(this.config, {
            connector: this.config.connectors[0],
            account: this.selectedAccount as Address,
            chainId: sepolia.id,
          });
          await this.assertReady();
          const hash = await client.sendTransaction({
            account: this.selectedAccount as Address,
            chain: sepolia,
            to: tx.to as Address,
            data: tx.data as Hex,
            value: BigInt(0),
            ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
          });
          if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash))
            throw new Error('Wallet returned an invalid transaction hash');
          hashes.push(hash);
          this.assertUnchanged();
        }
        return hashes;
      });
    } catch (error) {
      throw new WalletBatchError(error, hashes);
    }
  }

  /** Request native consent to a readable message; the caller must supply the exact domain-bound text. */
  async signMessage(message: string): Promise<string> {
    return this.exclusive(async () => {
      if (!this.selectedAccount)
        throw new Error('Connect the selected wallet first');
      if (typeof message !== 'string' || !message.length)
        throw new Error('Message required');
      await this.assertReady();
      const client = await getWalletClient(this.config, {
        connector: this.config.connectors[0],
        account: this.selectedAccount as Address,
        chainId: sepolia.id,
      });
      await this.assertReady();
      const signature = await client.signMessage({
        account: this.selectedAccount as Address,
        message,
      });
      await this.assertReady();
      if (
        typeof signature !== 'string' ||
        !/^0x[0-9a-f]{130}$/i.test(signature)
      )
        throw new Error('Wallet returned an invalid message signature');
      return signature;
    });
  }

  /** Native EIP-712 consent for this buyer and the configured conversion contract. */
  async signFunding(
    input: FundingTypedData,
    converter: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      const data = structuredClone(input);
      await this.assertReady();
      if (
        data.domain.name !== 'DayAtomicConverter' ||
        data.domain.version !== '1' ||
        BigInt(data.domain.chainId) !== BigInt(SEPOLIA_CHAIN_ID) ||
        address(data.domain.verifyingContract) !== address(converter) ||
        data.primaryType !== 'FundingIntent' ||
        address(data.message.buyer) !== this.selectedAccount ||
        address(data.message.recipient) !== this.selectedAccount ||
        address(data.message.executor) !== address(converter) ||
        BigInt(data.message.chainId) !== BigInt(SEPOLIA_CHAIN_ID)
      )
        throw new Error(
          'Funding signature differs from selected wallet or deployment',
        );
      const client = await getWalletClient(this.config, {
        connector: this.config.connectors[0],
        account: this.selectedAccount as Address,
        chainId: sepolia.id,
      });
      await this.assertReady();
      const signature = await client.signTypedData({
        ...data,
        domain: {
          ...data.domain,
          chainId: sepolia.id,
          verifyingContract: converter as Address,
        },
        account: this.selectedAccount as Address,
      });
      await this.assertReady();
      if (!/^0x[0-9a-f]{130}$/i.test(signature))
        throw new Error('Wallet returned an invalid funding signature');
      return signature;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.onChange();
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect'])
      this.provider.removeListener(event, this.onChange);
    for (const [event, listeners] of this.connectorListeners)
      for (const listener of listeners)
        this.provider.removeListener(event, listener);
    this.connectorListeners.clear();
    this.subscribers.clear();
  }

  private prepare(
    tx: PreparedTransaction,
  ): PreparedTransaction & { chainId: string } {
    if (
      !tx ||
      typeof tx !== 'object' ||
      Object.keys(tx).some(
        (key) => !['to', 'data', 'from', 'value', 'gas'].includes(key),
      )
    ) {
      throw new Error('Unsupported prepared transaction');
    }
    if (tx.from !== undefined && address(tx.from) !== this.selectedAccount)
      throw new Error('Prepared transaction is for a different account');
    if (typeof tx.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data))
      throw new Error('Invalid transaction data');
    if (tx.value !== undefined && !/^0x0$/i.test(tx.value))
      throw new Error('This action cannot send ETH');
    if (
      tx.gas !== undefined &&
      (!/^0x[0-9a-f]+$/i.test(tx.gas) ||
        BigInt(tx.gas) < BigInt(21000) ||
        BigInt(tx.gas) > BigInt(16777216))
    )
      throw new Error('Prepared gas exceeds transaction budget');
    return {
      ...(tx.gas ? { gas: tx.gas } : {}),
      from: this.selectedAccount!,
      to: address(tx.to),
      data: tx.data,
      value: '0x0',
      chainId: SEPOLIA_CHAIN_ID,
    };
  }

  private async assertReady(): Promise<void> {
    this.assertUnchanged();
    const revision = this.revision;
    const current = firstAccount(
      await this.provider.request({ method: 'eth_accounts' }),
    );
    assertSepolia(await this.provider.request({ method: 'eth_chainId' }));
    if (current !== this.selectedAccount) {
      this.onChange();
      throw new Error('Wallet account changed; connect again');
    }
    if (revision !== this.revision) this.changed = true;
    this.assertUnchanged();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Wallet session closed');
  }

  private assertUnchanged(): void {
    this.assertOpen();
    if (this.changed)
      throw new Error(
        'Wallet account or network changed; reconnect or switch network again',
      );
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.busy) throw new Error('A wallet request is already in progress');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
}

/** mipd owns EIP-6963 discovery and deduplication for this page. */
export function createWalletDiscovery() {
  const target = window as WalletWindow;
  const store = createStore();
  let disposed = false;
  const refresh = () => {
    if (disposed) throw new Error('Wallet discovery closed');
    target.dispatchEvent(new Event('eip6963:requestProvider'));
  };
  return {
    // RDNS is a self-attested label, not proof of an extension's authenticity.
    list(): WalletChoice[] {
      return store
        .getProviders()
        .map(({ info }) => ({
          uuid: info.uuid,
          name: info.name,
          rdns: info.rdns,
        }))
        .sort(
          (a, b) =>
            Number(b.rdns === PREFERRED_WALLET_RDNS) -
            Number(a.rdns === PREFERRED_WALLET_RDNS),
        );
    },
    select(selection: WalletSelection): WalletSession {
      if (disposed) throw new Error('Wallet discovery closed');
      if ('legacy' in selection && selection.legacy === true) {
        if (!isProvider(target.ethereum))
          throw new Error('Legacy injected wallet is unavailable');
        return new WalletSession(target.ethereum);
      }
      const matches = store
        .getProviders()
        .filter(({ info }) =>
          'uuid' in selection
            ? info.uuid === selection.uuid
            : 'rdns' in selection && info.rdns === selection.rdns,
        );
      if (matches.length !== 1)
        throw new Error(
          matches.length
            ? 'Wallet selection is ambiguous'
            : 'Selected wallet is unavailable',
        );
      if (!isProvider(matches[0].provider))
        throw new Error(
          'Selected wallet does not support required provider events',
        );
      return new WalletSession(matches[0].provider);
    },
    refresh,
    subscribe(listener: () => void) {
      if (disposed) throw new Error('Wallet discovery closed');
      return store.subscribe(listener);
    },
    dispose() {
      disposed = true;
      store.destroy();
    },
  };
}
