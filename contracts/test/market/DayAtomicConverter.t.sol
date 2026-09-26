// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Aqua} from "aqua/Aqua.sol";
import {RentalAsset} from "../../src/day/RentalAsset.sol";
import {RentalAssetFactory} from "../../src/day/RentalAssetFactory.sol";
import {DaySwapVM} from "../../src/market/DaySwapVM.sol";
import {DayAtomicConverter, IDayExactInputSingle} from "../../src/market/DayAtomicConverter.sol";

contract ConversionToken is ERC20 {
    uint8 private immutable precision;

    constructor(string memory label, uint8 decimals_) ERC20(label, label) {
        precision = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return precision;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Unit route endpoint only: settlement below uses actual DaySwapVM, official Aqua and day tokens.
contract ConversionRoute is IDayExactInputSingle {
    IERC20 private immutable input;
    ConversionToken private immutable output;
    uint256 public delivered = 300e6;
    uint256 public reported = 300e6;
    bool public partialInput;
    bytes public callback;
    bool public reentered;

    constructor(IERC20 weth, ConversionToken usd) {
        input = weth;
        output = usd;
    }

    function configure(uint256 delivered_, uint256 reported_, bool consumePartial) external {
        delivered = delivered_;
        reported = reported_;
        partialInput = consumePartial;
    }

    function setCallback(bytes calldata data) external {
        callback = data;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(p.tokenIn == address(input) && p.tokenOut == address(output) && p.fee == 500);
        require(p.sqrtPriceLimitX96 == 0 && p.amountIn == 1 ether && p.recipient != msg.sender);
        if (callback.length != 0) (reentered,) = msg.sender.call(callback);
        input.transferFrom(msg.sender, address(this), partialInput ? p.amountIn - 1 : p.amountIn);
        require(delivered >= p.amountOutMinimum, "slippage");
        output.mint(p.recipient, delivered);
        return reported;
    }
}

contract ConversionBuyer is IERC1271 {
    address private immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(digest, signature) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract DayAtomicConverterTest is Test {
    uint256 private constant BUY_KEY = 0xB0B;
    address private buyer;
    address private host = address(0xA11CE);
    address private seller = address(0x5E11);
    Aqua private aqua;
    ConversionToken private usd;
    ConversionToken private weth;
    RentalAsset private asset;
    DaySwapVM private market;
    ConversionRoute private route;
    DayAtomicConverter private converter;
    DaySwapVM.Bid private bid;
    DaySwapVM.Ask[] private asks;
    bytes[] private programs;
    uint32 private today;

    function setUp() public {
        vm.warp(1_800_000_000);
        buyer = vm.addr(BUY_KEY);
        aqua = new Aqua();
        usd = new ConversionToken("USDC", 6);
        weth = new ConversionToken("WETH", 18);
        RentalAssetFactory factory = new RentalAssetFactory();
        RentalAsset.AssetDefaults memory defaults;
        defaults.minimum = 1e6;
        for (uint256 i; i < 7; i++) {
            defaults.listedPrices[i] = 120e6;
            defaults.sellingPrices[i] = 100e6;
        }
        RentalAsset.DiscountStep[] memory ladder = new RentalAsset.DiscountStep[](1);
        ladder[0] = RentalAsset.DiscountStep(3, 1000);
        vm.prank(host);
        asset = RentalAsset(factory.createAsset(bytes32("car"), "car", defaults, ladder));
        today = asset.startDay();
        market = new DaySwapVM(aqua, usd, factory);
        route = new ConversionRoute(weth, usd);
        converter = new DayAtomicConverter(market, route, weth, 500);
        bid = DaySwapVM.Bid(
            buyer,
            block.chainid,
            address(market),
            address(asset),
            today,
            today + 3,
            300e6,
            1,
            uint40(block.timestamp + 1 days),
            bytes32(0)
        );
        for (uint32 i; i < 3; i++) {
            IERC20 token = IERC20(asset.materialize(today + i));
            address owner = i == 1 ? seller : host;
            if (i == 1) {
                vm.prank(host);
                token.transfer(seller, 1);
            }
            RentalAsset.DayView memory state = asset.dayState(today + i);
            asks.push(
                DaySwapVM.Ask(
                    owner, block.chainid, address(market), address(asset), today + i, state.saleNonce, 0, bytes32(0)
                )
            );
            asks[i].discountVersion = asset.discountVersion();
            programs.push(market.program(address(asset), today + i, 3));
            vm.startPrank(owner);
            asset.setListing(today + i, today + i + 1, true, 100e6);
            token.approve(address(aqua), 1);
            _ship(abi.encode(asks[i]), address(token), 1);
            vm.stopPrank();
        }
        _fundBuyer();
    }

    function testConversionSettlesRealMultiSellerAquaBasketAndLeavesBuyerSurplus() public {
        usd.mint(buyer, 17e6);
        weth.mint(address(converter), 5 ether); // Existing converter funds must remain untouched.
        DayAtomicConverter.FundingIntent memory f = _intent();
        (uint256 output, uint256 total) = converter.execute(f, _sign(f), bid, asks, programs);
        assertEq(output, 300e6);
        assertEq(total, 270e6);
        assertEq(usd.balanceOf(buyer), 47e6);
        assertEq(usd.balanceOf(host), 180e6);
        assertEq(usd.balanceOf(seller), 90e6);
        assertEq(weth.balanceOf(buyer), 1 ether);
        assertEq(weth.balanceOf(address(route)), 1 ether);
        assertEq(weth.balanceOf(address(converter)), 5 ether);
        assertEq(weth.allowance(address(converter), address(route)), 0);
        assertEq(usd.balanceOf(address(converter)), 0);
        assertTrue(converter.used(buyer, f.nonce));
        assertTrue(market.used(buyer, bid.nonce));
        assertEq(_balance(buyer, market.hashBid(bid), address(usd)), 30e6);
        for (uint32 i; i < 3; i++) {
            RentalAsset.DayView memory state = asset.dayState(today + i);
            assertEq(state.owner, buyer);
            assertFalse(state.listed);
            assertEq(IERC20(state.token).balanceOf(buyer), 1);
            assertEq(_balance(asks[i].seller, market.hashAsk(asks[i]), state.token), 0);
        }
        bytes memory signature = _sign(f);
        vm.expectRevert(DayAtomicConverter.SpentIntent.selector);
        converter.execute(f, signature, bid, asks, programs);
    }

    function testEverySignedIntentFieldRejectsTampering() public {
        DayAtomicConverter.FundingIntent memory f = _intent();
        bytes memory signature = _sign(f);
        for (uint256 field; field < 12; field++) {
            bytes memory encoded = abi.encode(f);
            assembly ("memory-safe") {
                let at := add(add(encoded, 32), mul(field, 32))
                mstore(at, xor(mload(at), 1))
            }
            DayAtomicConverter.FundingIntent memory changed = abi.decode(encoded, (DayAtomicConverter.FundingIntent));
            _failure(changed, signature);
        }
        _unfilled(0);
    }

    function testExactBidAndOrderedAskBasketCannotBeSubstituted() public {
        DayAtomicConverter.FundingIntent memory f = _intent();
        bytes memory signature = _sign(f);
        bid.salt = bytes32(uint256(1));
        _failure(f, signature);
        bid.salt = bytes32(0);
        asks[0].salt = bytes32(uint256(1));
        _failure(f, signature);
        asks[0].salt = bytes32(0);
        DaySwapVM.Ask memory first = asks[0];
        asks[0] = asks[1];
        asks[1] = first;
        _failure(f, signature);
        asks[1] = asks[0];
        asks[0] = first;
        _unfilled(0);
    }

    function testFundingSpendCapRollsBackConversionAndAllSettlementLegs() public {
        DayAtomicConverter.FundingIntent memory f = _intent();
        f.usdcCap = 269e6;
        _failure(f, _sign(f));
        _unfilled(0);
    }

    function testPreexistingUsdcCannotSubsidizeAnInsufficientConversion() public {
        usd.mint(buyer, 100e6);
        route.configure(200e6, 200e6, false);
        DayAtomicConverter.FundingIntent memory f = _intent();
        f.minOutput = 200e6;
        _failure(f, _sign(f));
        _unfilled(100e6);
    }

    function testSlippageInflatedReturnAndPartialInputAreRejected() public {
        DayAtomicConverter.FundingIntent memory f = _intent();
        bytes memory signature = _sign(f);
        route.configure(269e6, 269e6, false);
        _failure(f, signature);
        _unfilled(0);
        route.configure(290e6, 300e6, false);
        _failure(f, signature);
        _unfilled(0);
        route.configure(300e6, 300e6, true);
        _failure(f, signature);
        _unfilled(0);
    }

    function testFinalDayTransferFailureRollsBackSuccessfulSwapAndEarlierAquaLegs() public {
        address token = asset.tokenAddress(today + 2);
        vm.mockCallRevert(token, abi.encodeCall(IERC20.transferFrom, (host, buyer, 1)), bytes("late failure"));
        DayAtomicConverter.FundingIntent memory f = _intent();
        _failure(f, _sign(f));
        _unfilled(0);
        vm.clearMockedCalls();
        converter.execute(f, _sign(f), bid, asks, programs);
        assertEq(asset.dayState(today + 2).owner, buyer);
    }

    function testCanonicalProgramStillEnforcedThroughConverter() public {
        programs[1] = market.program(address(asset), today + 1, 1);
        DayAtomicConverter.FundingIntent memory f = _intent();
        _failure(f, _sign(f));
        _unfilled(0);
    }

    function testNonceCancellationExpiryAndDomainPreventReplay() public {
        DayAtomicConverter.FundingIntent memory f = _intent();
        converter.cancel(f.nonce); // Relayer cannot cancel the buyer's funding nonce.
        assertFalse(converter.used(buyer, f.nonce));
        vm.prank(buyer);
        converter.cancel(f.nonce);
        _failure(f, _sign(f));
        assertFalse(market.used(buyer, bid.nonce));
        f.nonce++;
        f.deadline = block.timestamp - 1;
        _failure(f, _sign(f));
        f.deadline = block.timestamp;
        bytes memory signature = _sign(f);
        DayAtomicConverter other = new DayAtomicConverter(market, route, weth, 500);
        f.executor = address(other);
        vm.expectRevert(DayAtomicConverter.InvalidSignature.selector);
        other.execute(f, signature, bid, asks, programs);
        f.executor = address(converter);
        vm.chainId(block.chainid + 1);
        f.chainId = block.chainid;
        _failure(f, signature);
    }

    function testExactDeadlineAndReentrantSwapCallback() public {
        DayAtomicConverter.FundingIntent memory f = _intent();
        f.deadline = block.timestamp;
        bytes memory signature = _sign(f);
        route.setCallback(abi.encodeCall(DayAtomicConverter.execute, (f, signature, bid, asks, programs)));
        converter.execute(f, signature, bid, asks, programs);
        assertFalse(route.reentered());
        assertTrue(converter.used(buyer, f.nonce));
    }

    function testERC1271BuyerCanFundItsPublishedBasket() public {
        buyer = address(new ConversionBuyer(vm.addr(BUY_KEY)));
        bid.buyer = buyer;
        _fundBuyer();
        DayAtomicConverter.FundingIntent memory f = _intent();
        converter.execute(f, _sign(f), bid, asks, programs);
        assertEq(asset.dayState(today).owner, buyer);
        assertEq(usd.balanceOf(buyer), 30e6);
    }

    function _fundBuyer() private {
        weth.mint(buyer, 2 ether);
        vm.startPrank(buyer);
        weth.approve(address(converter), 2 ether);
        usd.approve(address(aqua), bid.maxTotal);
        _ship(abi.encode(bid), address(usd), bid.maxTotal);
        vm.stopPrank();
    }

    function _intent() private view returns (DayAtomicConverter.FundingIntent memory) {
        return DayAtomicConverter.FundingIntent(
            buyer,
            market.hashBid(bid),
            converter.hashAsks(asks),
            address(weth),
            1 ether,
            270e6,
            300e6,
            buyer,
            block.timestamp + 1 days,
            block.chainid,
            address(converter),
            7
        );
    }

    function _sign(DayAtomicConverter.FundingIntent memory f) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUY_KEY, converter.hashIntent(f));
        return abi.encodePacked(r, s, v);
    }

    function _failure(DayAtomicConverter.FundingIntent memory f, bytes memory signature) private {
        vm.expectRevert();
        converter.execute(f, signature, bid, asks, programs);
    }

    function _ship(bytes memory data, address token, uint256 amount) private {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        aqua.ship(address(market), data, tokens, amounts);
    }

    function _balance(address maker, bytes32 hash, address token) private view returns (uint248 value) {
        (value,) = aqua.rawBalances(maker, address(market), hash, token);
    }

    function _unfilled(uint256 buyerUsdc) private view {
        assertEq(weth.balanceOf(buyer), 2 ether);
        assertEq(weth.balanceOf(address(route)), 0);
        assertEq(weth.balanceOf(address(converter)), 0);
        assertEq(weth.allowance(address(converter), address(route)), 0);
        assertEq(usd.balanceOf(buyer), buyerUsdc);
        assertEq(usd.balanceOf(host), 0);
        assertEq(usd.balanceOf(seller), 0);
        assertFalse(converter.used(buyer, 7));
        assertFalse(market.used(buyer, bid.nonce));
        assertEq(_balance(buyer, market.hashBid(bid), address(usd)), 300e6);
        for (uint32 i; i < 3; i++) {
            RentalAsset.DayView memory state = asset.dayState(today + i);
            assertEq(state.owner, asks[i].seller);
            assertEq(state.saleNonce, asks[i].saleNonce);
            assertTrue(state.listed);
            assertEq(_balance(asks[i].seller, market.hashAsk(asks[i]), state.token), 1);
        }
    }
}
