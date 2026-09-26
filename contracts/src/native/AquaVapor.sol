// SPDX-License-Identifier: LicenseRef-Degensoft-Aqua-Source-1.1
pragma solidity 0.8.30;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Balance, BalanceLib} from "aqua/libs/Balance.sol";

/// @title Aqua shared liquidity with native ERC-1155 asset identities
/// @notice Fork of Aqua.sol at ef24220ed9647555727b06867bf509cd6959d84b.
/// @dev Aqua — © Degensoft Ltd 2025. Modified 2026-09-26: typed asset keys,
/// batches, complete-list docking and callback protection. This is a separate deployment.
contract AquaVapor is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using BalanceLib for Balance;

    enum Kind {
        ERC20,
        ERC1155
    }

    struct Asset {
        Kind kind;
        address token;
        uint256 id;
    }

    uint8 private constant DOCKED = 0xff;
    mapping(address => mapping(address => mapping(bytes32 => mapping(bytes32 => Balance)))) private balances;
    mapping(address => mapping(address => mapping(bytes32 => bytes32))) private manifests;

    error InvalidAssets();
    error InactiveStrategy();
    error ImmutableStrategy();

    event Shipped(address indexed maker, address indexed app, bytes32 indexed strategyHash, bytes strategy);
    event Docked(address indexed maker, address indexed app, bytes32 indexed strategyHash);
    event Moved(
        address indexed maker,
        address indexed app,
        bytes32 indexed strategyHash,
        bytes32 asset,
        uint256 amount,
        address counterparty,
        bool incoming
    );

    /// @notice ERC-20 identities require id zero; ERC-1155 ID zero is a distinct asset.
    function assetKey(Asset memory asset) public pure returns (bytes32) {
        require(asset.token != address(0) && (asset.kind != Kind.ERC20 || asset.id == 0), InvalidAssets());
        return keccak256(abi.encode(asset));
    }

    function rawBalances(address maker, address app, bytes32 strategyHash, Asset memory asset)
        public
        view
        returns (uint248 amount, uint8 count)
    {
        return balances[maker][app][strategyHash][assetKey(asset)].load();
    }

    /// @notice Allocate virtual balances without moving assets. Repeated assets are forbidden.
    /// @dev Strict (kind, token, id) ordering makes duplicate detection linear and manifests canonical.
    function ship(address app, bytes calldata strategy, Asset[] calldata assets, uint256[] calldata amounts)
        external
        nonReentrant
        returns (bytes32 strategyHash)
    {
        _validate(assets, amounts);
        require(app != address(0) && assets.length < DOCKED, InvalidAssets());
        strategyHash = keccak256(strategy);
        require(manifests[msg.sender][app][strategyHash] == bytes32(0), ImmutableStrategy());
        manifests[msg.sender][app][strategyHash] = keccak256(abi.encode(assets));
        uint8 count = uint8(assets.length);
        for (uint256 i; i < assets.length; ++i) {
            balances[msg.sender][app][strategyHash][assetKey(assets[i])].store(amounts[i].toUint248(), count);
        }
        emit Shipped(msg.sender, app, strategyHash, strategy);
    }

    /// @notice Revoke the complete registered asset list; docking cannot be reversed by re-shipping.
    function dock(address app, bytes32 strategyHash, Asset[] calldata assets) external nonReentrant {
        require(keccak256(abi.encode(assets)) == manifests[msg.sender][app][strategyHash], InvalidAssets());
        for (uint256 i; i < assets.length; ++i) {
            balances[msg.sender][app][strategyHash][assetKey(assets[i])].store(0, DOCKED);
        }
        emit Docked(msg.sender, app, strategyHash);
    }

    /// @notice The registered app debits its own strategy and transfers directly from the maker.
    /// @dev All ledger effects precede receiver callbacks. A failed transfer rolls back the entire batch.
    function pull(address maker, bytes32 strategyHash, Asset[] calldata assets, uint256[] calldata amounts, address to)
        external
        nonReentrant
    {
        _validate(assets, amounts);
        for (uint256 i; i < assets.length; ++i) {
            Balance storage b = balances[maker][msg.sender][strategyHash][assetKey(assets[i])];
            (uint248 amount, uint8 count) = b.load();
            require(count != 0 && count != DOCKED, InactiveStrategy());
            b.store(amount - amounts[i].toUint248(), count);
            emit Moved(maker, msg.sender, strategyHash, assetKey(assets[i]), amounts[i], to, false);
        }
        _transfer(maker, to, assets, amounts);
    }

    /// @notice Fund an active strategy by transferring assets from the caller to its maker.
    function push(address maker, address app, bytes32 strategyHash, Asset[] calldata assets, uint256[] calldata amounts)
        external
        nonReentrant
    {
        _validate(assets, amounts);
        for (uint256 i; i < assets.length; ++i) {
            Balance storage b = balances[maker][app][strategyHash][assetKey(assets[i])];
            (uint248 amount, uint8 count) = b.load();
            require(count != 0 && count != DOCKED, InactiveStrategy());
            b.store(amount + amounts[i].toUint248(), count);
            emit Moved(maker, app, strategyHash, assetKey(assets[i]), amounts[i], msg.sender, true);
        }
        _transfer(msg.sender, maker, assets, amounts);
    }

    function _validate(Asset[] calldata assets, uint256[] calldata amounts) private pure {
        require(assets.length > 0 && assets.length == amounts.length, InvalidAssets());
        for (uint256 i; i < assets.length; ++i) {
            assetKey(assets[i]);
            if (i == 0) continue;
            Asset calldata a = assets[i - 1];
            Asset calldata b = assets[i];
            require(
                uint8(a.kind) < uint8(b.kind)
                    || (a.kind == b.kind && (a.token < b.token || (a.token == b.token && a.id < b.id))),
                InvalidAssets()
            );
        }
    }

    function _transfer(address from, address to, Asset[] calldata assets, uint256[] calldata amounts) private {
        // A single ERC-1155 collection uses its native batch transfer (one receiver callback).
        if (assets[0].kind == Kind.ERC1155 && assets[assets.length - 1].token == assets[0].token) {
            uint256[] memory ids = new uint256[](assets.length);
            for (uint256 i; i < assets.length; ++i) {
                ids[i] = assets[i].id;
            }
            IERC1155(assets[0].token).safeBatchTransferFrom(from, to, ids, amounts, "");
        } else {
            for (uint256 i; i < assets.length; ++i) {
                Asset calldata a = assets[i];
                if (a.kind == Kind.ERC20) IERC20(a.token).safeTransferFrom(from, to, amounts[i]);
                else IERC1155(a.token).safeTransferFrom(from, to, a.id, amounts[i], "");
            }
        }
    }
}
