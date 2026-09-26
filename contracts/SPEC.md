# Rental settlement specification

## Scope and trust

This implements transferable daily allotments, full-fill signed orders, shared wallet funding through Aqua, and atomic USDC/ERC-1155 settlement. A trusted supplier attests that the physical allotment exists and is excluded from other booking channels. It is a backend proof, not an audited marketplace or a fulfillment guarantee.

The administrator creates immutable-capacity pools. Suppliers issue up to that cap for each day, summed across terms versions. Different pool identifiers must not describe the same physical allotment; that offchain identity check remains the administrator's responsibility. Historical tokens can be transferred directly but the settlement router rejects service windows that have started.

## Inventory

`tokenId = uint256(keccak256(abi.encode(pool, day, terms)))`.
Days are UTC integer Unix days. Ranges are half-open `[startDay,endDay)`, one to 31 slots. Quantity is a positive whole-unit count on every included day. Hotel-local check-in rules and same-room continuity must be included in the supplier terms; UTC slots are the proof's canonical accounting grid. A range is a basket of daily IDs, never independently minted overlapping supply.

Capacity is immutable per pool. `issued[pool][day] <= capacity` across all terms. Only the pool supplier may issue, and historical issuance never resets through resale or reservation. The supplier can hold overlapping asks, but after a sale they no longer own the sold slot; subsequent overlapping transfers fail atomically. Multiple equivalent rooms use one ID with quantity greater than one.

## Reservation and consumption

`reserve(holder,pool,start,end,terms,quantity,beneficiary)` burns the holder's complete daily basket and records an immutable reservation ID with the beneficiary. The holder or an ERC-1155 approved operator must call it. Every day has the same pool, terms, and positive whole-unit quantity; the range remains half-open, at most 31 UTC days, and its first day must not have begun. All days succeed or the transaction reverts. `consumed[pool][day]` rises once per burned unit and never decreases; `issued` stays historical, so consumption cannot restore issue capacity. Reservations cannot be transferred or cancelled, and the contract has no remint or refund path. `Reserved` is the onchain allocation event. Beneficiary identity is public; keep personal booking details offchain.

The pool represents interchangeable capacity within a supplier-attested class. A multi-day reservation preserves that class and quantity across days, but fungible daily tokens cannot establish that a guest receives the same physical room on each day. A capacity-one pool can represent one identified unit across the range if the administrator and supplier attest that identity. Reservation records an entitlement allocation; supplier confirmation and actual fulfillment remain outside this contract.

## Funding mandate

ABI-encoded tuple: `(address buyer,address app,address token,uint256 limit,uint256 expiry,bytes32 salt)`.
Hash: `keccak256(abi.encode(mandate))`, identical to Aqua `ship`'s strategy hash.

Buyer approves USDC to Aqua and calls `ship(router, abi.encode(mandate), [USDC], [allowance])`. No deposit occurs. Each bid signs the mandate hash. The router checks active Aqua status, remaining allowance, maker, application, token, expiry, and independent cumulative spending inclusive of fees. Anyone can refill an active Aqua balance, but that does not reset the campaign spending cap. Different mandates can share a wallet; they do not create more money or guarantee simultaneous execution.

## Signed order

EIP-712 domain: name `RentalSettlement`, version `1`, chainId, verifyingContract (the deployed router). The exact typed fields and order appear in `RentalSettlement.ORDER_TYPEHASH` and `test/Fixture.sol`.

- `maker`: authority signing the order; EOA and ERC-1271 verification supported.
- `buy`: bid or ask.
- `pool`, `startDay`, `endDay`, `quantity`, `terms`: exact inventory basket.
- `recipient`: buyer's NFT recipient or seller's USDC recipient.
- `priceLimit`: buyer's maximum total including fees; seller's minimum net proceeds.
- `maxFee`: absolute USDC fee ceiling accepted by each party.
- `expiry`, `nonce`: execution deadline and maker-scoped single-use nonce.
- `group`: zero for independent; otherwise maker-scoped one-cancels-other group.
- `mandate`: buyer funding hash; must be zero for asks.
- `programHash`: both parties authenticate the same exact program.

USDC and inventory addresses are immutable in the signed domain's router, so cannot be substituted by the caller. Both orders must match on the entire basket and program. A third party can relay but cannot redirect delivery or proceeds. An order nonce is consumed once for the maker across both sides. Full fills only. Group consumption happens on success and rolls back on failure. Onchain cancellation races are resolved by transaction ordering.

## Price program and SwapVM adaptation

`RentalSwapVM` imports the pinned upstream Context/runLoop and LimitSwapFullAmount implementations, then replaces the stock two-ERC20 settlement shell with `RentalSettlement`. It is a specialized source-level integration/fork, not ABI-compatible with the deployed stock SwapVM router. It does not inherit stock router audit coverage or imply sponsor endorsement.

The whitelist is exactly two instructions:

1. Fork-local `0x9e` with 32 ABI bytes sets the total basket price; or `0x9f` with 128 ABI bytes sets `(high,low,start,end)` and computes a descending linear total basket price clamped to endpoints.
2. Upstream `LimitSwapFullAmount` (`0x54` at the pinned revision), one argument byte `0x80`, executes the full units-to-USDC price conversion.

The quantity is the total number of unit-slots. Pricing applies to the entire signed basket; it is not a per-slot oracle or reserve-based AMM. No jumps, callbacks, external execution, or arbitrary opcodes are accepted. Prices cannot mutate state. `quote` returns gross seller price and the separate buyer-paid fee; quote success is not proof of inventory/funding availability. Quote can be invoked via eth_call/staticcall. Execution re-evaluates the price, so elapsed time may change it.

Fee is floor(price / 100), paid by buyer to an immutable fee recipient. Seller receives the exact price. A fixed program may specify any positive price consistent with both signatures and caps. Dutch prices bound high to uint128 and duration to uint64. Parameters are signed and cannot be changed; updating a quote means canceling/replacing an order.

## Atomic execution

1. Globally lock settlement against cross-order reentrancy.
2. Verify both signatures, deadlines, window, nonce and group status.
3. Verify matching basket/program and buyer mandate/Aqua active status.
4. Run upstream VM with the whitelist; enforce price and fee limits.
5. Consume both nonces/groups and cumulative spending.
6. Pull seller proceeds and fee through Aqua from the buyer wallet.
7. Batch-transfer the seller's ERC-1155 rights to the buyer recipient.
8. Emit signed order hashes, mandate hash, price and fee.

Any revert unwinds the router, Aqua, ERC-20, and ERC-1155 state changes. ERC-1155 approval is not a sell order; the seller signature is independently mandatory. No matching/search is performed onchain. The order backend in `../apps/backend` stores signed orders, simulates compatible matches, and submits the same settlement call.

## Scope boundaries

Proof covers canonical Aqua integration, fixed and Dutch pricing, daily/weekly/31-day baskets, fungible room quantities, alternatives, independent orders, cancellations, revoked approvals, depleted wallet, moved inventory, authorization, budget refill, resale, rollback and malicious receivers. Invariants cover capacity/ownership, USDC conservation, and mandate cap over randomized sequences.

Not implemented: multi-seller fills, partial fills, open-ended flexible date allocation, reservation cancellation/refunds, supplier integrations, production liquidity, continuous market making, and guaranteed fulfillment.

No crowdsourcing threshold, pooled buyer commitment, or collective activation is implemented. The fee rate is fixed; only fixed-price and descending Dutch programs are accepted.
