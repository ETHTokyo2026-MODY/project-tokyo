export const CHAIN_ID = 11155111;
export const DEFAULT_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
export const PARENT_LABEL = 'projecttokyo';
export const PARENT_NAME = 'projecttokyo.eth';
export const LOG_CHUNK = BigInt(45_000);
export const DAY_CHUNK = 73;
export const HORIZON = 365;
export const TEST_ASSET_PREFIX = 'testasset';
export const LABEL_REGISTERED_TOPIC =
  '0x2fe093918572373e9f1f0368f414dffd0043a74ae8c9fd7b0e390b26a0d20b6e' as const;

export const ENS = {
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  rootRegistry: '0x9703DBD26dAB89504490994138cF2c575251a9cE',
  ethRegistry: '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E',
  ethRegistrar: '0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca',
  verifiableFactory: '0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C',
  userRegistryImpl: '0xA80338aAA8D23831cEa25E858D1774534aBb0263',
  permissionedResolverImpl: '0x14F09Fd05d4585759e54844DC9B00147131Cf243',
  mockUsdc: '0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  parentOwner: '0x92f6055f1a631E3C5fd3100920c63d8654729847',
  parentResolver: '0x9b54937F615458D93bA4BDc1E881109301DAaBd4',
  parentTokenId: BigInt(
    '1539694647528357085717297762044227324969906285209016262484180021492479688704',
  ),
} as const;

export type Address = `0x${string}`;
