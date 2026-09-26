# Day settlement

`DaySwapVM` is a rental-specific SwapVM execution shell using unchanged official
Aqua. It imports the pinned upstream interpreter and full-amount instruction and
adds an instruction reading the asset's live selling price and duration discount.
Its order ABI and bytecode are not the stock AquaSwapVMRouter interface.

The buyer approves USDC to Aqua and ships a bid containing the asset, consecutive
range, maximum total, deadline and nonce. Each seller approves its day token to
Aqua and ships an ask binding the asset, date, ownership epoch and discount version.
Both preimages bind chain and execution contract. Aqua's `Shipped` events publish
the complete orders; publishing transfers no funds or inventory.

Any taker can submit a fill. The contract validates every constituent ask and its
canonical pricing program, computes each seller's payout, and checks the buyer's
total. Each payout is the day's selling price multiplied by the undiscounted basis
points, rounded down to a USDC base unit. Summing those payouts defines the total;
there is no separate fee or rounding recipient.

The fill pulls USDC from the buyer through Aqua and pulls each ERC-20 day token
from its seller through Aqua. It consumes the buyer's nonce once, including for a
100%-discount purchase. All transfers, virtual balances and nonce changes roll
back if any leg fails. Tokens and funds stay wallet-held until that transaction.

Multiple bids can reference the same wallet balance. They are conditional buying
power, not reserved collateral. Cancellation can invalidate a buyer nonce or dock
its Aqua strategy. Sellers can unlist, revoke allowance or dock their strategy.
An ownership change invalidates old asks; a host discount change requires fresh
seller consent. A new owner starts unlisted and grants its own approvals.

Each day has a separate seller shipment. Aqua's per-strategy token-count limit
therefore does not limit the 365-day calendar. A fill still must fit transaction
gas limits. Listed metadata alone is insufficient: a day must be materialized,
approved and shipped before it is executable.

The open taker caps simulation and transaction admission at 16,777,216 gas by
default (`transactionGasLimit` may lower this). Oversized candidates are skipped
before a durable transaction is created, so they cannot block a later feasible
bid. Existing saved transactions retain their recovery rules. The integration
regression verifies that oversized 365- and 150-day bids do not block a seven-day
fill and that a capped failure changes no inventory, USDC or Aqua authorization.
The 365-day calendar is an inventory horizon, not a promise that all its dates fit
in one transaction.

Aqua authorizes and accounts for wallet-held trading liquidity. Our open taker
finds candidates and triggers execution; Aqua does not provide a hosted matching
or solver service for this deployment.

## Reproduce

Run `forge test --match-path 'test/market/*.t.sol'` from `contracts`. Tests cover
actual official Aqua on both legs, multi-seller payouts, competing wallet budgets,
revocation, stale asks, cancellation, full rollback and the Tokyo date boundary.
Local tests do not prove a public Sepolia deployment or an external solver network.
