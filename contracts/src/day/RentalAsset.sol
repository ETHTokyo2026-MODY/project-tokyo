// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DayToken} from "./DayToken.sol";
import {BookingCurve} from "../pricing/BookingCurve.sol";

/// @title Rental item and fixed calendar
/// @notice A physical item's fixed 365-day calendar, owned by its host until transferred.
contract RentalAsset {
    struct DayView {
        address token;
        address owner;
        bool deployed;
        bool listed;
        uint64 saleNonce;
        bool booked;
        uint128 listedPrice;
        uint128 sellingPrice;
    }

    /// @dev Prices are raw six-decimal USDC; weekday arrays run Sunday through Saturday.
    struct AssetDefaults {
        uint128 minimum;
        uint128[7] listedPrices;
        uint128[7] sellingPrices;
    }

    struct DiscountStep {
        uint16 minDays;
        uint16 discountBps;
    }

    enum Listing {
        Default,
        Listed,
        Unlisted
    }

    struct MarketState {
        uint128 sellingPrice;
        uint128 bookedPrice;
        uint64 saleNonce;
        Listing listing;
        bool booked;
    }

    struct Curve {
        uint128 minimum;
        BookingCurve.Point[] points;
    }

    address public immutable host;
    uint32 public immutable startDay;
    uint32 public immutable endDayExclusive;
    address public immutable dayTokenImplementation;
    string public metadataURI;
    uint64 public discountVersion;
    mapping(address => bool) public bookingRelayers;
    AssetDefaults private initialPrices;
    DiscountStep[] private discounts;
    mapping(uint32 => MarketState) private market;
    mapping(uint32 => Curve) private curves;

    error InvalidAsset();
    error InvalidDay();
    error UnauthorizedToken();
    error Unauthorized();
    error InvalidPrice();
    error InvalidBooking();
    error InvalidDiscounts();

    event DayMaterialized(uint32 indexed day, address indexed token);
    event DayTransferred(uint32 indexed day, address indexed from, address indexed to, uint64 saleNonce);
    event AssetConfigured(string metadataURI, AssetDefaults defaults);
    event ListingChanged(uint32 indexed day, bool listed, uint128 sellingPrice);
    event CurveChanged(uint32 indexed day, uint128 minimum, BookingCurve.Point[] points);
    event BookingChanged(uint32 indexed day, bool booked, uint128 listedPrice);
    event BookingRelayerChanged(address indexed relayer, bool allowed);
    event DiscountLadderChanged(uint64 indexed version, DiscountStep[] steps);

    constructor(
        address host_,
        address implementation_,
        string memory metadataURI_,
        AssetDefaults memory defaults,
        DiscountStep[] memory steps
    ) {
        require(host_ != address(0) && implementation_.code.length != 0, InvalidAsset());
        host = host_;
        dayTokenImplementation = implementation_;
        startDay = currentDay();
        endDayExclusive = startDay + 365;
        _validateBookingPrice(defaults.minimum, 1e6);
        for (uint256 i; i < 7; ++i) {
            _validateBookingPrice(defaults.listedPrices[i], defaults.minimum);
            require(defaults.sellingPrices[i] != 0, InvalidPrice());
        }
        metadataURI = metadataURI_;
        initialPrices = defaults;
        _setDiscountLadder(steps);
        emit AssetConfigured(metadataURI_, defaults);
    }

    /// @notice Tokyo calendar day index, changing at 15:00 UTC.
    function currentDay() public view returns (uint32) {
        return SafeCast.toUint32((block.timestamp + 9 hours) / 1 days);
    }

    /// @notice Predict the canonical token address for a day in this asset's fixed horizon.
    /// @return The same address before and after token deployment.
    function tokenAddress(uint32 day) public view returns (address) {
        _validateDay(day);
        return Clones.predictDeterministicAddressWithImmutableArgs(
            dayTokenImplementation, abi.encode(address(this), day), bytes32(uint256(day)), address(this)
        );
    }

    /// @notice Anyone may materialize a day; its existing host entitlement is unchanged.
    function materialize(uint32 day) external returns (address token) {
        token = tokenAddress(day);
        if (token.code.length != 0) return token;
        Clones.cloneDeterministicWithImmutableArgs(
            dayTokenImplementation, abi.encode(address(this), day), bytes32(uint256(day))
        );
        DayToken(token).initialize();
        emit DayMaterialized(day, token);
    }

    /// @notice Read ownership and initial sale metadata, including undeployed days.
    /// @return state Before deployment, owner is the host entitlement; no ERC-20 balance exists yet.
    function dayState(uint32 day) public view returns (DayView memory state) {
        state.token = tokenAddress(day);
        state.deployed = state.token.code.length != 0;
        state.owner = state.deployed ? DayToken(state.token).owner() : host;
        MarketState storage m = market[day];
        state.saleNonce = m.saleNonce;
        // Initial sale metadata is not an ERC-20 allowance or an Aqua strategy authorization.
        state.listed = day >= currentDay() && m.listing != Listing.Unlisted;
        state.booked = m.booked;
        state.listedPrice = m.booked ? m.bookedPrice : listedPriceAt(day, currentDay());
        state.sellingPrice = m.sellingPrice == 0 ? initialPrices.sellingPrices[_weekday(day)] : m.sellingPrice;
    }

    /// @notice Read a nonempty half-open range wholly within the asset's horizon.
    /// @return states One day view per date, in ascending order.
    function rangeState(uint32 start, uint32 endExclusive) external view returns (DayView[] memory states) {
        _validateRange(start, endExclusive);
        states = new DayView[](endExclusive - start);
        for (uint32 day = start; day < endExclusive; ++day) {
            states[day - start] = dayState(day);
        }
    }

    /// @dev Only the canonical token can invalidate a listing on a genuine owner change.
    function onDayTransfer(uint32 day, address from, address to) external {
        require(msg.sender == tokenAddress(day), UnauthorizedToken());
        require(from != address(0) && to != address(0) && from != to, UnauthorizedToken());
        market[day].listing = Listing.Unlisted;
        uint64 nonce = ++market[day].saleNonce;
        emit DayTransferred(day, from, to, nonce);
    }

    /// @notice List, unlist or reprice owned days; ownership epochs remain unchanged.
    function setListing(uint32 start, uint32 endExclusive, bool listed, uint128 sellingPrice) external {
        _validateRange(start, endExclusive);
        require(sellingPrice != 0, InvalidPrice());
        for (uint32 day = start; day < endExclusive; ++day) {
            _requireOwner(day);
            market[day].sellingPrice = sellingPrice;
            market[day].listing = listed ? Listing.Listed : Listing.Unlisted;
            emit ListingChanged(day, listed, sellingPrice);
        }
    }

    /// @notice Read authored points, or the creation-time default curve before an owner edit.
    function curve(uint32 day) public view returns (uint128 minimum, BookingCurve.Point[] memory points) {
        _validateDay(day);
        Curve storage c = curves[day];
        if (c.points.length != 0) return (c.minimum, c.points);
        minimum = initialPrices.minimum;
        points = new BookingCurve.Point[](day == startDay ? 1 : 2);
        points[0] = BookingCurve.Point(startDay, initialPrices.listedPrices[_weekday(day)]);
        if (day != startDay) points[1] = BookingCurve.Point(day, minimum);
    }

    /// @notice Evaluate the authored curve; booking snapshots are exposed through dayState.
    function listedPriceAt(uint32 day, uint32 evaluationDay) public view returns (uint128) {
        (uint128 minimum, BookingCurve.Point[] memory points) = curve(day);
        return SafeCast.toUint128(BookingCurve.priceAt(points, minimum, evaluationDay));
    }

    /// @notice Replace an owned, unbooked day's curve from today through its service date.
    function setCurve(uint32 day, uint128 minimum, BookingCurve.Point[] calldata points) external {
        _requireEditableCurve(day);
        _validateBookingPrice(minimum, 1e6);
        BookingCurve.validate(points, currentDay(), day);
        for (uint256 i; i < points.length; ++i) {
            _validateBookingPrice(points[i].price, minimum);
        }
        _storeCurve(day, minimum, points);
    }

    /// @notice Change today's public price while preserving each day's remaining future points.
    function setListedPrice(uint32 start, uint32 endExclusive, uint128 listedPrice) external {
        _validateRange(start, endExclusive);
        uint32 today = currentDay();
        for (uint32 day = start; day < endExclusive; ++day) {
            _requireEditableCurve(day);
            (uint128 minimum, BookingCurve.Point[] memory points) = curve(day);
            _validateBookingPrice(listedPrice, minimum);
            uint256 firstFuture;
            while (firstFuture < points.length && points[firstFuture].day <= today) ++firstFuture;
            BookingCurve.Point[] memory next = new BookingCurve.Point[](points.length - firstFuture + 1);
            next[0] = BookingCurve.Point(today, listedPrice);
            for (uint256 i = firstFuture; i < points.length; ++i) {
                next[i - firstFuture + 1] = points[i];
            }
            _storeCurve(day, minimum, next);
        }
    }

    /// @notice Authorize or revoke a host booking reporter, without changing owner price control.
    function setBookingRelayer(address relayer, bool allowed) external {
        require(msg.sender == host, Unauthorized());
        require(relayer != address(0), InvalidAsset());
        bookingRelayers[relayer] = allowed;
        emit BookingRelayerChanged(relayer, allowed);
    }

    /// @notice Freeze the canonical public price, or resume its retained curve before expiry.
    /// @param expectedListedPrice Current public price when booking; frozen price when unbooking.
    function setBooked(uint32 day, bool booked, uint128 expectedListedPrice) external {
        require(msg.sender == host || bookingRelayers[msg.sender], Unauthorized());
        _requireLive(day);
        MarketState storage m = market[day];
        require(m.booked != booked, InvalidBooking());
        uint128 price = m.booked ? m.bookedPrice : listedPriceAt(day, currentDay());
        require(expectedListedPrice == price, InvalidBooking());
        m.booked = booked;
        m.bookedPrice = booked ? price : 0;
        emit BookingChanged(day, booked, booked ? price : listedPriceAt(day, currentDay()));
    }

    function discountLadder() external view returns (DiscountStep[] memory) {
        return discounts;
    }

    /// @notice Greatest qualifying threshold for a whole consecutive run, across all sellers.
    function discountBps(uint16 consecutiveDays) external view returns (uint16 bps) {
        require(consecutiveDays != 0 && consecutiveDays <= 365, InvalidDay());
        for (uint256 i; i < discounts.length && discounts[i].minDays <= consecutiveDays; ++i) {
            bps = discounts[i].discountBps;
        }
    }

    function setDiscountLadder(DiscountStep[] calldata steps) external {
        require(msg.sender == host, Unauthorized());
        _setDiscountLadder(steps);
    }

    function _setDiscountLadder(DiscountStep[] memory steps) private {
        delete discounts;
        for (uint256 i; i < steps.length; ++i) {
            require(
                steps[i].minDays >= 2 && steps[i].minDays <= 365 && steps[i].discountBps <= 10_000
                    && (i == 0 || steps[i - 1].minDays < steps[i].minDays),
                InvalidDiscounts()
            );
            discounts.push(steps[i]);
        }
        emit DiscountLadderChanged(++discountVersion, steps);
    }

    function _storeCurve(uint32 day, uint128 minimum, BookingCurve.Point[] memory points) private {
        Curve storage c = curves[day];
        c.minimum = minimum;
        delete c.points;
        for (uint256 i; i < points.length; ++i) {
            c.points.push(points[i]);
        }
        emit CurveChanged(day, minimum, points);
    }

    function _requireEditableCurve(uint32 day) private view {
        _requireOwner(day);
        require(!market[day].booked, InvalidBooking());
    }

    function _requireOwner(uint32 day) private view {
        _requireLive(day);
        address token = tokenAddress(day);
        require(msg.sender == (token.code.length == 0 ? host : DayToken(token).owner()), Unauthorized());
    }

    function _requireLive(uint32 day) private view {
        _validateDay(day);
        require(day >= currentDay(), InvalidDay());
    }

    function _validateBookingPrice(uint128 price, uint128 minimum) private pure {
        require(price >= minimum && price % 1e6 == 0, InvalidPrice());
    }

    function _weekday(uint32 day) private pure returns (uint256) {
        return (uint256(day) + 4) % 7;
    }

    function _validateRange(uint32 start, uint32 endExclusive) private view {
        require(start >= startDay && start < endExclusive && endExclusive <= endDayExclusive, InvalidDay());
    }

    function _validateDay(uint32 day) private view {
        require(day >= startDay && day < endDayExclusive, InvalidDay());
    }
}
