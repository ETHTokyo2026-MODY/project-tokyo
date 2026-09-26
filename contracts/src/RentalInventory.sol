// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @notice Demonstration inventory. The administrator attests physical supply offchain.
/// Capacity is immutable and shared across terms versions; no burn/remint escape hatch.
contract RentalInventory is ERC1155 {
    struct Pool {
        address supplier;
        uint32 startDay;
        uint32 endDay;
        uint32 capacity;
    }

    address public immutable administrator;
    mapping(bytes32 => Pool) public pools;
    mapping(bytes32 => mapping(uint32 => uint256)) public issued;

    error InvalidInventory();

    constructor() ERC1155("") {
        administrator = msg.sender;
    }

    function createPool(bytes32 pool, address supplier, uint32 start, uint32 end, uint32 capacity) external {
        require(
            msg.sender == administrator && supplier != address(0) && start < end && capacity > 0
                && pools[pool].supplier == address(0),
            InvalidInventory()
        );
        pools[pool] = Pool(supplier, start, end, capacity);
    }

    function tokenId(bytes32 pool, uint32 day, bytes32 terms) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(pool, day, terms)));
    }

    function issue(bytes32 pool, uint32 start, uint32 end, bytes32 terms, uint256 quantity) external {
        Pool memory p = pools[pool];
        require(
            msg.sender == p.supplier && start >= p.startDay && end <= p.endDay && start < end && end - start <= 31
                && quantity > 0,
            InvalidInventory()
        );
        uint256[] memory ids = new uint256[](end - start);
        uint256[] memory amounts = new uint256[](end - start);
        for (uint32 day = start; day < end; ++day) {
            uint256 count = issued[pool][day] + quantity;
            require(count <= p.capacity, InvalidInventory());
            issued[pool][day] = count;
            ids[day - start] = tokenId(pool, day, terms);
            amounts[day - start] = quantity;
        }
        _mintBatch(msg.sender, ids, amounts, "");
    }
}
