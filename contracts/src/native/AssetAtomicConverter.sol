// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AssetSwapVM} from "./AssetSwapVM.sol";
import {IExactInputSingle} from "../RentalAtomicConverter.sol";

/// @notice Convert one exact WETH input into buyer-held USDC, then settle one shipped asset strategy pair.
/// @dev The immutable source, output, swap router, fee tier and rental router define the only route.
contract AssetAtomicConverter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Separate buyer authorization for this conversion and exact rental order pair.
    /// Despite its name, maxInput is the exact source amount consumed, not an exact-output ceiling.
    /// minOutput and usdcCap use USDC base units; recipient must match the signed rental bid.
    struct FundingIntent {
        address buyer;
        bytes32 bidHash;
        bytes32 askHash;
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
        "FundingIntent(address buyer,bytes32 bidHash,bytes32 askHash,address sourceToken,uint256 maxInput,uint256 minOutput,uint256 usdcCap,address recipient,uint256 deadline,uint256 chainId,address executor,uint256 nonce)"
    );

    AssetSwapVM public immutable rentalRouter;
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
        uint256 price
    );

    constructor(AssetSwapVM rental, IExactInputSingle swap, IERC20 source, IERC20 output, uint24 fee)
        EIP712("AssetAtomicConverter", "1")
    {
        require(
            address(rental) != address(0) && address(swap).code.length > 0 && address(source).code.length > 0
                && address(output).code.length > 0 && address(source) != address(output) && rental.USDC() == address(output)
                && fee != 0,
            InvalidIntent()
        );
        rentalRouter = rental;
        swapRouter = swap;
        sourceToken = source;
        usdc = output;
        poolFee = fee;
    }

    /// @notice Return the funding digest bound to this converter and chain.
    function hashIntent(FundingIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent)));
    }

    /// @notice Invalidate the caller's funding nonce without cancelling its separate rental orders.
    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit IntentCancelled(msg.sender, nonce);
    }

    /// @notice Convert the authorized source amount and settle the chosen rental in one transaction.
    /// @dev Anyone may relay. The buyer approves this converter for source tokens and Aqua for USDC.
    /// The buyer keeps conversion surplus and at least its preexisting USDC balance; any failure
    /// rolls back the swap, rental transfer, funding nonce and Aqua spending.
    /// @return output Actual increase in buyer USDC from conversion, before rental settlement.
    /// @return price Seller proceeds paid through Aqua.
    function execute(
        FundingIntent calldata intent,
        bytes calldata intentSig,
        AssetSwapVM.Strategy calldata bid,
        AssetSwapVM.Strategy calldata ask
    ) external nonReentrant returns (uint256 output, uint256 price) {
        _authorize(intent, intentSig, bid, ask);
        uint256 buyerUsdcBefore;
        (output, buyerUsdcBefore) = _convert(intent);
        price = rentalRouter.swap(bid, ask);
        require(price <= intent.usdcCap && usdc.balanceOf(intent.buyer) >= buyerUsdcBefore, InvalidFunding());
        emit ConvertedSettled(
            intent.buyer, intent.nonce, intent.bidHash, intent.askHash, intent.maxInput, output, price
        );
    }

    function _authorize(
        FundingIntent calldata intent,
        bytes calldata intentSig,
        AssetSwapVM.Strategy calldata bid,
        AssetSwapVM.Strategy calldata ask
    ) private view {
        require(
            intent.buyer != address(0) && intent.buyer == bid.maker && intent.recipient == bid.maker
                && intent.sourceToken == address(sourceToken) && intent.executor == address(this)
                && intent.chainId == block.chainid && block.timestamp <= intent.deadline && intent.maxInput > 0
                && intent.minOutput > 0 && intent.usdcCap > 0 && bid.buy && !ask.buy
                && intent.bidHash == rentalRouter.hash(bid) && intent.askHash == rentalRouter.hash(ask),
            InvalidIntent()
        );
        require(!used[intent.buyer][intent.nonce], SpentIntent());
        require(SignatureChecker.isValidSignatureNow(intent.buyer, hashIntent(intent), intentSig), InvalidSignature());
    }

    function _convert(FundingIntent calldata intent) private returns (uint256 output, uint256 buyerUsdcBefore) {
        // Pricing requires funded balances. Convert first; the signed cap and preserved
        // starting USDC balance are checked after swap, with atomic rollback on failure.
        uint256 minimum = intent.minOutput;
        used[intent.buyer][intent.nonce] = true;
        buyerUsdcBefore = usdc.balanceOf(intent.buyer);
        uint256 sourceBefore = sourceToken.balanceOf(address(this));
        sourceToken.safeTransferFrom(intent.buyer, address(this), intent.maxInput);
        require(sourceToken.balanceOf(address(this)) == sourceBefore + intent.maxInput, InvalidFunding());
        sourceToken.forceApprove(address(swapRouter), intent.maxInput);
        uint256 reportedOutput = swapRouter.exactInputSingle(
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
        // Measure delivery rather than trusting the swap router's reported output alone.
        uint256 buyerUsdcAfter = usdc.balanceOf(intent.buyer);
        require(
            reportedOutput >= minimum && sourceToken.balanceOf(address(this)) == sourceBefore
                && buyerUsdcAfter >= buyerUsdcBefore + reportedOutput,
            InvalidFunding()
        );
        output = buyerUsdcAfter - buyerUsdcBefore;
    }
}
