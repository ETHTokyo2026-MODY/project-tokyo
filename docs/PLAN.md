# Project Tokyo: plan

ETHGlobal Tokyo 2026. Team: Michael, Darryl.

## What we're building
Hosts (Turo or Airbnb hosts, hotels) sell future days of a car or room at a discount and get paid now.
Traders buy those days. Whoever owns a day sets its public rental price and keeps what the booking earns.
Days can be resold between traders, and the host can buy days back. Renters never touch the platform.
The price a day finally books at becomes the price signal for similar days.

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
- Checks on every PR: lint, type check, tests, Next.js build, `forge build` and `forge test`, and a secret scan.
- Never commit keys or `.env`. Contracts are deployed by hand from a wallet holding only test ETH.
- Each PR description says what changed, how it was tested, and where AI was used.
- Libraries and forked code are listed as reused in the README.

## Deploy
- Web app on Vercel: a preview link per PR, and GitHub Actions deploys every `main` push to the live site.
- Contracts on Sepolia, so anyone can try the live site with a browser wallet.
