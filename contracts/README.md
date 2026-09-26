# Item-day contracts

Each physical item has a fixed 365-day Tokyo calendar. Each date has one deterministic ERC-20 address, zero decimals and one raw unit of supply. Ownership survives booking and expiry.

- `src/day`: asset creation, canonical day tokens, ownership, listing, booking and host discounts.
- `src/pricing`: the public booking-price curve and whole-USD rounding.
- `src/market/DaySwapVM.sol`: atomic consecutive-day purchases through official Aqua, using the pinned SwapVM interpreter and full-amount instruction.

See [item and calendar behavior](../docs/item-day.md) and [settlement authorization](../docs/day-settlement.md). The backend consumes these contracts through the [day API and taker](../apps/backend/README.md).

## Build and test

From the repository root:

```sh
bash contracts/scripts/bootstrap.sh
forge test --root contracts
npm run test:integration --workspace=@project-tokyo/backend
```

The bootstrap pins Aqua, SwapVM, Solidity utilities, OpenZeppelin and forge-std to exact revisions. Foundry uses Solidity 0.8.30 with the optimizer, via IR and Cancun. Contract tests and the backend Anvil test execute locally; they do not establish public Sepolia deployment or real-wallet demo completion.

## Attribution and history

Powered by Aqua and SwapVM, © Degensoft Ltd 2025. `DaySwapVM` reuses upstream execution primitives with a rental-day pricing opcode and settlement shell. It is not ABI-compatible with the stock SwapVM router. See the [SwapVM license](LICENSES/SwapVM-1.1.txt) and retained [Aqua license](src/native/LICENSE-Aqua.txt).

The earlier ERC-1155 implementation remains in Git at `checkpoint/erc1155-aquavapor` (`8a794ef62dd2f6df12efe470938fabcf16761796`). Active contracts use official Aqua and item-day ERC-20s. ENS discovery and token conversion require new implementations against this model.

## ProjectTokyo ENSv2 (asset and day index)

`projecttokyo.eth` is already registered on ENSv2 Sepolia. `ProjectTokyoNames` is the ENS registrar for that name. It does not mint tokens.

- `<asset>.projecttokyo.eth` maps to an existing `RentalAsset` from the live factory (`addr` = the asset, text records = title/kind/location). The host keeps ENSv2 EAC edit rights.
- `<YYYY-MM-DD>.<asset>.projecttokyo.eth` covers the asset's 365-day horizon. `addr` is the predicted `DayToken` (`RentalAsset.tokenAddress(day)`), `text token` is `eip155:11155111/erc20:<dayToken>`, and `text asset` is the RentalAsset address. Day names register in 73-day chunks.
- Day ownership, listing, booking and Aqua settlement stay on `RentalAsset` / `DayToken` / `DaySwapVM`. Do not change those contracts for ENS.

Live Sepolia (`deployments/sepolia.json` `ens`): `ProjectTokyoNames` `0xCdA3f99339E979384a1Da958B02041E76F23510c`, asset registry `0x00C55E0DB52B53125F9150C11DDb9532Fe65E42F`, demo `demo-room.projecttokyo.eth` → RentalAsset `0x5C0838E82E9551A5b0566e8a4BFbec784A8c7120`. 219 of 365 day names are registered; remaining chunks need more Sepolia ETH.

### Tests

```sh
export PATH="$HOME/.foundry/bin:$PATH"
forge test --root contracts --no-match-contract Fork
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  forge test --root contracts --match-contract ProjectTokyoENSFork -vv
npm test --workspace=web
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  node --experimental-strip-types contracts/scripts/e2e-projecttokyo.mjs
```

The fork tests impersonate `projecttokyo.eth` owner `0x92f6055f1a631E3C5fd3100920c63d8654729847` on an Anvil fork. They do not send real Sepolia transactions.

### Deploy (later, with the owner key)

```sh
# read-only plan against live Sepolia
node --experimental-strip-types contracts/scripts/deploy-projecttokyo.mjs --dry-run

# broadcast (requires PROJECTTOKYO_DEPLOYER_KEY of the name owner)
PROJECTTOKYO_DEPLOYER_KEY=0x... \
  node --experimental-strip-types contracts/scripts/deploy-projecttokyo.mjs --send
```

Then call `createAsset` from `apps/web/lib/ens` (creates the RentalAsset through the live factory, then registers the ENS names). Labels starting with `testasset` are hidden from `listAssets` / `listDays` unless `includeTest` is true.
