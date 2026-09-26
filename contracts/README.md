# Item-day contracts

Each physical item has a fixed 365-day Tokyo calendar. Each date has one deterministic ERC-20 address, zero decimals and one raw unit of supply. Ownership survives booking and expiry.

- `src/day`: asset creation, canonical day tokens, ownership, listing, booking and host discounts.
- `src/pricing`: the public booking-price curve and whole-USD rounding.
- `src/market/DaySwapVM.sol`: atomic consecutive-day purchases through official Aqua, using the pinned SwapVM interpreter and full-amount instruction.

See [item and calendar behavior](../docs/item-day.md) and [settlement authorization](../docs/day-settlement.md). The backend consumes these contracts through the [day API and taker](../apps/backend/README.md).

## Build and test

From the repository root:

```sh
bash contracts/scripts/bootstrap.sh
forge test --root contracts
npm run test:integration --workspace=@project-tokyo/backend
```

The bootstrap pins Aqua, SwapVM, Solidity utilities, OpenZeppelin and forge-std to exact revisions. Foundry uses Solidity 0.8.30 with the optimizer, via IR and Cancun. Contract tests and the backend Anvil test execute locally; they do not establish public Sepolia deployment or real-wallet demo completion.

## Attribution and history

Powered by Aqua and SwapVM, © Degensoft Ltd 2025. `DaySwapVM` reuses upstream execution primitives with a rental-day pricing opcode and settlement shell. It is not ABI-compatible with the stock SwapVM router. See the [SwapVM license](LICENSES/SwapVM-1.1.txt) and retained [Aqua license](src/native/LICENSE-Aqua.txt).

The earlier ERC-1155 implementation remains in Git at `checkpoint/erc1155-aquavapor` (`8a794ef62dd2f6df12efe470938fabcf16761796`). Active contracts use official Aqua and item-day ERC-20s. `DayAtomicConverter` funds purchases through a configured WETH/USDC route.
`DayNameResolver` provides ENSv2 wildcard discovery of assets and deterministic
day-token addresses; it does not change ERC-20 ownership or deploy tokens.
