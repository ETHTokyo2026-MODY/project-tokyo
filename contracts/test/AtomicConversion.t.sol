// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Fixture, TestUSDC} from "./Fixture.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalCollective} from "../src/RentalCollective.sol";
import {RentalAtomicConverter, IExactInputSingle} from "../src/RentalAtomicConverter.sol";

contract TestSource is ERC20 {
    constructor() ERC20("Test WETH", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TestSingleRouter is IExactInputSingle {
    TestUSDC public immutable outputToken;
    IERC20 public immutable inputToken;
    uint256 public amountOut;
    uint256 public reportedOutput;
    bytes public callback;
    bool public callbackAttempted;
    bool public callbackSucceeded;

    constructor(IERC20 input, TestUSDC output) {
        inputToken = input;
        outputToken = output;
    }

    function setOutput(uint256 amount) external {
        amountOut = amount;
        reportedOutput = amount;
    }

    function setReportedOutput(uint256 amount) external {
        reportedOutput = amount;
    }

    function setCallback(bytes calldata data) external {
        callback = data;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(p.tokenIn == address(inputToken) && p.tokenOut == address(outputToken) && p.fee == 500);
        require(p.sqrtPriceLimitX96 == 0 && p.amountIn > 0 && p.recipient != address(this));
        if (callback.length > 0) {
            callbackAttempted = true;
            (callbackSucceeded,) = msg.sender.call(callback);
        }
        require(amountOut >= p.amountOutMinimum, "insufficient output");
        inputToken.transferFrom(msg.sender, address(this), p.amountIn);
        outputToken.mint(p.recipient, amountOut);
        return reportedOutput;
    }
}

contract Conversion1271Buyer is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4) {
        return ECDSA.recover(digest, sig) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract AtomicConversionTest is Fixture {
    TestSource internal weth;
    TestSingleRouter internal swap;
    RentalAtomicConverter internal converter;

    function setUp() public override {
        super.setUp();
        weth = new TestSource();
        swap = new TestSingleRouter(weth, usd);
        swap.setOutput(2e6);
        converter = new RentalAtomicConverter(router, swap, weth, usd, 500);
        weth.mint(buyer, 2 ether);
        vm.startPrank(buyer);
        weth.approve(address(converter), type(uint256).max);
        usd.transfer(address(0xBEEF), 1000e6);
        vm.stopPrank();
    }

    function _intent(RentalSettlement.Order memory bid, RentalSettlement.Order memory ask, uint256 nonce)
        internal
        view
        returns (RentalAtomicConverter.FundingIntent memory f)
    {
        f = RentalAtomicConverter.FundingIntent({
            buyer: bid.maker,
            bidHash: router.hashOrder(bid),
            askHash: router.hashOrder(ask),
            batchHash: bytes32(0),
            sourceToken: address(weth),
            maxInput: 1 ether,
            minOutput: 1e6,
            usdcCap: 2e6,
            recipient: bid.recipient,
            deadline: block.timestamp + 1 days,
            chainId: block.chainid,
            executor: address(converter),
            nonce: nonce
        });
    }

    function _fundingSig(RentalAtomicConverter.FundingIntent memory f) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUY_KEY, converter.hashIntent(f));
        return abi.encodePacked(r, s, v);
    }

    function _execute(
        RentalAtomicConverter.FundingIntent memory f,
        RentalSettlement.Order memory bid,
        RentalSettlement.Order memory ask,
        bytes memory program
    ) internal returns (uint256 output, uint256 price, uint256 fee) {
        return converter.execute(f, _fundingSig(f), bid, _sig(bid, BUY_KEY), ask, _sig(ask, SELL_KEY), mandate, program);
    }

    function _expectFailure(
        bytes memory reason,
        RentalAtomicConverter.FundingIntent memory f,
        RentalSettlement.Order memory bid,
        RentalSettlement.Order memory ask,
        bytes memory program
    ) internal {
        bytes memory fundingSig = _fundingSig(f);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.expectRevert(reason);
        converter.execute(f, fundingSig, bid, bidSig, ask, askSig, mandate, program);
    }

    function _expectAnyFailure(
        RentalAtomicConverter.FundingIntent memory f,
        RentalSettlement.Order memory bid,
        RentalSettlement.Order memory ask,
        bytes memory program
    ) internal {
        bytes memory fundingSig = _fundingSig(f);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.expectRevert();
        converter.execute(f, fundingSig, bid, bidSig, ask, askSig, mandate, program);
    }

    function testConversionPaysExactRentalAndLeavesSurplusInBuyerWallet() public {
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 21, p);
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 7);
        uint256 sellerBefore = usd.balanceOf(seller);
        (uint256 output, uint256 price, uint256 fee) = _execute(f, bid, ask, p);
        assertEq(output, 2e6);
        assertEq(price, 1e6);
        assertEq(fee, 10_000);
        assertEq(usd.balanceOf(buyer), 990_000);
        assertEq(usd.balanceOf(seller), sellerBefore + price);
        assertEq(usd.balanceOf(fees), fee);
        assertEq(weth.balanceOf(buyer), 1 ether);
        assertEq(weth.balanceOf(address(converter)), 0);
        assertEq(weth.allowance(address(converter), address(swap)), 0);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 1);
        assertTrue(converter.used(buyer, f.nonce));
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.SpentIntent.selector), f, bid, ask, p);
    }

    function testInsufficientOutputRollsBackSourceNonceAndAqua() public {
        swap.setOutput(1e6);
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 22, p);
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 8);
        _expectFailure(bytes("insufficient output"), f, bid, ask, p);
        _assertNoFill(f, bid, ask);
    }

    function testInflatedSwapReturnCannotOverstateBuyerUsdc() public {
        swap.setOutput(1_010_000);
        swap.setReportedOutput(2e6);
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 50, p);
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 50);
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.InvalidFunding.selector), f, bid, ask, p);
        assertFalse(converter.used(buyer, f.nonce));
        assertEq(weth.balanceOf(buyer), 2 ether);
        assertEq(usd.balanceOf(buyer), 0);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 0);
    }

    function testMovedInventoryAfterQuoteRollsBackSuccessfulSwap() public {
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 23, p);
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 9);
        uint256 tokenId = inventory.tokenId(POOL, day, TERMS);
        vm.prank(seller);
        inventory.safeTransferFrom(seller, other, tokenId, 1, "");
        _expectAnyFailure(f, bid, ask, p);
        _assertNoFill(f, bid, ask);
        assertEq(inventory.balanceOf(other, inventory.tokenId(POOL, day, TERMS)), 1);
    }

    function testTamperedPairRecipientSourceAndChainAreRejected() public {
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 24, p);
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 10);
        bytes memory originalSig = _fundingSig(f);
        RentalAtomicConverter.FundingIntent memory changed = f;
        changed.recipient = other;
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.InvalidIntent.selector), changed, bid, ask, p);
        changed = _intent(bid, ask, 10);
        changed.sourceToken = address(usd);
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.InvalidIntent.selector), changed, bid, ask, p);
        changed = _intent(bid, ask, 10);
        changed.chainId += 1;
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.InvalidIntent.selector), changed, bid, ask, p);
        changed = _intent(bid, ask, 10);
        changed.usdcCap += 1;
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.expectRevert(RentalAtomicConverter.InvalidSignature.selector);
        converter.execute(changed, originalSig, bid, bidSig, ask, askSig, mandate, p);
        changed = _intent(bid, ask, 10);
        changed.askHash = bytes32(uint256(1));
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.InvalidIntent.selector), changed, bid, ask, p);
        _assertNoFill(f, bid, ask);
    }

    function testAlternativeBidsShareWethButOcoRejectsSecondWithoutSwap() public {
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory firstBid, RentalSettlement.Order memory firstAsk) = _orders(day, day + 1, 25, p);
        (RentalSettlement.Order memory nextBid, RentalSettlement.Order memory nextAsk) = _orders(day + 1, day + 2, 26, p);
        bytes32 group = keccak256("weth-funded-alternatives");
        firstBid.group = group;
        nextBid.group = group;
        RentalAtomicConverter.FundingIntent memory first = _intent(firstBid, firstAsk, 11);
        RentalAtomicConverter.FundingIntent memory next = _intent(nextBid, nextAsk, 12);
        _execute(first, firstBid, firstAsk, p);
        uint256 remainingWeth = weth.balanceOf(buyer);
        uint256 remainingUsdc = usd.balanceOf(buyer);
        _expectFailure(abi.encodeWithSelector(RentalSettlement.ClosedOrder.selector), next, nextBid, nextAsk, p);
        assertEq(weth.balanceOf(buyer), remainingWeth);
        assertEq(usd.balanceOf(buyer), remainingUsdc);
        assertFalse(converter.used(buyer, next.nonce));
        assertFalse(router.used(buyer, nextBid.nonce));
        assertEq(inventory.balanceOf(seller, inventory.tokenId(POOL, day + 1, TERMS)), 1);
    }

    function testCancellationExpiryAndReentrantCallback() public {
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 27, p);
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 13);
        vm.prank(buyer);
        converter.cancel(f.nonce);
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.SpentIntent.selector), f, bid, ask, p);
        f.nonce = 14;
        f.deadline = block.timestamp - 1;
        _expectFailure(abi.encodeWithSelector(RentalAtomicConverter.InvalidIntent.selector), f, bid, ask, p);
        f.deadline = block.timestamp + 1 days;
        swap.setCallback(
            abi.encodeCall(
                RentalAtomicConverter.execute,
                (f, _fundingSig(f), bid, _sig(bid, BUY_KEY), ask, _sig(ask, SELL_KEY), mandate, p)
            )
        );
        _execute(f, bid, ask, p);
        assertTrue(swap.callbackAttempted());
        assertFalse(swap.callbackSucceeded());
        assertEq(usd.balanceOf(buyer), 990_000);
    }

    function testSignedSmartAccountBuyerCanFundItsOrder() public {
        Conversion1271Buyer wallet = new Conversion1271Buyer(vm.addr(BUY_KEY));
        buyer = address(wallet);
        weth.mint(buyer, 1 ether);
        vm.prank(buyer);
        weth.approve(address(converter), 1 ether);
        mandate = _fund(buyer, 2e6, keccak256("contract-buyer"));
        bytes memory p = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 28, p);
        bid.recipient = other;
        RentalAtomicConverter.FundingIntent memory f = _intent(bid, ask, 15);
        _execute(f, bid, ask, p);
        assertEq(usd.balanceOf(buyer), 990_000);
        assertEq(inventory.balanceOf(other, inventory.tokenId(POOL, day, TERMS)), 1);
    }

    function _collectiveFills(uint256 minimumSpend) internal returns (RentalCollective.Fill[] memory fills) {
        RentalCollective coordinator = router.collective();
        bytes memory p = bytes.concat(
            hex"a280", abi.encode(address(coordinator), keccak256("conversion-campaign"), uint256(2), minimumSpend),
            fixedProgram(1e6)
        );
        RentalSettlement.Mandate memory secondMandate = _fund(other, 1000e6, keccak256("other-participant"));
        (RentalSettlement.Order memory firstBid, RentalSettlement.Order memory firstAsk) =
            _orders(day, day + 1, 31, p);
        (RentalSettlement.Order memory secondBid, RentalSettlement.Order memory secondAsk) =
            _orders(day + 1, day + 2, 32, p);
        secondBid.maker = other;
        secondBid.recipient = other;
        secondBid.mandate = router.hashMandate(secondMandate);
        fills = new RentalCollective.Fill[](2);
        fills[0] = RentalCollective.Fill(
            firstBid, _sig(firstBid, BUY_KEY), firstAsk, _sig(firstAsk, SELL_KEY), mandate, p
        );
        fills[1] = RentalCollective.Fill(
            secondBid, _sig(secondBid, OTHER_KEY), secondAsk, _sig(secondAsk, SELL_KEY), secondMandate, p
        );
    }

    function testWethBuyerActivatesExactGuardedBatchAndSurplusRemains() public {
        RentalCollective.Fill[] memory fills = _collectiveFills(2_020_000);
        RentalAtomicConverter.FundingIntent memory f = _intent(fills[0].bid, fills[0].ask, 16);
        f.batchHash = converter.hashBatch(fills);
        (uint256 output, uint256 totalPrice, uint256 totalFee) =
            converter.executeCollective(f, _fundingSig(f), fills);
        assertEq(output, 2e6);
        assertEq(totalPrice, 2e6);
        assertEq(totalFee, 20_000);
        assertEq(usd.balanceOf(buyer), 990_000);
        assertEq(usd.balanceOf(other), 1000e6 - 1_010_000);
        assertEq(weth.balanceOf(buyer), 1 ether);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(inventory.balanceOf(other, inventory.tokenId(POOL, day + 1, TERMS)), 1);
        assertTrue(converter.used(buyer, f.nonce));
    }

    function testLaterCollectiveFailureRollsBackEarlierSwapAndAllFills() public {
        RentalCollective.Fill[] memory fills = _collectiveFills(2_020_000);
        RentalAtomicConverter.FundingIntent memory f = _intent(fills[0].bid, fills[0].ask, 17);
        f.batchHash = converter.hashBatch(fills);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vm.prank(other);
        aqua.dock(address(router), fills[1].bid.mandate, tokens);
        bytes memory sig = _fundingSig(f);
        vm.expectRevert(RentalSettlement.InvalidMandate.selector);
        converter.executeCollective(f, sig, fills);
        assertEq(weth.balanceOf(buyer), 2 ether);
        assertEq(usd.balanceOf(buyer), 0);
        assertEq(weth.balanceOf(address(swap)), 0);
        assertFalse(converter.used(buyer, f.nonce));
        assertFalse(router.used(buyer, fills[0].bid.nonce));
        assertFalse(router.used(other, fills[1].bid.nonce));
        assertEq(router.spent(fills[0].bid.mandate), 0);
    }

    function testCollectiveIntentBindsEveryOtherParticipantAndThreshold() public {
        RentalCollective.Fill[] memory fills = _collectiveFills(2_020_000);
        RentalAtomicConverter.FundingIntent memory f = _intent(fills[0].bid, fills[0].ask, 18);
        f.batchHash = converter.hashBatch(fills);
        bytes memory sig = _fundingSig(f);
        fills[1].bid.recipient = buyer;
        vm.expectRevert(RentalAtomicConverter.InvalidIntent.selector);
        converter.executeCollective(f, sig, fills);
        assertEq(weth.balanceOf(buyer), 2 ether);
        assertFalse(converter.used(buyer, f.nonce));
    }

    function _assertNoFill(
        RentalAtomicConverter.FundingIntent memory f,
        RentalSettlement.Order memory bid,
        RentalSettlement.Order memory ask
    ) internal view {
        assertEq(weth.balanceOf(buyer), 2 ether);
        assertEq(usd.balanceOf(buyer), 0);
        assertEq(weth.balanceOf(address(converter)), 0);
        assertEq(weth.balanceOf(address(swap)), 0);
        assertFalse(converter.used(buyer, f.nonce));
        assertFalse(router.used(buyer, bid.nonce));
        assertFalse(router.used(seller, ask.nonce));
        assertEq(router.spent(bid.mandate), 0);
        (uint248 remaining,) = aqua.rawBalances(buyer, address(router), bid.mandate, address(usd));
        assertEq(remaining, 1000e6);
    }
}
