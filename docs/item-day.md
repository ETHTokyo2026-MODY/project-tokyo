# Item-day ownership

`RentalAssetFactory` creates a calendar for one host-attested physical item. A
calendar contains 365 Tokyo dates beginning on its creation date. It never extends
automatically. Registering a different salt does not prove a different physical
item; the host remains responsible for that assertion.

Each date has a deterministic ERC-20 address. Before materialization, the asset's
view reports the host's entitlement and `deployed = false`; there is no ERC-20
balance to query at that address yet. Anyone can materialize the token, but its
single unit always goes to the host. Repeated materialization returns the same
address. Token identity excludes prices, terms and booking state.

Materialized tokens have zero decimals and exactly one raw unit. They cannot be
burned or replenished. Ordinary ERC-20 balances and allowances govern transfers.
Today remains transferable until midnight in Tokyo; past dates retain ownership
but reject nonzero transfers.

An ownership change increments the day's sale nonce and clears its initial
listing. Returning the token to an earlier owner does not restore the old nonce.
Zero-value and self transfers do not change listing state. Initial listing
metadata grants neither an ERC-20 allowance nor an Aqua shipment: execution must
obtain both from the owner.

The foundation uses OpenZeppelin ERC-20 and deterministic clones with immutable
arguments. There is no upgrade administrator or privileged transfer path.

## Reproduce

With the pinned Foundry dependencies installed, run from `contracts`:

```sh
forge test --match-path 'test/day/*.t.sol'
```

This layer establishes ownership and lifecycle. Pricing, booking reports and Aqua
settlement are subsequent layers; these tests do not establish their behavior.
