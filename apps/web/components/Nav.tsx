'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { linkTo, useAccount } from '@/lib/demo/account';
import {
  connectWallet,
  disconnectWallet,
  refreshChain,
  switchNetwork,
  useChainStore,
  walletChoices,
} from '@/lib/chain/store';
import { WalletMenu } from './WalletMenu';
import { money } from '@/lib/demo/format';

const TABS = [
  { href: '/', label: 'Dashboard' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/profile', label: 'Profile' },
  { href: '/stats', label: 'Stats' },
];
export function Nav() {
  const account = useAccount();
  const { state, busy, error, progress, hashes, hasWalletSession } =
    useChainStore();
  const pathname = usePathname();
  const [providers, setProviders] = useState<ReturnType<typeof walletChoices>>(
    [],
  );
  const [choice, setChoice] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const update = () => setProviders(walletChoices());
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
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
  return (
    <>
      <nav id="nav" aria-label="Main">
        <span className="brand">
          ProjectTokyo
          <small>Sepolia · test USDC</small>
        </span>
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
        <WalletMenu
          account={account}
          hasSession={Boolean(hasWalletSession)}
          balance={
            state?.accounts[account]
              ? money(state.accounts[account].cash)
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
      <div className="page" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <div className="row">
          <span>
            {account
              ? `${account} · ${money(state?.accounts[account]?.cash ?? 0)} USDC`
              : 'Connect a wallet to create assets or publish orders.'}
          </span>
          <button
            type="button"
            disabled={busy || waiting}
            onClick={() => void act(refreshChain)}
          >
            Refresh chain state
          </button>
        </div>
        <div className="note">
          Hosts report external bookings with their wallet. Booking revenue is
          unfunded; these amounts are not payouts.
        </div>
        {progress ? <div role="status">{progress}</div> : null}
        {message || error ? (
          <div className="err" role="alert">
            {message || error}
          </div>
        ) : null}
        {hashes.length ? (
          <details open>
            <summary>Submitted transactions ({hashes.length})</summary>
            {hashes.map((hash, i) => (
              <div key={`${hash}:${i}`}>
                <a
                  href={`https://sepolia.etherscan.io/tx/${hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {hash}
                </a>
              </div>
            ))}
          </details>
        ) : null}
      </div>
    </>
  );
}
