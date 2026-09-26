// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

interface IDayAsset {
    function host() external view returns (address);
    function currentDay() external view returns (uint32);
    function onDayTransfer(uint32 day, address from, address to) external;
}

/// @title Rental day ownership token
/// @notice One indivisible ownership unit for an immutable asset and Tokyo service day.
contract DayToken is ERC20 {
    address private immutable implementation = address(this);
    address public owner;

    error InvalidInitialization();
    error PastDay();

    constructor() ERC20("", "") {}

    function name() public pure override returns (string memory) {
        return "Rental day ownership";
    }

    function symbol() public pure override returns (string memory) {
        return "DAY";
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice Read the physical item's contract address from the clone's immutable arguments.
    function asset() public view returns (address asset_) {
        (asset_,) = _identity();
    }

    /// @notice Read the Tokyo calendar day index from the clone's immutable arguments.
    function day() public view returns (uint32 day_) {
        (, day_) = _identity();
    }

    /// @dev The asset deploys and initializes atomically; no caller chooses the mint recipient.
    function initialize() external {
        require(address(this) != implementation && owner == address(0), InvalidInitialization());
        address asset_ = asset();
        require(msg.sender == asset_, InvalidInitialization());
        _mint(IDayAsset(asset_).host(), 1);
    }

    function _identity() private view returns (address, uint32) {
        require(address(this) != implementation, InvalidInitialization());
        return abi.decode(Clones.fetchCloneArgs(address(this)), (address, uint32));
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && value != 0) {
            (address asset_, uint32 day_) = _identity();
            require(day_ >= IDayAsset(asset_).currentDay(), PastDay());
        }
        super._update(from, to, value);
        if (value != 0 && from != to) {
            owner = to;
            if (from != address(0)) {
                (address asset_, uint32 day_) = _identity();
                IDayAsset(asset_).onDayTransfer(day_, from, to);
            }
        }
    }
}
