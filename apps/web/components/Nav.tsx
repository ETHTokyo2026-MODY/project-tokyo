'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { linkTo, useAccount } from '@/lib/demo/account';
import {
  connectWallet,
  disconnectWallet,
  refreshChain,
  switchNetwork,
  useChainStore,
  walletChoices,
  subscribeWalletChoices,
} from '@/lib/chain/store';
import { WalletMenu } from './WalletMenu';
import { money } from '@/lib/demo/format';
import styles from './TransactionDrawer.module.css';

const TABS = [
  { href: '/', label: 'Dashboard' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/profile', label: 'Profile' },
  { href: '/stats', label: 'Stats' },
];
export function Nav() {
  const account = useAccount();
  const { state, wallet, busy, error, progress, hashes, hasWalletSession } =
    useChainStore();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [providers, setProviders] = useState<ReturnType<typeof walletChoices>>(
    [],
  );
  const [choice, setChoice] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const update = () => setProviders(walletChoices());
    const unsubscribe = subscribeWalletChoices(update);
    update();
    return unsubscribe;
  }, []);
  async function act(fn: () => Promise<void>) {
    setWaiting(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Wallet request failed');
    } finally {
      setWaiting(false);
    }
  }
  const selected = choice || providers[0]?.uuid || '';
  const personas = Object.entries(state?.accounts ?? {}).filter(([id]) => id);
  const viewingAnother = Boolean(account && account !== wallet);
  function choosePersona(next: string) {
    const query = new URLSearchParams(searchParams.toString());
    if (next === wallet) query.delete('account');
    else query.set('account', next);
    router.push(`${pathname}${query.size ? `?${query}` : ''}`, {
      scroll: false,
    });
  }
  return (
    <>
      <nav id="nav" aria-label="Main">
        <span className="brand">
          DayTrader
          <small>Sepolia · test USDC</small>
        </span>
        <div className="nav-links">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              className={pathname === tab.href ? 'tab on' : 'tab'}
              href={linkTo(tab.href, {}, account)}
              aria-current={pathname === tab.href ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </div>
        <label className="who" htmlFor="persona">
          Viewing as
          <select
            id="persona"
            value={account}
            onChange={(event) => choosePersona(event.target.value)}
            disabled={!personas.length}
          >
            {!account ? <option value="">Choose a persona</option> : null}
            {personas.map(([id, persona]) => (
              <option key={id} value={id}>
                {persona.role} · {persona.name}
                {id === wallet ? ' (your wallet)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || waiting}
          onClick={() => void act(refreshChain)}
          aria-label="Refresh data"
        >
          Refresh
        </button>
        <WalletMenu
          account={wallet}
          hasSession={Boolean(hasWalletSession)}
          balance={
            state?.accounts[wallet]
              ? money(state.accounts[wallet].cash)
              : undefined
          }
          providers={providers}
          selected={selected}
          busy={waiting || busy}
          onSelect={setChoice}
          onConnect={() =>
            void act(() =>
              connectWallet(
                selected === 'legacy' ? { legacy: true } : { uuid: selected },
              ),
            )
          }
          onSwitch={() => void act(switchNetwork)}
          onDisconnect={() => void act(disconnectWallet)}
        />
      </nav>
      {viewingAnother ? (
        <div
          className="page"
          role="status"
          style={{ paddingTop: 8, paddingBottom: 8 }}
        >
          Viewing public account activity. Connect that account’s wallet to
          trade or manage assets.
        </div>
      ) : null}
      {progress || message || error ? (
        <div className="page" style={{ paddingTop: 8, paddingBottom: 8 }}>
          {progress ? <div role="status">{progress}</div> : null}
          {message || error ? (
            <div className="err" role="alert">
              {message || error}
            </div>
          ) : null}
        </div>
      ) : null}
      {hashes.length ? (
        <details className={styles.drawer}>
          <summary>Transactions ({hashes.length})</summary>
          <ol className={styles.list}>
            {hashes.map((hash, i) => (
              <li key={`${hash}:${i}`}>
                <a
                  href={`https://eth-sepolia.blockscout.com/tx/${hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View transaction ${hash} on Blockscout`}
                  title={hash}
                >
                  {`${hash.slice(0, 10)}…${hash.slice(-8)}`}
                </a>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}
