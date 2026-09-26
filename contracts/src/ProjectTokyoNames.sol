// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {
    EnsRoles,
    IExtendedResolver,
    IPermissionedRegistry,
    IPermissionedResolver,
    IPermissionedResolverInit,
    IProjectTokyoInventory,
    IProjectTokyoNames,
    IUserRegistryInit,
    IVerifiableFactory
} from "./ens/IEnsV2.sol";
import {ProjectTokyoDates} from "./ens/ProjectTokyoDates.sol";

/// @notice Registrar for projecttokyo.eth asset/day names and computed day resolver.
contract ProjectTokyoNames is IExtendedResolver, IProjectTokyoNames, IERC1155Receiver {
    bytes4 private constant ADDR_SIG = 0x3b3b57de;
    bytes4 private constant ADDR_COIN_SIG = 0xf1cb7e06;
    bytes4 private constant TEXT_SIG = 0x59d1d43c;
    bytes4 private constant MULTICALL_SIG = 0xac9650d8;

    address public immutable administrator;
    IProjectTokyoInventory public immutable inventory;
    IVerifiableFactory public immutable factory;
    address public immutable userRegistryImpl;
    address public immutable permissionedResolverImpl;
    IPermissionedRegistry public immutable ethRegistry;
    IPermissionedRegistry public immutable assetRegistry;
    bytes32 public immutable parentNode;
    bytes public parentDns;
    string public parentLabel;

    mapping(bytes32 => bytes32) public poolOfLabel;
    mapping(bytes32 => IPermissionedRegistry) public dayRegistryOf;
    mapping(bytes32 => address) public assetResolverOf;
    mapping(bytes32 => address) public assetHostOf;

    error Unauthorized();
    error InvalidName();
    error UnknownName();

    event AssetRegistryCreated(address indexed registry);
    event AssetRegistered(
        string label, bytes32 indexed pool, address indexed host, address dayRegistry, address resolver
    );
    event DaysRegistered(bytes32 indexed pool, uint32 startDay, uint32 endDay);

    constructor(
        IProjectTokyoInventory inventory_,
        IVerifiableFactory factory_,
        address userRegistryImpl_,
        address permissionedResolverImpl_,
        IPermissionedRegistry ethRegistry_,
        string memory parentLabel_
    ) {
        require(address(inventory_) != address(0) && bytes(parentLabel_).length != 0, InvalidName());
        administrator = msg.sender;
        inventory = inventory_;
        factory = factory_;
        userRegistryImpl = userRegistryImpl_;
        permissionedResolverImpl = permissionedResolverImpl_;
        ethRegistry = ethRegistry_;
        parentLabel = parentLabel_;
        parentDns = _dnsEncode(string.concat(parentLabel_, ".eth"));
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        parentNode = keccak256(abi.encodePacked(ethNode, keccak256(bytes(parentLabel_))));
        if (address(factory_) != address(0)) {
            assetRegistry = IPermissionedRegistry(_deployRegistry(parentNode));
            emit AssetRegistryCreated(address(assetRegistry));
        }
    }

    function linkParent() external {
        require(msg.sender == administrator, Unauthorized());
        assetRegistry.setParent(address(ethRegistry), parentLabel);
    }

    function registerAsset(string calldata label, bytes32 pool, address host)
        external
        returns (address dayRegistry, address resolver)
    {
        require(msg.sender == address(inventory) || msg.sender == administrator, Unauthorized());
        require(host != address(0) && pool == keccak256(bytes(label)), InvalidName());
        bytes32 labelHash = _labelHash(bytes(label));
        require(poolOfLabel[labelHash] == bytes32(0), InvalidName());
        bytes32 assetNode = keccak256(abi.encodePacked(parentNode, labelHash));
        dayRegistry = _deployRegistry(assetNode);
        IPermissionedRegistry(dayRegistry).setParent(address(assetRegistry), label);
        resolver = _deployAssetResolver(host, assetNode);
        assetRegistry.register(label, host, dayRegistry, resolver, 0, type(uint64).max);
        poolOfLabel[labelHash] = pool;
        dayRegistryOf[pool] = IPermissionedRegistry(dayRegistry);
        assetResolverOf[pool] = resolver;
        assetHostOf[pool] = host;
        emit AssetRegistered(label, pool, host, dayRegistry, resolver);
    }

    function registerDays(bytes32 pool, uint32 startDay, uint32 endDay) external {
        require(msg.sender == address(inventory) || msg.sender == administrator, Unauthorized());
        IPermissionedRegistry dayRegistry = dayRegistryOf[pool];
        require(address(dayRegistry) != address(0) && startDay < endDay, InvalidName());
        for (uint32 d = startDay; d < endDay; ++d) {
            dayRegistry.register(
                ProjectTokyoDates.dateLabel(d), address(this), address(0), address(this), 0, type(uint64).max
            );
        }
        emit DaysRegistered(pool, startDay, endDay);
    }

    function setAssetTexts(string calldata label, string[] calldata keys, string[] calldata values) external {
        bytes32 pool = poolOfLabel[_labelHash(bytes(label))];
        require(pool != bytes32(0) && keys.length == values.length, InvalidName());
        require(msg.sender == assetHostOf[pool] || msg.sender == administrator, Unauthorized());
        bytes memory name = _dnsEncode(string.concat(label, ".", parentLabel, ".eth"));
        IPermissionedResolver resolver = IPermissionedResolver(assetResolverOf[pool]);
        for (uint256 i; i < keys.length; ++i) {
            resolver.setText(name, keys[i], values[i]);
        }
    }

    function dateLabel(uint32 day) external pure returns (string memory) {
        return ProjectTokyoDates.dateLabel(day);
    }

    function parseDateLabel(string calldata label) external pure returns (uint32) {
        return ProjectTokyoDates.parseDateLabel(bytes(label));
    }

    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        return _resolve(name, data);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC1155Receiver).interfaceId || id == 0x9061b923;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function _resolve(bytes calldata name, bytes calldata data) private view returns (bytes memory) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == MULTICALL_SIG) {
            bytes[] memory calls = abi.decode(data[4:], (bytes[]));
            bytes[] memory out = new bytes[](calls.length);
            for (uint256 i; i < calls.length; ++i) {
                out[i] = this.resolve(name, calls[i]);
            }
            return abi.encode(out);
        }
        (,, uint256 id) = _dayFromName(name);
        (bool minted,,,,) = inventory.dayInfo(id);
        require(minted, UnknownName());
        if (sel == ADDR_SIG) return abi.encode(address(inventory));
        if (sel == ADDR_COIN_SIG) {
            (, uint256 coin) = abi.decode(data[4:], (bytes32, uint256));
            require(coin == 60, InvalidName());
            return abi.encode(abi.encodePacked(address(inventory)));
        }
        if (sel == TEXT_SIG) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            if (keccak256(bytes(key)) == keccak256("token") || keccak256(bytes(key)) == keccak256("avatar")) {
                return abi.encode(_caip19(id));
            }
            revert InvalidName();
        }
        revert InvalidName();
    }

    function _dayFromName(bytes calldata name) private view returns (bytes32 pool, uint32 day, uint256 id) {
        require(name.length > parentDns.length + 2, InvalidName());
        uint256 suffixAt = name.length - parentDns.length;
        require(keccak256(name[suffixAt:]) == keccak256(parentDns), InvalidName());
        uint256 dateLen = uint8(name[0]);
        require(dateLen > 0 && dateLen < 64 && 1 + dateLen < suffixAt, InvalidName());
        day = ProjectTokyoDates.parseDateLabel(name[1:1 + dateLen]);
        uint256 assetAt = 1 + dateLen;
        uint256 assetLen = uint8(name[assetAt]);
        require(assetLen > 0 && assetAt + 1 + assetLen == suffixAt, InvalidName());
        bytes32 labelHash = _labelHash(name[assetAt + 1:assetAt + 1 + assetLen]);
        pool = poolOfLabel[labelHash];
        require(pool != bytes32(0), UnknownName());
        id = inventory.tokenId(pool, day);
    }

    function _deployRegistry(bytes32 node) private returns (address registry) {
        IUserRegistryInit.Grant[] memory grants = new IUserRegistryInit.Grant[](1);
        grants[0] = IUserRegistryInit.Grant(address(this), EnsRoles.REGISTRY_ROOT);
        registry = factory.deployProxy(
            userRegistryImpl,
            uint256(keccak256(abi.encode(keccak256("UserRegistry"), node, uint256(0)))),
            abi.encodeCall(IUserRegistryInit.initialize, (grants))
        );
    }

    function _deployAssetResolver(address host, bytes32 node) private returns (address resolver) {
        IPermissionedResolverInit.Grant[] memory grants = new IPermissionedResolverInit.Grant[](3);
        grants[0] = IPermissionedResolverInit.Grant(host, EnsRoles.RESOLVER_ALL);
        grants[1] = IPermissionedResolverInit.Grant(address(this), EnsRoles.RESOLVER_ALL);
        grants[2] = IPermissionedResolverInit.Grant(administrator, EnsRoles.RESOLVER_ALL);
        resolver = factory.deployProxy(
            permissionedResolverImpl,
            uint256(keccak256(abi.encode(keccak256("PermissionedResolver"), node, uint256(1)))),
            abi.encodeCall(IPermissionedResolverInit.initialize, (grants, new bytes[](0)))
        );
    }

    function _caip19(uint256 id) private view returns (string memory) {
        return string.concat(
            "eip155:", _uToString(block.chainid), "/erc1155:", _toHex(address(inventory)), "/", _uToString(id)
        );
    }

    function _labelHash(bytes memory label) private pure returns (bytes32) {
        uint256 length = label.length;
        require(length > 0 && length <= 63, InvalidName());
        for (uint256 i; i < length; ++i) {
            uint8 c = uint8(label[i]);
            require(
                (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c == 45 && i > 0 && i + 1 < length), InvalidName()
            );
        }
        return keccak256(label);
    }

    function _dnsEncode(string memory name) private pure returns (bytes memory out) {
        bytes memory raw = bytes(name);
        out = new bytes(raw.length + 2);
        uint256 w = 1;
        uint256 start;
        for (uint256 i; i <= raw.length; ++i) {
            if (i == raw.length || raw[i] == ".") {
                uint256 len = i - start;
                require(len > 0 && len <= 63, InvalidName());
                out[w - 1] = bytes1(uint8(len));
                for (uint256 j; j < len; ++j) {
                    out[w + j] = raw[start + j];
                }
                w += len + 1;
                start = i + 1;
            }
        }
        out[w - 1] = 0;
        assembly {
            mstore(out, w)
        }
    }

    function _toHex(address a) private pure returns (string memory) {
        bytes20 b = bytes20(a);
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        for (uint256 i; i < 20; ++i) {
            uint8 v = uint8(b[i]);
            s[2 + 2 * i] = _hexNibble(v >> 4);
            s[3 + 2 * i] = _hexNibble(v & 0xf);
        }
        return string(s);
    }

    function _hexNibble(uint8 v) private pure returns (bytes1) {
        return bytes1(v < 10 ? uint8(48 + v) : uint8(87 + v));
    }

    function _uToString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        uint256 t = v;
        while (t != 0) {
            ++len;
            t /= 10;
        }
        bytes memory s = new bytes(len);
        while (v != 0) {
            s[--len] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(s);
    }
}
