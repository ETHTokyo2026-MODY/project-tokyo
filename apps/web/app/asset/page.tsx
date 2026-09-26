'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { DiscountsEditor } from '@/components/calendar/DiscountsEditor';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { useDemo } from '@/lib/demo/store';

function Loading() {
  return (
    <main className="page">
      <h1>Asset</h1>
      <div className="muted">Loading demo…</div>
    </main>
  );
}

function AssetInner() {
  const { ready, state, dispatch } = useDemo();
  const account = useAccount();
  const id = useSearchParams().get('asset');
  const asset = id && state ? state.assets.find((a) => a.id === id) : undefined;
  const who = asset ? state!.accounts[asset.provider] : undefined;

  useEffect(() => {
    document.title = asset
      ? `${asset.title} · Asset · Project Tokyo (demo)`
      : 'Asset · Project Tokyo (demo)';
  }, [asset]);

  if (!ready || !state) return <Loading />;
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
        <a href={linkTo('/', {}, account)}>Dashboard</a> ›
      </div>
      <h1>
        {asset.title} <TypeBadge type={asset.type} />
      </h1>
      <div className="muted">
        Provided by {who.name} · {asset.location}
      </div>
      <p>
        <a href={cal}>Open calendar →</a>
      </p>
      <div className="card" style={{ maxWidth: 420, marginTop: 8 }}>
        <DiscountsEditor
          key={`${asset.id}:${account}`}
          asset={asset}
          account={account}
          busy={false}
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
