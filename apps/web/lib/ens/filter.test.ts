import { describe, expect, it } from 'vitest';
import { filterLabels, isTestAsset } from './filter';
import { parseCaip19 } from './lookup';

describe('ens list filter', () => {
  it('hides testasset labels unless includeTest is set', () => {
    const labels = ['tesla-model-3', 'testasset12345', 'cabin'];
    expect(filterLabels(labels)).toEqual(['tesla-model-3', 'cabin']);
    expect(filterLabels(labels, true)).toEqual(labels);
    expect(isTestAsset('testasset00000')).toBe(true);
    expect(isTestAsset('tesla-model-3')).toBe(false);
  });

  it('parses CAIP-19 day tokens', () => {
    const token =
      'eip155:11155111/erc20:0x3ec8e7d506fd74a25a445e234b1eafcf67cbb5eb';
    expect(parseCaip19(token)).toEqual({
      chainId: 11155111,
      contract: '0x3ec8e7d506fd74a25a445e234b1eafcf67cbb5eb',
    });
    expect(parseCaip19('eip155:1/erc1155:0xabc/1')).toBeNull();
  });
});
