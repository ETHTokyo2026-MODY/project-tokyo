// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture, TestUSDC} from "./Fixture.sol";
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalInventory} from "../src/RentalInventory.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";

contract OrderHandler is Test {
    RentalSwapVM public router;
    TestUSDC public usd;
    RentalInventory public inventory;
    RentalSettlement.Mandate public mandate;
    address public buyer;
    address public seller;
    uint32 public day;
    uint256 public minted;
    uint256 public successes;
    bytes32 constant POOL = keccak256("hotel-standard-room");
    bytes32 constant TERMS = keccak256("transferable;no-refund;class-continuity-guaranteed");

    constructor(RentalSwapVM r, TestUSDC u, RentalInventory i, RentalSettlement.Mandate memory m, uint32 d, address s) {
        router = r;
        usd = u;
        inventory = i;
        mandate = m;
        buyer = m.buyer;
        seller = s;
        day = d;
    }

    function buy(uint8 slot, uint8 length, uint8 nonce, uint32 rawPrice, uint8 group) external {
        uint32 start = day + uint32(slot % 31);
        uint32 end = start + uint32(length % 7) + 1;
        if (end > day + 31) end = day + 31;
        uint256 price = bound(rawPrice, 1, 300e6);
        bytes memory p = bytes.concat(hex"9e20", abi.encode(price), LimitSwapFullAmount.build(true));
        RentalSettlement.Order memory b = RentalSettlement.Order(
            buyer,
            true,
            POOL,
            start,
            end,
            1,
            TERMS,
            buyer,
            1000e6,
            10e6,
            block.timestamp + 1 days,
            nonce,
            bytes32(uint256(group % 4)),
            keccak256(abi.encode(mandate)),
            keccak256(p)
        );
        RentalSettlement.Order memory s = abi.decode(abi.encode(b), (RentalSettlement.Order));
        s.maker = seller;
        s.buy = false;
        s.recipient = seller;
        s.priceLimit = 1;
        s.mandate = 0;
        s.group = 0;
        (uint8 v, bytes32 rr, bytes32 ss) =
            vm.sign(uint256(keccak256("rental-aqua-proof-test-buyer-20260926")), router.hashOrder(b));
        bytes memory bs = abi.encodePacked(rr, ss, v);
        (v, rr, ss) = vm.sign(uint256(keccak256("rental-aqua-proof-test-seller-20260926")), router.hashOrder(s));
        try router.settle(b, bs, s, abi.encodePacked(rr, ss, v), mandate, p) {
            successes++;
        } catch {}
    }

    function cancel(uint8 nonce) external {
        vm.prank(buyer);
        router.cancel(nonce);
    }

    function cancelGroup(uint8 group) external {
        vm.prank(buyer);
        router.cancelGroup(bytes32(uint256(group % 3) + 1));
    }

    function drain(uint32 raw) external {
        uint256 n = bound(raw, 0, usd.balanceOf(buyer));
        vm.prank(buyer);
        usd.transfer(address(0xD), n);
    }

    function refill(uint32 raw) external {
        uint256 n = bound(raw, 0, 1000e6);
        minted += n;
        usd.mint(buyer, n);
    }
}

contract RentalInvariantTest is Fixture {
    OrderHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new OrderHandler(router, usd, inventory, mandate, day, seller);
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.buy.selector;
        selectors[1] = handler.cancel.selector;
        selectors[2] = handler.cancelGroup.selector;
        selectors[3] = handler.drain.selector;
        selectors[4] = handler.refill.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariantCapacityAndOwnershipConserved() public view {
        for (uint32 d = day; d < day + 31; ++d) {
            uint256 id = inventory.tokenId(POOL, d, TERMS);
            assertEq(inventory.balanceOf(buyer, id) + inventory.balanceOf(seller, id), 1);
            assertEq(inventory.issued(POOL, d), 1);
        }
    }

    function invariantBudgetNeverExceeded() public view {
        assertLe(router.spent(keccak256(abi.encode(mandate))), 1000e6);
    }

    function invariantUSDCConserved() public view {
        assertEq(
            usd.balanceOf(buyer) + usd.balanceOf(seller) + usd.balanceOf(fees) + usd.balanceOf(address(0xD)),
            1000e6 + handler.minted()
        );
    }
}
