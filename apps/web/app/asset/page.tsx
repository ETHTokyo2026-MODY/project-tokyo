'use client';

import Link from 'next/link';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { normalizeAssetId } from '@/lib/chain/model';
import { DiscountsEditor } from '@/components/calendar/DiscountsEditor';
import { EnsName } from '@/components/EnsName';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { useChainStore } from '@/lib/chain/store';

function Loading() {
  return (
    <main className="page">
      <h1>Asset</h1>
      <div className="muted">Loading…</div>
    </main>
  );
}

function AssetInner() {
  const { ready, state, dispatch, busy } = useChainStore();
  const account = useAccount();
  const id = normalizeAssetId(useSearchParams().get('asset') ?? '');
  const asset = id && state ? state.assets.find((a) => a.id === id) : undefined;
  const who = asset ? state!.accounts[asset.provider] : undefined;

  useEffect(() => {
    document.title = asset
      ? `${asset.title} · Asset · DayTrader`
      : 'Asset · DayTrader';
  }, [asset]);

  if (!state) return <Loading />;
  if (!asset || !who) {
    return (
      <main className="page">
        <h1>{id ? 'Unknown asset' : 'Asset'}</h1>
        <div className="muted">
          Pick an asset from the dashboard or calendar.
        </div>
      </main>
    );
  }

  const cal = linkTo('/calendar', { asset: asset.id }, account);
  return (
    <main className="page">
      <div className="crumbs">
        <Link href={linkTo('/', {}, account)}>Dashboard</Link> ›
      </div>
      <h1>
        {asset.title} <TypeBadge type={asset.type} />
      </h1>
      <div className="muted">
        Provided by {who.name} · {asset.location}
        {asset.ensName ? (
          <>
            {' · '}
            <EnsName name={asset.ensName} address={asset.id} />
          </>
        ) : null}
      </div>
      <p>
        <Link href={cal}>Open calendar →</Link>
      </p>
      <div className="card" style={{ maxWidth: 420, marginTop: 8 }}>
        <DiscountsEditor
          key={`${asset.id}:${account}`}
          asset={asset}
          account={account}
          busy={busy}
          onAct={(name, body) =>
            dispatch(name, { asset: asset.id, account, ...body })
          }
        />
      </div>
    </main>
  );
}

export default function AssetPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AssetInner />
    </Suspense>
  );
}
