// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DayToken} from "./DayToken.sol";

/// @title Rental item and fixed calendar
/// @notice A physical item's fixed 365-day calendar, owned by its host until transferred.
contract RentalAsset {
    struct DayView {
        address token;
        address owner;
        bool deployed;
        bool listed;
        uint64 saleNonce;
    }

    address public immutable host;
    uint32 public immutable startDay;
    uint32 public immutable endDayExclusive;
    address public immutable dayTokenImplementation;
    mapping(uint32 => uint64) private saleNonces;

    error InvalidAsset();
    error InvalidDay();
    error UnauthorizedToken();

    event DayMaterialized(uint32 indexed day, address indexed token);
    event DayTransferred(uint32 indexed day, address indexed from, address indexed to, uint64 saleNonce);

    constructor(address host_, address implementation_) {
        require(host_ != address(0) && implementation_.code.length != 0, InvalidAsset());
        host = host_;
        dayTokenImplementation = implementation_;
        startDay = currentDay();
        endDayExclusive = startDay + 365;
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
        state.saleNonce = saleNonces[day];
        // Initial sale metadata is not an ERC-20 allowance or an Aqua strategy authorization.
        state.listed = day >= currentDay() && state.saleNonce == 0;
    }

    /// @notice Read a nonempty half-open range wholly within the asset's horizon.
    /// @return states One day view per date, in ascending order.
    function rangeState(uint32 start, uint32 endExclusive) external view returns (DayView[] memory states) {
        require(start >= startDay && start < endExclusive && endExclusive <= endDayExclusive, InvalidDay());
        states = new DayView[](endExclusive - start);
        for (uint32 day = start; day < endExclusive; ++day) {
            states[day - start] = dayState(day);
        }
    }

    /// @dev Only the canonical token can invalidate a listing on a genuine owner change.
    function onDayTransfer(uint32 day, address from, address to) external {
        require(msg.sender == tokenAddress(day), UnauthorizedToken());
        require(from != address(0) && to != address(0) && from != to, UnauthorizedToken());
        uint64 nonce = ++saleNonces[day];
        emit DayTransferred(day, from, to, nonce);
    }

    function _validateDay(uint32 day) private view {
        require(day >= startDay && day < endDayExclusive, InvalidDay());
    }
}
