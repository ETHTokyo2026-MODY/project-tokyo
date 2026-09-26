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

## Capacity-one booking revenue

`RentalRevenue` is a separate ERC-1155 claim, one unit per claim ID. A holder creates a claim by escrowing one future-day inventory token from a pool whose capacity is exactly one. The current claim holder sets the positive booking price before that day starts; the price follows the claim on transfer until its holder changes it. These claims are transferable, but the inventory settlement router trades only inventory IDs and cannot settle revenue claims without a separate market adapter. Transfer alone does not establish a market-clearing price.

A buyer authenticates a booking by shipping `abi.encode(BookingMandate)` to Aqua for this revenue contract and USDC. The mandate binds buyer, contract, token, unique immutable claim ID (and therefore pool/day/terms), beneficiary, exact price, expiry and salt. Booking requires the live mandate and wallet allowance, pulls the exact USDC amount into escrow, verifies it arrived, and atomically calls inventory `reserve` for the guest. No buyer money is held before booking, and proceeds from an earlier inventory sale do not back this claim. The claim remains transferable after booking. After the service day ends, its current holder burns it and receives exactly the booked escrowed USDC once.

Before booking, the buyer can dock its Aqua mandate and the claim holder can burn the claim to recover its underlying token for zero revenue, including after an unbooked day expires. Once booked, docking cannot reclaim the USDC already in escrow. A booked claim has no cancellation, refund, or restoration path; it is an irrevocable, nonrefundable booking in this bounded model. The supplier and any booking channel must accept those commercial terms. The onchain reservation identifies the guest beneficiary but is not supplier confirmation or proof of occupancy, and the contract does not verify actual booking revenue beyond the USDC received through Aqua.

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

An unguarded price program has exactly two instructions:

1. One fork-local price opcode. Legacy `0x9e` with 32 ABI bytes sets the total basket price; `0x9f` with 128 ABI bytes sets `(high,low,start,end)` for a descending linear total basket price. Economic-terms `0xa0` takes `(unitPrice,feeBps,discountMinDays,discountBps)` (128 ABI bytes); `0xa1` takes `(highUnitPrice,lowUnitPrice,start,end,feeBps,discountMinDays,discountBps)` (224 ABI bytes). Dutch curves clamp to their endpoints.
2. Upstream `LimitSwapFullAmount` (`0x54` at the pinned revision), one argument byte `0x80`, executes the full units-to-USDC price conversion.

The two-argument `quote(program,units)` remains for legacy whole-basket programs. Economic-terms programs require `quote(program,durationDays,quantity)`, where duration is `endDay-startDay`. Settlement calls the same calculation with the signed order's duration and quantity. No jumps, callbacks, external execution, or arbitrary opcodes are accepted. Prices cannot mutate state. Quotes return seller proceeds and the separate buyer-paid fee; quote success does not prove inventory or funding availability. Quotes can be invoked via eth_call/staticcall. Execution re-evaluates the price, so elapsed time may change it.

## Collective activation

A collective program prepends `0xa2 0x80 abi.encode(coordinator,campaign,minParticipants,minSpend)` to an otherwise valid price program. The complete bytes remain in both orders' signed `programHash`. `campaign` is a nonzero identifier, `minParticipants` is 2–8, and `minSpend` is positive USDC base units. The router deploys one immutable coordinator and rejects a guarded program naming any other address. Public quotes strip the guard and evaluate the price, but settlement of a guarded order requires the coordinator as caller.

The coordinator accepts 2–8 fills in one `activate` call. Every fill must have the same exact guard prefix; price suffixes and baskets may differ. The bids must have distinct maker addresses, which count distinct wallets or contract accounts rather than distinct people. It calls the router for every fill, then requires the sum of actual seller prices plus buyer fees to meet `minSpend`. One failed signature, cancellation, expiry, inventory transfer, fee/price cap, depleted or revoked funding, or unmet threshold reverts every transfer, nonce, spend counter and event in the batch. A direct `settle` call cannot execute a guarded order. This proves atomic collective activation under the declared wallet identity model; it does not reserve funds while orders are open.

Legacy programs use a 1% fee. Economic-terms price is `unitPrice * durationDays * quantity`, then, when duration meets `discountMinDays`, floor of that amount times `(10000-discountBps)/10000`. The fee is floor of the resulting price times `feeBps/10000`; it is paid by the buyer to the immutable fee recipient. The seller receives the price. Fee bps is at most 1000, discount bps at most 9000, and the discount threshold is 1–31 when the discount is nonzero (otherwise both fields are zero). Unit prices are positive and at most uint128; Dutch duration is at most uint64. Each side's signed `maxFee` and price limit still apply. The discount is all-or-nothing for the current basket: splitting a qualifying range into smaller sales loses the discount on each part that misses the threshold. Resales use the resale basket's duration, regardless of the original purchase price or discount. All parameters are inside the signed `programHash`; updating terms requires new orders.

## Atomic execution

1. Globally lock settlement against cross-order reentrancy.
2. Verify both signatures, deadlines, window, nonce and group status.
3. Verify matching basket/program, any collective caller guard, and buyer mandate/Aqua active status.
4. Run upstream VM with the whitelist; enforce price and fee limits.
5. Consume both nonces/groups and cumulative spending.
6. Pull seller proceeds and fee through Aqua from the buyer wallet.
7. Batch-transfer the seller's ERC-1155 rights to the buyer recipient.
8. Emit signed order hashes, mandate hash, price and fee.

Any revert unwinds the router, Aqua, ERC-20, and ERC-1155 state changes. ERC-1155 approval is not a sell order; the seller signature is independently mandatory. No matching/search is performed onchain. The order backend in `../apps/backend` stores signed orders, simulates ordinary matches, and builds collective activations from compatible signed pairs.

## Scope boundaries

Proof covers canonical Aqua integration, fixed and Dutch pricing with authenticated fees and duration discounts, daily/weekly/31-day baskets, fungible room quantities, alternatives, independent orders, cancellations, revoked approvals, depleted wallet, moved inventory, authorization, budget refill, resale, rollback and malicious receivers. Invariants cover capacity/ownership, USDC conservation, and mandate cap over randomized sequences.

Not implemented: multi-seller fills, partial fills, open-ended flexible date allocation, reservation cancellation/refunds, supplier integrations, a market adapter for revenue claims, production liquidity, continuous market making, and guaranteed fulfillment.

The collective threshold applies only when all participating parties sign the guarded program. It counts wallet addresses and settled payment; it does not prove distinct people or guarantee that an open campaign will eventually activate.
