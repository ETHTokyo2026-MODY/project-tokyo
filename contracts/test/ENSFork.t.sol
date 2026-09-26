// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RentalInventory} from "../src/RentalInventory.sol";
import {RentalPoolResolver} from "../src/RentalPoolResolver.sol";

interface IENSv2Registrar {
    function isAvailable(string calldata label) external view returns (bool);
    function getRegisterPrice(string calldata label, uint64 duration, address token)
        external
        view
        returns (uint256 base, uint256 premium);
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external view returns (bytes32);
    function commit(bytes32 commitment) external;
    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256);
}

interface IENSv2Universal {
    function ROOT_REGISTRY() external view returns (address);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

interface IERC20Approval {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract ENSForkTest is Test {
    address internal constant UNIVERSAL = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address internal constant ROOT = 0x9703DBD26dAB89504490994138cF2c575251a9cE;
    address internal constant REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address internal constant INVENTORY = 0x3EC8E7D506fD74a25a445e234B1EafcF67CBb5EB;
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant SIGNER = 0x73e27831C388e3763FcA45c09d7B7Aad14663Bef;
    bytes32 internal constant POOL = keccak256("demo room");
    string internal constant PARENT = "rental-fork-73e27831";
    uint64 internal constant DURATION = 365 days;

    function testOfficialSepoliaENSv2ResolvesInventoryPool() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 11155111);
        assertEq(IENSv2Universal(UNIVERSAL).ROOT_REGISTRY(), ROOT);
        (address supplier, uint32 start, uint32 end, uint32 capacity) = RentalInventory(INVENTORY).pools(POOL);
        assertTrue(supplier != address(0) && start < end && capacity > 0);
        assertTrue(IENSv2Registrar(REGISTRAR).isAvailable(PARENT));

        bytes memory parentDns = bytes.concat(bytes1(uint8(bytes(PARENT).length)), bytes(PARENT), hex"0365746800");
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        bytes32 parentNode = keccak256(abi.encodePacked(ethNode, keccak256(bytes(PARENT))));
        vm.deal(SIGNER, 1 ether);
        vm.startPrank(SIGNER);
        RentalPoolResolver resolver =
            new RentalPoolResolver(RentalInventory(INVENTORY), parentNode, keccak256(parentDns));
        resolver.setPool("demo-room", POOL);
        (uint256 base, uint256 premium) = IENSv2Registrar(REGISTRAR).getRegisterPrice(PARENT, DURATION, USDC);
        IERC20Approval(USDC).approve(REGISTRAR, base + premium);
        bytes32 secret = keccak256("fork-only ENS registration secret");
        bytes32 commitment = IENSv2Registrar(REGISTRAR).makeCommitment(
            PARENT, SIGNER, secret, address(0), address(resolver), DURATION, bytes32(0)
        );
        IENSv2Registrar(REGISTRAR).commit(commitment);
        vm.stopPrank();
        vm.warp(block.timestamp + 61);
        vm.prank(SIGNER);
        IENSv2Registrar(REGISTRAR).register(
            PARENT, SIGNER, secret, address(0), address(resolver), DURATION, USDC, bytes32(0)
        );

        bytes memory label = bytes("demo-room");
        bytes memory name = bytes.concat(bytes1(uint8(label.length)), label, parentDns);
        bytes32 node = keccak256(abi.encodePacked(parentNode, keccak256(label)));
        (bytes memory value, address usedResolver) =
            IENSv2Universal(UNIVERSAL).resolve(name, abi.encodeWithSignature("pool(bytes32)", node));
        assertEq(usedResolver, address(resolver));
        assertEq(abi.decode(value, (bytes32)), POOL);
    }
}
