// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProjectTokyoNames} from "../../src/ProjectTokyoNames.sol";
import {IPermissionedRegistry, IVerifiableFactory} from "../../src/ens/IEnsV2.sol";
import {ProjectTokyoDates} from "../../src/ens/ProjectTokyoDates.sol";

contract MockRentalAsset {
    address public host;
    uint32 public startDay;
    uint32 public endDayExclusive;

    constructor(address host_, uint32 startDay_) {
        host = host_;
        startDay = startDay_;
        endDayExclusive = startDay_ + 365;
    }

    function tokenAddress(uint32 day) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(address(this), day)))));
    }
}

contract NamesHarness is ProjectTokyoNames {
    constructor()
        ProjectTokyoNames(
            IVerifiableFactory(address(0)),
            address(0),
            address(0),
            IPermissionedRegistry(address(0)),
            "projecttokyo",
            address(0)
        )
    {}

    function seed(string calldata label, address rentalAsset, address host) external {
        bytes32 labelHash = keccak256(bytes(label));
        assetOfLabel[labelHash] = rentalAsset;
        labelHashOfAsset[rentalAsset] = labelHash;
        assetHostOf[labelHash] = host;
    }
}

contract ProjectTokyoNamesTest is Test {
    NamesHarness internal names;
    MockRentalAsset internal asset;
    address internal host = address(0xA11CE);
    uint32 internal startDay;
    bytes internal parentDns;

    function setUp() public {
        vm.warp(1_800_000_000);
        startDay = ProjectTokyoDates.tokyoDay(1_800_000_000);
        asset = new MockRentalAsset(host, startDay);
        names = new NamesHarness();
        names.seed("cabin", address(asset), host);
        parentDns = names.parentDns();
    }

    function testDateHelpersMatchLibrary() public view {
        assertEq(names.dateLabel(startDay), ProjectTokyoDates.dateLabel(startDay));
        assertEq(names.parseDateLabel(names.dateLabel(startDay)), startDay);
    }

    function testResolveAddrTokenAndAsset() public view {
        bytes memory name = _dayName(startDay, "cabin");
        address token = asset.tokenAddress(startDay);
        bytes32 node = bytes32(0);
        bytes memory addr = names.resolve(name, abi.encodeWithSignature("addr(bytes32)", node));
        assertEq(abi.decode(addr, (address)), token);
        bytes memory tokenText = names.resolve(name, abi.encodeWithSignature("text(bytes32,string)", node, "token"));
        string memory caip = abi.decode(tokenText, (string));
        assertEq(caip, string.concat("eip155:31337/erc20:", _hex(token)));
        bytes memory avatar = names.resolve(name, abi.encodeWithSignature("text(bytes32,string)", node, "avatar"));
        assertEq(abi.decode(avatar, (string)), caip);
        bytes memory assetText = names.resolve(name, abi.encodeWithSignature("text(bytes32,string)", node, "asset"));
        assertEq(abi.decode(assetText, (string)), _hex(address(asset)));
    }

    function testResolveUnknownAssetReverts() public {
        bytes memory name = _dayName(startDay, "missing");
        vm.expectRevert(ProjectTokyoNames.UnknownName.selector);
        names.resolve(name, abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
    }

    function testSupportsResolverInterfaces() public view {
        assertTrue(names.supportsInterface(0x9061b923));
        assertTrue(names.supportsInterface(0x01ffc9a7));
        assertFalse(names.supportsInterface(0x4e2312e0));
    }

    function _dayName(uint32 day, string memory assetLabel) internal view returns (bytes memory) {
        bytes memory label = bytes(ProjectTokyoDates.dateLabel(day));
        bytes memory assetB = bytes(assetLabel);
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
}
