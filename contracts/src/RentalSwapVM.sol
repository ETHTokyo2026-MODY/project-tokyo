// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025. Rental integration added 2026-09-26.
pragma solidity 0.8.30;

import {Context} from "swap-vm/libs/VM.sol";
import {Opcode} from "swap-vm/libs/OpcodeList.sol";
import {LimitSwapFullAmount} from "swap-vm/instructions/LimitSwap.sol";
import {CalldataPtrLib} from "@1inch/solidity-utils/contracts/libraries/CalldataPtr.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {RentalInventory} from "./RentalInventory.sol";
import {RentalSettlement} from "./RentalSettlement.sol";

/// @notice Specialized SwapVM router: actual upstream VM + full-amount instruction,
/// with Aqua USDC / ERC1155 settlement replacing the ERC20/ ERC20 settlement shell.
/// Only two-instruction programs are accepted. No external calls, jumps or stateful opcodes.
contract RentalSwapVM is RentalSettlement {
    // Fork-local allocation of unused balance-family opcodes. Not stock router bytecode.
    uint8 public constant FIXED = 0x9e;
    uint8 public constant DUTCH = 0x9f;
    uint8 public constant TERMS_FIXED = 0xa0;
    uint8 public constant TERMS_DUTCH = 0xa1;
    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_DISCOUNT_BPS = 9_000;

    error InvalidProgram();

    constructor(IAqua a, RentalInventory i, address token, address fees) RentalSettlement(a, i, token, fees) {}

    function _quote(bytes calldata program, uint256 durationDays, uint256 quantity)
        internal
        override
        returns (uint256 price, uint256 fee)
    {
        require(quantity > 0 && program.length >= 2, InvalidProgram());
        uint8 kind = uint8(program[0]);
        bool termsProgram = kind == TERMS_FIXED || kind == TERMS_DUTCH;
        require(
            !termsProgram || (durationDays > 0 && durationDays <= 31 && quantity <= type(uint32).max), InvalidProgram()
        );
        uint256 argLength = uint8(program[1]);
        require(
            (kind == FIXED && argLength == 32) || (kind == DUTCH && argLength == 128)
                || (kind == TERMS_FIXED && argLength == 128) || (kind == TERMS_DUTCH && argLength == 224),
            InvalidProgram()
        );
        require(
            program.length == argLength + 5 && uint8(program[argLength + 2]) == uint8(Opcode.LimitSwapFullAmount)
                && uint8(program[argLength + 3]) == 1 && uint8(program[argLength + 4]) == 128,
            InvalidProgram()
        );
        Context memory ctx;
        ctx.vm.isStaticContext = true; // Pricing is pure/read-only even during settlement.
        ctx.vm.programPtr = CalldataPtrLib.from(program);
        ctx.vm.dispatch = _dispatch;
        ctx.query.tokenIn = address(1); // Logical units -> USDC; direction is fixed.
        ctx.query.tokenOut = address(2);
        ctx.query.isExactIn = true;
        uint256 units = durationDays == 0 ? quantity : durationDays * quantity;
        ctx.swap.amountIn = units;
        ctx.swap.balanceIn = units;
        (, price) = ctx.runLoop();
        require(ctx.swap.amountIn == units, InvalidProgram());
        uint256 feeBps = 100;
        if (termsProgram) {
            uint256 threshold;
            uint256 discountBps;
            if (kind == TERMS_FIXED) {
                (, feeBps, threshold, discountBps) = abi.decode(program[2:130], (uint256, uint256, uint256, uint256));
            } else {
                (,,,, feeBps, threshold, discountBps) =
                    abi.decode(program[2:226], (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            }
            require(
                feeBps <= MAX_FEE_BPS && discountBps <= MAX_DISCOUNT_BPS
                    && (discountBps == 0 ? threshold == 0 : threshold > 0 && threshold <= 31),
                InvalidProgram()
            );
            price *= units;
            if (durationDays >= threshold && discountBps > 0) price = price * (10_000 - discountBps) / 10_000;
        }
        fee = price * feeBps / 10_000;
    }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal view {
        if (opcode == FIXED) {
            ctx.swap.balanceOut = abi.decode(args, (uint256));
            require(ctx.swap.balanceOut > 0, InvalidProgram());
        } else if (opcode == TERMS_FIXED) {
            (uint256 unitPrice,,,) = abi.decode(args, (uint256, uint256, uint256, uint256));
            require(unitPrice > 0 && unitPrice <= type(uint128).max, InvalidProgram());
            ctx.swap.balanceOut = unitPrice;
        } else if (opcode == DUTCH) {
            (uint256 high, uint256 low, uint256 start, uint256 end) =
                abi.decode(args, (uint256, uint256, uint256, uint256));
            require(high >= low && low > 0 && end > start, InvalidProgram());
            uint256 elapsed =
                block.timestamp <= start ? 0 : block.timestamp >= end ? end - start : block.timestamp - start;
            // Prices bounded to avoid multiplication overflow for attacker-controlled curves.
            require(high <= type(uint128).max && end - start <= type(uint64).max, InvalidProgram());
            ctx.swap.balanceOut = high - (high - low) * elapsed / (end - start);
        } else if (opcode == TERMS_DUTCH) {
            (uint256 high, uint256 low, uint256 start, uint256 end,,,) =
                abi.decode(args, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            require(
                high >= low && low > 0 && high <= type(uint128).max && end > start && end - start <= type(uint64).max,
                InvalidProgram()
            );
            uint256 elapsed =
                block.timestamp <= start ? 0 : block.timestamp >= end ? end - start : block.timestamp - start;
            ctx.swap.balanceOut = high - (high - low) * elapsed / (end - start);
        } else if (opcode == uint8(Opcode.LimitSwapFullAmount)) {
            LimitSwapFullAmount.exec(ctx, args);
        } else {
            revert InvalidProgram();
        }
    }
}
