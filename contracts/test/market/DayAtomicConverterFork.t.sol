// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {RentalAsset} from "../../src/day/RentalAsset.sol";
import {RentalAssetFactory} from "../../src/day/RentalAssetFactory.sol";
import {DaySwapVM} from "../../src/market/DaySwapVM.sol";
import {DayAtomicConverter, IDayExactInputSingle} from "../../src/market/DayAtomicConverter.sol";

interface IForkWeth is IERC20 {
    function deposit() external payable;
}

interface IForkV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IForkV3Pool {
    function liquidity() external view returns (uint128);
}

/// @dev Read-only RPC fork: no broadcasting, token dealing, pool creation or liquidity injection.
/// Official route: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
contract DayAtomicConverterForkTest is Test {
    address private constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address private constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address private constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address private constant SWAP_ROUTER = 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E;
    address private constant V3_FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    address private constant POOL = 0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1;
    uint256 private constant FORK_BLOCK = 11788472;
    bytes32 private constant PARENT_HASH = 0x232a4e390cfe2985a2d6a5af2c29dd1faf31fb5d1d1fdaba399e0cec40cd1f60;
    uint256 private constant BUY_KEY = uint256(keccak256("ProjectTokyo isolated Sepolia conversion fork buyer"));
    uint256 private constant INPUT = 0.001 ether;

    function testDeployedSepoliaUniswapRouteAndAquaWithCanonicalDaySettlement() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        assertEq(block.chainid, 11155111);
        assertEq(blockhash(FORK_BLOCK - 1), PARENT_HASH, "fork parent changed");
        assertEq(IForkV3Factory(V3_FACTORY).getPool(WETH, USDC, 500), POOL);
        assertGt(IForkV3Pool(POOL).liquidity(), 0);
        assertGt(SWAP_ROUTER.code.length, 0);
        assertGt(AQUA.code.length, 0);
        address buyer = vm.addr(BUY_KEY);
        assertEq(buyer.code.length, 0, "fork signer must be an undelegated EOA");
        address host = address(0xA11CE);
        IERC20 usd = IERC20(USDC);
        assertEq(usd.balanceOf(buyer), 0);
        RentalAssetFactory factory = new RentalAssetFactory();
        RentalAsset.AssetDefaults memory defaults;
        defaults.minimum = 1e6;
        for (uint256 i; i < 7; ++i) {
            defaults.listedPrices[i] = 100e6;
            defaults.sellingPrices[i] = 1e6;
        }
        vm.prank(host);
        RentalAsset asset = RentalAsset(
            factory.createAsset(bytes32("fork-car"), "fork-car", defaults, new RentalAsset.DiscountStep[](0))
        );
        DaySwapVM market = new DaySwapVM(IAqua(AQUA), usd, factory);
        DayAtomicConverter converter =
            new DayAtomicConverter(market, IDayExactInputSingle(SWAP_ROUTER), IERC20(WETH), 500);
        uint32 day = asset.startDay();
        DaySwapVM.Ask[] memory asks = new DaySwapVM.Ask[](2);
        bytes[] memory programs = new bytes[](2);
        for (uint32 i; i < 2; i++) {
            address token = asset.materialize(day + i);
            asks[i] = DaySwapVM.Ask(
                host, block.chainid, address(market), address(asset), day + i, 0, asset.discountVersion(), bytes32(0)
            );
            programs[i] = market.program(address(asset), day + i, 2);
            vm.startPrank(host);
            IERC20(token).approve(AQUA, 1);
            _ship(address(market), abi.encode(asks[i]), token, 1);
            vm.stopPrank();
        }
        DaySwapVM.Bid memory bid = DaySwapVM.Bid(
            buyer,
            block.chainid,
            address(market),
            address(asset),
            day,
            day + 2,
            2e6,
            1,
            uint40(block.timestamp + 1 days),
            bytes32(0)
        );
        vm.deal(buyer, INPUT); // Fork-local native funding; obtain real WETH through its real deposit.
        vm.startPrank(buyer);
        IForkWeth(WETH).deposit{value: INPUT}();
        IERC20(WETH).approve(address(converter), INPUT);
        usd.approve(AQUA, bid.maxTotal);
        _ship(address(market), abi.encode(bid), USDC, bid.maxTotal);
        vm.stopPrank();
        DayAtomicConverter.FundingIntent memory intent = DayAtomicConverter.FundingIntent(
            buyer,
            market.hashBid(bid),
            converter.hashAsks(asks),
            WETH,
            INPUT,
            3e6,
            1e6,
            buyer,
            block.timestamp + 1 days,
            block.chainid,
            address(converter),
            7
        );
        uint256 sellerBefore = usd.balanceOf(host);
        bytes memory signature = _sign(converter, intent);
        vm.expectRevert(DayAtomicConverter.InvalidFunding.selector);
        converter.execute(intent, signature, bid, asks, programs); // Swap and first real transfers roll back at cap check.
        assertEq(IERC20(WETH).balanceOf(buyer), INPUT);
        assertEq(usd.balanceOf(buyer), 0);
        assertEq(usd.balanceOf(host), sellerBefore);
        assertFalse(market.used(buyer, bid.nonce));
        assertFalse(converter.used(buyer, intent.nonce));
        intent.usdcCap = 2e6;
        (uint256 output, uint256 total) = converter.execute(intent, _sign(converter, intent), bid, asks, programs);
        assertEq(total, 2e6);
        assertGe(output, 3e6);
        assertEq(usd.balanceOf(buyer), output - total);
        assertEq(usd.balanceOf(host) - sellerBefore, total);
        assertEq(IERC20(WETH).balanceOf(buyer), 0);
        assertEq(IERC20(WETH).balanceOf(address(converter)), 0);
        assertEq(IERC20(WETH).allowance(address(converter), SWAP_ROUTER), 0);
        for (uint32 i; i < 2; i++) {
            assertEq(asset.dayState(day + i).owner, buyer);
        }
        assertTrue(converter.used(buyer, intent.nonce));
        assertTrue(market.used(buyer, bid.nonce));
        emit log_named_uint("real Sepolia route output in raw USDC", output);
    }

    function _sign(DayAtomicConverter converter, DayAtomicConverter.FundingIntent memory intent)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUY_KEY, converter.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    function _ship(address market, bytes memory data, address token, uint256 amount) private {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        IAqua(AQUA).ship(market, data, tokens, amounts);
    }
}
