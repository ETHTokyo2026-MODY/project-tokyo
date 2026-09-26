// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {RentalInventory} from "./RentalInventory.sol";

interface IExtendedRentalResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @notice Wildcard ENS resolver for one parent name. Labels only point to existing inventory pools.
/// @dev Names are discovery aliases; signed orders commit to the returned bytes32 pool, never to this resolver.
contract RentalPoolResolver is IERC165, IExtendedRentalResolver {
    RentalInventory public immutable inventory;
    /// @notice Resolver deployer; transferring the ENS parent does not transfer this authority.
    address public immutable owner;
    bytes32 public immutable parentNode;
    bytes32 public immutable parentDnsHash;

    bytes4 public constant POOL_SELECTOR = bytes4(keccak256("pool(bytes32)"));
    mapping(bytes32 => bytes32) public poolForLabel;

    error InvalidName();
    error UnknownPool();
    error Unauthorized();

    event PoolNamed(bytes32 indexed labelHash, bytes32 indexed pool);

    constructor(RentalInventory inventory_, bytes32 parentNode_, bytes32 parentDnsHash_) {
        require(address(inventory_) != address(0) && parentNode_ != 0 && parentDnsHash_ != 0, InvalidName());
        inventory = inventory_;
        owner = msg.sender;
        parentNode = parentNode_;
        parentDnsHash = parentDnsHash_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IExtendedRentalResolver).interfaceId;
    }

    /// @notice Assign or clear a child alias; only the immutable resolver owner may call.
    /// @param label One lowercase ASCII label, with interior hyphens allowed.
    /// @param pool Existing inventory pool, or zero to remove the alias.
    function setPool(string calldata label, bytes32 pool) external {
        require(msg.sender == owner, Unauthorized());
        bytes32 labelHash = _labelHash(bytes(label));
        if (pool != 0) _requirePool(pool);
        poolForLabel[labelHash] = pool;
        emit PoolNamed(labelHash, pool);
    }

    /// @notice Resolve a single child name through the ENS extended resolver interface.
    /// @param name DNS-encoded child plus the configured parent suffix.
    /// @param data ABI-encoded pool(bytes32) query for that child's namehash.
    /// @return ABI-encoded concrete pool ID; unknown aliases revert.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        require(name.length > 2 && data.length == 36 && bytes4(data[:4]) == POOL_SELECTOR, InvalidName());
        uint256 labelEnd = uint8(name[0]) + 1;
        require(labelEnd < name.length && keccak256(name[labelEnd:]) == parentDnsHash, InvalidName());
        bytes32 labelHash = _labelHash(bytes(name[1:labelEnd]));
        bytes32 node = abi.decode(data[4:], (bytes32));
        require(node == keccak256(abi.encodePacked(parentNode, labelHash)), InvalidName());
        bytes32 pool = poolForLabel[labelHash];
        _requirePool(pool);
        return abi.encode(pool);
    }

    function _requirePool(bytes32 pool) private view {
        (address supplier, uint32 startDay, uint32 endDay, uint32 capacity) = inventory.pools(pool);
        require(supplier != address(0) && startDay < endDay && capacity > 0, UnknownPool());
    }

    function _labelHash(bytes memory label) private pure returns (bytes32) {
        uint256 length = label.length;
        require(length > 0 && length <= 63, InvalidName());
        for (uint256 i; i < length; ++i) {
            uint8 c = uint8(label[i]);
            require(
                (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c == 45 && i > 0 && i + 1 < length), InvalidName()
            );
        }
        return keccak256(label);
    }
}
