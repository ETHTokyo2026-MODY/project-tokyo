# Rental order backend

Persistent signed orders, chain reconciliation, and transaction submission for the contracts in `../../contracts`. No UI dependency. Uses [viem](https://viem.sh/) and Node's built-in SQLite; requires Node 22.13 or later.

## Run and verify

From the repository root:

```sh
npm ci
npm test --workspace=@project-tokyo/backend
# Requires Foundry and contracts/scripts/bootstrap.sh to have completed:
npm run test:integration --workspace=@project-tokyo/backend
```

The integration tests launch disposable Anvil instances with real Aqua, the rental contracts, and a six-decimal test USDC. They cover order persistence, Solidity/JavaScript hash parity, ERC-1271 intake, overlap rejection, saved-transaction recovery, reorg reconciliation, revenue claims, and atomic conversion through ordinary fills. They do not use a funded public wallet or write deployment receipts into Git.

Run the internal order API with `RPC_URL`, `CHAIN_ID`, `ROUTER_ADDRESS`, `USDC_ADDRESS`, `START_BLOCK`, and an absolute `DATABASE_PATH` outside the repository. `START_BLOCK` must be the router's deployment block or earlier. Sepolia's chain ID is 11155111; published addresses are in `../../contracts/deployments/sepolia.json`.

The published Sepolia router predates economic-terms programs. Use a deployment of the current contracts for `0xa0` and `0xa1` orders.

```sh
npm start --workspace=@project-tokyo/backend
```

It binds to `127.0.0.1:8787` (`PORT` overrides the port). This is an internal service: put authentication, request quotas and transport security at the gateway before exposing it beyond the host. The HTTP service holds no signing key and offers no transaction-submission endpoint.

| Route                                   | Behavior                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`                          | Accept `{order, signature, program, mandate?}`. Numeric fields use decimal strings. Validate canonical fields and current EOA/ERC-1271 signature; persist idempotently by typed-data hash.                                |
| `GET /orders?limit=100&offset=0`        | List persisted orders; maximum page size 1000.                                                                                                                                                                            |
| `GET /orders/:hash`                     | Return the order and its status at the indexed block.                                                                                                                                                                     |
| `GET /health`                           | Return indexed cursor, last sync time and whether sync is stale.                                                                                                                                                          |
| `GET /market/quotes?limit=20&offset=0`  | Simulate compatible signed bid/ask pairs against one chain block. Rank by buyer total (`price + fee`), then price and order hashes. At most 20 stored orders and 100 pairs are checked per page.                          |
| `GET /market/history?limit=20&offset=0` | Read up to 20 canonical indexed settlement events, then attribute prices where both signed order baskets remain stored. The returned `window` reports event and attribution counts; booking price history is unavailable. |

Admission reserves neither money nor inventory. Canonical envelopes are immutable; replacements use a new signed order. Onchain nonce/group cancellation is authoritative. `open` only means unconsumed at the indexed block, not currently executable: expiry, wallet funds, inventory, approval and ERC-1271 validity can change.

## Matching and relaying

`Matcher` takes the same `Store`, `OrderBook`, a viem public client, a viem wallet client with a configured signing account, and `{chainId, router}`. Keep one dedicated relayer account per database; do not send unrelated transactions from it. A remote signer can be supplied through the wallet client. No key storage is implemented here.

- `candidates(limit, offset)` scans a bounded 100-order window for matching complete baskets/programs and simulates settlement. It is a bounded discovery primitive, not an optimal market-wide scheduler. Callers may supply any two known hashes directly to `submit`.
- `submit(bidHash, askHash)` checks current chain execution, reserves a unique relayer nonce atomically, persists the unsigned request, signs it and persists exact signed bytes before broadcast. Repeated calls reuse that transaction. RPC estimation failures reserve no nonce.
- `recover()` resumes persisted jobs in nonce order. If a signature or transport call fails, retry after restoring the signer/transport. A mined revert is returned explicitly; it is not retried with a new nonce or new fee bid automatically.
- `status(id, index)` distinguishes prepared, broadcast, mined, reverted and confirmed. Confirmed means the exact transaction and both order hashes occur together in a canonical indexed settlement event, with the index's confirmation policy. It can change after a reorg.

A successful simulation cannot guarantee a later fill: competing orders, wallet spending and price movement can win the race. The contract's atomic checks are decisive. A reverted transaction can consume relayer gas without moving rental inventory or USDC.

The market quotes use the signed fixed or Dutch VM program and the buyer's signed price and fee limits. Bid and ask must agree on the exact program hash and basket. `bestByBasket` selects the lowest buyer cost within each buyer, signed recipient and economic basket (pool, dates, quantity and terms) in the requested page. The raw `quotes` list is ordered by total cost for inspection; a day, week, different property, recipient or buyer has no common value ranking. Each quote is independent at its reported block. Pages have an offset of at most 1000 orders. Multiple bids can share one wallet's unreserved USDC, so quote counts and prices do not establish simultaneous liquidity or aggregate demand. A secondary holder can sell only while the contract simulation confirms its current inventory and approval. `Matcher.submit` revalidates the chosen pair at submission. The history route reports right-sale prices from an indexed-event window, with unmatched events omitted from `sales` and counted in `window`; it is not booking revenue or an appraisal. RPC errors and reorgs make market reads unavailable rather than silently removing quotes.

The index processes up to 64 blocks per sync and defaults to two confirmations. It records empty blocks, validates block-hash-scoped logs, removes orphaned history, and consults nonce/group state at the indexed block. RPC outages propagate as unavailable status, not as empty history. Two confirmations are a configurable operational policy, not Ethereum finality.

## Atomic conversion relay

`ConversionRelay` in `src/conversion.mjs` uses the existing `Store` and `OrderBook` plus a viem public client and signing wallet client. Configure `{chainId,executor,router,swapRouter,sourceToken,usdc,poolFee,confirmations}` from the deployed converter and its immutable getters. The supported source in this route is WETH. The buyer signs `FundingIntent` using exported `intentDomain` and `intentTypes`. `maxInput` is spent in full by Uniswap `exactInputSingle`; the buyer keeps output above its own fill cost. The chosen bid/ask hashes are bound by the intent.

`submit({bidHash,askHash,intent,intentSig})` loads signed envelopes from that order book, verifies deployment and chain bindings, simulates the complete call, reserves a relayer nonce, saves the unsigned request, then saves exact signed raw bytes before broadcasting. `recover()` resumes conversion jobs after interruption; `status(intentHash)` checks chain, canonical block, mined calldata and every expected settlement event before reporting confirmed. Ordinary `Matcher` and conversion jobs share one persisted `submissions` nonce namespace and relayer account through `StoredSubmission`. A later job is rejected while an earlier nonce lacks raw bytes or the RPC pending nonce has not advanced past it; run the earlier consumer's `recover()` first. Signed but pending prior transactions may still delay confirmation, so operators should recover relayer jobs in nonce order. Keep one dedicated relayer account per database and back up the database. A mined revert remains reverted; it is not automatically fee-replaced. The internal HTTP server does not expose this relay or hold its signing key.

## Reservation consumer

`Redemption` in `src/redemption.mjs` accepts a public client, a wallet client for the holder or an ERC-1155 approved operator, and `{chainId, inventory, confirmations}`. Call `reserve({holder,pool,startDay,endDay,terms,quantity,beneficiary})` with a positive whole-unit quantity and a future half-open UTC-day range of at most 31 days. It simulates the actual inventory call, signs and submits from the supplied wallet, waits for the configured confirmations, checks the block hash, and returns the exact `Reserved` event's ID and transaction hash. The contract, rather than the backend, decides ownership, operator authority, capacity, and atomic consumption. A later reorg can change a receipt's canonical status; callers that need durable state should recheck the reservation ID on the canonical chain. The internal HTTP service does not hold a booking signer or expose reservation submission.

## Revenue consumer

`RevenueClient` in `src/revenue.mjs` takes a public client, a role-specific wallet client, and `{chainId, revenue, aqua, usdc, confirmations}`. The holder approves the revenue contract to transfer inventory, then calls `createClaim`, `setPrice`, and optionally `transferClaim` or `withdrawUnbooked`. The buyer approves Aqua to transfer USDC and calls `shipBooking(mandate)`; any relayer can then call `book(claimId, mandate)`. The current claim holder calls `claimRevenue` after the booked day ends. `bookingStrategy` returns the exact ABI bytes and Aqua hash for the buyer's mandate. Each method simulates the contract call and checks its canonical receipt, mined transaction calldata, sender, destination, chain, and expected event. A later reorg can still replace that block.

Revenue claims are a separate ERC-1155 asset. Deploy a separate `RentalSwapVM` with `RentalRevenue` as its rights contract, then configure an `OrderBook` and `Matcher` for that router to sell open claims for wallet-held USDC through Aqua. Its router address gives claim orders a distinct signed domain and funding app from inventory orders. A real transfer clears an open claim's booking price, so its new holder must set a price before booking; a pre-shipped mandate at the old price cannot book it. Booking before a router sale makes that sale revert atomically. Booked claims retain their funded amount and can be transferred directly by their owner, but paid post-booking resale needs a state-bound order extension. Signed open-claim sale prices are executable but do not establish market liquidity or a particular discovery algorithm. Bookings are nonrefundable after the Aqua pull and inventory reservation. An unbooked claim can return its underlying for zero revenue, but that basket cannot mint a replacement economic claim. The backend exposes no signing key or public booking route.

## ENSv2 inventory discovery

Set `ENS_POOL_RESOLVER`, `ENS_PARENT_NAME`, and `INVENTORY_ADDRESS` to enable `GET /inventory/resolve?name=<one-child-name>`. The server uses `ROUTER_ADDRESS` to verify that the trading router uses the same inventory. On Sepolia, the public ENSv2 Universal Resolver and root registry are pinned to the [official Beta deployment](https://docs.ens.domains/learn/deployments/); `ENS_UNIVERSAL_RESOLVER` and `ENS_ROOT_REGISTRY` may select a local deployment on other chains. The route returns a concrete `bytes32` pool with the source block hash. `InventoryDiscovery.prepareOrder(name, draft)` inserts that pool into an unsigned order draft; the wallet signs the resulting order in the configured router domain. The service holds no signing key.

Only one lowercase ASCII child label (`a-z`, `0-9`, or interior `-`) under the configured parent is supported. The resolver and backend reject unknown pools, another resolver taking over a child, deployment mismatches, and a block replaced during the read. All deployment and pool checks use one block. An alias can later be reassigned, but an already signed order still contains its original pool and cannot be redirected. The alias is controlled by the resolver owner and identifies an existing inventory pool; it does not certify a property's physical truth, supplier fulfillment, available dates, or funds. Settlement rechecks signed orders, balances, and authorization.

## Boundaries

Whole units, one seller per fill, exact basket/program matching, fixed or Dutch pricing, and the contract's 1–31-day limit. Program opcodes `0xa0` and `0xa1` carry authenticated unit prices, fee bps, and duration discounts. For these programs call `quote(program,durationDays,quantity)` with the signed basket duration and quantity; the older two-argument quote works for legacy basket prices. Discount applies only when the current basket reaches the signed duration threshold, including on resale. Revenue claims cover one day in capacity-one pools. No automatic fee replacement, public relayer, multi-seller routing, supplier booking, reservation cancellation/refunds or production deployment. The database contains executable signed orders and transactions; protect its access and backups. Contracts and backend have not been independently audited.
