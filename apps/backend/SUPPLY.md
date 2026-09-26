# Supplier availability

Set `INVENTORY_ADDRESS` to enable `POST /supply` and `GET /supply/:hash`.
The POST body is `{schedule, signature}`. `scheduleTypes` and `supplyDomain`
in `src/supply.mjs` define the EIP-712 message. The inventory pool's current
supplier must sign it. The signature authorizes publication, not spending.

A schedule identifies an immutable pool, terms, a half-open UTC service-day
range of at most 90 days, weekday bitmask (Sunday is bit zero), and cumulative
issuance target per selected day. `serviceDay('YYYY-MM-DD')` converts a service
date without local timezone or daylight-saving shifts. Properties with local
check-in hours must state them in their terms; this API does not turn elapsed
hours into hotel nights. Overlapping schedules for a pool are rejected even
if their terms differ. Repeating the same signed schedule is idempotent.

Reconciliation reads one canonical block and returns issued, consumed and
outstanding quantities, plus unsigned `publishDay` transactions for missing
issuance. The supplier submits these with their wallet. Each transaction is
idempotent at the contract: a cumulative target never replenishes transferred
or consumed units. A schedule is not evidence that issuance succeeded; the
canonical counts are the source of truth. Independent calls can partially
complete and be retried. Availability cannot be revised below issued capacity.

Pool creation remains administrator-attested. Onchain capacity cannot verify
physical inventory or prevent an administrator assigning the same physical
asset to multiple pools. Outstanding units include all holders; ownership and
bookability require current ERC-1155 balances and settlement simulation.
