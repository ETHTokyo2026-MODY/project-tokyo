// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Aqua} from "aqua/Aqua.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DayToken} from "../../src/day/DayToken.sol";
import {RentalAsset} from "../../src/day/RentalAsset.sol";
import {RentalAssetFactory} from "../../src/day/RentalAssetFactory.sol";

contract DayAssetsTest is Test {
    RentalAssetFactory internal factory;
    RentalAsset internal asset;
    address internal host = address(0xA11CE);
    address internal buyer = address(0xB0B);
    uint32 internal today;

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new RentalAssetFactory();
        vm.prank(host);
        asset = RentalAsset(factory.createAsset(bytes32("car")));
        today = asset.currentDay();
    }

    function testFixedCalendarAndVirtualOwnership() public {
        assertEq(asset.startDay(), today);
        assertEq(asset.endDayExclusive(), today + 365);
        assertEq(factory.assets(host, bytes32("car")), address(asset));
        assertTrue(factory.isAsset(address(asset)));
        RentalAsset.DayView[] memory states = asset.rangeState(today, today + 365);
        assertEq(states.length, 365);
        for (uint256 i; i < states.length; ++i) {
            assertEq(states[i].owner, host);
            assertEq(states[i].token.code.length, 0);
            assertFalse(states[i].deployed);
            assertTrue(states[i].listed);
            assertEq(states[i].saleNonce, 0);
            if (i != 0) assertNotEq(states[i].token, states[i - 1].token);
        }
        vm.warp(block.timestamp + 400 days);
        assertEq(asset.endDayExclusive(), today + 365);
        assertFalse(asset.dayState(today).listed);
        assertEq(asset.dayState(today).owner, host);
    }

    function testRejectsOutsideHorizonAndInvalidRanges() public {
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.materialize(today - 1);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.materialize(today + 365);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.rangeState(today, today);
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        asset.rangeState(today, today + 366);
    }

    function testHostSaltIsScopedAndCannotBeReused() public {
        vm.prank(host);
        vm.expectRevert(RentalAssetFactory.AssetAlreadyExists.selector);
        factory.createAsset(bytes32("car"));
        vm.prank(buyer);
        RentalAsset other = RentalAsset(factory.createAsset(bytes32("car")));
        assertEq(other.host(), buyer);
        assertNotEq(asset.tokenAddress(today), other.tokenAddress(today));
    }

    function testPermissionlessMaterializationIsDeterministicAndOnlyMintsOnce() public {
        address predicted = asset.tokenAddress(today);
        vm.prank(buyer);
        DayToken token = DayToken(asset.materialize(today));
        assertEq(address(token), predicted);
        assertEq(token.asset(), address(asset));
        assertEq(token.day(), today);
        assertEq(token.decimals(), 0);
        assertEq(token.totalSupply(), 1);
        assertEq(token.balanceOf(host), 1);
        assertEq(token.balanceOf(buyer), 0);
        assertEq(token.owner(), host);
        assertEq(token.name(), "Rental day ownership");
        assertEq(token.symbol(), "DAY");
        assertEq(asset.materialize(today), predicted);
        assertTrue(asset.dayState(today).deployed);
        assertTrue(asset.dayState(today).listed);
        vm.expectRevert(DayToken.InvalidInitialization.selector);
        token.initialize();
        DayToken implementation = DayToken(factory.dayTokenImplementation());
        vm.expectRevert(DayToken.InvalidInitialization.selector);
        implementation.initialize();
        assertEq(token.totalSupply(), 1);
    }

    function testOutsiderCannotInitializeClone() public {
        address clone =
            Clones.cloneWithImmutableArgs(factory.dayTokenImplementation(), abi.encode(address(asset), today));
        vm.prank(buyer);
        vm.expectRevert(DayToken.InvalidInitialization.selector);
        DayToken(clone).initialize();
        assertEq(DayToken(clone).totalSupply(), 0);
    }

    function testSurvivingAllowanceCannotRestoreOldListingNonce() public {
        DayToken token = DayToken(asset.materialize(today));
        vm.prank(host);
        token.approve(address(this), type(uint256).max);
        token.transferFrom(host, buyer, 1);
        vm.prank(buyer);
        token.transfer(host, 1);
        assertEq(token.allowance(host, address(this)), type(uint256).max);
        assertEq(asset.dayState(today).saleNonce, 2);
        assertFalse(asset.dayState(today).listed);
        token.transferFrom(host, buyer, 1);
        _assertOwner(token, buyer, 3);
    }

    function testTransfersRequireApprovalAndInvalidateListingAcrossRoundTrip() public {
        DayToken token = DayToken(asset.materialize(today));
        vm.prank(buyer);
        vm.expectRevert();
        token.transferFrom(host, buyer, 1);
        vm.prank(host);
        token.approve(address(this), 1);
        token.transferFrom(host, buyer, 1);
        assertEq(token.allowance(host, address(this)), 0);
        _assertOwner(token, buyer, 1);
        vm.prank(buyer);
        token.transfer(host, 1);
        _assertOwner(token, host, 2);
        assertFalse(asset.dayState(today).listed);
    }

    function testZeroAndSelfTransfersDoNotInvalidateListing() public {
        DayToken token = DayToken(asset.materialize(today));
        vm.prank(host);
        token.transfer(host, 1);
        vm.prank(buyer);
        token.transfer(host, 0);
        token.transferFrom(host, buyer, 0);
        assertEq(token.owner(), host);
        assertTrue(asset.dayState(today).listed);
        assertEq(asset.dayState(today).saleNonce, 0);
    }

    function testPastLockAtTokyoMidnightIncludingDelegatedTransfer() public {
        DayToken token = DayToken(asset.materialize(today));
        uint256 nextTokyoMidnight = uint256(today + 1) * 1 days - 9 hours;
        vm.warp(nextTokyoMidnight - 1);
        vm.prank(host);
        token.transfer(buyer, 1);
        vm.prank(buyer);
        token.approve(address(this), 1);
        vm.warp(nextTokyoMidnight);
        assertEq(asset.currentDay(), today + 1);
        vm.expectRevert(DayToken.PastDay.selector);
        token.transferFrom(buyer, host, 1);
        assertEq(token.allowance(buyer, address(this)), 1);
        vm.prank(buyer);
        vm.expectRevert(DayToken.PastDay.selector);
        token.transfer(host, 1);
        _assertOwner(token, buyer, 1);
        DayToken next = DayToken(asset.materialize(today + 1));
        vm.prank(host);
        next.transfer(buyer, 1);
        assertEq(next.owner(), buyer);
    }

    function testPastMaterializationPreservesLockedHostEntitlement() public {
        vm.warp(block.timestamp + 2 days);
        DayToken token = DayToken(asset.materialize(today));
        assertEq(token.owner(), host);
        assertEq(token.totalSupply(), 1);
        assertFalse(asset.dayState(today).listed);
        vm.prank(host);
        vm.expectRevert(DayToken.PastDay.selector);
        token.transfer(buyer, 1);
    }

    function testCannotForgeCallbackBurnOrTransferMoreThanOne() public {
        DayToken token = DayToken(asset.materialize(today));
        vm.expectRevert(RentalAsset.UnauthorizedToken.selector);
        asset.onDayTransfer(today, host, buyer);
        vm.startPrank(host);
        vm.expectRevert();
        token.transfer(buyer, 2);
        vm.expectRevert();
        token.transfer(address(0), 1);
        (bool success,) = address(token).call(abi.encodeWithSignature("burn(uint256)", 1));
        assertFalse(success);
        vm.stopPrank();
        assertEq(token.totalSupply(), 1);
        assertEq(token.owner(), host);
        assertTrue(asset.dayState(today).listed);
    }

    function testOfficialAquaPullUsesStandardAllowanceAndInvalidatesListing() public {
        Aqua aqua = new Aqua();
        DayToken token = DayToken(asset.materialize(today));
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        vm.startPrank(host);
        bytes32 strategy = aqua.ship(address(this), bytes("sell today"), tokens, amounts);
        vm.stopPrank();
        vm.expectRevert();
        aqua.pull(host, strategy, address(token), 1, buyer);
        (uint248 available,) = aqua.rawBalances(host, address(this), strategy, address(token));
        assertEq(available, 1);
        vm.prank(host);
        token.approve(address(aqua), 1);
        aqua.pull(host, strategy, address(token), 1, buyer);
        _assertOwner(token, buyer, 1);
    }

    function testFuzzSupplyAndIdentityAcrossTransfers(address recipient, uint16 offset) public {
        vm.assume(recipient != address(0) && recipient != host);
        uint32 serviceDay = today + uint32(bound(offset, 0, 364));
        DayToken token = DayToken(asset.materialize(serviceDay));
        vm.prank(host);
        token.transfer(recipient, 1);
        assertEq(token.balanceOf(host), 0);
        assertEq(token.balanceOf(recipient), 1);
        assertEq(token.totalSupply(), 1);
        assertEq(token.owner(), recipient);
        assertEq(token.asset(), address(asset));
        assertEq(token.day(), serviceDay);
        vm.prank(recipient);
        token.transfer(host, 1);
        assertEq(token.totalSupply(), 1);
        assertEq(asset.dayState(serviceDay).saleNonce, 2);
        assertFalse(asset.dayState(serviceDay).listed);
    }

    function testGasAssetCreation() public {
        vm.prank(host);
        uint256 before = gasleft();
        factory.createAsset(bytes32("gas"));
        emit log_named_uint("asset creation execution gas", before - gasleft());
    }

    function testGasMaterialization() public {
        uint256 before = gasleft();
        asset.materialize(today);
        emit log_named_uint("day materialization execution gas", before - gasleft());
    }

    function testGasTransfer() public {
        DayToken token = DayToken(asset.materialize(today));
        vm.prank(host);
        uint256 before = gasleft();
        token.transfer(buyer, 1);
        emit log_named_uint("day transfer execution gas (warm after materialization)", before - gasleft());
    }

    function _assertOwner(DayToken token, address expected, uint64 nonce) private view {
        assertEq(token.owner(), expected);
        assertEq(token.balanceOf(expected), 1);
        assertEq(token.totalSupply(), 1);
        RentalAsset.DayView memory state = asset.dayState(token.day());
        assertEq(state.owner, expected);
        assertEq(state.saleNonce, nonce);
        assertFalse(state.listed);
    }
}
