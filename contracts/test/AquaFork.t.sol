// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture, TestUSDC} from "./Fixture.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";

contract AquaForkTest is Fixture {
    function testCanonicalMainnetAquaAndUSDC() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        _prove(rpc, 26060000, 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    }

    function testSepoliaAquaAndCircleTestUSDC() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        _prove(rpc, 11785349, 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238);
    }

    function _prove(string memory rpc, uint256 blockNumber, address token) internal {
        vm.createSelectFork(rpc, blockNumber);
        super.setUp();
        aqua = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
        assertEq(address(aqua).codehash, 0x720bc02d220db318164dc3bade86eec1f3655bdc00fc1174de7d816a95c341f8);
        // Real token proxy/implementation on the fork; only balances are seeded by cheatcode.
        usd = TestUSDC(token);
        assertEq(usd.decimals(), 6);
        deal(token, buyer, 1000e6);
        deal(token, other, 1000e6);
        uint256 sellerBefore = usd.balanceOf(seller);
        uint256 feesBefore = usd.balanceOf(fees);
        router = new RentalSwapVM(aqua, inventory, token, fees);
        vm.prank(seller);
        inventory.setApprovalForAll(address(router), true);
        mandate = _fund(buyer, 1000e6, bytes32(uint256(1)));
        bytes memory p = fixedProgram(700e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        _fill(b, s, p);
        assertEq(usd.balanceOf(buyer), 293e6);
        assertEq(usd.balanceOf(seller) - sellerBefore, 700e6);
        assertEq(usd.balanceOf(fees) - feesBefore, 7e6);
        RentalSettlement.Mandate memory m = _fund(other, 1000e6, bytes32(uint256(2)));
        (b, s) = _orders(day, day + 7, 2, p);
        b.maker = other;
        b.recipient = other;
        b.mandate = keccak256(abi.encode(m));
        bytes memory bs = _sig(b, OTHER_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        uint256 soldId = inventory.tokenId(POOL, day, TERMS);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("ERC1155InsufficientBalance(address,uint256,uint256,uint256)")),
                seller,
                uint256(0),
                uint256(1),
                soldId
            )
        );
        router.settle(b, bs, s, ss, m, p);
        assertEq(usd.balanceOf(other), 1000e6);
        assertEq(router.spent(b.mandate), 0);
        (uint248 remaining,) = aqua.rawBalances(other, address(router), b.mandate, token);
        assertEq(remaining, 1000e6);
        assertFalse(router.used(other, 2));
        assertFalse(router.used(seller, 2));
    }
}
