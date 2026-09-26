// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Live ENSv2 Sepolia addresses checked against the deployed bytecode.
library EnsSepolia {
    address internal constant UNIVERSAL_RESOLVER = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address internal constant UNIVERSAL_RESOLVER_V2 = 0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3;
    address internal constant ROOT_REGISTRY = 0x9703DBD26dAB89504490994138cF2c575251a9cE;
    address internal constant ETH_REGISTRY = 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E;
    address internal constant ETH_REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address internal constant VERIFIABLE_FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;
    address internal constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address internal constant MOCK_USDC = 0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant PROJECTTOKYO_OWNER = 0x92f6055f1a631E3C5fd3100920c63d8654729847;
    address internal constant PROJECTTOKYO_RESOLVER = 0x9b54937F615458D93bA4BDc1E881109301DAaBd4;
    uint256 internal constant PROJECTTOKYO_TOKEN_ID =
        1539694647528357085717297762044227324969906285209016262484180021492479688704;
    string internal constant PARENT_LABEL = "projecttokyo";
    string internal constant PARENT_NAME = "projecttokyo.eth";
}
