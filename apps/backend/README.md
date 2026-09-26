# Item-day backend

The backend reads factory-recognized ERC-20 calendars, prepares unsigned wallet transactions and executes published Aqua budgets through the day settlement contract. Financial amounts use raw six-decimal USDC units. It uses viem and Node SQLite.

## Application flow

1. `prepareDayAction()` prepares asset creation with explicit host salt, metadata, weekday prices and discounts. The mined factory event identifies the asset and its fixed 365-day calendar.
2. Listing selected days prepares missing materialization, day-token approvals and current-epoch Aqua asks before setting sale metadata. Initial calendar listings alone do not establish token approvals or published asks.
3. A buyer publishes a USDC budget for an exact consecutive range. Funds remain in the wallet until a successful settlement. The open taker evaluates current prices and authorizations; unavailable funds or a conflicting day prevent the complete fill.
4. The host reports or reverses a booking with the expected public price. Booking preserves ownership and resale, and locks the public booking price while booked. External booking reports do not establish funded revenue payouts.

`day-server.mjs` prepares unsigned wallet calls. An optional mock booking adapter uses a separate reporter signer authorized by the host. The application supplies chain clients and the canonical factory/router/Aqua/USDC configuration:

| Endpoint                     | Result                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `GET /config`                | Chain and contract addresses                                                           |
| `GET /state?account=0x…`     | Confirmed calendars and optional wallet USDC balance, or explicit indexing status      |
| `GET /receipt/:hash`         | Canonical receipt status and an asset address when a factory creation event is present |
| `GET /curve?asset=0x…&day=…` | Canonical public booking curve                                                         |
| `POST /webhook`              | Trusted mock booking report; bearer token required                                     |
| `POST /prepare`              | Unsigned wallet steps for `{actor, action, body}`                                      |

Supported actions are `create-asset`, `list`, `unlist`, `set-price` (public listed price), `curve`, `discounts`, `book`, `unbook`, `buy`/`publish-bid`, `cancel-bid`, and `authorize-reporter`. The planner checks chain configuration, authorization, live dates and exact integer inputs. Wallet steps remain subject to current contract checks when submitted. Bid nonce and salt are caller-selected; a closed ask identity requires a fresh salt.

## Run

Set `DAY_CONFIG` to an external JSON file containing `chainId`, `factory`,
`router`, `aqua`, `usdc`, `startBlock`, and optionally `confirmations`.
Set `DAY_RPC_URL` and `DAY_DB` (an absolute path outside Git), then run:

```sh
npm start --workspace=@project-tokyo/backend
```

The default listener is local. `DAY_HOST`, `DAY_PORT` and `DAY_INTERVAL_MS`
configure it. `DAY_TAKER_PRIVATE_KEY` enables automatic fills; inject secrets
through the process environment without saving them in the repository.

For the mock booking adapter, additionally configure `DAY_BOOKING_PRIVATE_KEY`,
a separate `DAY_BOOKING_DB`, and `DAY_WEBHOOK_TOKEN`. The host first authorizes
the reporter shown in `/config`. A booking event has
`{eventId,host,asset,day,booked,expectedListedPrice,signature}`. The host signs
the exact EIP-191 message from `bookingMessage()`; the server verifies every
field and the deployment before invoking the reporter. Retries preserve the event
ID and exact body; a reversal uses a new event ID.

The website proxy uses `DAY_BACKEND_URL` and an exact `DAY_APP_ORIGIN`
(for example, `http://127.0.0.1:3000`) when its public origin differs from
Next.js URL normalization. Forwarded headers do not override this origin.
For the explicit demo adapter, configure
`DAY_WEBHOOK_TOKEN`. The proxy is a trusted demo host platform, with host wallet authorization but no external booking verification. Keep it local for the isolated
scenario. Default web mode reads this backend; `NEXT_PUBLIC_DATA_MODE=sample`
selects the labeled sample mode.

## Indexed reads and execution

`EventIndex` stores decoded events and block ancestry, including empty blocks. It is rebuildable chain data. Consumers check canonical readiness and paginate all publications, including those older than the first 1,000 rows.

`DayTaker` consumes onchain publications, simulates complete settlement and submits through a dedicated relayer. `StoredSubmission` retains exact unsigned and signed transaction bytes and serializes the relayer nonce. Restart recovery reuses saved bytes; canonical receipt and settlement-event checks establish the result. Keep its database private and preserve unresolved submissions when restarting. There is no authoritative private order book.

## Test

```sh
npm test --workspace=@project-tokyo/backend
npm run test:integration --workspace=@project-tokyo/backend
```

The integration test uses local Anvil and the maintained item-day contracts. Public Sepolia deployment, real extension interactions and recordings require their own acceptance evidence. See [calendar semantics](../../docs/item-day.md) and [official Aqua settlement](../../docs/day-settlement.md).

The previous implementation is preserved at `checkpoint/erc1155-aquavapor`; its reservation, revenue-claim, recurring-supply and conversion consumers are removed from the active backend.

### Booking journal retention

Booking replay protection requires retaining **all** records in `DAY_BOOKING_DB`,
including completed bookings and reversals, with the same reporter identity.
This database is a durable authorization journal; it cannot be rebuilt from the
calendar index. Restart recovery supports the retained journal. Journal loss,
restoring an older journal, and reporter rotation are unsupported in this demo:
stop the booking adapter and resolve recovery before accepting further reports.
Do not start with a replacement empty database. Host signatures have no expiry
or onchain booking revision, and a previously observed price can recur after a
reversal; neither prevents replay when journal records are absent.

### Held WETH funding

Optional `DAY_CONFIG.conversion` supplies `converter`, `sourceToken`,
`swapRouter`, and `poolFee`. Deploy `DayAtomicConverter` with the current
`DaySwapVM`, the configured Uniswap V3 SwapRouter02, WETH and the pool fee.
Preparation verifies these against the converter's immutable getters.

The calendar's WETH funding option uses `prepare-conversion` to prepare exact
WETH approval, USDC approval to Aqua, and ordinary bid publication. It then
requests native EIP-712 consent for the exact basket and funding bounds.
`execute-conversion` simulates the signed call, checks the transaction gas budget,
and returns an unsigned wallet transaction. The browser waits for every receipt.
Amounts use raw token units: WETH has 18 decimals and USDC has 6; `maxInput` is
exact WETH spent, not a variable-input ceiling. No ETH wrapping is included.

The published bid independently authorizes ordinary USDC settlement. If sufficient
USDC is present, another taker can fill it before conversion. The converter then
rejects the spent bid without consuming WETH. Only converter execution atomically
combines the swap and purchase. Failed conversion leaves earlier approvals and
an unfilled published bid intact; the normal order cancellation remains available.

## ENS discovery

Optionally add `ens: { parentName, resolver }` to the external deployment JSON.
The navigation lookup calls `GET /resolve?name=…`, verifies the canonical ENSv2
Universal Resolver and configured factory, and opens the concrete asset calendar.
An ISO-date label also selects that Tokyo service day. A predicted token address
resolves before materialization; lookup does not deploy it. Orders retain the
resolved asset address even if an alias is later changed. The event index still
enumerates markets; ENS supplies readable names.
