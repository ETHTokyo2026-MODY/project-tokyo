// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {Fixture, TestUSDC} from "./Fixture.sol";
import {RentalInventory} from "../src/RentalInventory.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";
import {RentalAtomicConverter, IExactInputSingle} from "../src/RentalAtomicConverter.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

contract AtomicConversionForkTest is Fixture {
    address internal constant MAINNET_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant MAINNET_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant MAINNET_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant MAINNET_SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    bytes32 internal constant FORK_PARENT_HASH = 0x93f9104b8eea248173f378c2f7e58574dd71935e72ca8c926a249cd413b7ec8d;

    function setUp() public override {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, 26060001);
        assertEq(blockhash(26060000), FORK_PARENT_HASH, "fork parent hash changed");
        buyer = vm.addr(BUY_KEY);
        seller = vm.addr(SELL_KEY);
        other = vm.addr(OTHER_KEY);
        day = uint32(block.timestamp / 1 days) + 10;
        aqua = IAqua(MAINNET_AQUA);
        usd = TestUSDC(MAINNET_USDC);
        inventory = new RentalInventory();
        router = new RentalSwapVM(aqua, inventory, MAINNET_USDC, fees);
        inventory.createPool(POOL, seller, day, day + 1, 1);
        vm.prank(seller);
        inventory.issue(POOL, day, day + 1, TERMS, 1);
        vm.prank(seller);
        inventory.setApprovalForAll(address(router), true);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        IWETH(MAINNET_WETH).deposit{value: 0.01 ether}();
        mandate = _fund(buyer, 2e6, keccak256("fork-weth-buyer"));
    }

    function testOfficialUniswapRouterAndAquaSettleInOneForkTransaction() public {
        assertGt(MAINNET_SWAP_ROUTER.code.length, 0);
        assertEq(usd.balanceOf(buyer), 0);
        RentalAtomicConverter converter = new RentalAtomicConverter(
            router, IExactInputSingle(MAINNET_SWAP_ROUTER), IERC20(MAINNET_WETH), usd, 500
        );
        vm.prank(buyer);
        IWETH(MAINNET_WETH).approve(address(converter), 0.01 ether);
        bytes memory program = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 77, program);
        RentalAtomicConverter.FundingIntent memory intent = RentalAtomicConverter.FundingIntent({
            buyer: buyer,
            bidHash: router.hashOrder(bid),
            askHash: router.hashOrder(ask),
            batchHash: bytes32(0),
            sourceToken: MAINNET_WETH,
            maxInput: 0.01 ether,
            minOutput: 1_100_000,
            usdcCap: 2e6,
            recipient: buyer,
            deadline: block.timestamp + 1 days,
            chainId: block.chainid,
            executor: address(converter),
            nonce: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUY_KEY, converter.hashIntent(intent));
        uint256 sellerBefore = usd.balanceOf(seller);
        uint256 feesBefore = usd.balanceOf(fees);
        (uint256 output, uint256 price, uint256 fee) = converter.execute(
            intent, abi.encodePacked(r, s, v), bid, _sig(bid, BUY_KEY), ask, _sig(ask, SELL_KEY), mandate, program
        );
        assertGt(output, price + fee);
        assertEq(price, 1e6);
        assertEq(fee, 10_000);
        assertEq(usd.balanceOf(buyer), output - price - fee);
        assertEq(usd.balanceOf(seller) - sellerBefore, price);
        assertEq(usd.balanceOf(fees) - feesBefore, fee);
        assertEq(IWETH(MAINNET_WETH).balanceOf(buyer), 0);
        assertEq(IWETH(MAINNET_WETH).balanceOf(address(converter)), 0);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(router.spent(bid.mandate), price + fee);
    }
}
