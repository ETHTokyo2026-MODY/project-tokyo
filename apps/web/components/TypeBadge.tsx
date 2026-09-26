import type { AssetType } from '@/lib/demo/types';

function typeClass(type: AssetType): string {
  if (type === 'airbnb') return 'type airbnb';
  if (type === 'hotel room') return 'type hotel';
  return 'type';
}

export function TypeBadge({ type }: { type: AssetType }) {
  return <span className={typeClass(type)}>{type}</span>;
}
