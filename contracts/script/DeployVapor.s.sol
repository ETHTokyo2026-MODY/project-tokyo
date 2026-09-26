// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {AquaVapor} from "../src/native/AquaVapor.sol";
import {AssetSwapVM} from "../src/native/AssetSwapVM.sol";

/// @notice Deploy native ERC-1155 settlement against Circle test USDC with an externally configured signer.
/// @dev This creates a separate AquaVapor deployment; it does not modify the official Aqua address.
contract DeployVapor is Script {
    function run() external {
        require(block.chainid == 11155111, "Sepolia only");
        address usdc = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
        require(usdc.code.length > 0, "USDC missing");
        vm.startBroadcast();
        AquaVapor aqua = new AquaVapor();
        AssetSwapVM router = new AssetSwapVM(aqua, usdc);
        vm.stopBroadcast();
        console2.log("AquaVapor", address(aqua));
        console2.log("AssetSwapVM", address(router));
        console2.log("USDC", usdc);
    }
}
