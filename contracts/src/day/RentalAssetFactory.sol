// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DayToken} from "./DayToken.sol";
import {RentalAsset} from "./RentalAsset.sol";

/// @title Rental asset factory
/// @notice Records one asset per host-selected salt and fixes its day-token implementation.
contract RentalAssetFactory {
    address public immutable dayTokenImplementation;
    mapping(address => mapping(bytes32 => address)) public assets;
    mapping(address => bool) public isAsset;

    error AssetAlreadyExists();

    event AssetCreated(
        address indexed asset, address indexed host, bytes32 indexed hostSalt, uint32 startDay, uint32 endDayExclusive
    );

    constructor() {
        dayTokenImplementation = address(new DayToken());
    }

    function createAsset(bytes32 hostSalt) external returns (address asset) {
        require(assets[msg.sender][hostSalt] == address(0), AssetAlreadyExists());
        RentalAsset created = new RentalAsset(msg.sender, dayTokenImplementation);
        asset = address(created);
        assets[msg.sender][hostSalt] = asset;
        isAsset[asset] = true;
        emit AssetCreated(asset, msg.sender, hostSalt, created.startDay(), created.endDayExclusive());
    }
}
