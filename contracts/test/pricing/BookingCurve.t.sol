// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {BookingCurve} from "../../src/pricing/BookingCurve.sol";

contract BookingCurveTest is Test {
    function testFrontendVectorsAndNoReadReanchoring() public pure {
        BookingCurve.Point[] memory points = new BookingCurve.Point[](2);
        points[0] = BookingCurve.Point(100, 80e6);
        points[1] = BookingCurve.Point(110, 40e6);
        BookingCurve.validate(points, 100, 110);
        assertEq(BookingCurve.priceAt(points, 40e6, 99), 80e6);
        assertEq(BookingCurve.priceAt(points, 40e6, 102), 79e6);
        assertEq(BookingCurve.priceAt(points, 40e6, 105), 60e6);
        assertEq(BookingCurve.priceAt(points, 50e6, 111), 50e6);
        assertEq(points[0].day, 100);
        assertEq(points[0].price, 80e6);
    }

    function testHalfDollarRoundsUpAndSinglePointWorks() public pure {
        BookingCurve.Point[] memory points = new BookingCurve.Point[](1);
        points[0] = BookingCurve.Point(100, 40500000);
        BookingCurve.validate(points, 100, 100);
        assertEq(BookingCurve.priceAt(points, 0, 100), 41e6);
    }

    function testFuzzDecliningCurveStaysMonotone(uint128 start, uint128 end, uint16 offset) public pure {
        start = uint128(bound(start, 1, 1e12)) * 1e6;
        end = uint128(bound(end, 0, start / 1e6)) * 1e6;
        uint32 day = uint32(bound(offset, 100, 463));
        BookingCurve.Point[] memory points = new BookingCurve.Point[](2);
        points[0] = BookingCurve.Point(100, start);
        points[1] = BookingCurve.Point(464, end);
        uint256 price = BookingCurve.priceAt(points, 0, day);
        assertLe(price, start);
        assertGe(price, end);
        assertGe(price, BookingCurve.priceAt(points, 0, day + 1));
    }
}
