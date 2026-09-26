const EXPLORER = 'https://eth-sepolia.blockscout.com';
const ENS_APP = 'https://app.ens.domains';

export function ensExplorerUrl(name: string) {
  return `https://sepolia.etherscan.io/enslookup-search?search=${encodeURIComponent(name)}`;
}

export function ensAppUrl(name: string) {
  return `${ENS_APP}/${encodeURIComponent(name)}`;
}

export function addressExplorerUrl(address: string) {
  return `${EXPLORER}/address/${address}`;
}

export function EnsName({
  name,
  address,
}: {
  name?: string;
  address?: string;
}) {
  if (!name) return null;
  return (
    <span className="muted">
      <a href={ensAppUrl(name)} target="_blank" rel="noreferrer">
        {name}
      </a>
      {' · '}
      <a href={ensExplorerUrl(name)} target="_blank" rel="noreferrer">
        Etherscan
      </a>
      {address ? (
        <>
          {' · '}
          <a
            href={addressExplorerUrl(address)}
            target="_blank"
            rel="noreferrer"
          >
            contract
          </a>
        </>
      ) : null}
    </span>
  );
}
