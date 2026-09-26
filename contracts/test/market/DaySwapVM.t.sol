// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "aqua/Aqua.sol";
import {DayToken} from "../../src/day/DayToken.sol";
import {RentalAsset} from "../../src/day/RentalAsset.sol";
import {RentalAssetFactory} from "../../src/day/RentalAssetFactory.sol";
import {DaySwapVM} from "../../src/market/DaySwapVM.sol";

contract MarketUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DaySwapVMTest is Test {
    Aqua private aqua;
    MarketUSDC private usd;
    RentalAssetFactory private factory;
    RentalAsset private asset;
    DaySwapVM private router;
    address private host = address(0xA11CE);
    address private seller = address(0x5E11);
    address private buyer = address(0xB0B);
    uint32 private today;
    DaySwapVM.Bid private bid;
    DaySwapVM.Ask[] private asks;
    bytes[] private programs;

    function setUp() public {
        vm.warp(1_800_000_000);
        aqua = new Aqua();
        usd = new MarketUSDC();
        factory = new RentalAssetFactory();
        RentalAsset.AssetDefaults memory defaults;
        defaults.minimum = 1e6;
        for (uint256 i; i < 7; ++i) {
            defaults.listedPrices[i] = 120e6;
            defaults.sellingPrices[i] = 100e6;
        }
        RentalAsset.DiscountStep[] memory steps = new RentalAsset.DiscountStep[](1);
        steps[0] = RentalAsset.DiscountStep(3, 1000);
        vm.prank(host);
        asset = RentalAsset(factory.createAsset(bytes32("car"), "ipfs://car", defaults, steps));
        today = asset.startDay();
        router = new DaySwapVM(aqua, usd, factory);
        usd.mint(buyer, 500e6);
        bid = DaySwapVM.Bid(
            buyer,
            block.chainid,
            address(router),
            address(asset),
            today,
            today + 3,
            300e6,
            1,
            uint40(block.timestamp + 7 days),
            bytes32(0)
        );
        for (uint32 i; i < 3; ++i) {
            DayToken token = DayToken(asset.materialize(today + i));
            if (i == 1) {
                vm.prank(host);
                token.transfer(seller, 1);
                vm.prank(seller);
                asset.setListing(today + i, today + i + 1, true, 100e6);
            }
            asks.push(_ask(today + i));
            programs.push(router.program(address(asset), today + i, 3));
            _shipAsk(asks[i]);
        }
        _shipBid(bid);
    }

    function testBothOfficialAquaLegsConserveAcrossSellersAndConsumeOnce() public {
        (uint256 quoted, DaySwapVM.DayFill[] memory fills) = router.quote(bid, asks, programs);
        assertEq(quoted, 270e6);
        assertEq(fills.length, 3);
        assertEq(fills[1].payment, 90e6);
        assertEq(router.settle(bid, asks, programs), quoted);
        assertEq(usd.balanceOf(buyer), 230e6);
        assertEq(usd.balanceOf(host), 180e6);
        assertEq(usd.balanceOf(seller), 90e6);
        assertEq(_available(buyer, router.hashBid(bid), address(usd)), 30e6);
        for (uint256 i; i < 3; ++i) {
            RentalAsset.DayView memory state = asset.dayState(today + uint32(i));
            assertEq(state.owner, buyer);
            assertFalse(state.listed);
            assertEq(DayToken(state.token).balanceOf(buyer), 1);
            assertEq(DayToken(state.token).totalSupply(), 1);
            assertEq(DayToken(state.token).decimals(), 0);
            assertEq(DayToken(state.token).allowance(buyer, address(aqua)), 0);
            assertEq(_available(asks[i].seller, router.hashAsk(asks[i]), state.token), 0);
        }
        vm.expectRevert(DaySwapVM.ClosedOrder.selector);
        router.settle(bid, asks, programs);
    }

    function testLastTransferFailureRevertsEarlierRealAquaTransfersAndNonce() public {
        address last = asset.tokenAddress(today + 2);
        vm.mockCallRevert(last, abi.encodeCall(IERC20.transferFrom, (host, buyer, 1)), bytes("last transfer failed"));
        vm.expectRevert();
        router.settle(bid, asks, programs);
        assertEq(usd.balanceOf(buyer), 500e6);
        assertEq(usd.balanceOf(host), 0);
        assertEq(usd.balanceOf(seller), 0);
        assertFalse(router.used(buyer, 1));
        assertEq(_available(buyer, router.hashBid(bid), address(usd)), 300e6);
        for (uint256 i; i < 3; ++i) {
            RentalAsset.DayView memory state = asset.dayState(today + uint32(i));
            assertEq(state.owner, asks[i].seller);
            assertEq(state.saleNonce, asks[i].saleNonce);
            assertTrue(state.listed);
            assertEq(_available(asks[i].seller, router.hashAsk(asks[i]), state.token), 1);
            assertEq(DayToken(state.token).allowance(asks[i].seller, address(aqua)), 1);
        }
        vm.clearMockedCalls();
        assertEq(router.settle(bid, asks, programs), 270e6);
    }

    function testStandingBidRepricesWithoutNewSellerEpoch() public {
        bid.maxTotal = 250e6;
        bid.nonce = 2;
        _shipBid(bid);
        vm.expectRevert(DaySwapVM.BudgetExceeded.selector);
        router.settle(bid, asks, programs);
        vm.prank(seller);
        asset.setListing(today + 1, today + 2, true, 70e6);
        assertEq(router.settle(bid, asks, programs), 243e6);
    }

    function testIndependentBidsCompeteForWalletFundsAndCanRecoverWithoutOCO() public {
        DaySwapVM.Bid memory other = bid;
        other.nonce = 2;
        _shipBid(other);
        router.settle(bid, asks, programs);
        assertFalse(router.used(buyer, 2));
        for (uint256 i; i < 3; ++i) {
            DayToken token = DayToken(asset.tokenAddress(today + uint32(i)));
            address oldSeller = asks[i].seller;
            vm.prank(buyer);
            token.transfer(oldSeller, 1);
            vm.prank(oldSeller);
            asset.setListing(today + uint32(i), today + uint32(i) + 1, true, 100e6);
            asks[i] = _ask(today + uint32(i));
            _shipAsk(asks[i]);
        }
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.settle(other, asks, programs);
        assertFalse(router.used(buyer, 2));
        assertEq(usd.balanceOf(buyer), 230e6);
        usd.mint(buyer, 40e6);
        assertEq(router.settle(other, asks, programs), 270e6);
    }

    function testLadderChangeRequiresFreshSellerConsent() public {
        _ladder(2000);
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        _refreshAsks();
        assertEq(router.settle(bid, asks, programs), 240e6);
    }

    function testFullDiscountStillRequiresShippedBidAndConsumesNonce() public {
        _ladder(10_000);
        _refreshAsks();
        bid.maxTotal = 0;
        bid.nonce = 2;
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.settle(bid, asks, programs);
        _shipBid(bid);
        vm.prank(buyer);
        usd.approve(address(aqua), 0);
        assertEq(router.settle(bid, asks, programs), 0);
        assertEq(usd.balanceOf(buyer), 500e6);
        assertEq(usd.balanceOf(host), 0);
        assertTrue(router.used(buyer, 2));
        vm.expectRevert(DaySwapVM.ClosedOrder.selector);
        router.settle(bid, asks, programs);
    }

    function testRoundingConservesPerDayPayoutsIndependentOfOwnerGrouping() public {
        vm.prank(host);
        asset.setListing(today, today + 1, true, 1);
        vm.prank(seller);
        asset.setListing(today + 1, today + 2, true, 2);
        vm.prank(host);
        asset.setListing(today + 2, today + 3, true, 3);
        assertEq(router.settle(bid, asks, programs), 3); // floor(.9)+floor(1.8)+floor(2.7)
        assertEq(usd.balanceOf(host), 2);
        assertEq(usd.balanceOf(seller), 1);
    }

    function testSellerDockAndAllowanceAreIndependentRequirements() public {
        DayToken token = DayToken(asset.tokenAddress(today + 1));
        vm.prank(seller);
        token.approve(address(aqua), 0);
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.quote(bid, asks, programs);
        vm.prank(seller);
        token.approve(address(aqua), 1);
        _dock(seller, router.hashAsk(asks[1]), address(token));
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.settle(bid, asks, programs);
    }

    function testBuyerDockAndAllowanceRevocation() public {
        vm.prank(buyer);
        usd.approve(address(aqua), 0);
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.quote(bid, asks, programs);
        vm.prank(buyer);
        usd.approve(address(aqua), 300e6);
        _dock(buyer, router.hashBid(bid), address(usd));
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.settle(bid, asks, programs);
    }

    function testCancelIsMakerScopedAndPersistentDespiteFunding() public {
        router.cancel(1); // caller cannot cancel buyer's nonce
        router.quote(bid, asks, programs);
        vm.prank(buyer);
        router.cancel(1);
        vm.expectRevert(DaySwapVM.ClosedOrder.selector);
        router.settle(bid, asks, programs);
    }

    function testUnlistBlocksLiveAskAndRelistKeepsOwnershipEpoch() public {
        vm.prank(seller);
        asset.setListing(today + 1, today + 2, false, 100e6);
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.quote(bid, asks, programs);
        vm.prank(seller);
        asset.setListing(today + 1, today + 2, true, 100e6);
        assertEq(router.settle(bid, asks, programs), 270e6);
    }

    function testOldAskCannotReviveAfterOwnershipRoundTrip() public {
        DayToken token = DayToken(asset.tokenAddress(today));
        vm.prank(host);
        token.transfer(seller, 1);
        vm.prank(seller);
        token.transfer(host, 1);
        vm.prank(host);
        asset.setListing(today, today + 1, true, 100e6);
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.settle(bid, asks, programs);
    }

    function testUnauthorizedProgramAndWrongDurationRejected() public {
        programs[0] = router.program(address(asset), today, 1);
        vm.expectRevert(DaySwapVM.InvalidProgram.selector);
        router.settle(bid, asks, programs);
        programs[0] = bytes.concat(router.program(address(asset), today, 3), hex"0000");
        vm.expectRevert(DaySwapVM.InvalidProgram.selector);
        router.quote(bid, asks, programs);
    }

    function testDomainFactoryRangeAndSelfPurchaseChecks() public {
        bid.chainId++;
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        bid.chainId = block.chainid;
        bid.app = address(this);
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        bid.app = address(router);
        bid.asset = address(this);
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        bid.asset = address(asset);
        bid.endDayExclusive = today;
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        bid.endDayExclusive = today + 366;
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        bid.endDayExclusive = today + 3;
        bid.buyer = host;
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
    }

    function testWrongSellerDomainOrDayCannotSubstituteForShippedAsk() public {
        asks[0].app = address(this);
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        asks[0].app = address(router);
        asks[0].chainId++;
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
        asks[0].chainId = block.chainid;
        asks[0].day++;
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.quote(bid, asks, programs);
    }

    function testExpiryInclusiveAndJSTMidnight() public {
        bid.deadline = uint40(block.timestamp);
        bid.nonce = 2;
        _shipBid(bid);
        router.quote(bid, asks, programs);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DaySwapVM.ClosedOrder.selector);
        router.quote(bid, asks, programs);
        bid.deadline = uint40(block.timestamp + 7 days);
        bid.nonce = 3;
        _shipBid(bid);
        vm.warp(uint256(today + 1) * 1 days - 9 hours - 1);
        router.quote(bid, asks, programs);
        vm.warp(uint256(today + 1) * 1 days - 9 hours);
        vm.expectRevert(DaySwapVM.InvalidOrder.selector);
        router.settle(bid, asks, programs);
    }

    function testBookingDoesNotChangeOwnershipSalePriceOrPayout() public {
        uint128 publicPrice = asset.dayState(today + 1).listedPrice;
        vm.prank(host);
        asset.setBooked(today + 1, true, publicPrice);
        assertEq(router.settle(bid, asks, programs), 270e6);
        RentalAsset.DayView memory state = asset.dayState(today + 1);
        assertTrue(state.booked);
        assertEq(state.listedPrice, publicPrice);
        assertEq(state.sellingPrice, 100e6);
    }

    function testPredictedTokenShipmentNeedsMaterializationAndApproval() public {
        uint32 day = today + 5;
        DaySwapVM.Ask memory a = _ask(day);
        address predicted = asset.tokenAddress(day);
        vm.prank(host);
        _ship(abi.encode(a), predicted, 1);
        bid.startDay = day;
        bid.endDayExclusive = day + 1;
        bid.nonce = 2;
        _shipBid(bid);
        delete asks;
        asks.push(a);
        delete programs;
        programs.push(router.program(address(asset), day, 1));
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.quote(bid, asks, programs);
        DayToken token = DayToken(asset.materialize(day));
        vm.expectRevert(DaySwapVM.Unavailable.selector);
        router.quote(bid, asks, programs);
        vm.prank(host);
        token.approve(address(aqua), 1);
        assertEq(router.settle(bid, asks, programs), 100e6);
    }

    function testGasOneDay() public {
        _gasRange(1);
    }

    function testGasSevenDays() public {
        _gasRange(7);
    }

    function testGasThirtyOneDays() public {
        _gasRange(31);
    }

    function _gasRange(uint16 count) private {
        delete asks;
        delete programs;
        bid.startDay = today + 10;
        bid.endDayExclusive = bid.startDay + count;
        bid.maxTotal = uint256(count) * 100e6;
        bid.nonce = 77;
        usd.mint(buyer, bid.maxTotal);
        for (uint32 i; i < count; ++i) {
            uint32 day = bid.startDay + i;
            asset.materialize(day);
            asks.push(_ask(day));
            _shipAsk(asks[i]);
            programs.push(router.program(address(asset), day, count));
        }
        _shipBid(bid);
        uint256 before = gasleft();
        uint256 paid = router.settle(bid, asks, programs);
        emit log_named_uint("settlement execution gas (warm after setup)", before - gasleft());
        assertEq(paid, uint256(count) * (count >= 3 ? 90e6 : 100e6));
    }

    function _ask(uint32 day) private view returns (DaySwapVM.Ask memory) {
        RentalAsset.DayView memory state = asset.dayState(day);
        return DaySwapVM.Ask(
            state.owner,
            block.chainid,
            address(router),
            address(asset),
            day,
            state.saleNonce,
            asset.discountVersion(),
            bytes32(0)
        );
    }

    function _shipAsk(DaySwapVM.Ask memory a) private {
        address token = asset.tokenAddress(a.day);
        vm.startPrank(a.seller);
        IERC20(token).approve(address(aqua), 1);
        _ship(abi.encode(a), token, 1);
        vm.stopPrank();
    }

    function _shipBid(DaySwapVM.Bid memory b) private {
        vm.startPrank(b.buyer);
        usd.approve(address(aqua), type(uint256).max);
        _ship(abi.encode(b), address(usd), b.maxTotal);
        vm.stopPrank();
    }

    function _ship(bytes memory data, address token, uint256 amount) private {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        aqua.ship(address(router), data, tokens, amounts);
    }

    function _dock(address maker, bytes32 hash, address token) private {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        vm.prank(maker);
        aqua.dock(address(router), hash, tokens);
    }

    function _available(address maker, bytes32 hash, address token) private view returns (uint248 amount) {
        (amount,) = aqua.rawBalances(maker, address(router), hash, token);
    }

    function _ladder(uint16 bps) private {
        RentalAsset.DiscountStep[] memory steps = new RentalAsset.DiscountStep[](1);
        steps[0] = RentalAsset.DiscountStep(3, bps);
        vm.prank(host);
        asset.setDiscountLadder(steps);
    }

    function _refreshAsks() private {
        for (uint256 i; i < asks.length; ++i) {
            asks[i] = _ask(today + uint32(i));
            _shipAsk(asks[i]);
        }
    }
}
