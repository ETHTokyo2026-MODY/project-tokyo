// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {IRentalRights} from "./IRentalRights.sol";
import {RentalInventory} from "./RentalInventory.sol";

/// @notice Transferable proceeds claim for a single supplier-attested capacity-one service day.
contract RentalRevenue is ERC1155, IRentalRights, IERC1155Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        Open,
        Booked,
        Withdrawn,
        Paid
    }

    struct Claim {
        bytes32 pool;
        uint32 day;
        bytes32 terms;
        uint256 price;
        uint256 reservationId;
        State state;
    }

    // The buyer authenticates this exact booking by shipping its ABI encoding to Aqua.
    // claimId is immutable and uniquely identifies pool, day, terms, and one unit.
    struct BookingMandate {
        address buyer;
        address app;
        address token;
        uint256 claimId;
        address beneficiary;
        uint256 price;
        uint256 expiry;
        bytes32 salt;
    }

    IAqua public immutable aqua;
    RentalInventory public immutable inventory;
    IERC20 public immutable usdc;
    uint256 public nextClaimId = 1;
    uint256 public escrowedRevenue;
    mapping(uint256 => Claim) public claims;
    mapping(bytes32 => uint256) private claimIds;

    address private expectedHolder;
    uint256 private expectedTokenId;

    error InvalidClaim();
    error InvalidMandate();
    error InvalidFunding();
    error InvalidEscrow();

    event ClaimCreated(
        uint256 indexed claimId, address indexed holder, bytes32 indexed pool, uint32 day, bytes32 terms
    );
    event PriceSet(uint256 indexed claimId, uint256 price);
    event Booked(
        uint256 indexed claimId,
        address indexed buyer,
        address indexed beneficiary,
        uint256 price,
        uint256 reservationId,
        bytes32 mandateHash
    );
    event UnbookedWithdrawn(uint256 indexed claimId, address indexed holder);
    event RevenuePaid(uint256 indexed claimId, address indexed holder, uint256 amount);

    constructor(IAqua a, RentalInventory i, IERC20 token) ERC1155("") {
        require(address(a) != address(0) && address(i) != address(0) && address(token) != address(0), InvalidClaim());
        aqua = a;
        inventory = i;
        usdc = token;
    }

    function hashMandate(BookingMandate calldata m) public pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @notice Stable router identity. A basket maps to at most one economic claim forever.
    function tokenId(bytes32 pool, uint32 day, bytes32 terms) public view override returns (uint256) {
        return claimIds[keccak256(abi.encode(pool, day, terms))];
    }

    function createClaim(bytes32 pool, uint32 day, bytes32 terms) external nonReentrant returns (uint256 claimId) {
        (, uint32 start, uint32 end, uint32 capacity) = inventory.pools(pool);
        require(
            capacity == 1 && day >= start && day < end && uint256(day) * 1 days > block.timestamp
                && tokenId(pool, day, terms) == 0,
            InvalidClaim()
        );

        uint256 underlyingId = inventory.tokenId(pool, day, terms);
        expectedHolder = msg.sender;
        expectedTokenId = underlyingId;
        inventory.safeTransferFrom(msg.sender, address(this), underlyingId, 1, "");
        expectedHolder = address(0);
        expectedTokenId = 0;

        claimId = nextClaimId++;
        claimIds[keccak256(abi.encode(pool, day, terms))] = claimId;
        claims[claimId] = Claim(pool, day, terms, 0, 0, State.Open);
        _mint(msg.sender, claimId, 1, "");
        emit ClaimCreated(claimId, msg.sender, pool, day, terms);
    }

    function setPrice(uint256 claimId, uint256 price) external nonReentrant {
        Claim storage c = _claim(claimId);
        require(
            c.state == State.Open && balanceOf(msg.sender, claimId) == 1 && price > 0
                && uint256(c.day) * 1 days > block.timestamp,
            InvalidClaim()
        );
        c.price = price;
        emit PriceSet(claimId, price);
    }

    function book(uint256 claimId, BookingMandate calldata m) external nonReentrant returns (uint256 reservationId) {
        Claim storage c = _claim(claimId);
        require(c.state == State.Open && c.price > 0 && uint256(c.day) * 1 days > block.timestamp, InvalidClaim());
        require(
            m.buyer != address(0) && m.beneficiary != address(0) && m.app == address(this) && m.token == address(usdc)
                && m.claimId == claimId && m.price == c.price && block.timestamp < m.expiry,
            InvalidMandate()
        );
        bytes32 mandateHash = hashMandate(m);
        (uint248 remaining, uint8 status) = aqua.rawBalances(m.buyer, address(this), mandateHash, address(usdc));
        require(status > 0 && status != 255 && remaining >= c.price, InvalidFunding());

        uint256 beforeBalance = usdc.balanceOf(address(this));
        c.state = State.Booked;
        escrowedRevenue += c.price;
        aqua.pull(m.buyer, mandateHash, address(usdc), c.price, address(this));
        require(usdc.balanceOf(address(this)) == beforeBalance + c.price, InvalidFunding());
        reservationId = inventory.reserve(address(this), c.pool, c.day, c.day + 1, c.terms, 1, m.beneficiary);
        c.reservationId = reservationId;
        emit Booked(claimId, m.buyer, m.beneficiary, c.price, reservationId, mandateHash);
    }

    /// @notice Close an unbooked claim and recover the underlying, with zero revenue.
    function withdrawUnbooked(uint256 claimId) external nonReentrant {
        Claim storage c = _claim(claimId);
        require(c.state == State.Open && balanceOf(msg.sender, claimId) == 1, InvalidClaim());
        c.state = State.Withdrawn;
        _burn(msg.sender, claimId, 1);
        inventory.safeTransferFrom(address(this), msg.sender, inventory.tokenId(c.pool, c.day, c.terms), 1, "");
        emit UnbookedWithdrawn(claimId, msg.sender);
    }

    /// @notice Burn the current holder's claim after the service day for funded proceeds.
    function claimRevenue(uint256 claimId) external nonReentrant returns (uint256 amount) {
        Claim storage c = _claim(claimId);
        require(
            c.state == State.Booked && balanceOf(msg.sender, claimId) == 1
                && block.timestamp >= (uint256(c.day) + 1) * 1 days,
            InvalidClaim()
        );
        c.state = State.Paid;
        amount = c.price;
        escrowedRevenue -= amount;
        _burn(msg.sender, claimId, 1);
        usdc.safeTransfer(msg.sender, amount);
        emit RevenuePaid(claimId, msg.sender, amount);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0) && from != to) {
            for (uint256 i; i < ids.length; ++i) {
                if (values[i] == 0) continue;
                Claim storage c = _claim(ids[i]);
                if (c.state == State.Booked) require(msg.sender == from, InvalidClaim());
                if (c.state == State.Open && c.price != 0) {
                    c.price = 0;
                    emit PriceSet(ids[i], 0);
                }
            }
        }
        super._update(from, to, ids, values);
    }

    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        require(
            msg.sender == address(inventory) && operator == address(this) && from == expectedHolder
                && from != address(0) && id == expectedTokenId && value == 1,
            InvalidEscrow()
        );
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert InvalidEscrow();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, IERC165) returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }

    function _claim(uint256 claimId) private view returns (Claim storage c) {
        require(claimId != 0 && claimId < nextClaimId, InvalidClaim());
        c = claims[claimId];
    }
}
