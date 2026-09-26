// SPDX-License-Identifier: LicenseRef-Degensoft-Aqua-Source-1.1 AND LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RentalInventory} from "../../src/RentalInventory.sol";
import {AquaVapor} from "../../src/native/AquaVapor.sol";
import {AssetSwapVM} from "../../src/native/AssetSwapVM.sol";
import {StaticBalances} from "swap-vm/instructions/Balances.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";

/// @notice Executes the native path against Circle's actual Sepolia USDC implementation on a local fork.
/// @dev Funds are seeded only in the fork. This is not a public deployment or public transaction.
contract NativeSepoliaForkTest is Test {
    function testCircleUSDCNativeBasket() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, 11_786_600);
        address usd = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
        require(usd.code.length != 0, "Circle USDC missing");
        AquaVapor aqua = new AquaVapor();
        AssetSwapVM router = new AssetSwapVM(aqua, usd);
        RentalInventory inventory = new RentalInventory();
        address host = makeAddr("host");
        address buyer = makeAddr("buyer");
        uint32 day = uint32(block.timestamp / 1 days + 10);
        bytes32 pool = keccak256("pool");
        bytes32 terms = keccak256("terms");
        inventory.createPool(pool, host, day, day + 7, 1);
        vm.prank(host);
        inventory.issue(pool, day, day + 7, terms, 1);
        uint256[] memory ids = new uint256[](7);
        for (uint32 i; i < 7; ++i) {
            ids[i] = inventory.tokenId(pool, day + i, terms);
        }
        // Token IDs are hashes, not chronological counters. Canonicalize before authorizing the basket.
        for (uint256 i = 1; i < ids.length; ++i) {
            uint256 id = ids[i];
            uint256 j = i;
            while (j > 0 && ids[j - 1] > id) {
                ids[j] = ids[j - 1];
                --j;
            }
            ids[j] = id;
        }
        AssetSwapVM.Strategy memory bid = AssetSwapVM.Strategy(
            buyer, address(inventory), ids, 1, true, bytes32(0), _program(usd, address(inventory), 300e6)
        );
        AssetSwapVM.Strategy memory ask = AssetSwapVM.Strategy(
            host, address(inventory), ids, 1, false, bytes32(0), _program(usd, address(inventory), 290e6)
        );
        deal(usd, buyer, 300e6);
        vm.prank(buyer);
        IERC20(usd).approve(address(aqua), 300e6);
        vm.prank(host);
        inventory.setApprovalForAll(address(aqua), true);
        AquaVapor.Asset[] memory money = new AquaVapor.Asset[](1);
        uint256[] memory amount = new uint256[](1);
        money[0] = AquaVapor.Asset(AquaVapor.Kind.ERC20, usd, 0);
        amount[0] = 300e6;
        vm.prank(buyer);
        aqua.ship(address(router), abi.encode(bid), money, amount);
        (AquaVapor.Asset[] memory assets, uint256[] memory units) = router.basket(ask);
        vm.prank(host);
        aqua.ship(address(router), abi.encode(ask), assets, units);
        router.swap(bid, ask);
        assertEq(IERC20(usd).balanceOf(buyer), 10e6);
        assertEq(IERC20(usd).balanceOf(host), 290e6);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(inventory.balanceOf(buyer, ids[i]), 1);
        }
        assertEq(IERC20(usd).balanceOf(address(aqua)), 0);
    }

    function _program(address usd, address inventory, uint256 price) private pure returns (bytes memory) {
        bytes memory balances = usd < inventory ? StaticBalances.build(price, 1) : StaticBalances.build(1, price);
        return bytes.concat(balances, LimitSwapFullAmount.build(usd, inventory));
    }
}
