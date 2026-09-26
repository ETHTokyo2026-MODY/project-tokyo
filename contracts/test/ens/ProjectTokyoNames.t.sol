// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProjectTokyoInventory} from "../../src/ProjectTokyoInventory.sol";
import {ProjectTokyoNames} from "../../src/ProjectTokyoNames.sol";
import {IPermissionedRegistry, IVerifiableFactory} from "../../src/ens/IEnsV2.sol";
import {ProjectTokyoDates} from "../../src/ens/ProjectTokyoDates.sol";

contract NamesHarness is ProjectTokyoNames {
    constructor(ProjectTokyoInventory inventory_)
        ProjectTokyoNames(
            inventory_,
            IVerifiableFactory(address(0)),
            address(0),
            address(0),
            IPermissionedRegistry(address(0)),
            "projecttokyo"
        )
    {}

    function seed(string calldata label, bytes32 pool) external {
        poolOfLabel[keccak256(bytes(label))] = pool;
    }
}

contract ProjectTokyoNamesTest is Test {
    ProjectTokyoInventory internal inv;
    NamesHarness internal names;
    address internal host = address(0xA11CE);
    bytes32 internal pool;
    uint32 internal startDay;
    bytes internal parentDns;

    function setUp() public {
        vm.warp(1_800_000_000);
        inv = new ProjectTokyoInventory();
        names = new NamesHarness(inv);
        (pool, startDay,) = inv.createAsset("cabin", host, "airbnb", "Cabin", "Shibuya");
        names.seed("cabin", pool);
        vm.prank(host);
        inv.mintDays(pool, startDay, startDay + 2, 80e6, 60e6);
        parentDns = names.parentDns();
    }

    function testDateHelpersMatchLibrary() public view {
        assertEq(names.dateLabel(startDay), ProjectTokyoDates.dateLabel(startDay));
        assertEq(names.parseDateLabel(names.dateLabel(startDay)), startDay);
    }

    function testResolveAddrAndToken() public view {
        bytes memory name = _dayName(startDay, "cabin");
        uint256 id = inv.tokenId(pool, startDay);
        bytes32 node = bytes32(0);
        bytes memory addr = names.resolve(name, abi.encodeWithSignature("addr(bytes32)", node));
        assertEq(abi.decode(addr, (address)), address(inv));
        bytes memory token = names.resolve(name, abi.encodeWithSignature("text(bytes32,string)", node, "token"));
        string memory caip = abi.decode(token, (string));
        assertEq(caip, string.concat("eip155:31337/erc1155:", _hex(address(inv)), "/", _u(id)));
        bytes memory avatar = names.resolve(name, abi.encodeWithSignature("text(bytes32,string)", node, "avatar"));
        assertEq(abi.decode(avatar, (string)), caip);
    }

    function testResolveUnmintedReverts() public {
        bytes memory name = _dayName(startDay + 10, "cabin");
        vm.expectRevert(ProjectTokyoNames.UnknownName.selector);
        names.resolve(name, abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
    }

    function testSupportsResolverInterfaces() public view {
        assertTrue(names.supportsInterface(0x9061b923));
        assertTrue(names.supportsInterface(0x4e2312e0));
        assertTrue(names.supportsInterface(0x01ffc9a7));
    }

    function _dayName(uint32 day, string memory asset) internal view returns (bytes memory) {
        bytes memory label = bytes(ProjectTokyoDates.dateLabel(day));
        bytes memory assetB = bytes(asset);
        return bytes.concat(bytes1(uint8(label.length)), label, bytes1(uint8(assetB.length)), assetB, parentDns);
    }

    function _hex(address a) internal pure returns (string memory) {
        bytes20 b = bytes20(a);
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        for (uint256 i; i < 20; ++i) {
            uint8 v = uint8(b[i]);
            s[2 + 2 * i] = bytes1(v >> 4 < 10 ? uint8(48 + (v >> 4)) : uint8(87 + (v >> 4)));
            s[3 + 2 * i] = bytes1((v & 0xf) < 10 ? uint8(48 + (v & 0xf)) : uint8(87 + (v & 0xf)));
        }
        return string(s);
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        uint256 t = v;
        while (t != 0) {
            ++len;
            t /= 10;
        }
        bytes memory s = new bytes(len);
        while (v != 0) {
            s[--len] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(s);
    }
}
