// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentalSettlement} from "./RentalSettlement.sol";
import {RentalCollectiveGuard} from "./RentalCollectiveGuard.sol";

/// @notice Atomic activation of at most eight distinct funding wallets under one signed campaign guard.
contract RentalCollective is ReentrancyGuard {
    struct Fill {
        RentalSettlement.Order bid;
        bytes bidSig;
        RentalSettlement.Order ask;
        bytes askSig;
        RentalSettlement.Mandate mandate;
        bytes program;
    }

    RentalSettlement public immutable router;

    error InvalidBatch();
    error ThresholdUnmet();

    event Activated(bytes32 indexed campaign, uint256 participants, uint256 price, uint256 fee);

    constructor(RentalSettlement r) {
        require(address(r) != address(0), InvalidBatch());
        router = r;
    }

    function activate(Fill[] calldata fills) external nonReentrant returns (uint256 totalPrice, uint256 totalFee) {
        uint256 count = fills.length;
        require(count >= 2 && count <= 8, InvalidBatch());
        (address coordinator, bytes32 campaign, uint256 minParticipants, uint256 minSpend) =
            RentalCollectiveGuard.decode(fills[0].program);
        require(coordinator == address(this) && count >= minParticipants, InvalidBatch());
        bytes32 guardHash = keccak256(fills[0].program[:RentalCollectiveGuard.PREFIX_LENGTH]);
        for (uint256 i; i < count; ++i) {
            Fill calldata f = fills[i];
            RentalCollectiveGuard.decode(f.program);
            require(keccak256(f.program[:RentalCollectiveGuard.PREFIX_LENGTH]) == guardHash, InvalidBatch());
            require(f.bid.buy, InvalidBatch());
            for (uint256 j; j < i; ++j) {
                require(f.bid.maker != fills[j].bid.maker, InvalidBatch());
            }
            (uint256 price, uint256 fee) = router.settle(f.bid, f.bidSig, f.ask, f.askSig, f.mandate, f.program);
            totalPrice += price;
            totalFee += fee;
        }
        require(totalPrice + totalFee >= minSpend, ThresholdUnmet());
        emit Activated(campaign, count, totalPrice, totalFee);
    }
}
