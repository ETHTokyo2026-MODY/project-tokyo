// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title BookingCurve
/// @notice The website's cubic ease-in-out booking-price curve, evaluated deterministically.
/// @dev Prices use six-decimal USDC units. Published prices round half-up to whole USD,
/// matching the existing calendar. Reading never reanchors or mutates authored points.
library BookingCurve {
    uint256 internal constant USD = 1e6;

    struct Point {
        uint32 day;
        uint128 price;
    }

    error InvalidPoints();

    /// @notice Validate an authored curve spanning today through the service day.
    /// @dev A service day equal to today requires exactly one point.
    function validate(Point[] memory points, uint32 today, uint32 serviceDay) internal pure {
        uint256 length = points.length;
        if (length == 0 || points[0].day != today || points[length - 1].day != serviceDay) {
            revert InvalidPoints();
        }
        for (uint256 i = 1; i < length; ++i) {
            if (points[i].day <= points[i - 1].day) revert InvalidPoints();
        }
    }

    /// @notice Evaluate validated points at a Tokyo calendar day, clamping to endpoints and minimum.
    /// @param minimum Booking-price floor in raw USDC units.
    /// @return price Whole-dollar booking price expressed in raw USDC units.
    function priceAt(Point[] memory points, uint128 minimum, uint32 day) internal pure returns (uint256 price) {
        uint256 length = points.length;
        if (length == 0) revert InvalidPoints();
        uint256 numerator;
        uint256 denominator = 1;
        if (day <= points[0].day) {
            numerator = points[0].price;
        } else if (day >= points[length - 1].day) {
            numerator = points[length - 1].price;
        } else {
            uint256 i;
            while (day > points[i + 1].day) ++i;
            uint256 span = points[i + 1].day - points[i].day;
            uint256 elapsed = day - points[i].day;
            denominator = span ** 3;
            uint256 weight = 2 * elapsed <= span
                ? 4 * elapsed ** 3
                : denominator - 4 * (span - elapsed) ** 3;
            numerator = uint256(points[i].price) * (denominator - weight)
                + uint256(points[i + 1].price) * weight;
        }
        if (numerator < uint256(minimum) * denominator) numerator = uint256(minimum) * denominator;
        uint256 quantum = denominator * USD;
        price = ((numerator + quantum / 2) / quantum) * USD;
    }
}
