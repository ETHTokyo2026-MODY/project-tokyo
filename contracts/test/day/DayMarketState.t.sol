// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RentalAsset} from "../../src/day/RentalAsset.sol";
import {RentalAssetFactory} from "../../src/day/RentalAssetFactory.sol";
import {DayToken} from "../../src/day/DayToken.sol";
import {BookingCurve} from "../../src/pricing/BookingCurve.sol";

contract DayMarketStateTest is Test {
    RentalAssetFactory private factory;
    RentalAsset private asset;
    address private host = address(0xA11CE);
    address private buyer = address(0xB0B);
    address private relayer = address(0xCAFE);
    uint32 private today;
    uint32 private serviceDay;

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new RentalAssetFactory();
        vm.prank(host);
        asset = RentalAsset(factory.createAsset(bytes32("room"), "ipfs://room", _defaults(), _steps()));
        today = asset.currentDay();
        serviceDay = today + 10;
    }

    function testDefaultsUseWeekdayPricesAndIndependentSellingPrice() public view {
        assertEq(asset.metadataURI(), "ipfs://room");
        RentalAsset.DayView[] memory states = asset.rangeState(today, today + 7);
        for (uint32 i; i < 7; ++i) {
            uint128 weekday = uint128((uint256(today + i) + 4) % 7);
            assertEq(states[i].listedPrice, 80e6 + weekday * 1e6);
            assertEq(states[i].sellingPrice, 60e6 + weekday);
            assertTrue(states[i].listed);
            assertFalse(states[i].booked);
        }
        (uint128 minimum, BookingCurve.Point[] memory points) = asset.curve(serviceDay);
        assertEq(minimum, 40e6);
        assertEq(points.length, 2);
        assertEq(points[0].day, today);
        assertEq(points[1].day, serviceDay);
        assertEq(points[1].price, minimum);
    }

    function testOnlyOwnerCanEditListingsAndCurveBeforeMaterializationOrAfterSale() public {
        vm.prank(buyer);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setListing(serviceDay, serviceDay + 1, false, 1);
        vm.prank(host);
        asset.setListing(serviceDay, serviceDay + 1, false, 1);
        assertFalse(asset.dayState(serviceDay).listed);
        _transfer(serviceDay, host, buyer);
        vm.prank(host);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setListedPrice(serviceDay, serviceDay + 1, 80e6);
        vm.startPrank(buyer);
        asset.setListing(serviceDay, serviceDay + 1, true, 123);
        asset.setCurve(serviceDay, 20e6, _points(serviceDay, 50e6, 20e6));
        vm.stopPrank();
        RentalAsset.DayView memory state = asset.dayState(serviceDay);
        assertEq(state.sellingPrice, 123);
        assertEq(state.listedPrice, 50e6);
        assertEq(state.saleNonce, 1);
        assertTrue(state.listed);
    }

    function testMixedOwnershipRangeEditRollsBackEveryEarlierDay() public {
        _transfer(serviceDay + 1, host, buyer);
        uint128 before = asset.dayState(serviceDay).sellingPrice;
        vm.prank(host);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setListing(serviceDay, serviceDay + 2, false, 2);
        assertEq(asset.dayState(serviceDay).sellingPrice, before);
        assertTrue(asset.dayState(serviceDay).listed);
    }

    function testBookingLocksPublicPriceButAllowsResaleAndUnbookResumesRetainedCurve() public {
        BookingCurve.Point[] memory points = _points(serviceDay, 100e6, 40e6);
        vm.startPrank(host);
        asset.setCurve(serviceDay, 40e6, points);
        asset.setBooked(serviceDay, true, 100e6);
        vm.expectRevert(RentalAsset.InvalidBooking.selector);
        asset.setListedPrice(serviceDay, serviceDay + 1, 90e6);
        vm.expectRevert(RentalAsset.InvalidBooking.selector);
        asset.setCurve(serviceDay, 40e6, points);
        vm.stopPrank();
        vm.warp(block.timestamp + 5 days);
        _transfer(serviceDay, host, buyer);
        RentalAsset.DayView memory state = asset.dayState(serviceDay);
        assertEq(state.owner, buyer);
        assertTrue(state.booked);
        assertFalse(state.listed);
        assertEq(state.listedPrice, 100e6);
        assertEq(asset.listedPriceAt(serviceDay, today + 5), 70e6);
        vm.prank(buyer);
        asset.setListing(serviceDay, serviceDay + 1, true, 25e6);
        assertEq(asset.dayState(serviceDay).listedPrice, 100e6);
        vm.prank(host);
        asset.setBooked(serviceDay, false, 100e6);
        state = asset.dayState(serviceDay);
        assertFalse(state.booked);
        assertTrue(state.listed);
        assertEq(state.sellingPrice, 25e6);
        assertEq(state.listedPrice, 70e6);
        (, BookingCurve.Point[] memory retained) = asset.curve(serviceDay);
        assertEq(keccak256(abi.encode(retained)), keccak256(abi.encode(points)));
    }

    function testBookingRolesRevocationAndRaceGuard() public {
        _transfer(serviceDay, host, buyer);
        uint128 price = asset.dayState(serviceDay).listedPrice;
        vm.startPrank(buyer);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setBooked(serviceDay, true, price);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setBookingRelayer(relayer, true);
        vm.stopPrank();
        vm.startPrank(host);
        asset.setBookingRelayer(relayer, true);
        vm.expectRevert(RentalAsset.InvalidBooking.selector);
        asset.setBooked(serviceDay, true, price + 1);
        vm.stopPrank();
        vm.prank(relayer);
        asset.setBooked(serviceDay, true, price);
        vm.prank(relayer);
        vm.expectRevert(RentalAsset.InvalidBooking.selector);
        asset.setBooked(serviceDay, true, price);
        vm.prank(host);
        asset.setBookingRelayer(relayer, false);
        vm.prank(relayer);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setBooked(serviceDay, false, price);
        vm.prank(host);
        vm.expectRevert(RentalAsset.InvalidBooking.selector);
        asset.setBooked(serviceDay, false, price + 1);
        assertTrue(asset.dayState(serviceDay).booked);
    }

    function testSetListedPriceReanchorsOnlyOnExplicitEditAndKeepsFuturePoints() public {
        BookingCurve.Point[] memory points = new BookingCurve.Point[](3);
        points[0] = BookingCurve.Point(today, 100e6);
        points[1] = BookingCurve.Point(today + 4, 80e6);
        points[2] = BookingCurve.Point(serviceDay, 40e6);
        vm.prank(host);
        asset.setCurve(serviceDay, 40e6, points);
        vm.warp(block.timestamp + 2 days);
        asset.dayState(serviceDay);
        (, BookingCurve.Point[] memory unchanged) = asset.curve(serviceDay);
        assertEq(keccak256(abi.encode(unchanged)), keccak256(abi.encode(points)));
        vm.prank(host);
        asset.setListedPrice(serviceDay, serviceDay + 1, 70e6);
        (uint128 minimum, BookingCurve.Point[] memory changed) = asset.curve(serviceDay);
        assertEq(minimum, 40e6);
        assertEq(changed.length, 3);
        assertEq(changed[0].day, today + 2);
        assertEq(changed[0].price, 70e6);
        assertEq(changed[1].day, today + 4);
        assertEq(changed[1].price, 80e6);
        assertEq(changed[2].day, serviceDay);
        assertEq(asset.dayState(serviceDay).listedPrice, 70e6);
    }

    function testTodayCurveAndPriceEditsRemainAllowedButPastEditsFail() public {
        BookingCurve.Point[] memory points = new BookingCurve.Point[](1);
        points[0] = BookingCurve.Point(today, 70e6);
        vm.startPrank(host);
        asset.setCurve(today, 40e6, points);
        asset.setListedPrice(today, today + 1, 60e6);
        asset.setBooked(today, true, 60e6);
        vm.warp(uint256(today + 1) * 1 days - 9 hours);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.setListing(today, today + 1, true, 1);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.setListedPrice(today, today + 1, 50e6);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.setCurve(today, 40e6, points);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.setBooked(today, false, 60e6);
        vm.stopPrank();
        assertEq(asset.dayState(today).listedPrice, 60e6);
        assertFalse(asset.dayState(today).listed);
    }

    function testCurveRequiresWholeUsdFloorAndValidPointDates() public {
        BookingCurve.Point[] memory points = _points(serviceDay, 100e6, 40e6);
        vm.startPrank(host);
        vm.expectRevert(RentalAsset.InvalidPrice.selector);
        asset.setCurve(serviceDay, 40500000, points);
        vm.expectRevert(RentalAsset.InvalidPrice.selector);
        asset.setListedPrice(serviceDay, serviceDay + 1, 39500000);
        points[0].price = 100500000;
        vm.expectRevert(RentalAsset.InvalidPrice.selector);
        asset.setCurve(serviceDay, 40e6, points);
        points[0].price = 100e6;
        points[1].day = today;
        vm.expectRevert(BookingCurve.InvalidPoints.selector);
        asset.setCurve(serviceDay, 40e6, points);
        vm.stopPrank();
    }

    function testInvalidInitialFloorAndSellingPriceRevertCreation() public {
        RentalAsset.AssetDefaults memory defaults = _defaults();
        defaults.minimum = 90e6;
        vm.expectRevert(RentalAsset.InvalidPrice.selector);
        factory.createAsset(bytes32("invalid"), "", defaults, _steps());
        defaults = _defaults();
        defaults.sellingPrices[0] = 0;
        vm.expectRevert(RentalAsset.InvalidPrice.selector);
        factory.createAsset(bytes32("invalid"), "", defaults, _steps());
    }

    function testMaximumWholeDollarPriceAndLongestCurveStayWithinUint128() public {
        uint128 highest = type(uint128).max / 1e6 * 1e6;
        uint32 last = today + 364;
        vm.prank(host);
        asset.setCurve(last, 1e6, _points(last, highest, highest));
        assertEq(asset.listedPriceAt(last, today + 183), highest);
    }

    function testHostLadderVersionThresholdsAndFullDiscount() public {
        assertEq(asset.discountVersion(), 1);
        assertEq(asset.discountBps(1), 0);
        assertEq(asset.discountBps(2), 0);
        assertEq(asset.discountBps(3), 1000);
        assertEq(asset.discountBps(6), 1000);
        assertEq(asset.discountBps(7), 2000);
        vm.prank(buyer);
        vm.expectRevert(RentalAsset.Unauthorized.selector);
        asset.setDiscountLadder(_steps());
        RentalAsset.DiscountStep[] memory steps = _steps();
        steps[1] = RentalAsset.DiscountStep(365, 10000);
        vm.prank(host);
        asset.setDiscountLadder(steps);
        assertEq(asset.discountVersion(), 2);
        assertEq(asset.discountBps(365), 10000);
        vm.prank(host);
        asset.setDiscountLadder(new RentalAsset.DiscountStep[](0));
        assertEq(asset.discountVersion(), 3);
        assertEq(asset.discountBps(365), 0);
    }

    function testInvalidLadderRollsBackReplacementAndVersion() public {
        RentalAsset.DiscountStep[] memory steps = _steps();
        steps[1].minDays = steps[0].minDays;
        vm.startPrank(host);
        vm.expectRevert(RentalAsset.InvalidDiscounts.selector);
        asset.setDiscountLadder(steps);
        steps[1] = RentalAsset.DiscountStep(7, 10001);
        vm.expectRevert(RentalAsset.InvalidDiscounts.selector);
        asset.setDiscountLadder(steps);
        vm.stopPrank();
        assertEq(asset.discountVersion(), 1);
        assertEq(asset.discountBps(7), 2000);
    }

    function _transfer(uint32 day, address from, address to) private {
        DayToken token = DayToken(asset.materialize(day));
        vm.prank(from);
        token.transfer(to, 1);
    }

    function _points(uint32 day, uint128 first, uint128 last)
        private
        view
        returns (BookingCurve.Point[] memory points)
    {
        points = new BookingCurve.Point[](2);
        points[0] = BookingCurve.Point(today, first);
        points[1] = BookingCurve.Point(day, last);
    }

    function _defaults() private pure returns (RentalAsset.AssetDefaults memory defaults) {
        defaults.minimum = 40e6;
        for (uint128 i; i < 7; ++i) {
            defaults.listedPrices[i] = 80e6 + i * 1e6;
            defaults.sellingPrices[i] = 60e6 + i;
        }
    }

    function _steps() private pure returns (RentalAsset.DiscountStep[] memory steps) {
        steps = new RentalAsset.DiscountStep[](2);
        steps[0] = RentalAsset.DiscountStep(3, 1000);
        steps[1] = RentalAsset.DiscountStep(7, 2000);
    }
}
