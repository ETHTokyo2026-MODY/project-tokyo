# ProjectTokyo

Hosts presell future room-nights and get paid now. Traders buy those nights and set the public rental price.

## Status

The ERC-20 demo connects the host calendar and trader bids to a local backend.
Each physical asset has a fixed 365-day JST calendar. Each materialized day is
an indivisible ERC-20 with supply one. Official Aqua settles both USDC and day
tokens; a permissionless taker executes compatible onchain publications.

The optional booking webhook simulates a trusted external host adapter. Booking
reports do not create funded revenue payouts. See the backend setup below for
live mode; the public deployment is updated separately.

Live demo: https://project-tokyo-rbt7w.ondigitalocean.app

## Develop

Node 22 (`.nvmrc`).

```
npm ci
npm run dev -w web
```

Checks:

```
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Contributing

Changes go through PRs only. See `AGENTS.md` and the PR template. PRs are squash-only merged directly with 0 approvals, a linear history, and all review comment threads resolved before merging. Tests run on `main` after each merge; PRs only get a PR-format check. Checks never block merging.

## Plan

See [`docs/PLAN.md`](docs/PLAN.md).

## License

MIT. See [`LICENSE`](LICENSE).

## Rental settlement contracts

`contracts/` contains day ownership, booking-price curves and the Aqua settlement
application. See [contract setup and tests](contracts/README.md).

Reused code: [1inch Aqua](https://github.com/1inch/aqua), [1inch SwapVM](https://github.com/1inch/swap-vm), [1inch solidity-utils](https://github.com/1inch/solidity-utils), [OpenZeppelin](https://github.com/OpenZeppelin/openzeppelin-contracts), and [forge-std](https://github.com/foundry-rs/forge-std). Exact revisions are pinned in `contracts/scripts/bootstrap.sh`.

**Powered by SwapVM — © Degensoft Ltd 2025.** The SwapVM adaptation uses [its upstream license](contracts/LICENSES/SwapVM-1.1.txt); the root MIT license does not replace that license.

## Order backend

[`apps/backend`](apps/backend/README.md) rebuilds calendars and orders from
canonical chain events, prepares unsigned wallet transactions, and runs a minimal
open taker. The frontend uses [Wagmi Core](https://wagmi.sh/core) and [viem](https://viem.sh/)
for wallet connections and signing. The backend uses viem and Node SQLite for a rebuildable
index and durable transaction recovery. The HTTP integration test creates,
lists and purchases an asset through the same interface used by the website.
