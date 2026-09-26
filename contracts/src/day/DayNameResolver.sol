// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RentalAssetFactory} from "./RentalAssetFactory.sol";
import {RentalAsset} from "./RentalAsset.sol";

/// @notice ENSIP-10 aliases for existing assets and their deterministic ERC-20 day addresses.
/// @dev The namespace administrator manages aliases. ENS names do not own or mint day tokens.
contract DayNameResolver {
    RentalAssetFactory public immutable factory;
    address public immutable owner;
    bytes32 public immutable parentNode;
    bytes32 public immutable parentDnsHash;
    mapping(bytes32 => address) public assetForLabel;

    error InvalidName();
    error UnknownAsset();
    error Unauthorized();

    event AssetNamed(bytes32 indexed labelHash, address indexed asset);

    constructor(RentalAssetFactory factory_, bytes32 parentNode_, bytes32 parentDnsHash_) {
        require(address(factory_).code.length != 0 && parentNode_ != 0 && parentDnsHash_ != 0, InvalidName());
        factory = factory_;
        owner = msg.sender;
        parentNode = parentNode_;
        parentDnsHash = parentDnsHash_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x9061b923;
    }

    /// @notice Assign an asset alias, or clear it with zero. Parent transfers do not change this administrator.
    function setAsset(string calldata label, address asset) external {
        require(msg.sender == owner, Unauthorized());
        bytes32 labelHash = _labelHash(bytes(label));
        require(asset == address(0) || factory.isAsset(asset), UnknownAsset());
        assetForLabel[labelHash] = asset;
        emit AssetNamed(labelHash, asset);
    }

    /// @notice Resolve asset.parent or YYYY-MM-DD.asset.parent with the standard addr(bytes32) record.
    /// @dev Supports the record through ENSIP-10, not a direct legacy addr call. Resolution is read-only.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        require(name.length > 2 && data.length == 36 && bytes4(data[:4]) == 0x3b3b57de, InvalidName());
        uint256 firstEnd = uint8(name[0]) + 1;
        require(firstEnd < name.length, InvalidName());
        bytes32 node;
        address asset;
        address result;
        if (keccak256(name[firstEnd:]) == parentDnsHash) {
            bytes32 labelHash = _labelHash(name[1:firstEnd]);
            node = keccak256(abi.encodePacked(parentNode, labelHash));
            asset = assetForLabel[labelHash];
            result = asset;
        } else {
            uint256 secondEnd = firstEnd + uint8(name[firstEnd]) + 1;
            require(secondEnd < name.length && keccak256(name[secondEnd:]) == parentDnsHash, InvalidName());
            bytes32 labelHash = _labelHash(name[firstEnd + 1:secondEnd]);
            asset = assetForLabel[labelHash];
            node = keccak256(
                abi.encodePacked(keccak256(abi.encodePacked(parentNode, labelHash)), keccak256(name[1:firstEnd]))
            );
            require(factory.isAsset(asset), UnknownAsset());
            result = RentalAsset(asset).tokenAddress(_day(name[1:firstEnd]));
        }
        require(node == abi.decode(data[4:], (bytes32)), InvalidName());
        require(factory.isAsset(asset), UnknownAsset());
        return abi.encode(result);
    }

    function _labelHash(bytes memory label) private pure returns (bytes32) {
        require(label.length > 0 && label.length <= 63, InvalidName());
        for (uint256 i; i < label.length; ++i) {
            uint8 c = uint8(label[i]);
            require(
                (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c == 45 && i > 0 && i + 1 < label.length),
                InvalidName()
            );
        }
        return keccak256(label);
    }

    /// @dev ISO dates identify Tokyo calendar days, independent of the timestamp's timezone.
    function _day(bytes calldata label) private pure returns (uint32) {
        require(label.length == 10 && label[4] == "-" && label[7] == "-", InvalidName());
        uint256 year;
        uint256 month;
        uint256 date;
        for (uint256 i; i < 10; ++i) {
            if (i == 4 || i == 7) continue;
            uint8 c = uint8(label[i]);
            require(c >= 48 && c <= 57, InvalidName());
            if (i < 4) year = year * 10 + c - 48;
            else if (i < 7) month = month * 10 + c - 48;
            else date = date * 10 + c - 48;
        }
        require(year >= 1970 && month >= 1 && month <= 12, InvalidName());
        uint8[12] memory lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) lengths[1] = 29;
        require(date > 0 && date <= lengths[month - 1], InvalidName());
        uint256 daysBefore = 365 * (year - 1970) + (year - 1969) / 4 - (year - 1901) / 100 + (year - 1601) / 400;
        for (uint256 i; i + 1 < month; ++i) {
            daysBefore += lengths[i];
        }
        return uint32(daysBefore + date - 1);
    }
}
