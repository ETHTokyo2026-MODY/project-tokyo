// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IAqua} from "aqua/interfaces/IAqua.sol";
import {RentalInventory} from "../src/RentalInventory.sol";
import {RentalSwapVM} from "../src/RentalSwapVM.sol";

contract Deploy is Script {
    function run() external {
        require(block.chainid == 11155111, "Sepolia deployment only");
        address a = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
        require(a.codehash == 0x720bc02d220db318164dc3bade86eec1f3655bdc00fc1174de7d816a95c341f8, "Aqua code changed");
        address usdc = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
        require(usdc.code.length > 0, "USDC missing");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        vm.startBroadcast();
        RentalInventory inventory = new RentalInventory();
        RentalSwapVM router = new RentalSwapVM(IAqua(a), inventory, usdc, feeRecipient);
        vm.stopBroadcast();
        console2.log("Inventory", address(inventory));
        console2.log("Router", address(router));
    }
}
