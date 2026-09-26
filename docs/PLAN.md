# DayTrader

ETHGlobal Tokyo 2026. Michael owns the website; Darryl owns contracts and backend.
The checked product decisions in [issue #44](https://github.com/ETHTokyo2026-MODY/project-tokyo/issues/44), together with the ERC-20 and Sepolia decisions below, govern the demo.

## Product

Hosts sell ownership of future days of a specific car or room to traders. The day owner controls its public booking price and receives its booking revenue. Guests book through an external host platform; they have no wallet, beneficiary address or reservation token in DayTrader.

- An **asset** is one physical item. There is no pool capacity or interchangeable-unit quantity.
- A **day token** is one ERC-20 contract per asset and Tokyo calendar date, with `decimals = 0` and exactly one raw unit of supply. It is never burned. Terms versions cannot create additional ownership for the same day.
- Asset creation exposes a fixed 365-day horizon initially owned by the host. Deterministic lazy token deployment is permitted; there is no daily calendar extension.
- Today and future days can trade. Past days are locked, and their tokens remain in existence.
- **listed_price** is the price shown to external guests. **selling_price** is the price paid to acquire ownership of the day. They are separate.
- The day owner controls selling_price and listing/unlisting. Days are listed by default; publication and execution must still respect actual owner authorization.
- Only the host or its authorized relayer can report or undo a booking before the day passes. A booked day locks listed_price and remains tradable. Ownership transfers preserve its public booking curve and booking state.
- Orders buy one or more consecutive days atomically, potentially from different owners. Each constituent token reaches the buyer. No arbitrary 31-day business cap applies; transaction gas and arithmetic validity still apply.
- A host-controlled discount ladder belongs to the asset, replacing per-order/per-account ladders. A consecutive order uses its qualifying duration step. Quotes and settlement must agree on rounding and seller payouts.
- OCO groups, collective activation, capacity accounting, terms-version IDs, burn-on-reserve and guest mandates are outside the demo.

## Settlement and discovery

Use official Aqua accounting with ERC-20 assets and reuse SwapVM execution. Modify SwapVM only where required by the product; the active demo does not use the ERC-1155 AquaVapor ledger.

The demo stays on **Sepolia** with test USDC. Strategies/orders are published onchain and a minimal open taker discovers, quotes and submits fills. The same wallet balance can back several alternatives; execution requires sufficient actual funds. Cancellation remains supported. There is no authoritative private order book and no claim that the hosted 1inch Orderbook API or production resolver network supports this deployment.

Keep chain-derived read models and recoverable transaction submission where needed. The website reads actual contract/indexed state for each integrated feature; simulated data stays visibly labeled.

## Demo acceptance

1. Create an asset and display its 365-day calendar.
2. Set prices, the asset discount ladder, and listings with the authorized wallet.
3. Register a trader's budget; a later compatible price triggers an actual taker transaction.
4. Buy consecutive days atomically, including a multi-seller example. Reject conflicting or unfunded fills without partial transfers.
5. Report a booking through a mocked host-platform webhook and show the onchain status in the calendar. The adapter is an explicit external-booking oracle, not proof of a real Turo/Airbnb reservation.
6. Use a fresh Sepolia deployment recorded in `contracts/deployments/sepolia.json`, real wallet extensions and test funds. Record the demo outside Git and clean up isolated wallets, approvals and processes safely.

Booking-revenue payout must have identified backing before being represented as real money. External revenue reconciliation is separate from the mocked booking adapter. Preserve the owner's entitlement without introducing guest wallets or duplicate revenue tokens.

## Subsequent integrations

Retain atomic conversion of supported wallet tokens into buyer-held USDC plus settlement as a separate layer. Preserve signed funding bounds, surplus and full rollback.

**ENS is last.** Use ENSv2 on Sepolia for asset/day name resolution to canonical or deterministically predicted ERC-20 addresses. Resolution does not deploy tokens or replace the event indexer. Existing authorizations bind concrete addresses across name changes.

## Layout and delivery

- `apps/web`: Next.js website, owned by Michael.
- `apps/backend`: contract consumers, indexed reads, open taker and mock host-platform adapter.
- `contracts`: Foundry contracts, focused tests and deployment tooling.
- `docs`: public product and integration documentation.

One proven layer per PR, with atomic commits, reproduction checks and AI attribution. Preserve other contributors' work. Follow `AGENTS.md` for publication and merging. Keep keys, private plans, recordings and generated execution artifacts outside Git.

The prior ERC-1155 implementation is preserved at `checkpoint/erc1155-aquavapor` (`8a794ef62dd2f6df12efe470938fabcf16761796`). It is reference history, not an alternative active product path.
