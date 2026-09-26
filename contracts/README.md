# Rental settlement contracts

ERC-1155 daily allotments settle atomically against wallet-held USDC through Aqua. Capacity-one daily allotments can also back transferable booking-revenue claims. The specialized router uses upstream SwapVM execution with fixed or descending Dutch prices. Signed programs can set bounded fees and duration discounts. It is not the stock SwapVM router.

## Setup and test

Requires Git and Foundry. No contract-specific npm install is needed.

```sh
cd contracts
./scripts/bootstrap.sh
forge test --no-match-contract AquaForkTest -vv
MAINNET_RPC_URL=https://mainnet.gateway.tenderly.co \
SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co \
forge test --match-contract AquaForkTest -vv
```

Bootstrap fetches exact revisions into ignored `lib/`: Aqua, SwapVM, solidity-utils 6.9.10, OpenZeppelin 5.4.0, and forge-std. Foundry pins Solidity 0.8.30, Cancun EVM, optimizer 200 runs, and via IR. Generated output stays in ignored `out/`, `cache/`, and `broadcast/`.

The suite contains local and pinned-chain fork tests. Fork tests skip when RPC variables are absent. Tests cover shared funding, cancellation, overlap, capacity, resale, booking revenue, pricing, signed economics, signatures, rollback, reentrancy, stateful invariants, and gas bounds. Fork balances are seeded by test cheatcodes.

## Sepolia

[Deployment metadata](deployments/sepolia.json) includes addresses and public purchase, resale, and 31-day transaction hashes. The recorded 31-day fill consumed 985,898 gas; the deployed router is 9,210 bytes. Those contracts were compiled with the same dependency versions from npm package paths; the current source-checkout layout changes compilation metadata. The measurement describes that deployed build.

That deployment predates the economic-terms opcodes and three-argument quote. Use a deployment of the current source for programs `0xa0` and `0xa1`.

Circle test USDC is used at `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Aqua bytecode at the checked Sepolia address matches the mainnet deployment, but Sepolia is not in Aqua's published supported-network list.

For a new deployment, set `FEE_RECIPIENT` and use `script/Deploy.s.sol` with a separately configured Foundry signer and Sepolia RPC. The script checks chain ID and Aqua code hash. Never place keys in this repository.

`RentalPoolResolver` maps one ENSv2 parent name's direct child labels to existing `RentalInventory` pool IDs. Its owner may change an alias, while EIP-712 rental orders continue to bind the concrete `bytes32` pool at signing. It implements the ENSv2 wildcard `resolve(bytes,bytes)` record for `pool(bytes32)`; the [Universal Resolver V2](https://docs.ens.domains/ensv2/universal-resolver-v2/) chooses the longest matching resolver. The backend checks that the returned resolver is this configured contract, so an overridden child is not silently accepted. The resolver's labels are deliberately limited to lowercase ASCII letters, digits and interior hyphens. Set the official Sepolia ENSv2 parent resolver through the [ETH Registrar](https://docs.ens.domains/ensv2/eth-registrar/) or an owned ENS name. Run `SEPOLIA_RPC_URL=<archive RPC> forge test --root contracts --match-path test/ENSFork.t.sol` to test the official registration and resolution path at pinned Sepolia block 11,786,600. The test seeds only fork-local USDC and ETH and is skipped when the RPC variable is absent.

The [Sepolia deployment metadata](deployments/sepolia.json) records a public ENSv2 registration and rental fill. `demo-room.rental-proof-73e27831.eth` first resolved to the deployed inventory's `demo room` pool. A wallet signed a bid and ask for that concrete pool, then the owner remapped the alias to another existing pool. The original signed order settled on the inventory router after the remap; the buyer received only the original pool's day token. The name is a mutable lookup, while order signatures bind pool bytes and router domain.

## Scope

One seller per fill; whole-unit quantities; contiguous future UTC dates up to 31 days. Legacy programs retain the 1% buyer-paid fee; economic-terms programs can set fees up to 10% and discounts up to 90%. Independent orders share conditional funding; OCO groups permit only one successful alternative. No crowdsourcing threshold, pooled buyer commitment, or collective activation is implemented.

[The specification](SPEC.md) defines the signed schema and trust boundaries. A separate router can trade revenue claims; booking USDC backs their eventual payout. Supplier fulfillment, offchain duplicate inventory, multi-unit revenue rights, refunds, and guaranteed liquidity remain outside these contracts. The contracts have not been audited.
