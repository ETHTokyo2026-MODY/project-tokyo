# Project Tokyo: plan

ETHGlobal Tokyo 2026. Team: Michael, Darryl.

## What we're building
Hosts (Turo or Airbnb hosts, hotels) sell future days of a car or room at a discount and get paid now.
Traders buy those days. Whoever owns a day sets its public rental price and keeps what the booking earns.
Days can be resold between traders, and the host can buy days back. Renters never touch the platform.
The price a day finally books at becomes the price signal for similar days.

## Definitions
These terms are authoritative. Where the rest of this plan conflicts with them, the definitions win, and the
rest is being updated (see issue #44).

- **Asset**: one single real-world thing, such as one car or one room. There are no identical units and no capacity.
- **Listing**: an asset that can be booked on a particular day for a price.
- **Day token**: exactly one token per asset per day, tradable. A day token is **never destroyed** (no burning).
- **Day token metadata** (on chain): `booked`, `listed`, `listed_price`, `selling_price`, and more.
  - `listed_price`: the price set on the host platform (Turo/Airbnb). This is what the guest pays.
  - `selling_price`: the token's sale price between traders.
  - Booking only sets `booked = true`. That locks `listed_price`, and the token stays tradable.
- **Host**: owns the asset and its host-platform account, and owns the day tokens when they are created.
- **Trader**: buys and sells day tokens.
- **Guest**: the host platform's end user. Guests are **not represented** in Project Tokyo at all. They only pay
  `listed_price` on the host platform. There is no guest, beneficiary or renter address on chain.
- **Default listing**: by default, the owner has a sell order for every day. Unlisting removes that day's sell order.
- **Discount ladder**: set per **asset**, for example `[(3 days, 10%), (7 days, 20%), ...]`. It applies **per run of
  consecutive days**. For example, 10 selected days made of a 3-day run and a 7-day run get the 3-day discount on
  the 3 and the 7-day discount on the 7.
- **Order**: any set of days, not necessarily consecutive, with one token per day and **no limit** on the number of
  days. A buyer of several days ends up owning each individual day token. Any grouping exists only for order matching.

## How we build it
First a working demo with simulated data, clearly labeled as simulated. Then each simulated part is
replaced with the real on-chain part, one small PR at a time, so the app works at every commit.

## The demo
- Top navigation: Dashboard, Calendar, Profile, Stats.
- Multiple assets: several cars and rooms from different hosts.
- Accounts: host, trader A, trader B, switched in the app to start.
- Calendar per asset, from Jan 1 this year to 24 months ahead, one block per month, drawn from the viewer's side:
  your days, days for sale (sale price, predicted price, gain), and other days (public price). Owners are not shown.
- Actions: buy, list or unlist, set price, and "Mark as Booked" (simulates a renter booking).
- Past days are locked. Whoever owns a day when its date passes is paid the booked price, or $0 if unbooked.
- Blocks: select a run of listed days and buy them all or nothing, with length discounts
  (3/7/14/21/30+ days at 5/10/15/20/25%, editable per account).
- Predicted price = average booked price of past days on the same weekday. Sale prices start about 15% below it.
- Price curve page: each day's price over the year before its date, editable from today on.
- Stats page: predicted versus actual price, trade volume, and comparisons with other pricing tools (sample data, labeled).
- Live updates across windows, and a reset that rebuilds the sample data.

## Simulated to real, in order
1. The demo in Next.js with sample data, everything simulated and labeled.
2. Wallet connect on Sepolia (Ethereum's test network), and a "get test money" button that mints labeled test USDC.
3. Days become tokens the owner holds in their wallet (one ERC-20 per asset-day, supply 1, so SwapVM can trade it).
4. Buying and selling through 1inch Aqua and SwapVM, deployed on Sepolia. A host's listing is a SwapVM order
   paid in test USDC, with a block explorer link on every trade.
5. A custom SwapVM instruction for all-or-nothing block buys with length discounts.
6. On-chain payout: when a day passes, its owner is paid the booked price in test USDC.
7. Stretch: prove real booking revenue with a web proof (TLSNotary or vlayer).

What stays off-chain: the booking itself and the renter (simulated Turo/Airbnb) and the public price display.
On-chain: day ownership, trades, discounts and payouts.

## Stack and layout
- `apps/web`: Next.js with wagmi and viem.
- `contracts/`: Foundry project with Aqua/SwapVM, our instruction, tests and deploy scripts.
  Deployed addresses in `contracts/deployments/sepolia.json`, read by the web app.
- `docs/`: this plan, specs and prompts.
- `README.md`, `FEEDBACK.md`, `LICENSE`, `.env.example`.

## Repo rules
- Every change is a PR from a branch. No direct pushes to `main`, no force pushes, no history rewrites.
- One PR does one thing, with a conventional-commit title (`feat: ...`, `fix: ...`, `docs: ...`).
- PRs are small and concise: one thing, aim under 300 changed lines, split above 800.
- Big work lands as a sequence of small PRs, each leaving `main` working.
- Full agent rules are in `AGENTS.md`. Every teammate's agents follow them.
- Squash merge: one PR becomes one commit on `main`.
- After each merge to `main`, CI runs format, lint, type check, unit tests, `forge build` and `forge test`, and backend tests against Anvil, and a separate check confirms the DigitalOcean deploy (which runs the Next.js build) succeeded. PRs only get a PR-format check; checks never block merging.
- Never commit keys or `.env`. Contracts are deployed by hand from a wallet holding only test ETH.
- Each PR description says what changed, how it was tested, and where AI was used.
- Libraries and forked code are listed as reused in the README.

## Deploy
- Web app on DigitalOcean App Platform: it auto-deploys every `main` push from source dir `apps/web`.
- Contracts on Sepolia, so anyone can try the live site with a browser wallet.
