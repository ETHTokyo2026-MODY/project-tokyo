import { TEST_ASSET_PREFIX } from './constants';

export function isTestAsset(label: string): boolean {
  return label.startsWith(TEST_ASSET_PREFIX);
}

export function filterAssets<T extends { label: string }>(
  items: T[],
  includeTest = false,
): T[] {
  if (includeTest) return items;
  return items.filter((item) => !isTestAsset(item.label));
}

export function filterLabels(labels: string[], includeTest = false): string[] {
  if (includeTest) return labels;
  return labels.filter((label) => !isTestAsset(label));
}
