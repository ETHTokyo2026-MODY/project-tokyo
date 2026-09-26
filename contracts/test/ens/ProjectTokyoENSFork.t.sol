// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProjectTokyoInventory} from "../../src/ProjectTokyoInventory.sol";
import {ProjectTokyoNames} from "../../src/ProjectTokyoNames.sol";
import {EnsSepolia} from "../../src/ens/EnsSepolia.sol";
import {IPermissionedRegistry, IVerifiableFactory} from "../../src/ens/IEnsV2.sol";
import {ProjectTokyoDates} from "../../src/ens/ProjectTokyoDates.sol";

interface IUniversalResolver {
    function ROOT_REGISTRY() external view returns (address);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
    function findResolver(bytes calldata name) external view returns (address, bytes32, uint256);
}

contract ProjectTokyoENSForkTest is Test {
    address internal constant OWNER = EnsSepolia.PROJECTTOKYO_OWNER;
    address internal host = address(0xA11CE);
    address internal trader = address(0xB0B);

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function testSetupCreateDaysResolveAndTrade() public {
        if (block.chainid != 11155111) return;
        assertEq(IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER).ROOT_REGISTRY(), EnsSepolia.ROOT_REGISTRY);

        ProjectTokyoInventory inv = new ProjectTokyoInventory();
        ProjectTokyoNames names = new ProjectTokyoNames(
            inv,
            IVerifiableFactory(EnsSepolia.VERIFIABLE_FACTORY),
            EnsSepolia.USER_REGISTRY_IMPL,
            EnsSepolia.PERMISSIONED_RESOLVER_IMPL,
            IPermissionedRegistry(EnsSepolia.ETH_REGISTRY),
            EnsSepolia.PARENT_LABEL
        );
        inv.setNames(names);
        assertTrue(address(names.assetRegistry()).code.length > 0);

        address assetRegistry = address(names.assetRegistry());
        vm.deal(OWNER, 10 ether);
        vm.prank(OWNER);
        IPermissionedRegistry(EnsSepolia.ETH_REGISTRY).setSubregistry(EnsSepolia.PROJECTTOKYO_TOKEN_ID, assetRegistry);
        assertEq(
            IPermissionedRegistry(EnsSepolia.ETH_REGISTRY).getSubregistry("projecttokyo"),
            address(names.assetRegistry())
        );

        string memory label =
            string.concat("testasset", _digits(uint256(keccak256(abi.encode(blockhash(block.number - 1)))) % 100000));
        vm.deal(host, 1 ether);
        (bytes32 pool, uint32 start,) = inv.createAsset(label, host, "car", "Test car", "Tokyo");
        string[] memory keys = new string[](4);
        string[] memory values = new string[](4);
        keys[0] = "title";
        values[0] = "Test car";
        keys[1] = "kind";
        values[1] = "car";
        keys[2] = "location";
        values[2] = "Tokyo";
        keys[3] = "discounts";
        values[3] = "{\"3\":10,\"7\":20}";
        names.setAssetTexts(label, keys, values);

        uint32 end = start + 365;
        for (uint32 d = start; d < end; d += 73) {
            uint32 chunkEnd = d + 73;
            if (chunkEnd > end) chunkEnd = end;
            vm.prank(host);
            inv.mintDays(pool, d, chunkEnd, 80e6, 50e6);
        }

        uint256 firstId = inv.tokenId(pool, start);
        uint256 lastId = inv.tokenId(pool, end - 1);
        (bool minted,, bool listed,,) = inv.dayInfo(firstId);
        assertTrue(minted && listed);
        assertEq(inv.holderOf(lastId), host);
        assertEq(inv.balanceOf(host, firstId), 1);

        bytes memory firstName = _dns(string.concat(names.dateLabel(start), ".", label, ".projecttokyo.eth"));
        (address resolver,,) = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER).findResolver(firstName);
        assertEq(resolver, address(names));
        (bytes memory addrData, address used) = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER)
            .resolve(firstName, abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
        assertEq(used, address(names));
        assertEq(abi.decode(addrData, (address)), address(inv));
        (bytes memory tokenData,) = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER)
            .resolve(firstName, abi.encodeWithSignature("text(bytes32,string)", bytes32(0), "token"));
        assertEq(
            abi.decode(tokenData, (string)),
            string.concat("eip155:11155111/erc1155:", _hex(address(inv)), "/", _u(firstId))
        );

        bytes memory lastName = _dns(string.concat(names.dateLabel(end - 1), ".", label, ".projecttokyo.eth"));
        (bytes memory lastAddr,) = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER)
            .resolve(lastName, abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
        assertEq(abi.decode(lastAddr, (address)), address(inv));

        bytes memory assetName = _dns(string.concat(label, ".projecttokyo.eth"));
        (bytes memory titleData,) = IUniversalResolver(EnsSepolia.UNIVERSAL_RESOLVER)
            .resolve(assetName, abi.encodeWithSignature("text(bytes32,string)", bytes32(0), "title"));
        assertEq(abi.decode(titleData, (string)), "Test car");

        vm.prank(host);
        inv.safeTransferFrom(host, trader, firstId, 1, "");
        assertEq(inv.holderOf(firstId), trader);
        vm.prank(trader);
        inv.setListing(firstId, true, 123e6);
        vm.prank(host);
        vm.expectRevert(ProjectTokyoInventory.Unauthorized.selector);
        inv.setListing(firstId, false, 1);
        vm.prank(host);
        inv.setBooked(firstId, true);
        vm.prank(trader);
        inv.safeTransferFrom(trader, host, firstId, 1, "");
        assertEq(inv.holderOf(firstId), host);
        (, bool booked,,,) = inv.dayInfo(firstId);
        assertTrue(booked);
    }

    function _digits(uint256 n) private pure returns (string memory) {
        bytes memory s = new bytes(5);
        for (uint256 i = 5; i > 0; --i) {
            s[i - 1] = bytes1(uint8(48 + n % 10));
            n /= 10;
        }
        return string(s);
    }

    function _dns(string memory name) private pure returns (bytes memory out) {
        bytes memory raw = bytes(name);
        out = new bytes(raw.length + 2);
        uint256 w = 1;
        uint256 start;
        for (uint256 i; i <= raw.length; ++i) {
            if (i == raw.length || raw[i] == ".") {
                uint256 len = i - start;
                out[w - 1] = bytes1(uint8(len));
                for (uint256 j; j < len; ++j) {
                    out[w + j] = raw[start + j];
                }
                w += len + 1;
                start = i + 1;
            }
        }
        out[w - 1] = 0;
        assembly {
            mstore(out, w)
        }
    }

    function _hex(address a) private pure returns (string memory) {
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

    function _u(uint256 v) private pure returns (string memory) {
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
