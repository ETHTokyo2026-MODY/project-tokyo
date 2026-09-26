// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Fixture} from "./Fixture.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";

contract RejectingRentalReceiver is ERC1155Holder {
    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        pure
        override
        returns (bytes4)
    {
        revert("reject inventory");
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        pure
        override
        returns (bytes4)
    {
        revert("reject inventory");
    }
}

contract ReenteringRentalReceiver is ERC1155Holder {
    address public immutable router;
    bytes public secondFill;
    bool public attempted;
    bool public rejected;
    bytes4 public rejectionSelector;

    constructor(address router_) {
        router = router_;
    }

    function configure(bytes memory callData) external {
        secondFill = callData;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes memory) public override returns (bytes4) {
        _reenter();
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        override
        returns (bytes4)
    {
        _reenter();
        return this.onERC1155BatchReceived.selector;
    }

    function _reenter() private {
        attempted = true;
        (bool ok, bytes memory reason) = router.call(secondFill);
        rejected = !ok;
        if (reason.length >= 4) {
            bytes4 selector;
            assembly {
                selector := mload(add(reason, 32))
            }
            rejectionSelector = selector;
        }
    }
}

contract Rental1271Buyer is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract AdversarialTest is Fixture {
    function testSuccessfulFillCannotReplay() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        router.settle(bid, bidSig, ask, askSig, mandate, p);
        assertTrue(router.used(buyer, bid.nonce));
        assertTrue(router.used(seller, ask.nonce));
        assertEq(router.spent(router.hashMandate(mandate)), 10_100_000);
        vm.expectRevert(RentalSettlement.ClosedOrder.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, p);
    }

    function testBuyerCapIncludesFeeAndSellerFeeAndPriceBounds() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);

        bid.priceLimit = 10e6; // The price fits, but price plus 1% fee does not.
        _expectPriceLimit(bid, ask, p);
        bid.priceLimit = 10_100_000;
        ask.priceLimit = 10e6 + 1;
        _expectPriceLimit(bid, ask, p);
        ask.priceLimit = 10e6;
        bid.maxFee = 99_999;
        _expectPriceLimit(bid, ask, p);
        bid.maxFee = 100_000;
        ask.maxFee = 99_999;
        _expectPriceLimit(bid, ask, p);
        _assertUnspent(bid, ask);
    }

    function testMoreThanThirtyOneDaysRejected() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 32, 1, p);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.expectRevert(RentalSettlement.InvalidOrder.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, p);
        _assertUnspent(bid, ask);
    }

    function testErc1271BuyerCanFill() public {
        Rental1271Buyer wallet = new Rental1271Buyer(vm.addr(BUY_KEY));
        buyer = address(wallet);
        usd.mint(buyer, 1000e6);
        mandate = _fund(buyer, 1000e6, bytes32(uint256(2)));
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bid.recipient = other;
        _fill(bid, ask, p);
        assertEq(usd.balanceOf(buyer), 989_900_000);
        assertEq(inventory.balanceOf(other, inventory.tokenId(POOL, day, TERMS)), 1);
        assertTrue(router.used(buyer, bid.nonce));
    }

    function testSignedFieldsCannotBeTamperedWith() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        RentalSettlement.Order memory changed = _copy(bid);

        changed.recipient = other;
        _expectBadBidSignature(changed, bidSig, ask, askSig, p);
        changed = _copy(bid);
        changed.endDay = day + 2;
        _expectBadBidSignature(changed, bidSig, ask, askSig, p);
        changed = _copy(bid);
        changed.quantity = 2;
        _expectBadBidSignature(changed, bidSig, ask, askSig, p);
        changed = _copy(bid);
        changed.pool = keccak256("different pool");
        _expectBadBidSignature(changed, bidSig, ask, askSig, p);
        changed = _copy(bid);
        changed.maxFee = 0;
        _expectBadBidSignature(changed, bidSig, ask, askSig, p);
        changed = _copy(bid);
        changed.programHash = keccak256("different program");
        _expectBadBidSignature(changed, bidSig, ask, askSig, p);

        bytes memory alteredProgram = fixedProgram(11e6);
        vm.expectRevert(RentalSettlement.InvalidOrder.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, alteredProgram);
        _assertUnspent(bid, ask);
    }

    function testWrongSignerAndWrongDomainCannotReplay() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        bytes memory wrongSignerSig = _sig(bid, OTHER_KEY);

        vm.expectRevert(RentalSettlement.InvalidSignature.selector);
        router.settle(bid, wrongSignerSig, ask, askSig, mandate, p);

        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        vm.expectRevert(RentalSettlement.InvalidSignature.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, p);
        vm.chainId(originalChain);

        RentalSwapVM secondRouter = new RentalSwapVM(aqua, inventory, address(usd), fees);
        vm.expectRevert(RentalSettlement.InvalidSignature.selector);
        secondRouter.settle(bid, bidSig, ask, askSig, mandate, p);
        _assertUnspent(bid, ask);
    }

    function testOrderAndMandateExpiry() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.warp(bid.expiry);
        vm.expectRevert(RentalSettlement.InvalidOrder.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, p);

        vm.warp(mandate.expiry);
        bid.expiry = block.timestamp + 1 days;
        ask.expiry = bid.expiry;
        bidSig = _sig(bid, BUY_KEY);
        askSig = _sig(ask, SELL_KEY);
        vm.expectRevert(RentalSettlement.InvalidMandate.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, p);
    }

    function testRevokedInventoryApprovalRollsBackEverything() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bid.group = keccak256("bid group");
        ask.group = keccak256("ask group");
        vm.prank(seller);
        inventory.setApprovalForAll(address(router), false);
        _expectFillRevert(bid, ask, p);
        _assertUnspent(bid, ask);
    }

    function testRejectingReceiverRollsBackEverything() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        bid.group = keccak256("bid group");
        ask.group = keccak256("ask group");
        bid.recipient = address(new RejectingRentalReceiver());
        _expectFillRevert(bid, ask, p);
        _assertUnspent(bid, ask);
    }

    function testReceiverCannotReenterWithDifferentOrders() public {
        bytes memory p = fixedProgram(10e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 1, p);
        (RentalSettlement.Order memory secondBid, RentalSettlement.Order memory secondAsk) =
            _orders(day + 1, day + 2, 2, p);
        ReenteringRentalReceiver receiver = new ReenteringRentalReceiver(address(router));
        receiver.configure(
            abi.encodeCall(
                router.settle, (secondBid, _sig(secondBid, BUY_KEY), secondAsk, _sig(secondAsk, SELL_KEY), mandate, p)
            )
        );
        bid.recipient = address(receiver);
        _fill(bid, ask, p);

        assertTrue(receiver.attempted());
        assertTrue(receiver.rejected());
        assertEq(receiver.rejectionSelector(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertTrue(router.used(buyer, bid.nonce));
        assertTrue(router.used(seller, ask.nonce));
        assertFalse(router.used(buyer, secondBid.nonce));
        assertFalse(router.used(seller, secondAsk.nonce));
        assertEq(inventory.balanceOf(seller, inventory.tokenId(POOL, day + 1, TERMS)), 1);
        assertEq(inventory.balanceOf(address(receiver), inventory.tokenId(POOL, day, TERMS)), 1);
    }

    function testMalformedVmProgramsAreRejected() public {
        _expectBadProgram(hex"");
        _expectBadProgram(hex"00");
        _expectBadProgram(hex"ff20");
        _expectBadProgram(hex"9e1f");
        bytes memory valid = fixedProgram(10e6);
        _expectBadProgram(_prefix(valid, valid.length - 1));
        _expectBadProgram(bytes.concat(valid, hex"00"));
        bytes memory wrongDirection = bytes.concat(valid);
        wrongDirection[wrongDirection.length - 1] = bytes1(uint8(0));
        _expectBadProgram(wrongDirection);
        _expectBadProgram(dutchProgram(1e6, 2e6, 1, 2));
        _expectBadProgram(dutchProgram(2e6, 0, 1, 2));
        _expectBadProgram(dutchProgram(2e6, 1e6, 2, 2));
        _expectBadProgram(dutchProgram(uint256(type(uint128).max) + 1, 1e6, 1, 2));
        _expectBadProgram(dutchProgram(2e6, 1e6, 1, uint256(type(uint64).max) + 2));
        vm.expectRevert(RentalSwapVM.InvalidProgram.selector);
        router.quote(valid, 0);
    }

    function _expectBadBidSignature(
        RentalSettlement.Order memory bid,
        bytes memory badSig,
        RentalSettlement.Order memory ask,
        bytes memory askSig,
        bytes memory p
    ) private {
        vm.expectRevert(RentalSettlement.InvalidSignature.selector);
        router.settle(bid, badSig, ask, askSig, mandate, p);
    }

    function _expectBadProgram(bytes memory p) private {
        vm.expectRevert(RentalSwapVM.InvalidProgram.selector);
        router.quote(p, 1);
    }

    function _expectPriceLimit(RentalSettlement.Order memory bid, RentalSettlement.Order memory ask, bytes memory p)
        private
    {
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.expectRevert(RentalSettlement.PriceLimit.selector);
        router.settle(bid, bidSig, ask, askSig, mandate, p);
    }

    function _expectFillRevert(RentalSettlement.Order memory bid, RentalSettlement.Order memory ask, bytes memory p)
        private
    {
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.expectRevert();
        router.settle(bid, bidSig, ask, askSig, mandate, p);
    }

    function _prefix(bytes memory data, uint256 length) private pure returns (bytes memory result) {
        result = new bytes(length);
        for (uint256 i; i < length; ++i) {
            result[i] = data[i];
        }
    }

    function _copy(RentalSettlement.Order memory order) private pure returns (RentalSettlement.Order memory) {
        return abi.decode(abi.encode(order), (RentalSettlement.Order));
    }

    function _assertUnspent(RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) private view {
        bytes32 mandateHash = router.hashMandate(mandate);
        (uint248 remaining, uint8 status) = aqua.rawBalances(buyer, address(router), mandateHash, address(usd));
        assertEq(remaining, mandate.limit);
        assertEq(status, 1);
        assertEq(router.spent(mandateHash), 0);
        assertFalse(router.used(bid.maker, bid.nonce));
        assertFalse(router.used(ask.maker, ask.nonce));
        assertFalse(router.closedGroup(bid.maker, bid.group));
        assertFalse(router.closedGroup(ask.maker, ask.group));
        assertEq(usd.balanceOf(buyer), 1000e6);
        assertEq(usd.balanceOf(seller), 0);
        assertEq(usd.balanceOf(fees), 0);
        assertEq(inventory.balanceOf(seller, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(inventory.balanceOf(bid.recipient, inventory.tokenId(POOL, day, TERMS)), 0);
    }
}
