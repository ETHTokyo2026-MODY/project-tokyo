// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IRentalRights} from "./IRentalRights.sol";

/// @notice Supplier-attested class allotments accounted for by UTC service day.
/// @dev Historical issuance counts against the immutable daily cap across all terms versions and holders.
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

    /// @notice Register a supplier and immutable daily capacity; callable only by the administrator.
    /// @dev Physical identity and exclusion from other booking channels are offchain attestations.
    /// @param start First supported UTC Unix day, inclusive.
    /// @param end Last supported UTC Unix day, exclusive.
    /// @param capacity Maximum whole units issued per day across every terms version.
    function createPool(bytes32 pool, address supplier, uint32 start, uint32 end, uint32 capacity) external {
        require(
            msg.sender == administrator && supplier != address(0) && start < end && capacity > 0
                && pools[pool].supplier == address(0),
            InvalidInventory()
        );
        pools[pool] = Pool(supplier, start, end, capacity);
    }

    /// @inheritdoc IRentalRights
    function tokenId(bytes32 pool, uint32 day, bytes32 terms) public pure override returns (uint256) {
        return uint256(keccak256(abi.encode(pool, day, terms)));
    }

    /// @notice Raise a future day's cumulative issuance to the supplier's target.
    /// @dev Repeating a target is a no-op; resale or consumption never replenishes issuance capacity.
    /// @param target Total units ever issued for this pool/day/terms, not units to add.
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

    /// @notice Issue the same whole-unit quantity on each day of a supplier-owned pool's range.
    /// @dev Every daily cap must pass or the entire mint reverts. A range is a basket of daily IDs.
    /// @param start Inclusive UTC Unix day.
    /// @param end Exclusive UTC Unix day; the range is limited to 31 days.
    /// @param quantity Units to add on every day, not a total spread across the range.
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
    /// @dev The holder or an approved operator burns every daily component atomically. Issuance stays
    /// historical, so reservation cannot free minting capacity. No cancellation or remint path exists.
    /// @param holder Wallet whose daily rights are consumed.
    /// @param start Inclusive future UTC Unix day.
    /// @param end Exclusive UTC Unix day, at most 31 days after start.
    /// @param quantity Whole units consumed on each day.
    /// @param beneficiary Public entitlement recipient; personal booking details belong offchain.
    /// @return reservationId Permanent allocation ID; it does not certify supplier fulfillment.
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
