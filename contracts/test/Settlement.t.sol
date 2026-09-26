// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "./Fixture.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";

contract SettlementTest is Fixture {
    function testWeeklyAtomicSettlement() public {
        bytes memory p = fixedProgram(700e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        assertEq(usd.balanceOf(buyer), 1000e6);
        _fill(b, s, p);
        assertEq(usd.balanceOf(buyer), 293e6);
        assertEq(usd.balanceOf(seller), 700e6);
        assertEq(usd.balanceOf(fees), 7e6);
        assertEq(router.spent(b.mandate), 707e6);
        for (uint32 d = day; d < day + 7; ++d) {
            assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, d, TERMS)), 1);
            assertEq(inventory.balanceOf(seller, inventory.tokenId(POOL, d, TERMS)), 0);
        }
    }

    function testDailyThenWeeklyConflictIndependentBuyer() public {
        bytes memory p = fixedProgram(100e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day + 2, day + 3, 1, p);
        _fill(b, s, p);
        RentalSettlement.Mandate memory m = _fund(other, 1000e6, bytes32(uint256(2)));
        p = fixedProgram(700e6);
        (b, s) = _orders(day, day + 7, 2, p);
        b.maker = other;
        b.recipient = other;
        b.mandate = keccak256(abi.encode(m));
        bytes memory bs = _sig(b, OTHER_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        vm.expectRevert();
        router.settle(b, bs, s, ss, m, p);
        assertEq(usd.balanceOf(other), 1000e6);
        assertEq(router.spent(b.mandate), 0);
        assertFalse(router.used(other, 2));
        assertFalse(router.used(seller, 2));
        assertEq(inventory.balanceOf(other, inventory.tokenId(POOL, day, TERMS)), 0);
    }

    function testAlternativeGroupWithSufficientInventoryAndFunds() public {
        bytes memory p = fixedProgram(100e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 1, 1, p);
        b.group = bytes32(uint256(42));
        _fill(b, s, p);
        (b, s) = _orders(day + 1, day + 2, 2, p);
        b.group = bytes32(uint256(42));
        bytes memory bs = _sig(b, BUY_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        vm.expectRevert(RentalSettlement.ClosedOrder.selector);
        router.settle(b, bs, s, ss, mandate, p);
        assertEq(usd.balanceOf(buyer), 899e6);
    }

    function testIndependentOrdersShareWallet() public {
        bytes memory p = fixedProgram(100e6);
        for (uint32 n; n < 3; ++n) {
            (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day + n, day + n + 1, n, p);
            _fill(b, s, p);
        }
        assertEq(usd.balanceOf(buyer), 697e6);
    }

    function testCancellationAndDock() public {
        bytes memory p = fixedProgram(100e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 1, 1, p);
        bytes memory bs = _sig(b, BUY_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        vm.prank(buyer);
        router.cancel(1);
        vm.expectRevert(RentalSettlement.ClosedOrder.selector);
        router.settle(b, bs, s, ss, mandate, p);
        (b, s) = _orders(day, day + 1, 2, p);
        bs = _sig(b, BUY_KEY);
        ss = _sig(s, SELL_KEY);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vm.prank(buyer);
        aqua.dock(address(router), b.mandate, tokens);
        vm.expectRevert(RentalSettlement.InvalidMandate.selector);
        router.settle(b, bs, s, ss, mandate, p);
    }

    function testSpentWalletFailsWithoutConsumingOrder() public {
        bytes memory p = fixedProgram(700e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        bytes memory bs = _sig(b, BUY_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        vm.prank(buyer);
        usd.transfer(other, 900e6);
        vm.expectRevert();
        router.settle(b, bs, s, ss, mandate, p);
        assertFalse(router.used(buyer, 1));
        assertEq(router.spent(b.mandate), 0);
    }

    function testBudgetDoesNotResetOnWalletOrAquaRefill() public {
        bytes memory p = fixedProgram(700e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        _fill(b, s, p);
        usd.mint(buyer, 1000e6);
        usd.mint(address(this), 1000e6);
        usd.approve(address(aqua), 1000e6);
        aqua.push(buyer, address(router), b.mandate, address(usd), 1000e6);
        p = fixedProgram(400e6);
        (b, s) = _orders(day + 7, day + 8, 2, p);
        bytes memory bs = _sig(b, BUY_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        vm.expectRevert(RentalSettlement.BudgetExceeded.selector);
        router.settle(b, bs, s, ss, mandate, p);
        assertEq(router.spent(b.mandate), 707e6);
    }

    function testResaleWithoutIssuance() public {
        bytes memory p = fixedProgram(700e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        _fill(b, s, p);
        RentalSettlement.Mandate memory m = _fund(other, 1000e6, bytes32(uint256(2)));
        p = fixedProgram(250e6);
        (b, s) = _orders(day, day + 2, 2, p);
        b.maker = other;
        b.recipient = other;
        b.mandate = keccak256(abi.encode(m));
        s.maker = buyer;
        s.recipient = buyer;
        vm.prank(buyer);
        inventory.setApprovalForAll(address(router), true);
        router.settle(b, _sig(b, OTHER_KEY), s, _sig(s, BUY_KEY), m, p);
        assertEq(usd.balanceOf(buyer), 543e6);
        assertEq(usd.balanceOf(other), 7475e5);
        assertEq(inventory.balanceOf(other, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(inventory.issued(POOL, day), 1);
    }

    function testFungibleMultipleRoomsAndInventoryMovedAway() public {
        bytes32 pool = keccak256("three rooms");
        inventory.createPool(pool, seller, day, day + 7, 3);
        vm.prank(seller);
        inventory.issue(pool, day, day + 7, TERMS, 3);
        bytes memory p = fixedProgram(200e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 2, 1, p);
        b.pool = pool;
        s.pool = pool;
        b.quantity = 2;
        s.quantity = 2;
        _fill(b, s, p);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(pool, day, TERMS)), 2);
        assertEq(inventory.balanceOf(seller, inventory.tokenId(pool, day, TERMS)), 1);
        uint256 movedId = inventory.tokenId(pool, day, TERMS);
        vm.prank(seller);
        inventory.safeTransferFrom(seller, other, movedId, 1, "");
        (b, s) = _orders(day, day + 1, 2, p);
        b.pool = pool;
        s.pool = pool;
        bytes memory bs = _sig(b, BUY_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        vm.expectRevert();
        router.settle(b, bs, s, ss, mandate, p);
        assertEq(usd.balanceOf(buyer), 798e6);
        assertFalse(router.used(buyer, 2));
    }

    function testCapacitySharedAcrossTerms() public {
        vm.prank(seller);
        vm.expectRevert();
        inventory.issue(POOL, day, day + 1, keccak256("other terms"), 1);
    }

    function testDutchPriceActuallyDrivesPayment() public {
        uint256 start = block.timestamp;
        bytes memory p = dutchProgram(700e6, 500e6, start, start + 1000);
        (uint256 q,) = router.quote(p, 7);
        assertEq(q, 700e6);
        vm.warp(start + 500);
        (q,) = router.quote(p, 7);
        assertEq(q, 600e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        _fill(b, s, p);
        assertEq(usd.balanceOf(seller), 600e6);
        assertEq(usd.balanceOf(buyer), 394e6);
        vm.warp(start + 2000);
        (q,) = router.quote(p, 7);
        assertEq(q, 500e6);
    }

    function testFuzzPriceAndFeeConservation(uint96 raw) public {
        uint256 price = bound(raw, 1, 990e6);
        bytes memory p = fixedProgram(price);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 1, 1, p);
        _fill(b, s, p);
        assertEq(usd.balanceOf(buyer) + usd.balanceOf(seller) + usd.balanceOf(fees), 1000e6);
        assertEq(router.spent(b.mandate), price + price / 100);
    }

    function testGas31SlotsBelowTwoMillion() public {
        bytes memory p = fixedProgram(700e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 31, 1, p);
        bytes memory bs = _sig(b, BUY_KEY);
        bytes memory ss = _sig(s, SELL_KEY);
        uint256 beforeGas = gasleft();
        router.settle(b, bs, s, ss, mandate, p);
        uint256 usedGas = beforeGas - gasleft();
        emit log_named_uint("31-slot settlement gas (warm fixture)", usedGas);
        assertLt(usedGas, 2_000_000);
        assertLt(address(router).code.length, 24576);
    }
}
