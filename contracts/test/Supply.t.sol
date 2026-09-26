// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RentalInventory} from "../src/RentalInventory.sol";

contract SupplyTest is Test {
    function testTargetReplayDoesNotReplenishTransferredSupply() public {
        RentalInventory inventory = new RentalInventory();
        address supplier = address(1);
        bytes32 pool = keccak256("unit");
        bytes32 terms = keccak256("terms");
        uint32 day = uint32(block.timestamp / 1 days) + 2;
        inventory.createPool(pool, supplier, day, day + 7, 2);
        vm.startPrank(supplier);
        inventory.publishDay(pool, day, terms, 1);
        uint256 id = inventory.tokenId(pool, day, terms);
        inventory.safeTransferFrom(supplier, address(2), id, 1, "");
        inventory.publishDay(pool, day, terms, 1);
        assertEq(inventory.balanceOf(supplier, id), 0);
        assertEq(inventory.issued(pool, day), 1);
        inventory.publishDay(pool, day, terms, 2);
        assertEq(inventory.balanceOf(supplier, id), 1);
        vm.expectRevert();
        inventory.publishDay(pool, day, terms, 3);
        vm.stopPrank();
        vm.expectRevert();
        inventory.publishDay(pool, day, terms, 2);
        vm.warp(uint256(day) * 1 days);
        vm.prank(supplier);
        vm.expectRevert();
        inventory.publishDay(pool, day, terms, 2);
    }
}
