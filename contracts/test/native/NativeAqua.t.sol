// SPDX-License-Identifier: LicenseRef-Degensoft-Aqua-Source-1.1 AND LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {AquaVapor} from "../../src/native/AquaVapor.sol";
import {AssetSwapVM} from "../../src/native/AssetSwapVM.sol";
import {StaticBalances} from "swap-vm/instructions/Balances.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";
import {InvalidateBit} from "swap-vm/instructions/Invalidators.sol";
import {Deadline} from "swap-vm/instructions/Controls.sol";

contract ProofUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ProofInventory is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

abstract contract NativeAquaFixture is Test {
    AquaVapor aqua;
    AssetSwapVM router;
    ProofUSDC usdc;
    ProofInventory rights;
    address seller = makeAddr("host");
    address buyer = makeAddr("buyer");
    address other = makeAddr("other");
    uint256 salt;

    function setUp() public {
        aqua = new AquaVapor();
        usdc = new ProofUSDC();
        rights = new ProofInventory();
        router = new AssetSwapVM(aqua, address(usdc));
        usdc.mint(buyer, 1000e6);
        usdc.mint(other, 1000e6);
        vm.prank(buyer);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(other);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(seller);
        rights.setApprovalForAll(address(aqua), true);
        for (uint256 i = 1; i <= 7; ++i) {
            rights.mint(seller, i, 1);
        }
    }

    function program(uint256 price, uint256 quantity, uint32 group) internal view returns (bytes memory) {
        bytes memory balances = address(usdc) < address(rights)
            ? StaticBalances.build(price, quantity)
            : StaticBalances.build(quantity, price);
        return bytes.concat(
            Deadline.build(uint40(block.timestamp + 1 days)),
            InvalidateBit.build(group),
            balances,
            LimitSwapFullAmount.build(address(usdc), address(rights))
        );
    }

    function strategy(address maker, bool buy, uint256 start, uint256 count, uint256 price, uint32 group)
        internal
        returns (AssetSwapVM.Strategy memory s)
    {
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = start + i;
        }
        s = AssetSwapVM.Strategy(maker, address(rights), ids, 1, buy, bytes32(++salt), program(price, 1, group));
    }

    function money(uint256 amount) internal view returns (AquaVapor.Asset[] memory a, uint256[] memory v) {
        a = new AquaVapor.Asset[](1);
        v = new uint256[](1);
        a[0] = AquaVapor.Asset(AquaVapor.Kind.ERC20, address(usdc), 0);
        v[0] = amount;
    }

    function ship(AssetSwapVM.Strategy memory s, uint256 budget) internal {
        AquaVapor.Asset[] memory a;
        uint256[] memory v;
        if (s.buy) (a, v) = money(budget);
        else (a, v) = router.basket(s);
        vm.prank(s.maker);
        aqua.ship(address(router), abi.encode(s), a, v);
    }

    function pair(uint256 start, uint256 count, uint256 price, uint32 group)
        internal
        returns (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask)
    {
        bid = strategy(buyer, true, start, count, price, group);
        ask = strategy(seller, false, start, count, price, group);
        ship(bid, price);
        ship(ask, 0);
    }

    function remaining(AssetSwapVM.Strategy memory s, bool payment, uint256 id)
        internal
        view
        returns (uint256 amount)
    {
        AquaVapor.Asset memory asset = payment
            ? AquaVapor.Asset(AquaVapor.Kind.ERC20, address(usdc), 0)
            : AquaVapor.Asset(AquaVapor.Kind.ERC1155, address(rights), id);
        (amount,) = aqua.rawBalances(s.maker, address(router), keccak256(abi.encode(s)), asset);
    }
}

contract NativeAquaTest is NativeAquaFixture {
    function testNativeWalletHeldRegistrationAndWeeklySwap() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 7, 290e6, 1);
        assertEq(usdc.balanceOf(buyer), 1000e6);
        assertEq(usdc.balanceOf(address(aqua)), 0);
        for (uint256 i = 1; i <= 7; ++i) {
            assertEq(rights.balanceOf(seller, i), 1);
            assertEq(rights.balanceOf(address(aqua), i), 0);
            assertEq(remaining(ask, false, i), 1);
        }
        assertEq(router.quote(bid, ask), 290e6);
        assertEq(router.bitInvalidators(buyer, 0), 0);
        assertEq(router.swap(bid, ask), 290e6);
        assertEq(usdc.balanceOf(buyer), 710e6);
        assertEq(usdc.balanceOf(seller), 290e6);
        for (uint256 i = 1; i <= 7; ++i) {
            assertEq(rights.balanceOf(buyer, i), 1);
            assertEq(remaining(ask, false, i), 0);
        }
        assertEq(remaining(bid, true, 0), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        vm.expectRevert();
        router.swap(bid, ask);
    }

    function testUnforeseenCheaperAskMatchesStandingCap() public {
        AssetSwapVM.Strategy memory bid = strategy(buyer, true, 1, 1, 300e6, 1);
        ship(bid, 300e6);
        AssetSwapVM.Strategy memory expensive = strategy(seller, false, 1, 1, 330e6, 2);
        ship(expensive, 0);
        vm.expectRevert();
        router.swap(bid, expensive);
        assertEq(router.bitInvalidators(buyer, 0), 0);
        // Created after the standing buyer strategy. No new buyer registration or signature.
        AssetSwapVM.Strategy memory cheaper = strategy(seller, false, 1, 1, 290e6, 2);
        ship(cheaper, 0);
        assertTrue(keccak256(bid.program) != keccak256(cheaper.program));
        router.swap(bid, cheaper);
        assertEq(usdc.balanceOf(buyer), 710e6);
        assertEq(remaining(bid, true, 0), 10e6);
    }

    function testDailyThenWeeklyOverlapRollsBack() public {
        (AssetSwapVM.Strategy memory weekBid, AssetSwapVM.Strategy memory weekAsk) = pair(1, 7, 700e6, 1);
        (AssetSwapVM.Strategy memory dayBid, AssetSwapVM.Strategy memory dayAsk) = pair(2, 1, 100e6, 2);
        router.swap(dayBid, dayAsk);
        vm.expectRevert();
        router.swap(weekBid, weekAsk);
        assertEq(usdc.balanceOf(buyer), 900e6);
        assertEq(remaining(weekAsk, false, 2), 1); // Other strategies' virtual balances may be stale.
        assertEq(router.bitInvalidators(buyer, 0), 1 << 2);
        assertEq(rights.balanceOf(seller, 1), 1);
    }

    function testWeeklyThenDailyOverlapRollsBack() public {
        (AssetSwapVM.Strategy memory weekBid, AssetSwapVM.Strategy memory weekAsk) = pair(1, 7, 700e6, 1);
        (AssetSwapVM.Strategy memory dayBid, AssetSwapVM.Strategy memory dayAsk) = pair(2, 1, 100e6, 2);
        router.swap(weekBid, weekAsk);
        vm.expectRevert();
        router.swap(dayBid, dayAsk);
        assertEq(usdc.balanceOf(buyer), 300e6);
    }

    function testIndependentOrdersShareFiniteWallet() public {
        (AssetSwapVM.Strategy memory b1, AssetSwapVM.Strategy memory a1) = pair(1, 1, 600e6, 1);
        (AssetSwapVM.Strategy memory b2, AssetSwapVM.Strategy memory a2) = pair(2, 1, 600e6, 2);
        router.swap(b1, a1);
        vm.expectRevert();
        router.swap(b2, a2);
        assertEq(usdc.balanceOf(buyer), 400e6);
        assertEq(remaining(b2, true, 0), 600e6);
        assertEq(rights.balanceOf(seller, 2), 1);
    }

    function testUpstreamInvalidateBitImplementsOCOWithSufficientFunds() public {
        (AssetSwapVM.Strategy memory b1, AssetSwapVM.Strategy memory a1) = pair(1, 1, 100e6, 44);
        AssetSwapVM.Strategy memory b2 = strategy(buyer, true, 2, 1, 100e6, 44);
        AssetSwapVM.Strategy memory a2 = strategy(seller, false, 2, 1, 100e6, 45);
        ship(b2, 100e6);
        ship(a2, 0);
        router.swap(b1, a1);
        vm.expectRevert();
        router.swap(b2, a2);
        assertEq(usdc.balanceOf(buyer), 900e6);
        assertEq(rights.balanceOf(seller, 2), 1);
    }

    function testDockAndUpstreamCancellation() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 1, 100e6, 9);
        vm.prank(buyer);
        router.invalidateBit(9);
        vm.expectRevert();
        router.swap(bid, ask);
        (AquaVapor.Asset[] memory a,) = router.basket(ask);
        vm.prank(seller);
        aqua.dock(address(router), keccak256(abi.encode(ask)), a);
        assertEq(remaining(ask, false, 1), 0);
        uint256[] memory v = new uint256[](1);
        v[0] = 1;
        vm.prank(seller);
        vm.expectRevert();
        aqua.ship(address(router), abi.encode(ask), a, v);
    }

    function testRevokedERC1155ApprovalRollsBackPaymentAndVMState() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 7, 290e6, 1);
        vm.prank(seller);
        rights.setApprovalForAll(address(aqua), false);
        vm.expectRevert();
        router.swap(bid, ask);
        assertEq(usdc.balanceOf(buyer), 1000e6);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(remaining(bid, true, 0), 290e6);
        assertEq(router.bitInvalidators(buyer, 0), 0);
        assertEq(router.bitInvalidators(seller, 0), 0);
    }

    function testRevokedUSDCApprovalAndWithdrawnFunds() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 1, 100e6, 1);
        vm.prank(buyer);
        usdc.approve(address(aqua), 0);
        vm.expectRevert();
        router.swap(bid, ask);
        vm.prank(buyer);
        usdc.transfer(other, 1000e6);
        vm.expectRevert();
        router.swap(bid, ask);
        assertEq(rights.balanceOf(seller, 1), 1);
    }

    function testMissingMiddleIdRejectsWholeBasket() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 7, 290e6, 1);
        vm.prank(seller);
        rights.safeTransferFrom(seller, other, 4, 1, "");
        vm.expectRevert();
        router.swap(bid, ask);
        assertEq(usdc.balanceOf(buyer), 1000e6);
        assertEq(rights.balanceOf(buyer, 1), 0);
        assertEq(remaining(ask, false, 1), 1);
    }

    function testDuplicateIDsAndMalformedProgramRejected() public {
        AssetSwapVM.Strategy memory ask = strategy(seller, false, 1, 2, 100e6, 1);
        ask.ids[1] = ask.ids[0];
        (AquaVapor.Asset[] memory a, uint256[] memory v) = router.basket(ask);
        vm.prank(seller);
        vm.expectRevert();
        aqua.ship(address(router), abi.encode(ask), a, v);
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory valid) = pair(1, 1, 100e6, 2);
        bid.program = hex"4000";
        ship(bid, 100e6);
        vm.expectRevert();
        router.swap(bid, valid);
    }

    function testWrongAppCannotPullRegisteredInventory() public {
        (, AssetSwapVM.Strategy memory ask) = pair(1, 1, 100e6, 1);
        (AquaVapor.Asset[] memory a, uint256[] memory v) = router.basket(ask);
        vm.prank(other);
        vm.expectRevert();
        aqua.pull(seller, keccak256(abi.encode(ask)), a, v, other);
        assertEq(rights.balanceOf(seller, 1), 1);
    }

    function testChangingBasketOrMakerDoesNotReuseAuthorization() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 1, 100e6, 1);
        bid.ids[0] = 2;
        ask.ids[0] = 2;
        vm.expectRevert();
        router.swap(bid, ask);
        bid.ids[0] = 1;
        ask.ids[0] = 1;
        ask.maker = other;
        vm.expectRevert();
        router.swap(bid, ask);
    }

    function testResaleUsesSameNativeLiquidityAndConservesUnits() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 7, 290e6, 1);
        router.swap(bid, ask);
        vm.prank(buyer);
        rights.setApprovalForAll(address(aqua), true);
        AssetSwapVM.Strategy memory resale = strategy(buyer, false, 1, 7, 300e6, 2);
        AssetSwapVM.Strategy memory nextBid = strategy(other, true, 1, 7, 310e6, 1);
        ship(resale, 0);
        ship(nextBid, 310e6);
        router.swap(nextBid, resale);
        assertEq(usdc.balanceOf(buyer), 1010e6);
        for (uint256 i = 1; i <= 7; ++i) {
            assertEq(rights.balanceOf(seller, i) + rights.balanceOf(buyer, i) + rights.balanceOf(other, i), 1);
        }
    }

    function testPushERC1155AndUSDCToActiveStrategies() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 1, 100e6, 1);
        rights.mint(other, 1, 1);
        vm.prank(other);
        rights.setApprovalForAll(address(aqua), true);
        (AquaVapor.Asset[] memory a, uint256[] memory v) = router.basket(ask);
        vm.prank(other);
        aqua.push(seller, address(router), keccak256(abi.encode(ask)), a, v);
        assertEq(remaining(ask, false, 1), 2);
        assertEq(rights.balanceOf(seller, 1), 2);
        (a, v) = money(10e6);
        vm.prank(other);
        aqua.push(buyer, address(router), keccak256(abi.encode(bid)), a, v);
        assertEq(remaining(bid, true, 0), 110e6);
        assertEq(usdc.balanceOf(buyer), 1010e6);
    }

    function testFuzzNativeQuantityAndPaymentConservation(uint32 units, uint96 price) public {
        units = uint32(bound(units, 1, 100));
        price = uint96(bound(price, 1, 1000e6));
        rights.mint(seller, 1, units - 1);
        AssetSwapVM.Strategy memory bid = strategy(buyer, true, 1, 1, price, 1);
        AssetSwapVM.Strategy memory ask = strategy(seller, false, 1, 1, price, 1);
        bid.quantity = units;
        ask.quantity = units;
        bid.program = program(price, units, 1);
        ask.program = program(price, units, 1);
        ship(bid, price);
        ship(ask, 0);
        router.swap(bid, ask);
        assertEq(rights.balanceOf(buyer, 1), units);
        assertEq(rights.balanceOf(seller, 1), 0);
        assertEq(usdc.balanceOf(buyer) + usdc.balanceOf(seller), 1000e6);
        assertEq(remaining(ask, false, 1), 0);
    }

    function testExpiredStrategyAndPerStrategyBudget() public {
        (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(1, 1, 100e6, 1);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert();
        router.swap(bid, ask);
        bid = strategy(buyer, true, 1, 1, 300e6, 2);
        ask = strategy(seller, false, 1, 1, 290e6, 2);
        ship(bid, 280e6);
        ship(ask, 0);
        vm.expectRevert();
        router.swap(bid, ask);
        assertEq(usdc.balanceOf(buyer), 1000e6);
        assertEq(router.bitInvalidators(buyer, 0), 0);
    }

    function testIncompleteDockAndPushAfterDockRejected() public {
        (, AssetSwapVM.Strategy memory ask) = pair(1, 7, 100e6, 1);
        (AquaVapor.Asset[] memory full, uint256[] memory v) = router.basket(ask);
        AquaVapor.Asset[] memory subset = new AquaVapor.Asset[](1);
        subset[0] = full[0];
        bytes32 h = keccak256(abi.encode(ask));
        vm.prank(seller);
        vm.expectRevert();
        aqua.dock(address(router), h, subset);
        vm.prank(seller);
        aqua.dock(address(router), h, full);
        vm.expectRevert();
        aqua.push(seller, address(router), h, full, v);
        assertEq(rights.balanceOf(seller, 1), 1);
    }

    function testAssetTypeSeparatesTokenIDZeroAndERC20() public view {
        bytes32 fungible = aqua.assetKey(AquaVapor.Asset(AquaVapor.Kind.ERC20, address(rights), 0));
        bytes32 semiFungible = aqua.assetKey(AquaVapor.Asset(AquaVapor.Kind.ERC1155, address(rights), 0));
        assertTrue(fungible != semiFungible);
    }

    function testFuzzSharedInventorySequence(uint256 seed) public {
        uint256 successful;
        for (uint32 step = 1; step <= 12; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 id = seed % 7 + 1;
            uint256 n = (seed >> 8) % (9 - id) + 1;
            if (id + n > 8) n = 8 - id;
            (AssetSwapVM.Strategy memory bid, AssetSwapVM.Strategy memory ask) = pair(id, n, 10e6, step);
            if ((seed >> 16) % 3 == 0) {
                vm.prank(buyer);
                router.invalidateBit(step);
            }
            try router.swap(bid, ask) {
                successful++;
            } catch {}
            assertEq(usdc.balanceOf(seller), successful * 10e6);
            assertEq(usdc.balanceOf(buyer) + usdc.balanceOf(seller), 1000e6);
            for (uint256 d = 1; d <= 7; ++d) {
                assertEq(rights.balanceOf(seller, d) + rights.balanceOf(buyer, d), 1);
            }
        }
    }

    function testGas1() public {
        _gas(1);
    }

    function testGas7() public {
        _gas(7);
    }

    function testGas31() public {
        _gas(31);
    }

    function testGas90() public {
        _gas(90);
    }

    function testGas254() public {
        _gas(254);
    }

    function _gas(uint256 size) private {
        for (uint256 i; i < size; ++i) {
            rights.mint(seller, 1000 + i, 1);
        }
        AssetSwapVM.Strategy memory bid = strategy(buyer, true, 1000, size, 1e6, 1);
        AssetSwapVM.Strategy memory ask = strategy(seller, false, 1000, size, 1e6, 1);
        uint256 before = gasleft();
        ship(bid, 1e6);
        ship(ask, 0);
        emit log_named_uint("ship both strategies (harness gas)", before - gasleft());
        before = gasleft();
        router.swap(bid, ask);
        uint256 gasUsed = before - gasleft();
        emit log_named_uint("swap (warm fixture; excludes transaction intrinsic gas)", gasUsed);
        assertLt(gasUsed, 15_000_000);
        assertLt(address(router).code.length, 24_576);
        assertLt(address(aqua).code.length, 24_576);
        emit log_named_uint("AquaVapor runtime bytes", address(aqua).code.length);
        emit log_named_uint("AssetSwapVM runtime bytes", address(router).code.length);
    }
}

contract CallbackBuyer is ERC1155Holder {
    AquaVapor immutable aqua;
    AssetSwapVM immutable router;
    bool public reject;
    bool public routerBlocked;
    bool public aquaBlocked;
    bytes private nested;
    bytes private nestedAqua;

    constructor(AquaVapor a, AssetSwapVM r) {
        aqua = a;
        router = r;
    }

    function prepare(ProofUSDC token, AssetSwapVM.Strategy calldata bid, AssetSwapVM.Strategy calldata ask, bool fail)
        external
    {
        token.approve(address(aqua), type(uint256).max);
        AquaVapor.Asset[] memory a = new AquaVapor.Asset[](1);
        uint256[] memory v = new uint256[](1);
        a[0] = AquaVapor.Asset(AquaVapor.Kind.ERC20, address(token), 0);
        v[0] = 300e6;
        aqua.ship(address(router), abi.encode(bid), a, v);
        nested = abi.encodeCall(router.swap, (bid, ask));
        nestedAqua = abi.encodeCall(aqua.dock, (address(router), keccak256(abi.encode(bid)), a));
        reject = fail;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        override
        returns (bytes4)
    {
        require(!reject, "rejected");
        (bool ok, bytes memory reason) = address(router).call(nested);
        routerBlocked = !ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        (ok, reason) = address(aqua).call(nestedAqua);
        aquaBlocked = !ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        return this.onERC1155BatchReceived.selector;
    }
}

contract NativeCallbacksTest is NativeAquaFixture {
    function testReceiverRejectionRollsBackBothLegsAndBits() public {
        _callback(true);
    }

    function testReceiverCannotReenterAquaOrRouter() public {
        _callback(false);
    }

    function _callback(bool reject) private {
        CallbackBuyer cb = new CallbackBuyer(aqua, router);
        usdc.mint(address(cb), 300e6);
        AssetSwapVM.Strategy memory bid = strategy(address(cb), true, 1, 7, 300e6, 1);
        AssetSwapVM.Strategy memory ask = strategy(seller, false, 1, 7, 290e6, 1);
        ship(ask, 0);
        cb.prepare(usdc, bid, ask, reject);
        if (reject) vm.expectRevert();
        router.swap(bid, ask);
        if (reject) {
            assertEq(usdc.balanceOf(address(cb)), 300e6);
            assertEq(usdc.balanceOf(seller), 0);
            assertEq(router.bitInvalidators(address(cb), 0), 0);
            assertEq(router.bitInvalidators(seller, 0), 0);
            assertEq(remaining(bid, true, 0), 300e6);
            assertEq(rights.balanceOf(seller, 1), 1);
        } else {
            assertTrue(cb.routerBlocked());
            assertTrue(cb.aquaBlocked());
            assertEq(usdc.balanceOf(address(cb)), 10e6);
            assertEq(rights.balanceOf(address(cb), 1), 1);
        }
    }
}
