# Project Tokyo

Hosts presell future room-nights and get paid now. Traders buy those nights and set the public rental price.

## Status

Early demo. The web app shows sample data.

## Develop

Node 20 (`.nvmrc`).

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

Changes go through PRs only. See `AGENTS.md` and the PR template. Squash merged through the merge queue once the `checks`, `pr-format` and `secrets` checks pass.

## Plan

See [`docs/PLAN.md`](docs/PLAN.md).

## License

MIT. See [`LICENSE`](LICENSE).

## Rental settlement contracts

`contracts/` contains the standalone ERC-1155/Aqua settlement package; it is not wired into the web app. See [contract setup and tests](contracts/README.md), [order semantics](contracts/SPEC.md), and [Sepolia addresses](contracts/deployments/sepolia.json).

Reused code: [1inch Aqua](https://github.com/1inch/aqua), [1inch SwapVM](https://github.com/1inch/swap-vm), [1inch solidity-utils](https://github.com/1inch/solidity-utils), [OpenZeppelin](https://github.com/OpenZeppelin/openzeppelin-contracts), and [forge-std](https://github.com/foundry-rs/forge-std). Exact revisions are pinned in `contracts/scripts/bootstrap.sh`.

**Powered by SwapVM — © Degensoft Ltd 2025.** The SwapVM adaptation uses [its upstream license](contracts/LICENSES/SwapVM-1.1.txt); the root MIT license does not replace that license.
