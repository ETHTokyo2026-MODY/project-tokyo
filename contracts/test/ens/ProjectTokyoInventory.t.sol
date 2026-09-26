// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ProjectTokyoInventory} from "../../src/ProjectTokyoInventory.sol";
import {ProjectTokyoDates} from "../../src/ens/ProjectTokyoDates.sol";
import {IProjectTokyoNames} from "../../src/ens/IEnsV2.sol";

contract BurnHarness is ProjectTokyoInventory, ERC1155Holder {
    function burn(uint256 id) external {
        _burn(address(this), id, 1);
    }

    function supportsInterface(bytes4 id) public view override(ERC1155, ERC1155Holder) returns (bool) {
        return ERC1155.supportsInterface(id) || ERC1155Holder.supportsInterface(id);
    }
}

contract MockNames is IProjectTokyoNames {
    uint256 public assets;
    uint256 public daysRegistered;

    function registerAsset(string calldata, bytes32, address) external returns (address, address) {
        ++assets;
        return (address(0xD1), address(0xD2));
    }

    function registerDays(bytes32, uint32 startDay, uint32 endDay) external {
        daysRegistered += endDay - startDay;
    }

    function setAssetTexts(string calldata, string[] calldata, string[] calldata) external {}
}

contract ProjectTokyoInventoryTest is Test {
    ProjectTokyoInventory internal inv;
    address internal admin = address(this);
    address internal host = address(0xA11CE);
    address internal trader = address(0xB0B);
    bytes32 internal pool;
    uint32 internal startDay;

    function setUp() public {
        vm.warp(1_800_000_000);
        inv = new ProjectTokyoInventory();
        (pool, startDay,) = inv.createAsset("cabin", host, "airbnb", "Cabin", "Shibuya");
    }

    function testCreateAssetMintsNoTokensUntilChunkedMint() public view {
        assertTrue(inv.isAsset(pool));
        assertEq(pool, keccak256("cabin"));
        assertEq(inv.assetHost(pool), host);
        assertEq(startDay, ProjectTokyoDates.tokyoDay(1_800_000_000));
        assertEq(inv.assetInfo(pool).endDay, startDay + 365);
        assertEq(inv.balanceOf(host, inv.tokenId(pool, startDay)), 0);
    }

    function testMintDaysSetsMetadataAndHolder() public {
        vm.prank(host);
        inv.mintDays(pool, startDay, startDay + 3, 80e6, 60e6);
        for (uint32 i; i < 3; ++i) {
            uint256 id = inv.tokenId(pool, startDay + i);
            (bool minted, bool booked, bool listed, uint128 listedPrice, uint128 sellingPrice) = inv.dayInfo(id);
            assertTrue(minted);
            assertFalse(booked);
            assertTrue(listed);
            assertEq(listedPrice, 80e6);
            assertEq(sellingPrice, 60e6);
            assertEq(inv.holderOf(id), host);
            assertEq(inv.balanceOf(host, id), 1);
        }
    }

    function testHolderOnlyPriceEditsAndBookingKeepsTradable() public {
        vm.prank(host);
        inv.mintDays(pool, startDay, startDay + 1, 80e6, 60e6);
        uint256 id = inv.tokenId(pool, startDay);
        vm.prank(trader);
        vm.expectRevert(ProjectTokyoInventory.Unauthorized.selector);
        inv.setListing(id, false, 1);
        vm.prank(host);
        inv.setListing(id, true, 99e6);
        vm.prank(host);
        inv.setListedPrice(id, 70e6);
        vm.prank(host);
        inv.setBooked(id, true);
        (bool minted, bool booked, bool listed, uint128 listedPrice, uint128 sellingPrice) = inv.dayInfo(id);
        assertTrue(minted && booked && listed);
        assertEq(listedPrice, 70e6);
        assertEq(sellingPrice, 99e6);
        vm.prank(host);
        vm.expectRevert(ProjectTokyoInventory.InvalidDay.selector);
        inv.setListedPrice(id, 1);
        vm.prank(host);
        inv.safeTransferFrom(host, trader, id, 1, "");
        assertEq(inv.holderOf(id), trader);
        assertEq(inv.balanceOf(trader, id), 1);
        assertEq(inv.balanceOf(host, id), 0);
        (, booked,, listedPrice,) = inv.dayInfo(id);
        assertTrue(booked);
        assertEq(listedPrice, 70e6);
        vm.prank(trader);
        inv.setListing(id, false, 12e6);
        (,, listed,, sellingPrice) = inv.dayInfo(id);
        assertFalse(listed);
        assertEq(sellingPrice, 12e6);
        vm.prank(host);
        vm.expectRevert(ProjectTokyoInventory.Unauthorized.selector);
        inv.setListing(id, true, 1);
    }

    function testNeverBurns() public {
        BurnHarness h = new BurnHarness();
        (bytes32 p, uint32 s,) = h.createAsset("burnme", address(h), "car", "Car", "Tokyo");
        h.mintDays(p, s, s + 1, 1, 1);
        uint256 id = h.tokenId(p, s);
        vm.expectRevert(ProjectTokyoInventory.NeverBurn.selector);
        h.burn(id);
    }

    function testRejectsSecondMintAndOversizeChunk() public {
        vm.startPrank(host);
        inv.mintDays(pool, startDay, startDay + 2, 1, 1);
        vm.expectRevert(ProjectTokyoInventory.InvalidDay.selector);
        inv.mintDays(pool, startDay, startDay + 1, 1, 1);
        vm.expectRevert(ProjectTokyoInventory.InvalidDay.selector);
        inv.mintDays(pool, startDay + 2, startDay + 83, 1, 1);
        vm.stopPrank();
    }

    function testNamesHookCountsRegisteredDays() public {
        ProjectTokyoInventory wired = new ProjectTokyoInventory();
        MockNames mock = new MockNames();
        wired.setNames(mock);
        (bytes32 p, uint32 s,) = wired.createAsset("room", host, "car", "Car", "Tokyo");
        assertEq(mock.assets(), 1);
        vm.prank(host);
        wired.mintDays(p, s, s + 5, 1, 1);
        assertEq(mock.daysRegistered(), 5);
    }

    function testGetDaysBatch() public {
        vm.prank(host);
        inv.mintDays(pool, startDay, startDay + 2, 5, 6);
        uint256[] memory ids = new uint256[](2);
        ids[0] = inv.tokenId(pool, startDay);
        ids[1] = inv.tokenId(pool, startDay + 1);
        (ProjectTokyoInventory.DayInfo[] memory infos, address[] memory holders) = inv.getDays(ids);
        assertEq(infos.length, 2);
        assertTrue(infos[0].minted);
        assertEq(holders[1], host);
    }
}
