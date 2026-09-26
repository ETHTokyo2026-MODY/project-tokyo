// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @notice Basket identity and ERC-1155 transfer surface accepted by the rental router.
interface IRentalRights is IERC1155 {
    /// @notice Resolve a daily basket component to its ERC-1155 identifier.
    /// @dev Implementations may reject transfers based on lifecycle state; an ID alone proves no availability.
    /// @param pool Supplier-attested inventory class or identified physical unit.
    /// @param day UTC Unix day, not a timestamp in seconds.
    /// @param terms Hash identifying the rental terms accepted by both parties.
    /// @return The implementation-specific token ID; revenue claims return zero before creation.
    function tokenId(bytes32 pool, uint32 day, bytes32 terms) external view returns (uint256);
}
