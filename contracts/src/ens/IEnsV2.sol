// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Live ENSv2 Sepolia selectors (not contracts-v2 HEAD).
interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IUserRegistryInit {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    function initialize(Grant[] calldata grants) external;
}

interface IPermissionedResolverInit {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    function initialize(Grant[] calldata grants, bytes[] calldata records) external;
}

interface IPermissionedRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function setParent(address parent, string calldata label) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IPermissionedResolver {
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata value) external;
    function multicall(bytes[] calldata data) external returns (bytes[] memory);
}

interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface IRentalAssetView {
    function host() external view returns (address);
    function startDay() external view returns (uint32);
    function endDayExclusive() external view returns (uint32);
    function tokenAddress(uint32 day) external view returns (address);
    function metadataURI() external view returns (string memory);
}

interface IRentalAssetFactoryView {
    function isAsset(address asset) external view returns (bool);
}

interface IProjectTokyoNames {
    function registerAsset(string calldata label, address rentalAsset)
        external
        returns (address dayRegistry, address resolver);

    function registerDays(string calldata label, uint32 startDay, uint32 endDay) external;

    function setAssetTexts(string calldata label, string[] calldata keys, string[] calldata values) external;
}

library EnsRoles {
    uint256 internal constant REGISTRAR = 1 << 0;
    uint256 internal constant SET_PARENT = 1 << 8;
    uint256 internal constant SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant SET_RESOLVER = 1 << 24;
    uint256 internal constant REGISTRY_ROOT = REGISTRAR | SET_PARENT | SET_SUBREGISTRY | SET_RESOLVER
        | (REGISTRAR << 128) | (SET_PARENT << 128) | (SET_SUBREGISTRY << 128) | (SET_RESOLVER << 128);
    uint256 internal constant RESOLVER_ALL = 0x1111111111111111111111111111111111111111111111111111111111111111;
}
