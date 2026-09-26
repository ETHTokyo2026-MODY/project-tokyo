// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "./Fixture.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";

contract EconomicTermsTest is Fixture {
    function fixedTerms(uint256 unitPrice, uint256 feeBps, uint256 threshold, uint256 discountBps)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(
            hex"a080", abi.encode(unitPrice, feeBps, threshold, discountBps), LimitSwapFullAmount.build(true)
        );
    }

    function dutchTerms(
        uint256 high,
        uint256 low,
        uint256 start,
        uint256 end,
        uint256 feeBps,
        uint256 threshold,
        uint256 discountBps
    ) internal pure returns (bytes memory) {
        return bytes.concat(
            hex"a1e0",
            abi.encode(high, low, start, end, feeBps, threshold, discountBps),
            LimitSwapFullAmount.build(true)
        );
    }

    function testSignedTermsQuoteAndSettlementAgree() public {
        bytes memory p = fixedTerms(10e6, 250, 7, 1000);
        (uint256 price, uint256 fee) = router.quote(p, 7, 1);
        assertEq(price, 63e6);
        assertEq(fee, 1_575_000);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        _fill(b, s, p);
        assertEq(usd.balanceOf(seller), price);
        assertEq(usd.balanceOf(fees), fee);
        assertEq(router.spent(b.mandate), price + fee);
        assertEq(usd.balanceOf(buyer), 1000e6 - price - fee);
    }

    function testDurationAndQuantityAreDistinctInputs() public {
        bytes32 pool = keccak256("two-room economics");
        inventory.createPool(pool, seller, day, day + 7, 2);
        vm.prank(seller);
        inventory.issue(pool, day, day + 7, TERMS, 2);
        bytes memory p = fixedTerms(10e6, 250, 7, 1000);
        (uint256 price, uint256 fee) = router.quote(p, 7, 2);
        assertEq(price, 126e6);
        assertEq(fee, 3_150_000);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        b.pool = pool;
        s.pool = pool;
        b.quantity = 2;
        s.quantity = 2;
        _fill(b, s, p);
        assertEq(usd.balanceOf(seller), price);
        assertEq(usd.balanceOf(fees), fee);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(pool, day, TERMS)), 2);
    }

    function testDiscountDependsOnCurrentBasketIncludingResale() public {
        bytes memory p = fixedTerms(10e6, 0, 7, 1000);
        (uint256 whole,) = router.quote(p, 7, 1);
        (uint256 first,) = router.quote(p, 3, 1);
        (uint256 second,) = router.quote(p, 4, 1);
        assertEq(whole, 63e6);
        assertEq(first + second, 70e6);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        _fill(b, s, p);
        RentalSettlement.Mandate memory resaleMandate = _fund(other, 1000e6, bytes32(uint256(2)));
        (b, s) = _orders(day, day + 7, 2, p);
        b.maker = other;
        b.recipient = other;
        b.mandate = keccak256(abi.encode(resaleMandate));
        s.maker = buyer;
        s.recipient = buyer;
        vm.prank(buyer);
        inventory.setApprovalForAll(address(router), true);
        router.settle(b, _sig(b, OTHER_KEY), s, _sig(s, BUY_KEY), resaleMandate, p);
        assertEq(usd.balanceOf(buyer), 1000e6);
        assertEq(usd.balanceOf(other), 1000e6 - whole);
        assertEq(inventory.issued(POOL, day), 1);
    }

    function testDutchCurveAndRounding() public {
        uint256 start = block.timestamp;
        bytes memory p = dutchTerms(11, 7, start, start + 100, 1000, 3, 3333);
        (uint256 price, uint256 fee) = router.quote(p, 3, 1);
        assertEq(price, 22); // floor(33 * 6667 / 10000)
        assertEq(fee, 2); // floor(22 * 1000 / 10000)
        vm.warp(start + 50);
        (price, fee) = router.quote(p, 3, 1);
        assertEq(price, 18);
        assertEq(fee, 1);
        vm.warp(start + 100);
        (price, fee) = router.quote(p, 3, 1);
        assertEq(price, 14);
        assertEq(fee, 1);
    }

    function testTamperedTermsAndFeeCapsRevertBeforeConsumption() public {
        bytes memory p = fixedTerms(10e6, 1000, 7, 1000);
        (RentalSettlement.Order memory b, RentalSettlement.Order memory s) = _orders(day, day + 7, 1, p);
        bytes memory altered = fixedTerms(10e6, 1000, 7, 900);
        bytes memory bidSig = _sig(b, BUY_KEY);
        bytes memory askSig = _sig(s, SELL_KEY);
        vm.expectRevert(RentalSettlement.InvalidOrder.selector);
        router.settle(b, bidSig, s, askSig, mandate, altered);
        b.maxFee = 6e6;
        bidSig = _sig(b, BUY_KEY);
        vm.expectRevert(RentalSettlement.PriceLimit.selector);
        router.settle(b, bidSig, s, askSig, mandate, p);
        b.maxFee = 10e6;
        s.maxFee = 6e6;
        bidSig = _sig(b, BUY_KEY);
        askSig = _sig(s, SELL_KEY);
        vm.expectRevert(RentalSettlement.PriceLimit.selector);
        router.settle(b, bidSig, s, askSig, mandate, p);
        assertFalse(router.used(buyer, 1));
        assertEq(router.spent(b.mandate), 0);
    }

    function testRejectsUnboundedOrNoncanonicalTerms() public {
        bytes memory p = fixedTerms(10e6, 1001, 7, 1000);
        vm.expectRevert();
        router.quote(p, 7, 1);
        p = fixedTerms(10e6, 0, 0, 9001);
        vm.expectRevert();
        router.quote(p, 7, 1);
        p = fixedTerms(10e6, 0, 7, 0);
        vm.expectRevert();
        router.quote(p, 7, 1);
        p = fixedTerms(uint256(type(uint128).max) + 1, 0, 0, 0);
        vm.expectRevert();
        router.quote(p, 7, 1);
        p = fixedTerms(10e6, 0, 0, 0);
        vm.expectRevert();
        router.quote(p, 7); // Duration is required for unit pricing.
    }
}
