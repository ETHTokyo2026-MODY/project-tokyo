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

## Prices and booking reports

Asset creation supplies descriptive metadata, seven weekday booking/selling prices
and a booking-price minimum. Owners control selling prices and listing status.
Booking prices use the existing cubic ease-in-out curve and round half-up to whole
USD, represented in six-decimal USDC units. Selling prices remain independent and
may use USDC's full precision. Authored curve points change only through an owner
edit; reading a calendar never reanchors a curve.

Only the host or its explicitly authorized reporter can mark or undo a booking
before the service day passes. Booking freezes the current public price. It does
not transfer or burn the token, prevent resale, or collect guest funds. The owner
and curve survive booking changes; the booking and curve survive ownership changes.
Unbooking resumes the retained curve at the current date.

The host controls one versioned discount ladder per asset. Its greatest qualifying
duration threshold applies to the entire consecutive purchase, across sellers.
A later settlement layer must authenticate seller consent to the ladder version.
Reporting a booking attests external activity; it does not establish funded revenue.

## Reproduce

With the pinned Foundry dependencies installed, run from `contracts`:

```sh
forge test --match-path 'test/{day,pricing}/*.t.sol'
```

These tests establish ownership, lifecycle, prices and booking-report authority.
Full Aqua settlement is a subsequent layer.
