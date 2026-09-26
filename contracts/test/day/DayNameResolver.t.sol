// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RentalAssetFactory} from "../../src/day/RentalAssetFactory.sol";
import {RentalAsset} from "../../src/day/RentalAsset.sol";
import {DayToken} from "../../src/day/DayToken.sol";
import {DayNameResolver} from "../../src/day/DayNameResolver.sol";

interface INameRegistry {
    function setResolver(uint256 anyId, address resolver) external;
    function hasRoles(uint256 anyId, uint256 roles, address account) external view returns (bool);
}

interface INameUniversal {
    function ROOT_REGISTRY() external view returns (address);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

contract DayNameResolverTest is Test {
    string private constant PARENT = "rental-proof-73e27831";
    RentalAssetFactory private factory;
    RentalAsset private asset;
    DayNameResolver private resolver;
    bytes private parentDns;
    bytes32 private parentNode;

    function setUp() public {
        vm.warp(1_790_348_400); // 2026-09-26 00:00 JST.
        _deploy();
    }

    function _deploy() private {
        parentDns = bytes.concat(bytes1(uint8(bytes(PARENT).length)), bytes(PARENT), hex"0365746800");
        parentNode = keccak256(
            abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))), keccak256(bytes(PARENT)))
        );
        factory = new RentalAssetFactory();
        asset = _asset("car");
        resolver = new DayNameResolver(factory, parentNode, keccak256(parentDns));
        resolver.setAsset("car", address(asset));
    }

    function _asset(bytes32 salt) private returns (RentalAsset) {
        RentalAsset.AssetDefaults memory defaults;
        defaults.minimum = 1e6;
        for (uint256 i; i < 7; ++i) {
            defaults.listedPrices[i] = 100e6;
            defaults.sellingPrices[i] = 60e6;
        }
        return RentalAsset(factory.createAsset(salt, "ipfs://car", defaults, new RentalAsset.DiscountStep[](0)));
    }

    function _query(string memory label, string memory date)
        private
        view
        returns (bytes memory name, bytes memory data)
    {
        bytes32 node = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
        name = bytes.concat(bytes1(uint8(bytes(label).length)), bytes(label), parentDns);
        if (bytes(date).length != 0) {
            node = keccak256(abi.encodePacked(node, keccak256(bytes(date))));
            name = bytes.concat(bytes1(uint8(bytes(date).length)), bytes(date), name);
        }
        data = abi.encodeWithSelector(bytes4(0x3b3b57de), node);
    }

    function _resolve(string memory label, string memory date) private view returns (address) {
        (bytes memory name, bytes memory data) = _query(label, date);
        return abi.decode(resolver.resolve(name, data), (address));
    }

    function testStandardWildcardAssetAndDayBeforeAndAfterMaterialization() public {
        assertTrue(resolver.supportsInterface(0x9061b923));
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
        assertFalse(resolver.supportsInterface(0xffffffff));
        assertEq(_resolve("car", ""), address(asset));
        address predicted = _resolve("car", "2026-09-27");
        assertEq(predicted, asset.tokenAddress(20723));
        assertEq(predicted.code.length, 0);
        asset.materialize(20723);
        assertEq(_resolve("car", "2026-09-27"), predicted);
        assertEq(DayToken(predicted).totalSupply(), 1);
        assertEq(DayToken(predicted).balanceOf(address(this)), 1);
    }

    function testRemappingCannotChangePreviouslyResolvedConcreteToken() public {
        address original = _resolve("car", "2026-09-27");
        RentalAsset second = _asset("second");
        resolver.setAsset("car", address(second));
        assertEq(_resolve("car", ""), address(second));
        assertEq(_resolve("car", "2026-09-27"), second.tokenAddress(20723));
        asset.materialize(20723);
        DayToken(original).transfer(address(0xB0B), 1);
        assertEq(DayToken(original).balanceOf(address(0xB0B)), 1);
        assertEq(second.tokenAddress(20723).code.length, 0);
    }

    function testRejectsUnauthorizedForeignUnknownAndMalformedNames() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(DayNameResolver.Unauthorized.selector);
        resolver.setAsset("car", address(asset));
        vm.expectRevert(DayNameResolver.UnknownAsset.selector);
        resolver.setAsset("foreign", address(0xBAD));
        string[7] memory invalid =
            ["2026-02-29", "2026-09-31", "2026-13-01", "1969-01-01", "2026-9-27", "2026-00-27", "2026-09-00"];
        for (uint256 i; i < invalid.length; ++i) {
            (bytes memory invalidName, bytes memory invalidData) = _query("car", invalid[i]);
            vm.expectRevert(DayNameResolver.InvalidName.selector);
            resolver.resolve(invalidName, invalidData);
        }
        (bytes memory name, bytes memory data) = _query("Car", "");
        vm.expectRevert(DayNameResolver.InvalidName.selector);
        resolver.resolve(name, data);
        (name, data) = _query("car", "");
        vm.expectRevert(DayNameResolver.InvalidName.selector);
        resolver.resolve(name, abi.encodeWithSelector(bytes4(0x3b3b57de), bytes32(0)));
        vm.expectRevert(DayNameResolver.InvalidName.selector);
        resolver.resolve(bytes.concat(name, hex"00"), data);
        resolver.setAsset("car", address(0));
        vm.expectRevert(DayNameResolver.UnknownAsset.selector);
        resolver.resolve(name, data);
    }

    function testLeapDayAndFixedHorizon() public {
        vm.warp(1_835_362_800); // 2028-02-29 00:00 JST.
        RentalAsset leap = _asset("leap");
        resolver.setAsset("leap", address(leap));
        assertEq(_resolve("leap", "2028-02-29"), leap.tokenAddress(21243));
        (bytes memory name, bytes memory data) = _query("leap", "2029-03-01");
        vm.expectRevert(RentalAsset.InvalidDay.selector);
        resolver.resolve(name, data);
    }

    /// @dev Uses the existing registered parent on an isolated fork; never broadcasts or registers a new name.
    function testCanonicalSepoliaENSv2ParentWildcardResolution() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, 11_788_564);
        _deploy();
        INameUniversal universal = INameUniversal(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
        assertEq(universal.ROOT_REGISTRY(), 0x9703DBD26dAB89504490994138cF2c575251a9cE);
        INameRegistry registry = INameRegistry(0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E);
        address parentOwner = 0x73e27831C388e3763FcA45c09d7B7Aad14663Bef;
        uint256 labelId = uint256(keccak256(bytes(PARENT)));
        assertTrue(registry.hasRoles(labelId, 1 << 24, parentOwner));
        vm.prank(parentOwner);
        registry.setResolver(labelId, address(resolver));
        (bytes memory name, bytes memory data) = _query("car", "");
        (bytes memory result, address used) = universal.resolve(name, data);
        assertEq(used, address(resolver));
        assertEq(abi.decode(result, (address)), address(asset));
        (name, data) = _query("car", "2026-09-28");
        (result, used) = universal.resolve(name, data);
        address predicted = abi.decode(result, (address));
        assertEq(used, address(resolver));
        assertEq(predicted, asset.tokenAddress(20724));
        assertEq(predicted.code.length, 0);
        asset.materialize(20724);
        (result, used) = universal.resolve(name, data);
        assertEq(abi.decode(result, (address)), predicted);
        assertEq(DayToken(predicted).totalSupply(), 1);
    }
}
