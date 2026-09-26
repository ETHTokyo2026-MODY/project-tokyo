// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RentalSettlement} from "./RentalSettlement.sol";
import {RentalSwapVM} from "./RentalSwapVM.sol";
import {RentalCollective} from "./RentalCollective.sol";

/// @dev The bounded Uniswap V3 SwapRouter02 exact-input entry point.
interface IExactInputSingle {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Convert one exact WETH input into buyer-held USDC, then settle one signed rental fill.
/// @dev The immutable source, output, swap router, fee tier and rental router define the only route.
contract RentalAtomicConverter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct FundingIntent {
        address buyer;
        bytes32 bidHash;
        bytes32 askHash;
        bytes32 batchHash;
        address sourceToken;
        uint256 maxInput;
        uint256 minOutput;
        uint256 usdcCap;
        address recipient;
        uint256 deadline;
        uint256 chainId;
        address executor;
        uint256 nonce;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "FundingIntent(address buyer,bytes32 bidHash,bytes32 askHash,bytes32 batchHash,address sourceToken,uint256 maxInput,uint256 minOutput,uint256 usdcCap,address recipient,uint256 deadline,uint256 chainId,address executor,uint256 nonce)"
    );

    RentalSettlement public immutable rentalRouter;
    RentalCollective public immutable collective;
    IExactInputSingle public immutable swapRouter;
    IERC20 public immutable sourceToken;
    IERC20 public immutable usdc;
    uint24 public immutable poolFee;
    mapping(address => mapping(uint256 => bool)) public used;

    error InvalidIntent();
    error InvalidSignature();
    error SpentIntent();
    error InvalidFunding();

    event IntentCancelled(address indexed buyer, uint256 indexed nonce);
    event ConvertedSettled(
        address indexed buyer,
        uint256 indexed nonce,
        bytes32 indexed bidHash,
        bytes32 askHash,
        uint256 input,
        uint256 output,
        uint256 price,
        uint256 fee
    );
    event ConvertedCollective(
        address indexed buyer,
        uint256 indexed nonce,
        bytes32 indexed batchHash,
        bytes32 bidHash,
        uint256 input,
        uint256 output,
        uint256 buyerPrice,
        uint256 buyerFee,
        uint256 totalPrice,
        uint256 totalFee
    );

    constructor(RentalSettlement rental, IExactInputSingle swap, IERC20 source, IERC20 output, uint24 fee)
        EIP712("RentalAtomicConverter", "1")
    {
        require(
            address(rental) != address(0) && address(swap).code.length > 0 && address(source).code.length > 0
                && address(output).code.length > 0 && address(source) != address(output)
                && rental.usdc() == address(output) && fee != 0,
            InvalidIntent()
        );
        rentalRouter = rental;
        RentalCollective coordinator = RentalSwapVM(address(rental)).collective();
        require(address(coordinator).code.length > 0 && address(coordinator.router()) == address(rental), InvalidIntent());
        collective = coordinator;
        swapRouter = swap;
        sourceToken = source;
        usdc = output;
        poolFee = fee;
    }

    function hashIntent(FundingIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent)));
    }

    function hashBatch(RentalCollective.Fill[] calldata fills) public pure returns (bytes32) {
        return keccak256(abi.encode(fills));
    }

    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit IntentCancelled(msg.sender, nonce);
    }

    function execute(
        FundingIntent calldata intent,
        bytes calldata intentSig,
        RentalSettlement.Order calldata bid,
        bytes calldata bidSig,
        RentalSettlement.Order calldata ask,
        bytes calldata askSig,
        RentalSettlement.Mandate calldata mandate,
        bytes calldata program
    ) external nonReentrant returns (uint256 output, uint256 price, uint256 fee) {
        _authorize(intent, intentSig, bid, ask, mandate, program, bytes32(0));
        (uint256 quotedPrice, uint256 quotedFee) =
            rentalRouter.quote(program, bid.endDay - bid.startDay, bid.quantity);
        uint256 quotedTotal = quotedPrice + quotedFee;
        uint256 buyerUsdcBefore;
        (output, buyerUsdcBefore) = _convert(intent, quotedTotal);
        (price, fee) = rentalRouter.settle(bid, bidSig, ask, askSig, mandate, program);
        require(
            price + fee <= intent.usdcCap && usdc.balanceOf(intent.buyer) >= buyerUsdcBefore,
            InvalidFunding()
        );
        emit ConvertedSettled(
            intent.buyer, intent.nonce, intent.bidHash, intent.askHash, intent.maxInput, output, price, fee
        );
    }

    /// @notice Fund one exact buyer fill and activate its whole signed collective batch.
    function executeCollective(
        FundingIntent calldata intent,
        bytes calldata intentSig,
        RentalCollective.Fill[] calldata fills
    ) external nonReentrant returns (uint256 output, uint256 totalPrice, uint256 totalFee) {
        require(fills.length >= 2 && fills.length <= 8, InvalidIntent());
        bytes32 batchHash = hashBatch(fills);
        require(intent.batchHash == batchHash && batchHash != bytes32(0), InvalidIntent());
        uint256 selected = type(uint256).max;
        for (uint256 i; i < fills.length; ++i) {
            if (fills[i].bid.maker == intent.buyer) {
                require(selected == type(uint256).max, InvalidIntent());
                selected = i;
            }
        }
        require(selected != type(uint256).max, InvalidIntent());
        RentalCollective.Fill calldata chosen = fills[selected];
        _authorize(
            intent, intentSig, chosen.bid, chosen.ask, chosen.mandate, chosen.program, batchHash
        );
        (uint256 buyerPrice, uint256 buyerFee) =
            rentalRouter.quote(chosen.program, chosen.bid.endDay - chosen.bid.startDay, chosen.bid.quantity);
        uint256 buyerUsdcBefore;
        (output, buyerUsdcBefore) = _convert(intent, buyerPrice + buyerFee);
        (totalPrice, totalFee) = collective.activate(fills);
        require(usdc.balanceOf(intent.buyer) >= buyerUsdcBefore, InvalidFunding());
        emit ConvertedCollective(
            intent.buyer,
            intent.nonce,
            batchHash,
            intent.bidHash,
            intent.maxInput,
            output,
            buyerPrice,
            buyerFee,
            totalPrice,
            totalFee
        );
    }

    function _authorize(
        FundingIntent calldata intent,
        bytes calldata intentSig,
        RentalSettlement.Order calldata bid,
        RentalSettlement.Order calldata ask,
        RentalSettlement.Mandate calldata mandate,
        bytes calldata program,
        bytes32 batchHash
    ) private view {
        require(
            intent.buyer != address(0) && intent.buyer == bid.maker && intent.recipient == bid.recipient
                && intent.sourceToken == address(sourceToken) && intent.executor == address(this)
                && intent.chainId == block.chainid && block.timestamp <= intent.deadline && intent.maxInput > 0
                && intent.minOutput > 0 && intent.usdcCap > 0 && bid.buy && !ask.buy
                && intent.batchHash == batchHash && intent.bidHash == rentalRouter.hashOrder(bid)
                && intent.askHash == rentalRouter.hashOrder(ask) && bid.programHash == keccak256(program)
                && bid.mandate == rentalRouter.hashMandate(mandate),
            InvalidIntent()
        );
        require(!used[intent.buyer][intent.nonce], SpentIntent());
        require(SignatureChecker.isValidSignatureNow(intent.buyer, hashIntent(intent), intentSig), InvalidSignature());
    }

    function _convert(FundingIntent calldata intent, uint256 quotedTotal)
        private
        returns (uint256 output, uint256 buyerUsdcBefore)
    {
        require(quotedTotal > 0 && quotedTotal <= intent.usdcCap, InvalidIntent());
        uint256 minimum = quotedTotal > intent.minOutput ? quotedTotal : intent.minOutput;
        used[intent.buyer][intent.nonce] = true;
        buyerUsdcBefore = usdc.balanceOf(intent.buyer);
        uint256 sourceBefore = sourceToken.balanceOf(address(this));
        sourceToken.safeTransferFrom(intent.buyer, address(this), intent.maxInput);
        require(sourceToken.balanceOf(address(this)) == sourceBefore + intent.maxInput, InvalidFunding());
        sourceToken.forceApprove(address(swapRouter), intent.maxInput);
        output = swapRouter.exactInputSingle(
            IExactInputSingle.ExactInputSingleParams({
                tokenIn: address(sourceToken),
                tokenOut: address(usdc),
                fee: poolFee,
                recipient: intent.buyer,
                amountIn: intent.maxInput,
                amountOutMinimum: minimum,
                sqrtPriceLimitX96: 0
            })
        );
        sourceToken.forceApprove(address(swapRouter), 0);
        require(
            output >= minimum && sourceToken.balanceOf(address(this)) == sourceBefore
                && usdc.balanceOf(intent.buyer) >= buyerUsdcBefore + minimum,
            InvalidFunding()
        );
    }
}
