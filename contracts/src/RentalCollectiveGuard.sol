// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Signed prefix for a collective campaign. The suffix is an ordinary rental price program.
library RentalCollectiveGuard {
    uint8 internal constant OPCODE = 0xa2;
    uint256 internal constant PREFIX_LENGTH = 130;

    error InvalidGuard();

    function decode(bytes calldata program)
        internal
        pure
        returns (address coordinator, bytes32 campaign, uint256 minParticipants, uint256 minSpend)
    {
        require(
            program.length > PREFIX_LENGTH && uint8(program[0]) == OPCODE && uint8(program[1]) == 128, InvalidGuard()
        );
        (coordinator, campaign, minParticipants, minSpend) =
            abi.decode(program[2:PREFIX_LENGTH], (address, bytes32, uint256, uint256));
        require(
            coordinator != address(0) && campaign != 0 && minParticipants >= 2 && minParticipants <= 8 && minSpend > 0,
            InvalidGuard()
        );
    }
}
