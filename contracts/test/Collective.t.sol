// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "./Fixture.sol";
import {RentalCollective} from "../src/RentalCollective.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";

contract CollectiveTest is Fixture {
    bytes32 internal constant CAMPAIGN = keccak256("collective-week-one");
    bytes32 internal constant COLLECTIVE_POOL = keccak256("collective-room-class");
    RentalCollective internal coordinator;

    function setUp() public override {
        super.setUp();
        coordinator = router.collective();
    }

    function _key(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("collective-buyer", i)));
    }

    function _guard(
        bytes memory priceProgram,
        address coordinatorAddress,
        bytes32 campaign,
        uint256 participants,
        uint256 spend
    ) internal pure returns (bytes memory) {
        return bytes.concat(hex"a280", abi.encode(coordinatorAddress, campaign, participants, spend), priceProgram);
    }

    function _fills(uint256 count, uint32 daysCount, uint256 participants, uint256 spend)
        internal
        returns (RentalCollective.Fill[] memory fills)
    {
        inventory.createPool(COLLECTIVE_POOL, seller, day, day + daysCount, uint32(count));
        vm.prank(seller);
        inventory.issue(COLLECTIVE_POOL, day, day + daysCount, TERMS, uint32(count));
        bytes memory program =
            _guard(fixedProgram(uint256(daysCount) * 1e6), address(coordinator), CAMPAIGN, participants, spend);
        fills = new RentalCollective.Fill[](count);
        for (uint256 i; i < count; ++i) {
            uint256 key = _key(i);
            address who = vm.addr(key);
            usd.mint(who, 1000e6);
            RentalSettlement.Mandate memory m = _fund(who, 1000e6, bytes32(i + 10));
            (RentalSettlement.Order memory b, RentalSettlement.Order memory s) =
                _orders(day, day + daysCount, i + 100, program);
            b.maker = who;
            b.recipient = who;
            b.pool = COLLECTIVE_POOL;
            b.mandate = keccak256(abi.encode(m));
            s.pool = COLLECTIVE_POOL;
            fills[i] = RentalCollective.Fill(b, _sig(b, key), s, _sig(s, SELL_KEY), m, program);
        }
    }

    function testDirectSettlementCannotBypassThreshold() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        RentalCollective.Fill memory f = fills[0];
        vm.expectRevert(RentalSwapVM.InvalidProgram.selector);
        router.settle(f.bid, f.bidSig, f.ask, f.askSig, f.mandate, f.program);
        assertFalse(router.used(f.bid.maker, f.bid.nonce));
        assertEq(router.spent(f.bid.mandate), 0);
        (uint256 quoted, uint256 fee) = router.quote(f.program, 1, 1);
        assertEq(quoted, 1e6);
        assertEq(fee, 10_000);
    }

    function testGuardAndBatchBounds() public {
        bytes memory priceProgram = fixedProgram(1e6);
        bytes memory invalid = _guard(priceProgram, address(coordinator), CAMPAIGN, 1, 1);
        vm.expectRevert();
        router.quote(invalid, 1, 1);
        invalid = _guard(priceProgram, address(coordinator), CAMPAIGN, 9, 1);
        vm.expectRevert();
        router.quote(invalid, 1, 1);
        invalid = _guard(priceProgram, address(coordinator), CAMPAIGN, 2, 0);
        vm.expectRevert();
        router.quote(invalid, 1, 1);
        invalid = _guard(priceProgram, address(coordinator), bytes32(0), 2, 1);
        vm.expectRevert();
        router.quote(invalid, 1, 1);
        RentalCollective.Fill[] memory oversized = new RentalCollective.Fill[](9);
        vm.expectRevert(RentalCollective.InvalidBatch.selector);
        coordinator.activate(oversized);
    }

    function testCountAndSpendThresholdsRollBackAllFills() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 3, 2e6);
        vm.expectRevert(RentalCollective.InvalidBatch.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
    }

    function testAggregateSpendUsesActualSettledAmountsAndRollsBack() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 3e6);
        vm.expectRevert(RentalCollective.ThresholdUnmet.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
        assertFalse(router.used(fills[1].bid.maker, fills[1].bid.nonce));
        assertEq(usd.balanceOf(seller), 0);
        assertEq(router.spent(fills[0].bid.mandate), 0);
        assertEq(inventory.balanceOf(fills[0].bid.maker, inventory.tokenId(COLLECTIVE_POOL, day, TERMS)), 0);
    }

    function testGuardedEconomicTermsUseTheSameBatchQuote() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        bytes memory pricing = bytes.concat(hex"a080", abi.encode(1e6, 250, 0, 0), LimitSwapFullAmount.build(true));
        bytes memory guarded = _guard(pricing, address(coordinator), CAMPAIGN, 2, 2e6);
        for (uint256 i; i < 2; ++i) {
            fills[i].program = guarded;
            fills[i].bid.programHash = keccak256(guarded);
            fills[i].ask.programHash = keccak256(guarded);
            fills[i].bidSig = _sig(fills[i].bid, _key(i));
            fills[i].askSig = _sig(fills[i].ask, SELL_KEY);
        }
        (uint256 quotePrice, uint256 quoteFee) = router.quote(guarded, 1, 1);
        assertEq(quotePrice, 1e6);
        assertEq(quoteFee, 25_000);
        (uint256 price, uint256 fee) = coordinator.activate(fills);
        assertEq(price, quotePrice * 2);
        assertEq(fee, quoteFee * 2);
    }

    function testDuplicateWalletRollsBackEarlierFill() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        fills[1].bid.maker = fills[0].bid.maker;
        fills[1].bid.recipient = fills[0].bid.maker;
        fills[1].bid.mandate = fills[0].bid.mandate;
        fills[1].mandate = fills[0].mandate;
        fills[1].bidSig = _sig(fills[1].bid, _key(0));
        vm.expectRevert(RentalCollective.InvalidBatch.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
        assertEq(usd.balanceOf(seller), 0);
    }

    function testRevokedLaterFundingRollsBackEarlierFill() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vm.prank(fills[1].bid.maker);
        aqua.dock(address(router), fills[1].bid.mandate, tokens);
        vm.expectRevert(RentalSettlement.InvalidMandate.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
        assertEq(usd.balanceOf(seller), 0);
    }

    function testAlteredGuardAndFakeCoordinatorRejected() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        bytes memory changed = _guard(fixedProgram(1e6), address(coordinator), CAMPAIGN, 2, 2e6 + 1);
        fills[1].program = changed;
        fills[1].bid.programHash = keccak256(changed);
        fills[1].ask.programHash = keccak256(changed);
        fills[1].bidSig = _sig(fills[1].bid, _key(1));
        fills[1].askSig = _sig(fills[1].ask, SELL_KEY);
        vm.expectRevert(RentalCollective.InvalidBatch.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
        bytes memory fake = _guard(fixedProgram(1e6), address(0xBEEF), CAMPAIGN, 2, 2e6);
        vm.expectRevert(RentalSwapVM.InvalidProgram.selector);
        router.quote(fake, 1, 1);
        fills[0].program = fake;
        vm.expectRevert(RentalCollective.InvalidBatch.selector);
        coordinator.activate(fills);
        bytes memory noncanonical = _guard(fixedProgram(1e6), address(coordinator), CAMPAIGN, 2, 2e6);
        noncanonical[2] = 0x01; // ABI address padding must not create a second encoding of this coordinator.
        vm.expectRevert();
        router.quote(noncanonical, 1, 1);
    }

    function testCancellationAndExpiryRollBackBatch() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        vm.prank(fills[1].bid.maker);
        router.cancel(fills[1].bid.nonce);
        vm.expectRevert(RentalSettlement.ClosedOrder.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
    }

    function testLaterExpiredOrderRollsBackBatch() public {
        RentalCollective.Fill[] memory fills = _fills(2, 1, 2, 2e6);
        fills[0].bid.expiry = block.timestamp + 2 days;
        fills[0].ask.expiry = block.timestamp + 2 days;
        fills[0].bidSig = _sig(fills[0].bid, _key(0));
        fills[0].askSig = _sig(fills[0].ask, SELL_KEY);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(RentalSettlement.InvalidOrder.selector);
        coordinator.activate(fills);
        assertFalse(router.used(fills[0].bid.maker, fills[0].bid.nonce));
    }

    function testEightParticipantsAcross31DaysStayBounded() public {
        RentalCollective.Fill[] memory fills = _fills(8, 31, 8, 248e6);
        uint256 beforeGas = gasleft();
        (uint256 price, uint256 fee) = coordinator.activate(fills);
        uint256 usedGas = beforeGas - gasleft();
        emit log_named_uint("8 x 31 collective activation gas", usedGas);
        assertEq(price, 248e6);
        assertEq(fee, 2_480_000);
        assertLt(usedGas, 15_000_000);
        assertLt(address(router).code.length, 24_576);
        assertLt(address(coordinator).code.length, 24_576);
        assertEq(inventory.balanceOf(fills[7].bid.maker, inventory.tokenId(COLLECTIVE_POOL, day + 30, TERMS)), 1);
    }
}
