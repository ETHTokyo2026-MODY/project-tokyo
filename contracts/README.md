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

`projecttokyo.eth` is already registered on ENSv2 Sepolia. This package adds:

- `ProjectTokyoInventory`: one never-burned ERC-1155 day token per (asset, day), with on-chain `booked` / `listed` / `listed_price` / `selling_price`. Price edits follow the current holder. Booking does not burn or freeze transfers.
- `ProjectTokyoNames`: deploys a UserRegistry asset registry via the live VerifiableFactory, one day registry per asset, and a PermissionedResolver per asset so the host can edit text records through ENSv2 EAC. Day names resolve `addr` to the inventory and `text token` to a CAIP-19 ERC-1155 id.

The ERC-20 `DayToken` / `DaySwapVM` path is unchanged. This inventory is a parallel ENS index; a new Aqua router would be required to settle these ERC-1155 ids.

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

Then call `createAsset` from `apps/web/lib/ens` (no UI in this PR). Labels starting with `testasset` are hidden from `listAssets` / `listDays` unless `includeTest` is true.
