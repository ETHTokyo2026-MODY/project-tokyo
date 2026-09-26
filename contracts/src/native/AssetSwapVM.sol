// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Context} from "swap-vm/libs/VM.sol";
import {Opcode} from "swap-vm/libs/OpcodeList.sol";
import {CalldataPtrLib} from "@1inch/solidity-utils/contracts/libraries/CalldataPtr.sol";
import {StaticBalances} from "swap-vm/instructions/Balances.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";
import {InvalidateBit, InvalidateBitExternal} from "swap-vm/instructions/Invalidators.sol";
import {Deadline, Salt} from "swap-vm/instructions/Controls.sol";
import {AquaVapor} from "./AquaVapor.sol";

/// @title Native Aqua basket execution through SwapVM
/// @notice Adapted quote/runLoop/transfer shell from SwapVM.sol at feb16411738331f7d05ae71d4a664154068018fc.
/// @dev SwapVM — © Degensoft Ltd 2025. Modified 2026-09-26: two independently
/// authorized strategies, ERC-1155 baskets and AquaVapor transfers replace ERC-20-only traits.
/// The upstream interpreter and supported instruction implementations are reused unchanged.
contract AssetSwapVM is ReentrancyGuard, InvalidateBitExternal {
    struct Strategy {
        address maker;
        address inventory;
        uint256[] ids;
        uint256 quantity;
        bool buy;
        bytes32 salt;
        bytes program;
    }

    AquaVapor public immutable AQUA;
    address public immutable USDC;

    error InvalidStrategy();
    error IncompatibleStrategies();
    error UnsupportedInstruction(uint256 opcode);
    error UnavailableAsset();

    event Swapped(bytes32 indexed bidHash, bytes32 indexed askHash, uint256 payment, uint256 quantity);

    constructor(AquaVapor aqua, address usdc) {
        require(address(aqua) != address(0) && usdc != address(0), InvalidStrategy());
        AQUA = aqua;
        USDC = usdc;
    }

    /// @notice Hash exactly the bytes registered by the maker using AquaVapor.ship.
    function hash(Strategy calldata strategy) public pure returns (bytes32) {
        return keccak256(abi.encode(strategy));
    }

    /// @notice Evaluate both programs without consuming their upstream invalidation bits.
    /// @dev This checks current balances but does not promise transfer success; callers should simulate swap.
    function quote(Strategy calldata bid, Strategy calldata ask) external returns (uint256 payment) {
        return _evaluate(bid, ask, true);
    }

    /// @notice Any matcher may execute compatible, already shipped strategies.
    /// @dev Maker identity and destinations cannot be supplied separately from the registered strategy.
    function swap(Strategy calldata bid, Strategy calldata ask) external nonReentrant returns (uint256 payment) {
        payment = _evaluate(bid, ask, false);
        (AquaVapor.Asset[] memory money, uint256[] memory amounts) = _money(payment);
        AQUA.pull(bid.maker, hash(bid), money, amounts, ask.maker);
        (AquaVapor.Asset[] memory rights, uint256[] memory quantities) = basket(ask);
        AQUA.pull(ask.maker, hash(ask), rights, quantities, bid.maker);
        emit Swapped(hash(bid), hash(ask), payment, ask.quantity);
    }

    /// @notice Canonical constituent asset list; no separate week token or synthetic ERC-20 wrapper.
    function basket(Strategy calldata s)
        public
        pure
        returns (AquaVapor.Asset[] memory assets, uint256[] memory quantities)
    {
        assets = new AquaVapor.Asset[](s.ids.length);
        quantities = new uint256[](s.ids.length);
        for (uint256 i; i < s.ids.length; ++i) {
            assets[i] = AquaVapor.Asset(AquaVapor.Kind.ERC1155, s.inventory, s.ids[i]);
            quantities[i] = s.quantity;
        }
    }

    function _evaluate(Strategy calldata bid, Strategy calldata ask, bool readOnly) private returns (uint256 price) {
        require(
            bid.buy && !ask.buy && bid.maker != ask.maker && bid.inventory == ask.inventory
                && bid.quantity == ask.quantity && keccak256(abi.encode(bid.ids)) == keccak256(abi.encode(ask.ids)),
            IncompatibleStrategies()
        );
        _validate(bid);
        _validate(ask);
        bytes32 bidHash = hash(bid);
        bytes32 askHash = hash(ask);
        uint256 cap = _run(bid, readOnly);
        price = _run(ask, readOnly);
        require(price <= cap, IncompatibleStrategies());
        // Virtual balances are permissions, not reserved assets. Both are checked separately.
        (AquaVapor.Asset[] memory money,) = _money(price);
        _available(bid.maker, bidHash, money[0], price);
        require(IERC20(USDC).balanceOf(bid.maker) >= price, UnavailableAsset());
        (AquaVapor.Asset[] memory rights,) = basket(ask);
        for (uint256 i; i < rights.length; ++i) {
            _available(ask.maker, askHash, rights[i], ask.quantity);
            require(IERC1155(ask.inventory).balanceOf(ask.maker, ask.ids[i]) >= ask.quantity, UnavailableAsset());
        }
    }

    function _validate(Strategy calldata s) private view {
        require(
            s.maker != address(0) && s.inventory != address(0) && s.inventory != USDC && s.quantity > 0
                && s.ids.length > 0,
            InvalidStrategy()
        );
        for (uint256 i = 1; i < s.ids.length; ++i) {
            require(s.ids[i - 1] < s.ids[i], InvalidStrategy());
        }
    }

    function _available(address maker, bytes32 strategyHash, AquaVapor.Asset memory asset, uint256 needed)
        private
        view
    {
        (uint248 amount, uint8 count) = AQUA.rawBalances(maker, address(this), strategyHash, asset);
        require(count != 0 && count != 255 && amount >= needed, UnavailableAsset());
    }

    function _run(Strategy calldata s, bool readOnly) private returns (uint256 price) {
        Context memory ctx;
        ctx.vm.isStaticContext = readOnly;
        ctx.vm.programPtr = CalldataPtrLib.from(s.program);
        ctx.vm.dispatch = _dispatch;
        ctx.query.orderHash = hash(s);
        ctx.query.maker = s.maker;
        ctx.query.taker = msg.sender;
        ctx.query.tokenIn = USDC;
        ctx.query.tokenOut = s.inventory;
        ctx.query.isExactIn = false;
        ctx.swap.amountOut = s.quantity;
        uint256 output;
        (price, output) = ctx.runLoop();
        require(price > 0 && output == s.quantity, InvalidStrategy());
    }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal {
        // Strict lengths prevent malformed operands from reading adjacent calldata.
        if (opcode == uint8(Opcode.StaticBalances) && args.length == 64) StaticBalances.exec(ctx, args);
        else if (opcode == uint8(Opcode.LimitSwapFullAmount) && args.length == 1) LimitSwapFullAmount.exec(ctx, args);
        else if (opcode == uint8(Opcode.InvalidateBit) && args.length == 4) InvalidateBit.exec(ctx, args);
        else if (opcode == uint8(Opcode.Deadline) && args.length == 5) Deadline.exec(ctx, args);
        else if (opcode == uint8(Opcode.Salt)) Salt.exec(ctx, args);
        else revert UnsupportedInstruction(opcode);
    }

    function _money(uint256 amount) private view returns (AquaVapor.Asset[] memory assets, uint256[] memory amounts) {
        assets = new AquaVapor.Asset[](1);
        amounts = new uint256[](1);
        assets[0] = AquaVapor.Asset(AquaVapor.Kind.ERC20, USDC, 0);
        amounts[0] = amount;
    }
}
