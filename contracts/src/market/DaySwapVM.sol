// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025. Rental integration added 2026-09-26.
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {Context} from "swap-vm/libs/VM.sol";
import {Opcode} from "swap-vm/libs/OpcodeList.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";
import {CalldataPtrLib} from "@1inch/solidity-utils/contracts/libraries/CalldataPtr.sol";
import {RentalAsset} from "../day/RentalAsset.sol";
import {RentalAssetFactory} from "../day/RentalAssetFactory.sol";

/// @title Atomic rental-day execution through official Aqua
/// @notice Executes a shipped buyer budget against independently shipped day asks.
/// @dev Reuses the pinned SwapVM interpreter and full-amount instruction. Its custom
/// day-price opcode reads selling prices and the asset ladder; the transfer shell
/// pulls both USDC and each individual ERC-20 through unchanged Aqua. Programs are
/// canonical per-day programs, not compatible with the stock router's order ABI.
contract DaySwapVM is ReentrancyGuard {
    struct Bid {
        address buyer;
        uint256 chainId;
        address app;
        address asset;
        uint32 startDay;
        uint32 endDayExclusive;
        uint256 maxTotal;
        uint256 nonce;
        uint40 deadline;
        bytes32 salt;
    }

    /// @dev saleNonce binds ownership; price edits remain live. A host ladder edit
    /// requires sellers to publish fresh asks consenting to its discountVersion.
    struct Ask {
        address seller;
        uint256 chainId;
        address app;
        address asset;
        uint32 day;
        uint64 saleNonce;
        uint64 discountVersion;
        bytes32 salt;
    }

    struct DayFill {
        address token;
        address seller;
        bytes32 askHash;
        uint256 payment;
    }

    uint8 public constant DAY_PRICE = 0x9e;
    IAqua public immutable AQUA;
    IERC20 public immutable USDC;
    RentalAssetFactory public immutable FACTORY;
    mapping(address buyer => mapping(uint256 nonce => bool)) public used;

    error InvalidOrder();
    error ClosedOrder();
    error InvalidProgram();
    error Unavailable();
    error BudgetExceeded();

    event Cancelled(address indexed buyer, uint256 indexed nonce);
    event DaySettled(bytes32 indexed bidHash, bytes32 indexed askHash, address indexed token, uint256 payment);
    event Settled(bytes32 indexed bidHash, address indexed buyer, address indexed asset, uint256 total);

    constructor(IAqua aqua, IERC20 usdc, RentalAssetFactory factory) {
        require(
            address(aqua).code.length != 0 && address(usdc).code.length != 0 && address(factory).code.length != 0,
            InvalidOrder()
        );
        AQUA = aqua;
        USDC = usdc;
        FACTORY = factory;
    }

    /// @notice Hash exactly the preimage the buyer ships with [USDC] and [maxTotal].
    function hashBid(Bid calldata bid) public pure returns (bytes32) {
        return keccak256(abi.encode(bid));
    }

    /// @notice Hash exactly the preimage the seller ships with [dayToken] and [1].
    function hashAsk(Ask calldata ask) public pure returns (bytes32) {
        return keccak256(abi.encode(ask));
    }

    /// @notice Permanently close the caller's nonce without affecting their other bids.
    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

    /// @notice Build the sole permitted program for a constituent day and whole-range duration.
    /// @dev The authenticated range determines these operands; no arbitrary caller program executes.
    function program(address asset, uint32 day, uint16 duration) public view returns (bytes memory) {
        require(FACTORY.isAsset(asset) && duration != 0, InvalidOrder());
        address token = RentalAsset(asset).tokenAddress(day);
        return bytes.concat(
            bytes1(DAY_PRICE),
            hex"60",
            abi.encode(asset, day, duration),
            LimitSwapFullAmount.build(address(USDC) < token)
        );
    }

    /// @notice Quote live prices, funding and seller authorizations without consuming the bid.
    /// @dev May be called with eth_call. Simulate settle for authoritative transfer readiness.
    function quote(Bid calldata bid, Ask[] calldata asks, bytes[] calldata programs)
        external
        returns (uint256 total, DayFill[] memory fills)
    {
        return _evaluate(bid, asks, programs);
    }

    /// @notice Anyone can fill the complete range; a failed leg rolls back every transfer and nonce.
    /// @dev Recipients, prices and tokens come from authenticated orders and canonical asset state.
    function settle(Bid calldata bid, Ask[] calldata asks, bytes[] calldata programs)
        external
        nonReentrant
        returns (uint256 total)
    {
        DayFill[] memory fills;
        (total, fills) = _evaluate(bid, asks, programs);
        bytes32 bidHash = hashBid(bid);
        used[bid.buyer][bid.nonce] = true;
        for (uint256 i; i < fills.length; ++i) {
            DayFill memory fill = fills[i];
            if (fill.payment != 0) AQUA.pull(bid.buyer, bidHash, address(USDC), fill.payment, fill.seller);
            AQUA.pull(fill.seller, fill.askHash, fill.token, 1, bid.buyer);
            emit DaySettled(bidHash, fill.askHash, fill.token, fill.payment);
        }
        emit Settled(bidHash, bid.buyer, bid.asset, total);
    }

    function _evaluate(Bid calldata bid, Ask[] calldata asks, bytes[] calldata programs)
        private
        returns (uint256 total, DayFill[] memory fills)
    {
        require(
            bid.buyer != address(0) && bid.app == address(this) && bid.chainId == block.chainid
                && FACTORY.isAsset(bid.asset),
            InvalidOrder()
        );
        require(!used[bid.buyer][bid.nonce] && block.timestamp <= bid.deadline, ClosedOrder());
        RentalAsset asset = RentalAsset(bid.asset);
        require(
            bid.startDay >= asset.startDay() && bid.startDay >= asset.currentDay() && bid.startDay < bid.endDayExclusive
                && bid.endDayExclusive <= asset.endDayExclusive(),
            InvalidOrder()
        );
        uint16 duration = uint16(bid.endDayExclusive - bid.startDay); // fixed 365-day horizon
        require(asks.length == duration && programs.length == duration, InvalidOrder());
        uint64 version = asset.discountVersion();
        fills = new DayFill[](duration);
        for (uint256 i; i < duration; ++i) {
            Ask calldata ask = asks[i];
            uint32 day = bid.startDay + uint32(i);
            RentalAsset.DayView memory state = asset.dayState(day);
            require(
                ask.app == address(this) && ask.chainId == block.chainid && ask.asset == bid.asset && ask.day == day
                    && ask.seller == state.owner && ask.seller != bid.buyer && ask.saleNonce == state.saleNonce
                    && ask.discountVersion == version,
                InvalidOrder()
            );
            require(state.deployed && state.listed, Unavailable());
            bytes32 askHash = hashAsk(ask);
            _available(ask.seller, askHash, IERC20(state.token), 1);
            require(keccak256(programs[i]) == keccak256(program(bid.asset, day, duration)), InvalidProgram());
            uint256 payment = _run(programs[i], state.token);
            fills[i] = DayFill(state.token, ask.seller, askHash, payment);
            total += payment;
        }
        require(total <= bid.maxTotal, BudgetExceeded());
        // A zero-total purchase still requires a live shipped bid and consumes its nonce.
        _available(bid.buyer, hashBid(bid), USDC, total);
    }

    function _available(address maker, bytes32 strategyHash, IERC20 token, uint256 amount) private view {
        (uint248 remaining, uint8 count) = AQUA.rawBalances(maker, address(this), strategyHash, address(token));
        require(
            count != 0 && count != 255 && remaining >= amount && token.balanceOf(maker) >= amount
                && token.allowance(maker, address(AQUA)) >= amount,
            Unavailable()
        );
    }

    function _run(bytes calldata code, address token) private returns (uint256 payment) {
        Context memory ctx;
        ctx.vm.isStaticContext = true;
        ctx.vm.programPtr = CalldataPtrLib.from(code);
        ctx.vm.dispatch = _dispatch;
        ctx.query.tokenIn = address(USDC);
        ctx.query.tokenOut = token;
        ctx.swap.amountOut = 1; // exact one raw unit, independently of ERC-20 decimals
        uint256 output;
        (payment, output) = ctx.runLoop();
        require(output == 1, InvalidProgram());
    }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal view {
        if (opcode == DAY_PRICE && args.length == 96) {
            (RentalAsset asset, uint32 day, uint16 duration) = abi.decode(args, (RentalAsset, uint32, uint16));
            ctx.swap.balanceIn =
                Math.mulDiv(asset.dayState(day).sellingPrice, 10_000 - asset.discountBps(duration), 10_000);
            ctx.swap.balanceOut = 1;
        } else if (opcode == uint8(Opcode.LimitSwapFullAmount) && args.length == 1) {
            LimitSwapFullAmount.exec(ctx, args);
        } else {
            revert InvalidProgram();
        }
    }
}
