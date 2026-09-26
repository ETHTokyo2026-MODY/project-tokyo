# Night Market

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
