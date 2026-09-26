// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {RentalInventory} from "./RentalInventory.sol";

/// @notice Full-fill, single-seller rental exchange. Aqua holds only USDC allowances.
abstract contract RentalSettlement is EIP712, ReentrancyGuard {
    struct Mandate {
        address buyer;
        address app;
        address token;
        uint256 limit;
        uint256 expiry;
        bytes32 salt;
    }

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
    RentalInventory public immutable inventory;
    address public immutable usdc;
    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 100;
    mapping(address => mapping(uint256 => bool)) public used;
    mapping(address => mapping(bytes32 => bool)) public closedGroup;
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

    constructor(IAqua a, RentalInventory i, address token, address fees) EIP712("RentalSettlement", "1") {
        require(address(a) != address(0) && address(i) != address(0) && token != address(0) && fees != address(0));
        aqua = a;
        inventory = i;
        usdc = token;
        feeRecipient = fees;
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, o)));
    }

    function hashMandate(Mandate calldata m) public pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

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
        price = _price(program, uint256(bid.endDay - bid.startDay) * bid.quantity);
        fee = price * FEE_BPS / 10_000;
        uint256 total = price + fee;
        require(
            price > 0 && total <= bid.priceLimit && price >= ask.priceLimit && fee <= bid.maxFee && fee <= ask.maxFee,
            PriceLimit()
        );
        require(spent[mandateHash] + total <= m.limit && total <= remaining, BudgetExceeded());
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

    function quote(bytes calldata program, uint256 units) external returns (uint256 price, uint256 fee) {
        price = _price(program, units);
        fee = price * FEE_BPS / 10_000;
    }

    function _price(bytes calldata program, uint256 units) internal virtual returns (uint256);
}
