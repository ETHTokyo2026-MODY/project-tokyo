'use client';

import { useEffect, useRef, useState } from 'react';
import {
  generateWallet,
  savedGeneratedWallets,
  selectGeneratedWallet,
  useChainStore,
} from '@/lib/chain/store';
import styles from './WalletMenu.module.css';

type Props = {
  account: string;
  balance?: string;
  hasSession: boolean;
  providers: { uuid: string; name: string; rdns: string }[];
  selected: string;
  busy: boolean;
  onSelect: (value: string) => void;
  onConnect: () => void;
  onSwitch: () => void;
  onDisconnect: () => void;
};

export function WalletMenu(props: Props) {
  const { eth, generated } = useChainStore();
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState('');
  const [saved, setSaved] = useState(() =>
    typeof window === 'undefined' ? [] : savedGeneratedWallets(),
  );
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        root.current?.removeAttribute('open');
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && root.current?.open) {
        root.current.removeAttribute('open');
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  function refreshSaved() {
    setSaved(savedGeneratedWallets());
  }
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(props.account);
      setCopied('Address copied');
    } catch {
      setCopied('Could not copy. Select the address below to copy it.');
    }
  }
  return (
    <details
      className={styles.root}
      ref={root}
      onToggle={() => {
        setCopied('');
        refreshSaved();
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.removeAttribute('open');
        }
      }}
    >
      <summary
        ref={trigger}
        className={styles.trigger}
        aria-label="Wallet connection management"
      >
        <span
          className={props.account ? styles.connected : styles.dot}
          aria-hidden="true"
        />
        {props.account
          ? `${props.account.slice(0, 6)}…${props.account.slice(-4)}`
          : 'Generate wallet'}
        <span className={styles.chevron} aria-hidden="true">
          ⌄
        </span>
      </summary>
      <section className={styles.panel} aria-label="Wallet connection">
        <strong>
          {props.account
            ? generated
              ? 'Generated wallet'
              : 'Connected wallet'
            : 'Demo wallet'}
        </strong>
        <p className={styles.status}>
          {props.account
            ? 'DayTrader testnet · signs in this window'
            : 'Create a fresh wallet in this window. No browser extension required.'}
        </p>
        {props.account ? (
          <>
            <p className={styles.address}>{props.account}</p>
            <p className={styles.balance}>
              {eth ? `${eth} ETH` : 'ETH …'}
              {props.balance !== undefined ? ` · ${props.balance} USDC` : ''}
            </p>
            <div className={styles.actions}>
              <button type="button" onClick={() => void copyAddress()}>
                Copy address
              </button>
              <a
                href={`https://eth-sepolia.blockscout.com/address/${props.account}`}
                target="_blank"
                rel="noreferrer"
              >
                View on explorer ↗
              </a>
            </div>
            <span className={styles.status} role="status">
              {copied}
            </span>
          </>
        ) : null}
        <button
          className={styles.connect}
          type="button"
          disabled={props.busy}
          onClick={() => {
            void generateWallet().then(refreshSaved);
          }}
        >
          {props.account ? 'Generate another wallet' : 'Generate wallet'}
        </button>
        {saved.length ? (
          <label className={styles.provider}>
            Saved wallets
            <select
              aria-label="Saved generated wallets"
              value={generated ? props.account : ''}
              disabled={props.busy}
              onChange={(event) => {
                const next = event.target.value;
                if (!next) return;
                void selectGeneratedWallet(next).then(refreshSaved);
              }}
            >
              <option value="" disabled>
                Use a wallet from this browser
              </option>
              {saved.map((wallet, index) => (
                <option key={wallet.address} value={wallet.address}>
                  {index === 0 ? 'Latest · ' : ''}
                  {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {props.hasSession && !props.account ? (
          <p className={styles.status}>
            Reconnect your wallet or generate a new one to sign transactions.
          </p>
        ) : null}
        <details className={styles.extension}>
          <summary>Use a browser extension</summary>
          <label className={styles.provider}>
            Wallet provider
            <select
              aria-label="Wallet provider"
              value={props.selected}
              disabled={props.busy}
              onChange={(event) => props.onSelect(event.target.value)}
            >
              <option value="" disabled>
                Select extension
              </option>
              {props.providers.map((provider) => (
                <option key={provider.uuid} value={provider.uuid}>
                  {provider.name} ({provider.rdns})
                </option>
              ))}
              <option value="legacy">Injected wallet (legacy)</option>
            </select>
          </label>
          <button
            className={styles.secondary}
            type="button"
            disabled={!props.selected || props.busy}
            onClick={props.onConnect}
          >
            {props.account && !generated ? 'Reconnect' : 'Connect wallet'}
          </button>
          {props.hasSession && !generated ? (
            <div className={styles.session}>
              <button
                type="button"
                disabled={props.busy}
                onClick={props.onSwitch}
              >
                Switch network
              </button>
            </div>
          ) : null}
        </details>
        {props.hasSession ? (
          <div className={styles.session}>
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onDisconnect}
            >
              Disconnect
            </button>
          </div>
        ) : null}
        {props.busy ? (
          <p className={styles.status} role="status">
            Wallet request in progress…
          </p>
        ) : null}
      </section>
    </details>
  );
}
