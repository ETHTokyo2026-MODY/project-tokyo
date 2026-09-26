// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "./Fixture.sol";
import {RentalPoolResolver} from "../src/RentalPoolResolver.sol";
import {RentalSettlement} from "../src/RentalSettlement.sol";

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

contract ENSForkTest is Fixture {
    address internal constant UNIVERSAL = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address internal constant ROOT = 0x9703DBD26dAB89504490994138cF2c575251a9cE;
    address internal constant REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant SIGNER = 0x73e27831C388e3763FcA45c09d7B7Aad14663Bef;
    bytes32 internal constant OTHER_POOL = keccak256("another room");
    string internal constant PARENT = "rental-fork-73e27831";
    uint64 internal constant DURATION = 365 days;
    uint256 internal constant PROOF_BLOCK = 11_786_600;

    function setUp() public override {}

    function testOfficialSepoliaENSv2ResolvesInventoryPool() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, PROOF_BLOCK);
        super.setUp();
        assertEq(block.chainid, 11155111);
        assertEq(IENSv2Universal(UNIVERSAL).ROOT_REGISTRY(), ROOT);
        assertTrue(IENSv2Registrar(REGISTRAR).isAvailable(PARENT));
        deal(USDC, SIGNER, 10_000_000);
        inventory.createPool(OTHER_POOL, seller, day, day + 31, 1);

        bytes memory parentDns = bytes.concat(bytes1(uint8(bytes(PARENT).length)), bytes(PARENT), hex"0365746800");
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        bytes32 parentNode = keccak256(abi.encodePacked(ethNode, keccak256(bytes(PARENT))));
        vm.deal(SIGNER, 1 ether);
        vm.startPrank(SIGNER);
        RentalPoolResolver resolver = new RentalPoolResolver(inventory, parentNode, keccak256(parentDns));
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

        // The signed order uses the exact value returned by the official resolver.
        bytes32 resolvedPool = abi.decode(value, (bytes32));
        bytes memory program = fixedProgram(1e6);
        (RentalSettlement.Order memory bid, RentalSettlement.Order memory ask) = _orders(day, day + 1, 91, program);
        bid.pool = resolvedPool;
        ask.pool = resolvedPool;
        bytes memory bidSig = _sig(bid, BUY_KEY);
        bytes memory askSig = _sig(ask, SELL_KEY);
        vm.prank(SIGNER);
        resolver.setPool("demo-room", OTHER_POOL);
        (value, usedResolver) = IENSv2Universal(UNIVERSAL).resolve(name, abi.encodeWithSignature("pool(bytes32)", node));
        assertEq(usedResolver, address(resolver));
        assertEq(abi.decode(value, (bytes32)), OTHER_POOL);
        router.settle(bid, bidSig, ask, askSig, mandate, program);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(POOL, day, TERMS)), 1);
        assertEq(inventory.balanceOf(buyer, inventory.tokenId(OTHER_POOL, day, TERMS)), 0);
    }
}
