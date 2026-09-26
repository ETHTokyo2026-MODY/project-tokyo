// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "./Fixture.sol";
import {RentalPoolResolver} from "../src/RentalPoolResolver.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";

contract ENSDiscoveryTest is Fixture {
    RentalPoolResolver internal resolver;
    bytes internal parentDns;
    bytes32 internal parentNode;
    bytes32 internal room = keccak256("demo room");
    bytes32 internal otherRoom = keccak256("other room");

    function setUp() public override {
        super.setUp();
        parentDns = bytes.concat(bytes1(uint8(6)), bytes("rental"), bytes1(uint8(4)), bytes("test"), hex"00");
        parentNode =
            keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), keccak256("test"))), keccak256("rental")));
        resolver = new RentalPoolResolver(inventory, parentNode, keccak256(parentDns));
        inventory.createPool(room, seller, day, day + 7, 1);
        inventory.createPool(otherRoom, seller, day, day + 7, 1);
        resolver.setPool("demo-room", room);
    }

    function _name(bytes memory label) internal view returns (bytes memory) {
        return bytes.concat(bytes1(uint8(label.length)), label, parentDns);
    }

    function _query(bytes memory label) internal view returns (bytes memory) {
        return abi.encodeWithSignature("pool(bytes32)", keccak256(abi.encodePacked(parentNode, keccak256(label))));
    }

    function testWildcardPoolResolutionAndMutableAlias() public {
        bytes memory label = bytes("demo-room");
        assertTrue(resolver.supportsInterface(0x9061b923));
        assertEq(abi.decode(resolver.resolve(_name(label), _query(label)), (bytes32)), room);
        resolver.setPool("demo-room", otherRoom);
        assertEq(abi.decode(resolver.resolve(_name(label), _query(label)), (bytes32)), otherRoom);
        resolver.setPool("demo-room", 0);
        vm.expectRevert(RentalPoolResolver.UnknownPool.selector);
        resolver.resolve(_name(label), _query(label));
    }

    function testNameChangeCannotRetargetSignedRentalOrder() public {
        resolver.setPool("demo-room", POOL);
        bytes memory label = bytes("demo-room");
        bytes32 discoveredPool = abi.decode(resolver.resolve(_name(label), _query(label)), (bytes32));
        bytes memory program = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 79, program);
        bid.pool = discoveredPool;
        ask.pool = discoveredPool;
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        resolver.setPool("demo-room", otherRoom);
        assertEq(abi.decode(resolver.resolve(_name(label), _query(label)), (bytes32)), otherRoom);
        router.settle(bid, bidSig, ask, askSig, mandate, program);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(otherRoom, day, TERMS)), 0);
    }

    function testRejectsUnknownMalformedAndUnauthorizedNames() public {
        bytes memory label = bytes("demo-room");
        vm.expectRevert(RentalPoolResolver.InvalidName.selector);
        resolver.resolve(_name(label), abi.encodeWithSignature("pool(bytes32)", bytes32(0)));
        vm.expectRevert(RentalPoolResolver.InvalidName.selector);
        resolver.resolve(_name(label), abi.encodeWithSignature("other(bytes32)", bytes32(0)));
        vm.expectRevert(RentalPoolResolver.InvalidName.selector);
        resolver.resolve(bytes.concat(bytes1(uint8(9)), label, hex"0362616400"), _query(label));
        vm.expectRevert(RentalPoolResolver.InvalidName.selector);
        resolver.resolve(_name(bytes("Demo-room")), _query(bytes("Demo-room")));
        vm.expectRevert(RentalPoolResolver.UnknownPool.selector);
        resolver.resolve(_name(bytes("unknown")), _query(bytes("unknown")));
        vm.expectRevert(RentalPoolResolver.UnknownPool.selector);
        resolver.setPool("unknown", keccak256("no inventory pool"));
        vm.prank(seller);
        vm.expectRevert(RentalPoolResolver.Unauthorized.selector);
        resolver.setPool("demo-room", otherRoom);
    }
}
