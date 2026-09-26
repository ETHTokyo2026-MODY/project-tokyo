// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {RentalRevenue} from "../src/RentalRevenue.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";
import {Fixture} from "./Fixture.sol";

contract CallbackUSDC is ERC20, ERC1155Holder {
    address public target;
    bytes public payload;
    bool public attempted;
    bool public succeeded;

    constructor() ERC20("Callback USDC", "cUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configure(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (target != address(0) && !attempted) {
            attempted = true;
            (succeeded,) = target.call(payload);
        }
        return super.transferFrom(from, to, amount);
    }
}

contract RevenueTest is Fixture {
    RentalRevenue internal revenue;
    uint256 internal claimId;
    uint256 internal constant PRICE = 100e6;

    function setUp() public override {
        super.setUp();
        revenue = new RentalRevenue(aqua, inventory, usd);
        vm.startPrank(seller);
        inventory.setApprovalForAll(address(revenue), true);
        claimId = revenue.createClaim(POOL, day, TERMS);
        revenue.setPrice(claimId, PRICE);
        vm.stopPrank();
    }

    function _mandate(uint256 id, address guest, uint256 price, bytes32 salt)
        internal
        view
        returns (RentalRevenue.BookingMandate memory m)
    {
        m = RentalRevenue.BookingMandate(
            buyer, address(revenue), address(usd), id, guest, price, block.timestamp + 1 days, salt
        );
    }

    function _ship(RentalRevenue.BookingMandate memory m, uint256 amount) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = m.token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        vm.prank(m.buyer);
        aqua.ship(address(revenue), abi.encode(m), tokens, amounts);
    }

    function testCurrentHolderPricesAndResaleReceivesOnlyFundedRevenue() public {
        vm.prank(seller);
        revenue.safeTransferFrom(seller, other, claimId, 1, "");
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.setPrice(claimId, 1);
        vm.prank(other);
        revenue.setPrice(claimId, 125e6);

        RentalRevenue.BookingMandate memory m = _mandate(claimId, seller, 125e6, keccak256("resale"));
        _ship(m, 125e6);
        uint256 buyerBefore = usd.balanceOf(buyer);
        uint256 sellerBefore = usd.balanceOf(seller);
        uint256 otherBefore = usd.balanceOf(other);
        uint256 reservationId = revenue.book(claimId, m);
        assertEq(reservationId, 1);
        assertEq(usd.balanceOf(buyer), buyerBefore - 125e6);
        assertEq(usd.balanceOf(address(revenue)), 125e6);
        assertEq(revenue.escrowedRevenue(), 125e6);
        assertEq(inventory.consumed(POOL, day), 1);
        assertEq(inventory.issued(POOL, day), 1);
        (address holder, address beneficiary,,,,,) = inventory.reservations(reservationId);
        assertEq(holder, address(revenue));
        assertEq(beneficiary, seller);

        vm.prank(other);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.claimRevenue(claimId);
        vm.warp((uint256(day) + 1) * 1 days);
        vm.prank(other);
        assertEq(revenue.claimRevenue(claimId), 125e6);
        assertEq(usd.balanceOf(other), otherBefore + 125e6);
        assertEq(usd.balanceOf(seller), sellerBefore);
        assertEq(usd.balanceOf(address(revenue)), 0);
        assertEq(revenue.escrowedRevenue(), 0);
        vm.prank(other);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.claimRevenue(claimId);
        assertEq(revenue.balanceOf(other, claimId), 0);
    }

    function testBookedClaimCanChangePayoutHolderButNotGuestOrPrice() public {
        RentalRevenue.BookingMandate memory m = _mandate(claimId, other, PRICE, keccak256("guest"));
        _ship(m, PRICE);
        revenue.book(claimId, m);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        bytes32 mandateHash = revenue.hashMandate(m);
        vm.prank(buyer);
        aqua.dock(address(revenue), mandateHash, tokens);
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.setPrice(claimId, 1);
        vm.prank(seller);
        revenue.safeTransferFrom(seller, other, claimId, 1, "");
        (,,, uint256 fundedPrice,,) = revenue.claims(claimId);
        assertEq(fundedPrice, PRICE);
        vm.warp((uint256(day) + 1) * 1 days);
        vm.prank(other);
        assertEq(revenue.claimRevenue(claimId), PRICE);
    }

    function testOpenTransferClearsOldPriceAndCheapMandateCannotBookNewOwner() public {
        RentalRevenue.BookingMandate memory cheap = _mandate(claimId, buyer, PRICE, keccak256("old-price"));
        _ship(cheap, PRICE);
        vm.prank(other);
        revenue.safeTransferFrom(other, buyer, claimId, 0, "");
        (,,, uint256 unchangedPrice,,) = revenue.claims(claimId);
        assertEq(unchangedPrice, PRICE);
        vm.prank(seller);
        revenue.safeTransferFrom(seller, seller, claimId, 1, "");
        (,,, unchangedPrice,,) = revenue.claims(claimId);
        assertEq(unchangedPrice, PRICE);

        vm.prank(seller);
        revenue.safeTransferFrom(seller, other, claimId, 1, "");
        (,,, uint256 clearedPrice,,) = revenue.claims(claimId);
        assertEq(clearedPrice, 0);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.book(claimId, cheap);
        vm.prank(other);
        revenue.setPrice(claimId, 2 * PRICE);
        vm.expectRevert(RentalRevenue.InvalidMandate.selector);
        revenue.book(claimId, cheap);
        assertEq(inventory.consumed(POOL, day), 0);
    }

    function testBookingBeforeSignedOpenClaimSaleRollsBackRouterPayment() public {
        RentalSwapVM claimRouter = new RentalSwapVM(aqua, revenue, address(usd), fees);
        vm.prank(seller);
        revenue.setApprovalForAll(address(claimRouter), true);
        bytes memory saleProgram = fixedProgram(50e6);
        RentalSettlement.Mandate memory saleMandate = RentalSettlement.Mandate(
            buyer, address(claimRouter), address(usd), 51e6, block.timestamp + 1 days, keccak256("pending-sale")
        );
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 51e6;
        vm.prank(buyer);
        aqua.ship(address(claimRouter), abi.encode(saleMandate), tokens, amounts);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 78, saleProgram);
        bid.mandate = keccak256(abi.encode(saleMandate));
        (uint8 bidV, bytes32 bidR, bytes32 bidS) = vm.sign(BUY_KEY, claimRouter.hashOrder(bid));
        (uint8 askV, bytes32 askR, bytes32 askS) = vm.sign(SELL_KEY, claimRouter.hashOrder(ask));

        RentalRevenue.BookingMandate memory booking = _mandate(claimId, other, PRICE, keccak256("race"));
        _ship(booking, PRICE);
        revenue.book(claimId, booking);
        uint256 buyerBefore = usd.balanceOf(buyer);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        claimRouter.settle(
            bid, abi.encodePacked(bidR, bidS, bidV), ask, abi.encodePacked(askR, askS, askV), saleMandate, saleProgram
        );
        assertEq(usd.balanceOf(buyer), buyerBefore);
        assertEq(revenue.balanceOf(seller, claimId), 1);
        assertFalse(claimRouter.used(buyer, 78));
    }

    function testFundingFailureRollsBackAndCannotBookTwice() public {
        RentalRevenue.BookingMandate memory m = _mandate(claimId, other, PRICE, keccak256("funding"));
        _ship(m, PRICE);
        vm.prank(buyer);
        usd.approve(address(aqua), 0);
        vm.expectRevert();
        revenue.book(claimId, m);
        assertEq(revenue.escrowedRevenue(), 0);
        assertEq(inventory.consumed(POOL, day), 0);
        assertEq(inventory.balanceOf(address(revenue), inventory.tokenId(POOL, day, TERMS)), 1);
        (,,,,, RentalRevenue.State state) = revenue.claims(claimId);
        assertEq(uint8(state), uint8(RentalRevenue.State.Open));
        vm.prank(buyer);
        usd.approve(address(aqua), PRICE);
        revenue.book(claimId, m);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.book(claimId, m);
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.withdrawUnbooked(claimId);
    }

    function testMandateBindsPriceAndBeneficiary() public {
        RentalRevenue.BookingMandate memory m = _mandate(claimId, other, PRICE, keccak256("bound"));
        _ship(m, PRICE);
        RentalRevenue.BookingMandate memory wrongGuest = m;
        wrongGuest.beneficiary = seller;
        vm.expectRevert(RentalRevenue.InvalidFunding.selector);
        revenue.book(claimId, wrongGuest);
        assertEq(inventory.consumed(POOL, day), 0);
        vm.prank(seller);
        revenue.setPrice(claimId, PRICE + 1);
        vm.expectRevert(RentalRevenue.InvalidMandate.selector);
        revenue.book(claimId, m);
        assertEq(usd.balanceOf(address(revenue)), 0);
    }

    function testUnbookedExpiryReturnsUnderlyingWithZeroRevenue() public {
        vm.warp((uint256(day) + 1) * 1 days);
        vm.prank(seller);
        revenue.withdrawUnbooked(claimId);
        assertEq(usd.balanceOf(address(revenue)), 0);
        assertEq(revenue.escrowedRevenue(), 0);
        assertEq(inventory.balanceOf(seller, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(inventory.consumed(POOL, day), 0);
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.claimRevenue(claimId);
    }

    function testWithdrawnBasketCannotCreateReplacementClaimForOldSignedOrders() public {
        vm.prank(seller);
        revenue.withdrawUnbooked(claimId);
        assertEq(revenue.tokenId(POOL, day, TERMS), claimId);
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.createClaim(POOL, day, TERMS);
        assertEq(revenue.balanceOf(seller, claimId), 0);
    }

    function testAquaRouterSellsEconomicClaimThenBuyerReceivesBookedRevenue() public {
        RentalSwapVM claimRouter = new RentalSwapVM(aqua, revenue, address(usd), fees);
        vm.prank(seller);
        revenue.setApprovalForAll(address(claimRouter), true);
        bytes memory saleProgram = fixedProgram(50e6);
        RentalSettlement.Mandate memory saleMandate = RentalSettlement.Mandate(
            buyer, address(claimRouter), address(usd), 51e6, block.timestamp + 1 days, keccak256("claim-sale")
        );
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 51e6;
        vm.prank(buyer);
        aqua.ship(address(claimRouter), abi.encode(saleMandate), tokens, amounts);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 77, saleProgram);
        bid.mandate = keccak256(abi.encode(saleMandate));
        (uint8 bidV, bytes32 bidR, bytes32 bidS) = vm.sign(BUY_KEY, claimRouter.hashOrder(bid));
        (uint8 askV, bytes32 askR, bytes32 askS) = vm.sign(SELL_KEY, claimRouter.hashOrder(ask));
        claimRouter.settle(
            bid, abi.encodePacked(bidR, bidS, bidV), ask, abi.encodePacked(askR, askS, askV), saleMandate, saleProgram
        );
        assertEq(revenue.tokenId(POOL, day, TERMS), claimId);
        assertEq(revenue.balanceOf(buyer, claimId), 1);
        assertEq(revenue.balanceOf(seller, claimId), 0);
        assertEq(usd.balanceOf(seller), 50e6);
        assertEq(usd.balanceOf(buyer), 1000e6 - 50_500_000);

        vm.prank(buyer);
        revenue.setPrice(claimId, 100e6);
        RentalRevenue.BookingMandate memory booking = RentalRevenue.BookingMandate(
            other,
            address(revenue),
            address(usd),
            claimId,
            other,
            100e6,
            block.timestamp + 1 days,
            keccak256("guest-funding")
        );
        vm.prank(other);
        usd.approve(address(aqua), 100e6);
        amounts[0] = 100e6;
        vm.prank(other);
        aqua.ship(address(revenue), abi.encode(booking), tokens, amounts);
        revenue.book(claimId, booking);
        assertEq(inventory.consumed(POOL, day), 1);
        assertEq(revenue.escrowedRevenue(), 100e6);
        vm.warp((uint256(day) + 1) * 1 days);
        vm.prank(buyer);
        assertEq(revenue.claimRevenue(claimId), 100e6);
        assertEq(usd.balanceOf(buyer), 1000e6 - 50_500_000 + 100e6);
        assertEq(usd.balanceOf(other), 1000e6 - 100e6);
    }

    function testCapacityOneAndOnlyExpectedEscrowAreAccepted() public {
        bytes32 pool = keccak256("multi-unit");
        inventory.createPool(pool, seller, day, day + 1, 2);
        vm.prank(seller);
        inventory.issue(pool, day, day + 1, TERMS, 2);
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidClaim.selector);
        revenue.createClaim(pool, day, TERMS);
        uint256 strayId = inventory.tokenId(POOL, day + 1, TERMS);
        vm.prank(seller);
        vm.expectRevert(RentalRevenue.InvalidEscrow.selector);
        inventory.safeTransferFrom(seller, address(revenue), strayId, 1, "");
    }

    function testMaliciousTokenCallbackCannotMutateAnotherClaimDuringBooking() public {
        CallbackUSDC callbackToken = new CallbackUSDC();
        RentalRevenue callbackRevenue = new RentalRevenue(aqua, inventory, callbackToken);
        vm.startPrank(seller);
        inventory.setApprovalForAll(address(callbackRevenue), true);
        uint256 first = callbackRevenue.createClaim(POOL, day + 1, TERMS);
        uint256 second = callbackRevenue.createClaim(POOL, day + 2, TERMS);
        callbackRevenue.setPrice(first, 1e6);
        callbackRevenue.safeTransferFrom(seller, address(callbackToken), second, 1, "");
        vm.stopPrank();
        callbackToken.configure(address(callbackRevenue), abi.encodeCall(RentalRevenue.setPrice, (second, 5e6)));
        callbackToken.mint(buyer, 1e6);
        vm.prank(buyer);
        callbackToken.approve(address(aqua), 1e6);
        RentalRevenue.BookingMandate memory m = RentalRevenue.BookingMandate(
            buyer,
            address(callbackRevenue),
            address(callbackToken),
            first,
            other,
            1e6,
            block.timestamp + 1 days,
            keccak256("callback")
        );
        address[] memory tokens = new address[](1);
        tokens[0] = address(callbackToken);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1e6;
        vm.prank(buyer);
        aqua.ship(address(callbackRevenue), abi.encode(m), tokens, amounts);
        callbackRevenue.book(first, m);
        assertTrue(callbackToken.attempted());
        assertFalse(callbackToken.succeeded());
        (,,, uint256 untouchedPrice,, RentalRevenue.State state) = callbackRevenue.claims(second);
        assertEq(untouchedPrice, 0);
        assertEq(uint8(state), uint8(RentalRevenue.State.Open));
        assertEq(callbackRevenue.escrowedRevenue(), 1e6);
    }

    function testBuyerCanRevokeUnfilledBookingWithoutEscrowLiability() public {
        RentalRevenue.BookingMandate memory m = _mandate(claimId, other, PRICE, keccak256("revoked"));
        _ship(m, PRICE);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        bytes32 mandateHash = revenue.hashMandate(m);
        vm.prank(buyer);
        aqua.dock(address(revenue), mandateHash, tokens);
        vm.expectRevert(RentalRevenue.InvalidFunding.selector);
        revenue.book(claimId, m);
        assertEq(revenue.escrowedRevenue(), 0);
        assertEq(usd.balanceOf(address(revenue)), 0);
        assertEq(inventory.consumed(POOL, day), 0);
    }
}
