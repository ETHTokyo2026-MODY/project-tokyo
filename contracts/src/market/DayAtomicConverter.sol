// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DaySwapVM} from "./DaySwapVM.sol";

/// @dev Uniswap V3 SwapRouter02's bounded exact-input entry point (no arbitrary router calldata).
interface IDayExactInputSingle {
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

/// @title Signed WETH funding and atomic rental-day settlement
/// @notice Converts an authorized exact WETH input into buyer-held USDC, then fills one complete day basket.
/// @dev The immutable configured SwapRouter02, WETH, USDC and fee define the only supported route.
/// Adapted from the checkpoint AssetAtomicConverter funding bounds; no ERC-1155 accounting is used.
contract DayAtomicConverter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev maxInput is the exact input consumed by this exact-input route, not an exact-output ceiling.
    /// asksHash binds the complete ordered ask array. minOutput and usdcCap are raw USDC amounts.
    struct FundingIntent {
        address buyer;
        bytes32 bidHash;
        bytes32 asksHash;
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
        "FundingIntent(address buyer,bytes32 bidHash,bytes32 asksHash,address sourceToken,uint256 maxInput,uint256 minOutput,uint256 usdcCap,address recipient,uint256 deadline,uint256 chainId,address executor,uint256 nonce)"
    );
    DaySwapVM public immutable rentalRouter;
    IDayExactInputSingle public immutable swapRouter;
    IERC20 public immutable sourceToken;
    IERC20 public immutable usdc;
    uint24 public immutable poolFee;
    mapping(address buyer => mapping(uint256 nonce => bool)) public used;

    error InvalidIntent();
    error InvalidSignature();
    error SpentIntent();
    error InvalidFunding();

    event IntentCancelled(address indexed buyer, uint256 indexed nonce);
    event ConvertedSettled(
        address indexed buyer,
        uint256 indexed nonce,
        bytes32 indexed bidHash,
        bytes32 asksHash,
        uint256 input,
        uint256 output,
        uint256 total
    );

    constructor(DaySwapVM rental, IDayExactInputSingle swap, IERC20 weth, uint24 fee)
        EIP712("DayAtomicConverter", "1")
    {
        require(
            address(rental).code.length != 0 && address(swap).code.length != 0 && address(weth).code.length != 0
                && address(weth) != address(rental.USDC()) && fee != 0,
            InvalidIntent()
        );
        rentalRouter = rental;
        swapRouter = swap;
        sourceToken = weth;
        usdc = rental.USDC();
        poolFee = fee;
    }

    /// @notice Hash the full ordered ask basket, including its length and every authorization field.
    /// @return The basket hash used in FundingIntent. Programs are canonical and checked by DaySwapVM.
    function hashAsks(DaySwapVM.Ask[] calldata asks) public pure returns (bytes32) {
        return keccak256(abi.encode(asks));
    }

    /// @notice Hash the funding intent under this converter's EIP-712 chain and contract domain.
    /// @return The digest for an EOA or ERC-1271 buyer signature.
    function hashIntent(FundingIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent)));
    }

    /// @notice Close the caller's funding nonce; the separate published day bid remains independently cancellable.
    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit IntentCancelled(msg.sender, nonce);
    }

    /// @notice Anyone may relay this exact signed conversion and already-published day basket.
    /// @dev Buyer approves WETH to this converter and USDC to Aqua, and ships the bid to DaySwapVM.
    /// Conversion surplus stays with the buyer and preexisting USDC cannot subsidize the purchase.
    /// Any failure reverts the swap, both funding/order nonces and all official Aqua transfers.
    /// @return output Actual buyer USDC increase from conversion, before settlement.
    /// @return total Actual sum of seller payouts through official Aqua.
    function execute(
        FundingIntent calldata intent,
        bytes calldata signature,
        DaySwapVM.Bid calldata bid,
        DaySwapVM.Ask[] calldata asks,
        bytes[] calldata programs
    ) external nonReentrant returns (uint256 output, uint256 total) {
        require(
            intent.buyer != address(0) && intent.buyer == bid.buyer && intent.recipient == bid.buyer
                && intent.sourceToken == address(sourceToken) && intent.executor == address(this)
                && intent.chainId == block.chainid && block.timestamp <= intent.deadline && intent.maxInput != 0
                && intent.minOutput != 0 && intent.bidHash == rentalRouter.hashBid(bid) && intent.asksHash == hashAsks(asks),
            InvalidIntent()
        );
        require(!used[intent.buyer][intent.nonce], SpentIntent());
        require(SignatureChecker.isValidSignatureNow(intent.buyer, hashIntent(intent), signature), InvalidSignature());
        used[intent.buyer][intent.nonce] = true;
        uint256 beforeUsdc = usdc.balanceOf(intent.buyer);
        uint256 beforeSource = sourceToken.balanceOf(address(this));
        sourceToken.safeTransferFrom(intent.buyer, address(this), intent.maxInput);
        require(sourceToken.balanceOf(address(this)) == beforeSource + intent.maxInput, InvalidFunding());
        sourceToken.forceApprove(address(swapRouter), intent.maxInput);
        uint256 reported = swapRouter.exactInputSingle(
            IDayExactInputSingle.ExactInputSingleParams({
                tokenIn: address(sourceToken),
                tokenOut: address(usdc),
                fee: poolFee,
                recipient: intent.buyer,
                amountIn: intent.maxInput,
                amountOutMinimum: intent.minOutput,
                sqrtPriceLimitX96: 0
            })
        );
        sourceToken.forceApprove(address(swapRouter), 0);
        uint256 afterUsdc = usdc.balanceOf(intent.buyer);
        require(
            reported >= intent.minOutput && afterUsdc >= beforeUsdc + reported
                && sourceToken.balanceOf(address(this)) == beforeSource,
            InvalidFunding()
        );
        output = afterUsdc - beforeUsdc;
        total = rentalRouter.settle(bid, asks, programs);
        require(total <= intent.usdcCap && usdc.balanceOf(intent.buyer) >= beforeUsdc, InvalidFunding());
        emit ConvertedSettled(
            intent.buyer, intent.nonce, intent.bidHash, intent.asksHash, intent.maxInput, output, total
        );
    }
}
