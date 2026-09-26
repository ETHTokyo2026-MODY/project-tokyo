// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IRentalRights} from "./IRentalRights.sol";

/// @notice Supplier-attested class allotments accounted for by UTC service day.
/// Capacity and historical issuance are immutable across terms and redemption.
contract RentalInventory is ERC1155, IRentalRights {
    struct Pool {
        address supplier;
        uint32 startDay;
        uint32 endDay;
        uint32 capacity;
    }

    struct Reservation {
        address holder;
        address beneficiary;
        bytes32 pool;
        uint32 startDay;
        uint32 endDay;
        bytes32 terms;
        uint256 quantity;
    }

    address public immutable administrator;
    mapping(bytes32 => Pool) public pools;
    mapping(bytes32 => mapping(uint32 => uint256)) public issued;
    mapping(bytes32 => mapping(uint32 => uint256)) public consumed;
    mapping(uint256 => uint256) public issuedByToken;
    mapping(uint256 => uint256) public consumedByToken;
    mapping(uint256 => Reservation) public reservations;
    uint256 public nextReservationId = 1;

    error InvalidInventory();

    event Reserved(
        uint256 indexed reservationId,
        address indexed holder,
        address indexed beneficiary,
        bytes32 pool,
        uint32 startDay,
        uint32 endDay,
        bytes32 terms,
        uint256 quantity
    );

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

    function tokenId(bytes32 pool, uint32 day, bytes32 terms) public pure override returns (uint256) {
        return uint256(keccak256(abi.encode(pool, day, terms)));
    }

    /// @notice Idempotent daily issuance target; already issued or consumed units are never replenished.
    function publishDay(bytes32 pool, uint32 day, bytes32 terms, uint256 target) external {
        Pool memory p = pools[pool];
        require(
            msg.sender == p.supplier && day >= p.startDay && day < p.endDay && day > block.timestamp / 1 days
                && target > 0 && target <= p.capacity,
            InvalidInventory()
        );
        uint256 prior = issuedByToken[tokenId(pool, day, terms)];
        if (target > prior) _issue(pool, day, day + 1, terms, target - prior);
    }

    function issue(bytes32 pool, uint32 start, uint32 end, bytes32 terms, uint256 quantity) external {
        _issue(pool, start, end, terms, quantity);
    }

    function _issue(bytes32 pool, uint32 start, uint32 end, bytes32 terms, uint256 quantity) internal {
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
            issuedByToken[ids[day - start]] += quantity;
        }
        _mintBatch(msg.sender, ids, amounts, "");
    }

    /// @notice Convert a uniform basket into a permanent, non-transferable beneficiary allocation.
    /// The holder or an ERC-1155 approved operator may consume the holder's entire specified basket.
    function reserve(
        address holder,
        bytes32 pool,
        uint32 start,
        uint32 end,
        bytes32 terms,
        uint256 quantity,
        address beneficiary
    ) external returns (uint256 reservationId) {
        Pool memory p = pools[pool];
        require(
            (msg.sender == holder || isApprovedForAll(holder, msg.sender)) && holder != address(0)
                && beneficiary != address(0) && p.supplier != address(0) && start >= p.startDay && end <= p.endDay
                && start < end && end - start <= 31 && uint256(start) * 1 days > block.timestamp && quantity > 0,
            InvalidInventory()
        );
        uint256[] memory ids = new uint256[](end - start);
        uint256[] memory amounts = new uint256[](end - start);
        for (uint32 day = start; day < end; ++day) {
            uint256 used = consumed[pool][day] + quantity;
            require(used <= issued[pool][day], InvalidInventory());
            consumed[pool][day] = used;
            ids[day - start] = tokenId(pool, day, terms);
            amounts[day - start] = quantity;
            consumedByToken[ids[day - start]] += quantity;
        }
        _burnBatch(holder, ids, amounts);
        reservationId = nextReservationId++;
        reservations[reservationId] = Reservation(holder, beneficiary, pool, start, end, terms, quantity);
        emit Reserved(reservationId, holder, beneficiary, pool, start, end, terms, quantity);
    }
}
