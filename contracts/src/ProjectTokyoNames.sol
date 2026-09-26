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
    IProjectTokyoNames,
    IRentalAssetFactoryView,
    IRentalAssetView,
    IUserRegistryInit,
    IVerifiableFactory
} from "./ens/IEnsV2.sol";
import {ProjectTokyoDates} from "./ens/ProjectTokyoDates.sol";

/// @notice Registrar for projecttokyo.eth asset/day names over live RentalAsset / DayToken.
/// IERC1155Receiver is required because ENSv2 UserRegistry mints name tokens to this contract.
contract ProjectTokyoNames is IExtendedResolver, IProjectTokyoNames, IERC1155Receiver {
    bytes4 private constant ADDR_SIG = 0x3b3b57de;
    bytes4 private constant ADDR_COIN_SIG = 0xf1cb7e06;
    bytes4 private constant TEXT_SIG = 0x59d1d43c;
    bytes4 private constant MULTICALL_SIG = 0xac9650d8;

    uint32 public constant MAX_DAYS_PER_TX = 80;

    address public immutable administrator;
    IVerifiableFactory public immutable ensFactory;
    address public immutable userRegistryImpl;
    address public immutable permissionedResolverImpl;
    IPermissionedRegistry public immutable ethRegistry;
    IPermissionedRegistry public immutable assetRegistry;
    IRentalAssetFactoryView public immutable rentalFactory;
    bytes32 public immutable parentNode;
    bytes public parentDns;
    string public parentLabel;

    mapping(bytes32 => address) public assetOfLabel;
    mapping(address => bytes32) public labelHashOfAsset;
    mapping(bytes32 => IPermissionedRegistry) public dayRegistryOf;
    mapping(bytes32 => address) public assetResolverOf;
    mapping(bytes32 => address) public assetHostOf;

    error Unauthorized();
    error InvalidName();
    error UnknownName();

    event AssetRegistryCreated(address indexed registry);
    event AssetRegistered(
        string label, address indexed rentalAsset, address indexed host, address dayRegistry, address resolver
    );
    event DaysRegistered(string label, address indexed rentalAsset, uint32 startDay, uint32 endDay);

    constructor(
        IVerifiableFactory ensFactory_,
        address userRegistryImpl_,
        address permissionedResolverImpl_,
        IPermissionedRegistry ethRegistry_,
        string memory parentLabel_,
        address rentalFactory_
    ) {
        require(bytes(parentLabel_).length != 0, InvalidName());
        administrator = msg.sender;
        ensFactory = ensFactory_;
        userRegistryImpl = userRegistryImpl_;
        permissionedResolverImpl = permissionedResolverImpl_;
        ethRegistry = ethRegistry_;
        rentalFactory = IRentalAssetFactoryView(rentalFactory_);
        parentLabel = parentLabel_;
        parentDns = _dnsEncode(string.concat(parentLabel_, ".eth"));
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        parentNode = keccak256(abi.encodePacked(ethNode, keccak256(bytes(parentLabel_))));
        if (address(ensFactory_) != address(0)) {
            assetRegistry = IPermissionedRegistry(_deployRegistry(parentNode));
            emit AssetRegistryCreated(address(assetRegistry));
        }
    }

    function linkParent() external {
        require(msg.sender == administrator, Unauthorized());
        assetRegistry.setParent(address(ethRegistry), parentLabel);
    }

    function assetOf(string calldata label) external view returns (address) {
        return assetOfLabel[_labelHash(bytes(label))];
    }

    function registerAsset(string calldata label, address rentalAsset)
        external
        returns (address dayRegistry, address resolver)
    {
        require(rentalAsset != address(0), InvalidName());
        require(address(rentalFactory) == address(0) || rentalFactory.isAsset(rentalAsset), InvalidName());
        address host = IRentalAssetView(rentalAsset).host();
        require(msg.sender == host || msg.sender == administrator, Unauthorized());
        bytes32 labelHash = _labelHash(bytes(label));
        require(assetOfLabel[labelHash] == address(0) && labelHashOfAsset[rentalAsset] == bytes32(0), InvalidName());
        bytes32 assetNode = keccak256(abi.encodePacked(parentNode, labelHash));
        dayRegistry = _deployRegistry(assetNode);
        IPermissionedRegistry(dayRegistry).setParent(address(assetRegistry), label);
        resolver = _deployAssetResolver(host, assetNode);
        bytes memory name = _dnsEncode(string.concat(label, ".", parentLabel, ".eth"));
        IPermissionedResolver(resolver).setAddress(name, 60, abi.encodePacked(rentalAsset));
        assetRegistry.register(label, host, dayRegistry, resolver, 0, type(uint64).max);
        assetOfLabel[labelHash] = rentalAsset;
        labelHashOfAsset[rentalAsset] = labelHash;
        dayRegistryOf[labelHash] = IPermissionedRegistry(dayRegistry);
        assetResolverOf[labelHash] = resolver;
        assetHostOf[labelHash] = host;
        emit AssetRegistered(label, rentalAsset, host, dayRegistry, resolver);
    }

    function registerDays(string calldata label, uint32 startDay, uint32 endDay) external {
        bytes32 labelHash = _labelHash(bytes(label));
        address rentalAsset = assetOfLabel[labelHash];
        require(rentalAsset != address(0) && startDay < endDay && endDay - startDay <= MAX_DAYS_PER_TX, InvalidName());
        require(msg.sender == assetHostOf[labelHash] || msg.sender == administrator, Unauthorized());
        IRentalAssetView asset = IRentalAssetView(rentalAsset);
        require(startDay >= asset.startDay() && endDay <= asset.endDayExclusive(), InvalidName());
        IPermissionedRegistry dayRegistry = dayRegistryOf[labelHash];
        for (uint32 d = startDay; d < endDay; ++d) {
            dayRegistry.register(
                ProjectTokyoDates.dateLabel(d), address(this), address(0), address(this), 0, type(uint64).max
            );
        }
        emit DaysRegistered(label, rentalAsset, startDay, endDay);
    }

    function setAssetTexts(string calldata label, string[] calldata keys, string[] calldata values) external {
        bytes32 labelHash = _labelHash(bytes(label));
        require(assetOfLabel[labelHash] != address(0) && keys.length == values.length, InvalidName());
        require(msg.sender == assetHostOf[labelHash] || msg.sender == administrator, Unauthorized());
        bytes memory name = _dnsEncode(string.concat(label, ".", parentLabel, ".eth"));
        IPermissionedResolver resolver = IPermissionedResolver(assetResolverOf[labelHash]);
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
        (address rentalAsset, uint32 day) = _dayFromName(name);
        address token = IRentalAssetView(rentalAsset).tokenAddress(day);
        if (sel == ADDR_SIG) return abi.encode(token);
        if (sel == ADDR_COIN_SIG) {
            (, uint256 coin) = abi.decode(data[4:], (bytes32, uint256));
            require(coin == 60, InvalidName());
            return abi.encode(abi.encodePacked(token));
        }
        if (sel == TEXT_SIG) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            bytes32 keyHash = keccak256(bytes(key));
            if (keyHash == keccak256("token") || keyHash == keccak256("avatar")) {
                return abi.encode(_caip19(token));
            }
            if (keyHash == keccak256("asset")) return abi.encode(_toHex(rentalAsset));
            revert InvalidName();
        }
        revert InvalidName();
    }

    function _dayFromName(bytes calldata name) private view returns (address rentalAsset, uint32 day) {
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
        rentalAsset = assetOfLabel[labelHash];
        require(rentalAsset != address(0), UnknownName());
        IRentalAssetView asset = IRentalAssetView(rentalAsset);
        require(day >= asset.startDay() && day < asset.endDayExclusive(), InvalidName());
    }

    function _deployRegistry(bytes32 node) private returns (address registry) {
        IUserRegistryInit.Grant[] memory grants = new IUserRegistryInit.Grant[](1);
        grants[0] = IUserRegistryInit.Grant(address(this), EnsRoles.REGISTRY_ROOT);
        registry = ensFactory.deployProxy(
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
        resolver = ensFactory.deployProxy(
            permissionedResolverImpl,
            uint256(keccak256(abi.encode(keccak256("PermissionedResolver"), node, uint256(1)))),
            abi.encodeCall(IPermissionedResolverInit.initialize, (grants, new bytes[](0)))
        );
    }

    function _caip19(address token) private view returns (string memory) {
        return string.concat("eip155:", _uToString(block.chainid), "/erc20:", _toHex(token));
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
