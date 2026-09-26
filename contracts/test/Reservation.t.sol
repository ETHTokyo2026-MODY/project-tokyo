// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "./Fixture.sol";
import {RentalInventory} from "../src/RentalInventory.sol";

contract ReservationTest is Fixture {
    function testHolderAllocatesCapacityOneBasketToBeneficiary() public {
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        for (uint32 d = day; d < day + 2; ++d) {
            ids[d - day] = inventory.tokenId(POOL, d, TERMS);
            amounts[d - day] = 1;
        }
        vm.prank(seller);
        inventory.safeBatchTransferFrom(seller, buyer, ids, amounts, "");

        vm.prank(buyer);
        uint256 id = inventory.reserve(buyer, POOL, day, day + 2, TERMS, 1, other);
        assertEq(id, 1);
        assertEq(inventory.nextReservationId(), 2);
        (address holder, address beneficiary, bytes32 pool, uint32 start, uint32 end, bytes32 terms, uint256 quantity) =
            inventory.reservations(id);
        assertEq(holder, buyer);
        assertEq(beneficiary, other);
        assertEq(pool, POOL);
        assertEq(start, day);
        assertEq(end, day + 2);
        assertEq(terms, TERMS);
        assertEq(quantity, 1);
        for (uint32 d = day; d < day + 2; ++d) {
            assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, d, TERMS)), 0);
            assertEq(inventory.issued(POOL, d), 1);
            assertEq(inventory.consumed(POOL, d), 1);
        }
        vm.prank(buyer);
        vm.expectRevert();
        inventory.reserve(buyer, POOL, day, day + 2, TERMS, 1, other);
        vm.prank(seller);
        vm.expectRevert(RentalInventory.InvalidInventory.selector);
        inventory.issue(POOL, day, day + 1, keccak256("new terms"), 1);
    }

    function testOnlyHolderOrApprovedOperatorCanChooseBeneficiary() public {
        vm.prank(other);
        vm.expectRevert(RentalInventory.InvalidInventory.selector);
        inventory.reserve(seller, POOL, day, day + 1, TERMS, 1, other);
        vm.prank(seller);
        inventory.setApprovalForAll(other, true);
        vm.prank(other);
        uint256 id = inventory.reserve(seller, POOL, day, day + 1, TERMS, 1, buyer);
        (address holder, address beneficiary,,,,,) = inventory.reservations(id);
        assertEq(holder, seller);
        assertEq(beneficiary, buyer);
        assertEq(inventory.consumed(POOL, day), 1);
    }

    function testMissingDayRollsBackEntireAllocation() public {
        uint256 firstId = inventory.tokenId(POOL, day, TERMS);
        vm.prank(seller);
        inventory.safeTransferFrom(seller, buyer, firstId, 1, "");
        vm.prank(buyer);
        vm.expectRevert();
        inventory.reserve(buyer, POOL, day, day + 2, TERMS, 1, buyer);
        assertEq(inventory.nextReservationId(), 1);
        assertEq(inventory.consumed(POOL, day), 0);
        assertEq(inventory.consumed(POOL, day + 1), 0);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 1);
    }

    function testTermsCannotBeSubstitutedAndRangeCannotExceedThirtyOneDays() public {
        vm.prank(seller);
        vm.expectRevert();
        inventory.reserve(seller, POOL, day, day + 1, keccak256("different terms"), 1, buyer);
        assertEq(inventory.consumed(POOL, day), 0);

        bytes32 pool = keccak256("long-range");
        inventory.createPool(pool, seller, day, day + 32, 1);
        vm.prank(seller);
        inventory.issue(pool, day, day + 31, TERMS, 1);
        vm.prank(seller);
        inventory.issue(pool, day + 31, day + 32, TERMS, 1);
        vm.prank(seller);
        vm.expectRevert(RentalInventory.InvalidInventory.selector);
        inventory.reserve(seller, pool, day, day + 32, TERMS, 1, buyer);
        assertEq(inventory.consumed(pool, day), 0);
    }

    function testWholeQuantityAndFutureBoundedRange() public {
        bytes32 pool = keccak256("three-interchangeable-units");
        inventory.createPool(pool, seller, day, day + 31, 3);
        vm.prank(seller);
        inventory.issue(pool, day, day + 31, TERMS, 3);
        vm.prank(seller);
        inventory.reserve(seller, pool, day, day + 31, TERMS, 2, buyer);
        assertEq(inventory.balanceOf(seller, inventory.tokenId(pool, day, TERMS)), 1);
        assertEq(inventory.consumed(pool, day), 2);
        assertEq(inventory.consumed(pool, day + 30), 2);
        vm.prank(seller);
        vm.expectRevert(RentalInventory.InvalidInventory.selector);
        inventory.reserve(seller, pool, day, day + 1, TERMS, 0, buyer);
        vm.prank(seller);
        vm.expectRevert(RentalInventory.InvalidInventory.selector);
        inventory.reserve(seller, pool, day, day + 31, TERMS, 1, address(0));
        vm.warp(uint256(day) * 1 days);
        vm.prank(seller);
        vm.expectRevert(RentalInventory.InvalidInventory.selector);
        inventory.reserve(seller, pool, day, day + 1, TERMS, 1, buyer);
    }
}
