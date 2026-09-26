// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {IRentalRights} from "./IRentalRights.sol";

/// @notice Full-fill, single-seller rental exchange. Aqua holds only USDC allowances.
abstract contract RentalSettlement is EIP712, ReentrancyGuard {
    /// @dev Aqua strategy preimage. Shipping authorizes wallet pulls without depositing USDC.
    /// The lifetime limit includes fees and is independent of Aqua allowance refills.
    struct Mandate {
        address buyer;
        address app;
        address token;
        uint256 limit;
        uint256 expiry;
        bytes32 salt;
    }

    /// @dev Exact, full-fill basket authorization. Buy priceLimit includes fees; sell priceLimit is net.
    /// Nonzero group is maker-scoped one-cancels-other; zero leaves orders independent.
    /// programHash authenticates pricing/fees, while mandate binds buyer funding (zero for asks).
    struct Order {
        address maker;
        bool buy;
        bytes32 pool;
        uint32 startDay;
        uint32 endDay;
        uint32 quantity;
        bytes32 terms;
        address recipient;
        uint256 priceLimit;
        uint256 maxFee;
        uint256 expiry;
        uint256 nonce;
        bytes32 group;
        bytes32 mandate;
        bytes32 programHash;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,bool buy,bytes32 pool,uint32 startDay,uint32 endDay,uint32 quantity,bytes32 terms,address recipient,uint256 priceLimit,uint256 maxFee,uint256 expiry,uint256 nonce,bytes32 group,bytes32 mandate,bytes32 programHash)"
    );
    IAqua public immutable aqua;
    IRentalRights public immutable inventory;
    address public immutable usdc;
    address public immutable feeRecipient;
    mapping(address => mapping(uint256 => bool)) public used;
    mapping(address => mapping(bytes32 => bool)) public closedGroup;
    /// @notice Cumulative USDC spent per mandate, including fees; never reset by an Aqua refill.
    mapping(bytes32 => uint256) public spent;

    error InvalidOrder();
    error InvalidSignature();
    error ClosedOrder();
    error InvalidMandate();
    error PriceLimit();
    error BudgetExceeded();

    event Cancelled(address indexed maker, uint256 nonce);
    event GroupClosed(address indexed maker, bytes32 group);
    event Settled(
        bytes32 indexed buyHash, bytes32 indexed sellHash, bytes32 indexed mandate, uint256 price, uint256 fee
    );

    constructor(IAqua a, IRentalRights i, address token, address fees) EIP712("RentalSettlement", "1") {
        require(address(a) != address(0) && address(i) != address(0) && token != address(0) && fees != address(0));
        aqua = a;
        inventory = i;
        usdc = token;
        feeRecipient = fees;
    }

    /// @notice Return the EIP-712 digest bound to this router and chain.
    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, o)));
    }

    /// @notice Return Aqua's strategy hash for the exact ABI-encoded mandate.
    function hashMandate(Mandate calldata m) public pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @notice Permanently invalidate the caller's nonce across both buy and sell orders.
    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

    /// @notice Permanently close a nonzero alternative group belonging to the caller.
    function cancelGroup(bytes32 group) external {
        require(group != 0, InvalidOrder());
        closedGroup[msg.sender][group] = true;
        emit GroupClosed(msg.sender, group);
    }

    function _validate(Order calldata o, bytes calldata sig) private view {
        require(
            o.maker != address(0) && o.recipient != address(0) && o.quantity > 0 && o.startDay < o.endDay
                && o.endDay - o.startDay <= 31 && block.timestamp < uint256(o.startDay) * 1 days
                && block.timestamp < o.expiry,
            InvalidOrder()
        );
        require(!used[o.maker][o.nonce] && (o.group == 0 || !closedGroup[o.maker][o.group]), ClosedOrder());
        require(SignatureChecker.isValidSignatureNow(o.maker, hashOrder(o), sig), InvalidSignature());
    }

    function _consume(Order calldata o) private {
        // Recheck because both orders could use the same maker/group/nonce.
        require(!used[o.maker][o.nonce] && (o.group == 0 || !closedGroup[o.maker][o.group]), ClosedOrder());
        used[o.maker][o.nonce] = true;
        if (o.group != 0) closedGroup[o.maker][o.group] = true;
    }

    /// @notice Atomically exchange one matching bid/ask basket for wallet-held USDC through Aqua.
    /// @dev Anyone may relay; signatures fix recipients, basket, program and funding authority.
    /// Failure of either payment or ERC-1155 transfer rolls back nonces, groups and mandate spending.
    /// @param program Exact two-instruction program authenticated by both orders' programHash.
    /// @return price Seller proceeds in USDC base units.
    /// @return fee Additional buyer-paid USDC sent to the immutable fee recipient.
    function settle(
        Order calldata bid,
        bytes calldata bidSig,
        Order calldata ask,
        bytes calldata askSig,
        Mandate calldata m,
        bytes calldata program
    ) external nonReentrant returns (uint256 price, uint256 fee) {
        _validate(bid, bidSig);
        _validate(ask, askSig);
        require(
            bid.buy && !ask.buy && ask.mandate == 0 && bid.pool == ask.pool && bid.startDay == ask.startDay
                && bid.endDay == ask.endDay && bid.quantity == ask.quantity && bid.terms == ask.terms
                && bid.programHash == ask.programHash && bid.programHash == keccak256(program),
            InvalidOrder()
        );
        bytes32 mandateHash = hashMandate(m);
        require(
            bid.mandate == mandateHash && m.buyer == bid.maker && m.app == address(this) && m.token == usdc
                && block.timestamp < m.expiry,
            InvalidMandate()
        );
        (uint248 remaining, uint8 status) = aqua.rawBalances(m.buyer, address(this), mandateHash, usdc);
        require(status > 0 && status != 255, InvalidMandate());
        (price, fee) = _quote(program, bid.endDay - bid.startDay, bid.quantity);
        uint256 total = price + fee;
        require(
            price > 0 && total <= bid.priceLimit && price >= ask.priceLimit && fee <= bid.maxFee && fee <= ask.maxFee,
            PriceLimit()
        );
        require(spent[mandateHash] + total <= m.limit && total <= remaining, BudgetExceeded());
        // Consume authorization before external transfers. Reversion restores it if either asset leg fails.
        _consume(bid);
        _consume(ask);
        spent[mandateHash] += total;
        uint256 count = bid.endDay - bid.startDay;
        uint256[] memory ids = new uint256[](count);
        uint256[] memory amounts = new uint256[](count);
        for (uint256 n; n < count; ++n) {
            ids[n] = inventory.tokenId(bid.pool, bid.startDay + uint32(n), bid.terms);
            amounts[n] = bid.quantity;
        }
        aqua.pull(bid.maker, mandateHash, usdc, price, ask.recipient);
        if (fee > 0) aqua.pull(bid.maker, mandateHash, usdc, fee, feeRecipient);
        inventory.safeBatchTransferFrom(ask.maker, bid.recipient, ids, amounts, "");
        emit Settled(hashOrder(bid), hashOrder(ask), mandateHash, price, fee);
    }

    /// @notice Quote legacy whole-basket programs without a duration.
    /// @dev Terms programs require the duration-aware overload. Neither quote checks funds or ownership.
    /// @return price Seller proceeds in USDC base units.
    /// @return fee Additional buyer-paid USDC fee.
    function quote(bytes calldata program, uint256 units) external returns (uint256 price, uint256 fee) {
        return _quote(program, 0, units);
    }

    /// @notice Quote the same duration and quantity that settle derives from a signed order.
    /// @dev A Dutch quote is time-dependent; settlement recalculates it and enforces signed limits.
    /// @param durationDays Number of UTC daily slots in the basket (1-31).
    /// @param quantity Whole units per day.
    /// @return price Seller proceeds in USDC base units.
    /// @return fee Additional buyer-paid USDC fee.
    function quote(bytes calldata program, uint256 durationDays, uint256 quantity)
        external
        returns (uint256 price, uint256 fee)
    {
        require(durationDays > 0 && durationDays <= 31 && quantity > 0 && quantity <= type(uint32).max, InvalidOrder());
        return _quote(program, durationDays, quantity);
    }

    function _quote(bytes calldata program, uint256 durationDays, uint256 quantity)
        internal
        virtual
        returns (uint256 price, uint256 fee);
}
