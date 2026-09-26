'use client';

import { useEffect, useRef, useState } from 'react';
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
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState('');
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
      onToggle={() => setCopied('')}
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
          : 'Connect wallet'}
        <span className={styles.chevron} aria-hidden="true">
          ⌄
        </span>
      </summary>
      <section className={styles.panel} aria-label="Wallet connection">
        <strong>
          {props.account ? 'Connected wallet' : 'Wallet connection'}
        </strong>
        <p className={styles.status}>
          {props.account
            ? 'Sepolia · test network'
            : 'Browse freely. Connect to trade or manage assets.'}
        </p>
        {props.account ? (
          <>
            <p className={styles.address}>{props.account}</p>
            {props.balance !== undefined ? (
              <p className={styles.balance}>{props.balance} USDC</p>
            ) : null}
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
        {props.hasSession && !props.account ? (
          <p className={styles.status}>
            Reconnect your wallet or switch to Sepolia to sign transactions.
          </p>
        ) : null}
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
          className={styles.connect}
          type="button"
          disabled={!props.selected || props.busy}
          onClick={props.onConnect}
        >
          {props.account ? 'Reconnect' : 'Connect wallet'}
        </button>
        {props.hasSession ? (
          <div className={styles.session}>
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onSwitch}
            >
              Switch to Sepolia
            </button>
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
