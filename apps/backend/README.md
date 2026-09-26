# AquaVapor trading backend

The backend discovers strategies registered through `AquaVapor.ship`, simulates matching bids and asks, and submits atomic ERC-1155/USDC trades through `AssetSwapVM`. It uses viem and Node SQLite. The HTTP service has no signing key; the web dashboard is not connected to it.

## Run and verify

Requires Node 22.13+, Foundry, `npm ci` and `contracts/scripts/bootstrap.sh`.

```sh
npm test --workspace=@project-tokyo/backend
npm run test:integration --workspace=@project-tokyo/backend
npm start --workspace=@project-tokyo/backend
```

Configure `RPC_URL`, `CHAIN_ID`, `AQUA_ADDRESS`, `ROUTER_ADDRESS`, `USDC_ADDRESS`, `START_BLOCK` and `DATABASE_PATH`. Keep the database outside the repository. `START_BLOCK` must include the first strategy registration. The service defaults to `127.0.0.1:8787`; `PORT` overrides it. Protect the internal service with authentication and quotas before exposing it remotely.

Use a **new database and an AquaVapor deployment**. Startup verifies `AssetSwapVM.AQUA()` and `USDC()`. The persisted scope binds the protocol, chain and all three addresses. Old EIP-712 rental orders and official Aqua deployments are incompatible. The historical Sepolia addresses in `contracts/deployments/sepolia.json` are not AquaVapor addresses. `contracts/script/DeployVapor.s.sol` deploys the new pair against Circle Sepolia USDC; it does not rewrite historical receipts.

## Authorization and execution

1. Construct a strategy with `maker`, `inventory`, sorted unique `ids`, whole-unit `quantity`, `buy`, `salt` and `program`. Decimal strings represent integers in JSON. `fixedProgram` builds the supported upstream SwapVM instruction sequence: absolute deadline, optional single-use bit, static balances and full-amount swap. Bid and ask programs are independent.
2. Approve **AquaVapor** to spend USDC or transfer ERC-1155s. `StrategyWallet.approve`, `ship` and `dock` validate the wallet and chain and verify the mined call. The pure `approvalRequest`, `registration` and `cancellationRequest` builders return calldata for extension wallets.
3. Ship the strategy and its asset permissions. Assets stay in the maker's wallet. Many alternatives can use the same funds or inventory; none is reserved. Shipping and docking are onchain transactions.
4. The index reads canonical `Shipped` logs into the order book. `POST /orders` provides immediate intake after registration, checking the current onchain permission. Neither path needs a second order signature or funding mandate.
5. `Matcher` simulates `swap(bid, ask)` before persisting and signing a submission. AquaVapor transfers both USDC and ERC-1155s, or the whole transaction reverts. Saved unsigned requests and signed bytes allow restart recovery without allocating a different transaction casually.

The router supports repeatable strategies when no invalidation bit is present. This relayer records one submission per bid/ask hash pair; additional fills require another strategy pair. Use a unique per-maker nonce for single-use orders. A shared nonce can couple alternatives, but OCO is not a required product behavior.

## HTTP surface

| Route                                   | Meaning                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `GET /deployment`                       | Protocol and configured chain/contract identities                         |
| `POST /orders`                          | Accept `{strategy}` after verifying active registration                   |
| `GET /orders?limit=100&offset=0`        | Persisted strategies, up to 1000 per page                                 |
| `GET /orders/:hash`                     | Strategy plus status at the indexed block                                 |
| `GET /health`                           | Indexed cursor and sync health                                            |
| `GET /market/quotes?limit=20&offset=0`  | Bounded simulations at one canonical block                                |
| `GET /market/history?limit=20&offset=0` | Canonical ownership-sale events                                           |
| `POST /orders/prepare`                  | Encode a legacy `RentalInventory` range and return unsigned ship calldata |
| `GET /inventory/resolve?name=...`       | Optional ENSv2 pool lookup                                                |

The range encoder only computes the legacy inventory's IDs; it does not certify supply, dates, backing or fulfillment. Generic strategies carry the actual ERC-1155 IDs. Quotes require identical baskets and quantities, but allow independent prices. Quote opportunities share conditional balances and cannot be added together. `open` describes authorization, not guaranteed funding or inventory. A failed RPC read is not reported as an empty market.

The index records block ancestry, removes orphaned events and reconciles strategy permissions after reorgs. Orphaned strategies may remain cached, but cached data never authorizes settlement. Confirmation count delays indexing; it is not finality.

## ENS and retained inventory consumers

Set `ENS_POOL_RESOLVER`, `ENS_PARENT_NAME` and `INVENTORY_ADDRESS` to enable discovery. Sepolia defaults to the official ENSv2 Beta resolver and registry; other chains can use `ENS_UNIVERSAL_RESOLVER` and `ENS_ROOT_REGISTRY`. `InventoryDiscovery.prepareStrategy` resolves a supported child name to a concrete legacy pool before encoding IDs. Reassigning the name cannot redirect a shipped strategy.

`SupplyBook`, `Redemption` and `RevenueClient` retain coverage for existing inventory and revenue contracts. Revenue-claim ownership can trade through the generic AquaVapor router using its actual claim ID. Its old booking path still uses its original Aqua deployment. These legacy contracts do **not** implement the final external-booking product: they differ on booking reversals, price preservation and service-day ownership. They are not the acceptance baseline for that next contract layer.

## Optional token conversion

`AssetAtomicConverter` and `ConversionRelay` support one configured source-token/USDC Uniswap V3 route. The buyer signs a separate EIP-712 funding intent binding both shipped strategy hashes, exact source amount, minimum output, USDC spending cap, recipient, deadline, chain, converter and nonce. The source amount called `maxInput` is consumed exactly.

Conversion delivers USDC to the buyer, then executes the same native strategy pair. Surplus stays with the buyer; the buyer's starting USDC balance must be preserved. A failed conversion or settlement rolls back both legs and the funding nonce. The relay verifies the mined call and both converter and router events. Conversion and ordinary submissions share the durable transaction nonce allocator.

## Evidence and limits

Local integrations exercise hash parity, canonical `Shipped` discovery, a later affordable ask, overlap rejection, restart and reorg recovery, resale, legacy inventory redemption, conversion rollback and retained revenue lifecycle behavior. They use disposable Anvil chains and ephemeral funded-local wallets, with no public transactions or committed receipts.

This layer supports fixed-price exact-basket settlement. It does not yet provide multi-seller blocks, duration discounts, final asset-day booking revenue, arbitrary-token routing, or frontend integration. The native limit of 254 registered assets comes from Aqua's packed asset-count sentinel; it is not a 31-day business policy. Pricing curves and lifecycle rules must be proven in their owning contract layers. The contracts have not been independently audited.
