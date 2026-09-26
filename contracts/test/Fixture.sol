// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Aqua} from "aqua/Aqua.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {RentalInventory} from "../src/RentalInventory.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";

contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

abstract contract Fixture is Test {
    TestUSDC internal usd;
    IAqua internal aqua;
    RentalInventory internal inventory;
    RentalSwapVM internal router;
    uint256 internal constant BUY_KEY = uint256(keccak256("rental-aqua-proof-test-buyer-20260926"));
    uint256 internal constant SELL_KEY = uint256(keccak256("rental-aqua-proof-test-seller-20260926"));
    uint256 internal constant OTHER_KEY = uint256(keccak256("rental-aqua-proof-test-other-20260926"));
    address internal buyer;
    address internal seller;
    address internal other;
    address internal fees = address(0xFEE);
    bytes32 internal constant POOL = keccak256("hotel-standard-room");
    bytes32 internal constant TERMS = keccak256("transferable;no-refund;class-continuity-guaranteed");
    uint32 internal day;
    RentalSettlement.Mandate internal mandate;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        buyer = vm.addr(BUY_KEY);
        seller = vm.addr(SELL_KEY);
        other = vm.addr(OTHER_KEY);
        day = uint32(block.timestamp / 1 days) + 10;
        usd = new TestUSDC();
        aqua = IAqua(address(new Aqua()));
        inventory = new RentalInventory();
        router = new RentalSwapVM(aqua, inventory, address(usd), fees);
        inventory.createPool(POOL, seller, day, day + 31, 1);
        vm.prank(seller);
        inventory.issue(POOL, day, day + 31, TERMS, 1);
        vm.prank(seller);
        inventory.setApprovalForAll(address(router), true);
        usd.mint(buyer, 1000e6);
        usd.mint(other, 1000e6);
        mandate = _fund(buyer, 1000e6, bytes32(uint256(1)));
    }

    function _fund(address who, uint256 limit, bytes32 salt) internal returns (RentalSettlement.Mandate memory m) {
        m = RentalSettlement.Mandate(who, address(router), address(usd), limit, block.timestamp + 7 days, salt);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = limit;
        vm.startPrank(who);
        usd.approve(address(aqua), type(uint256).max);
        aqua.ship(address(router), abi.encode(m), tokens, amounts);
        vm.stopPrank();
    }

    function fixedProgram(uint256 price) public pure returns (bytes memory) {
        return bytes.concat(hex"9e20", abi.encode(price), LimitSwapFullAmount.build(true));
    }

    function dutchProgram(uint256 high, uint256 low, uint256 start, uint256 end) public pure returns (bytes memory) {
        return bytes.concat(hex"9f80", abi.encode(high, low, start, end), LimitSwapFullAmount.build(true));
    }

    function _orders(uint32 start, uint32 end, uint256 nonce, bytes memory program)
        internal
        view
        returns (RentalSettlement.Order memory b, RentalSettlement.Order memory s)
    {
        b = RentalSettlement.Order(
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
            bytes32(0),
            keccak256(abi.encode(mandate)),
            keccak256(program)
        );
        s = abi.decode(abi.encode(b), (RentalSettlement.Order));
        s.maker = seller;
        s.buy = false;
        s.recipient = seller;
        s.priceLimit = 1;
        s.mandate = 0;
    }

    function _sig(RentalSettlement.Order memory o, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, router.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function _fill(RentalSettlement.Order memory b, RentalSettlement.Order memory s, bytes memory p) internal {
        router.settle(b, _sig(b, BUY_KEY), s, _sig(s, SELL_KEY), mandate, p);
    }
}
