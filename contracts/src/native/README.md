# AquaVapor: native ERC-1155 Aqua liquidity

Powered by Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.

This experimental protocol extension registers and transfers ERC-1155 assets in Aqua's own strategy ledger. It does not wrap rental rights as ERC-20s or delegate their transfer to `RentalSettlement`. It is a separate deployment from official Aqua. The HTTP backend consumes this protocol; the historical public deployment has not been replaced.

## Source and changes

- `AquaVapor.sol` adapts [Aqua.sol at ef24220](https://github.com/1inch/aqua/blob/ef24220ed9647555727b06867bf509cd6959d84b/src/Aqua.sol). Asset identity becomes `(kind, token, id)`. It retains wallet/app/strategy virtual balances, ship/dock/pull/push and the upstream packed balance library. Changes add canonical asset lists, batch transfers, manifest validation and callback protection.
- `AssetSwapVM.sol` adapts the quote, interpreter and transfer flow of [SwapVM.sol at feb1641](https://github.com/1inch/swap-vm/blob/feb16411738331f7d05ae71d4a664154068018fc/contracts/SwapVM.sol). It reuses the actual interpreter and StaticBalances, LimitSwapFullAmount, Deadline, Salt and InvalidateBit instructions. Its execution shell matches two shipped strategies and transfers both asset types through AquaVapor. It is not the full upstream router: ERC-20-only traits, native ETH, Permit2, hooks, AMM curves and protocol-fee instructions are omitted.
- No ERC-1155-specific opcode is needed for this fixed-price basket proof. Basket identity belongs to the authenticated strategy and transfer/accounting layer. The existing VM executes pricing and optional invalidation. Additional instructions should be introduced only for behavior the retained instructions cannot express.

Modified 2026-09-26. Original notices are preserved; applicable license texts are [Aqua](LICENSE-Aqua.txt) and [SwapVM](LICENSE-SwapVM.txt). Dependency revisions and compiler settings remain pinned by the existing bootstrap and Foundry configuration.

## Authorization and execution

A seller ships virtual quantities for each inventory ID. A buyer independently ships USDC for its chosen basket. Shipping is an onchain authorization transaction and moves no tokens. Both wallets approve AquaVapor for their corresponding token standard. Programs and basket contents are included in the shipped strategy hash.

Any matcher may submit a pair. The router evaluates each program independently, checks that the basket and quantity agree and that the seller's price is within the buyer's cap, then calls AquaVapor for both transfers. The buyer always receives the rights and the seller always receives USDC. No caller-supplied destination can redirect them. A later seller program can match an earlier buyer cap without replacing the buyer strategy.

Virtual quantities remain independent across strategies. Filling one does not rewrite other strategies' balances. Missing real inventory or insufficient wallet funds causes a later conflicting fill to revert. Registration is conditional purchasing power, not reserved collateral. The router's quote checks balances; a full swap simulation is still needed to check approvals and receiver acceptance.

Upstream InvalidateBit can make a strategy single-use, or implement OCO when alternatives deliberately use the same maker-scoped bit. OCO is optional and is not required by the native-asset proof. Without an invalidation instruction, a strategy may fill again while its remaining authorization and real assets permit. Deadline is also a program instruction; the generic router does not infer service dates from opaque token IDs.

## What can be reused or removed in a migration

| Existing responsibility                                  | Native path                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ERC-1155 transfer in RentalSettlement                    | AquaVapor.pull performs the actual transfer and debits per-ID authorization                                                      |
| Exact shared program between buyer and seller            | Independent programs; compatible basket and price bounds suffice                                                                 |
| Custom per-order used bitmap / OCO mapping               | Upstream InvalidateBit can provide this policy                                                                                   |
| Custom strategy spend counter                            | AquaVapor tracks remaining spending permission per strategy                                                                      |
| EIP-712 order authorization                              | Shipped authorization suffices here, at the cost of an onchain registration; this does not prove offchain-only order publication |
| Daily issuance, capacity and redemption                  | Existing RentalInventory works unchanged                                                                                         |
| Aggregate budget across several distinct strategies      | Not automatically provided by per-strategy balances; still requires an explicit policy if requested                              |
| Indexing, persistence, matching and transaction recovery | Reused by the migrated AquaVapor backend                                                                         |
| Revenue payouts, ENS and conversion                      | ENS and conversion consumers migrated; legacy revenue lifecycle remains separate                                                           |

No old production path is removed by this change. The generic router does not certify supplier identity, physical availability, reservation fulfillment, or ERC-1155 implementation honesty. Test fixtures use standard ERC-1155 and ERC-20 behavior; fee-on-transfer/rebasing payment tokens are outside the USDC contract assumption.

## Reproduce

From the repository root, with the existing workspace dependencies installed:

```sh
bash contracts/scripts/bootstrap.sh
forge test --root contracts --match-path 'test/native/*' -vv
node contracts/scripts/native-smoke.mjs
SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co \
  forge test --root contracts --match-contract NativeSepoliaForkTest -vv
```

The Solidity suite covers registration without custody, native transfer/accounting, daily/weekly overlap in either order, later cheaper asks, shared wallet depletion, cancellation, budget checks, resale, duplicate IDs, malformed instructions, wrong application/maker/basket, revoked approvals, rejected receivers, reentrancy, and randomized conservation sequences. OCO is included as optional instruction reuse coverage.

`NativeSepoliaForkTest` also passed against Circle’s deployed Sepolia USDC at pinned block 11,786,600. It seeds funds in the local fork only and is explicitly skipped without `SEPOLIA_RPC_URL`. This verifies the actual payment-token implementation, not a public deployment.

The smoke script starts its own localhost Anvil, generates ephemeral signing keys only in memory, funds them only on that local chain, deploys the native contracts plus the maintained RentalInventory, executes a later cheaper ask and reservation redemption, and terminates Anvil. It also measures separate transaction receipts; no public funds are used and no keys, chain dumps or receipt artifacts are written to the repository.

Observed local receipt gas with Solidity 0.8.30, optimizer 200, via IR and Cancun:

| Daily IDs | Buyer ship | Seller ship | Atomic swap |
| --------- | ---------: | ----------: | ----------: |
| 1         |       ~84k |        ~84k |       ~153k |
| 7         |       ~88k |       ~250k |       ~429k |
| 31        |      ~107k |       ~913k |      ~1.53m |
| 90        |      ~154k |      ~2.55m |      ~4.26m |
| 254       |      ~283k |      ~7.12m |     ~11.95m |

Addresses and calldata change exact gas. These are measured workloads, not guarantees for arbitrary token contracts or target-chain limits. The separate seven-day scenario consumed about 447k swap gas and 518k reservation gas. The runtime sizes are approximately 4.1k bytes for AquaVapor and 6.5k bytes for AssetSwapVM, below EIP-170's 24,576-byte limit.

The native path has no 31-day trading cap. Aqua's inherited packed status/count format supports at most 254 distinct registered assets per strategy; this is a representation bound, not a demonstrated gas maximum. RentalInventory still caps each issuance/reservation call at 31 days. The smoke script chunks issuance for longer baskets but transfers each complete basket in one transaction; it does not claim longer reservation support.

## Remaining gates

This is tested local feasibility, not an audited or public-testnet deployment. Fresh registrations and approvals are required for this fork. Official Aqua SDKs, deployments and application liquidity are not automatically compatible.

The Tokyo prize explicitly permits a modified SwapVM deployment but does not explicitly grant the same exception for modified Aqua. Sponsor eligibility therefore remains unconfirmed; no sponsor contact or eligibility claim is implied by this implementation.

## Backend consumers

The [backend](../../../apps/backend/README.md) consumes shipped strategies and native events, verifies independent programs, and recovers durable transactions. `AssetAtomicConverter` reuses the existing conversion design with native strategy hashes and `AssetSwapVM.swap`; both payment and rights still move through AquaVapor. `DeployVapor.s.sol` deploys the native pair on Sepolia against Circle test USDC. Historical published addresses are not migrated deployments.
