// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @notice Basket identity and ERC-1155 transfer surface accepted by the rental router.
interface IRentalRights is IERC1155 {
    function tokenId(bytes32 pool, uint32 day, bytes32 terms) external view returns (uint256);
}
