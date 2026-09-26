// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IProjectTokyoInventory, IProjectTokyoNames} from "./ens/IEnsV2.sol";
import {ProjectTokyoDates} from "./ens/ProjectTokyoDates.sol";

/// @notice One ERC-1155 day token per ProjectTokyo asset and calendar day. Tokens are never burned.
contract ProjectTokyoInventory is ERC1155, IProjectTokyoInventory {
    struct AssetInfo {
        address host;
        uint32 startDay;
        uint32 endDay;
        string label;
        string kind;
        string title;
        string location;
    }

    struct DayInfo {
        bool minted;
        bool booked;
        bool listed;
        uint128 listedPrice;
        uint128 sellingPrice;
    }

    uint32 public constant HORIZON = 365;
    uint32 public constant MAX_DAYS_PER_TX = 80;

    address public immutable administrator;
    IProjectTokyoNames public names;

    mapping(bytes32 => AssetInfo) private _assets;
    mapping(bytes32 => bool) public isAsset;
    mapping(uint256 => DayInfo) public dayInfo;
    mapping(uint256 => address) public holderOf;
    mapping(uint256 => bytes32) public poolOf;
    mapping(uint256 => uint32) public dayOf;
    mapping(address => bool) public bookingRelayers;

    error InvalidAsset();
    error InvalidDay();
    error Unauthorized();
    error NeverBurn();

    event NamesSet(address indexed names);
    event AssetCreated(bytes32 indexed pool, string label, address indexed host, uint32 startDay, uint32 endDay);
    event DayUpdated(uint256 indexed id, bool booked, bool listed, uint128 listedPrice, uint128 sellingPrice);
    event BookingRelayerChanged(address indexed relayer, bool allowed);

    constructor() ERC1155("") {
        administrator = msg.sender;
    }

    function setNames(IProjectTokyoNames n) external {
        require(msg.sender == administrator && address(names) == address(0) && address(n) != address(0), Unauthorized());
        names = n;
        emit NamesSet(address(n));
    }

    function setBookingRelayer(address relayer, bool allowed) external {
        require(msg.sender == administrator && relayer != address(0), Unauthorized());
        bookingRelayers[relayer] = allowed;
        emit BookingRelayerChanged(relayer, allowed);
    }

    function tokenId(bytes32 pool, uint32 day) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(pool, day, bytes32(0))));
    }

    function assetInfo(bytes32 pool) external view returns (AssetInfo memory) {
        require(isAsset[pool], InvalidAsset());
        return _assets[pool];
    }

    function assetHost(bytes32 pool) external view returns (address) {
        return _assets[pool].host;
    }

    function currentDay() public view returns (uint32) {
        return ProjectTokyoDates.tokyoDay(block.timestamp);
    }

    function createAsset(
        string calldata label,
        address host,
        string calldata kind,
        string calldata title,
        string calldata location
    ) external returns (bytes32 pool, uint32 startDay, uint32 endDay) {
        require(msg.sender == administrator, Unauthorized());
        require(host != address(0) && bytes(label).length != 0, InvalidAsset());
        pool = keccak256(bytes(label));
        require(!isAsset[pool], InvalidAsset());
        startDay = currentDay();
        endDay = startDay + HORIZON;
        isAsset[pool] = true;
        _assets[pool] = AssetInfo(host, startDay, endDay, label, kind, title, location);
        if (address(names) != address(0)) names.registerAsset(label, pool, host);
        emit AssetCreated(pool, label, host, startDay, endDay);
    }

    function mintDays(bytes32 pool, uint32 start, uint32 end, uint128 listedPrice, uint128 sellingPrice) external {
        AssetInfo memory a = _assets[pool];
        require(isAsset[pool] && (msg.sender == a.host || msg.sender == administrator), Unauthorized());
        require(start >= a.startDay && end <= a.endDay && start < end && end - start <= MAX_DAYS_PER_TX, InvalidDay());
        uint256 n = end - start;
        uint256[] memory ids = new uint256[](n);
        uint256[] memory amounts = new uint256[](n);
        for (uint32 d = start; d < end; ++d) {
            uint256 id = tokenId(pool, d);
            require(!dayInfo[id].minted, InvalidDay());
            dayInfo[id] = DayInfo(true, false, true, listedPrice, sellingPrice);
            poolOf[id] = pool;
            dayOf[id] = d;
            ids[d - start] = id;
            amounts[d - start] = 1;
            emit DayUpdated(id, false, true, listedPrice, sellingPrice);
        }
        _mintBatch(a.host, ids, amounts, "");
        if (address(names) != address(0)) names.registerDays(pool, start, end);
    }

    function setListing(uint256 id, bool listed, uint128 sellingPrice) external {
        _requireHolder(id);
        DayInfo storage info = dayInfo[id];
        info.listed = listed;
        info.sellingPrice = sellingPrice;
        emit DayUpdated(id, info.booked, listed, info.listedPrice, sellingPrice);
    }

    function setListedPrice(uint256 id, uint128 listedPrice) external {
        _requireHolder(id);
        DayInfo storage info = dayInfo[id];
        require(!info.booked, InvalidDay());
        info.listedPrice = listedPrice;
        emit DayUpdated(id, false, info.listed, listedPrice, info.sellingPrice);
    }

    function setBooked(uint256 id, bool booked) external {
        require(dayInfo[id].minted, InvalidDay());
        address host = _assets[poolOf[id]].host;
        require(msg.sender == host || bookingRelayers[msg.sender] || msg.sender == administrator, Unauthorized());
        DayInfo storage info = dayInfo[id];
        info.booked = booked;
        emit DayUpdated(id, booked, info.listed, info.listedPrice, info.sellingPrice);
    }

    function getDays(uint256[] calldata ids) external view returns (DayInfo[] memory infos, address[] memory holders) {
        infos = new DayInfo[](ids.length);
        holders = new address[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            infos[i] = dayInfo[ids[i]];
            holders[i] = holderOf[ids[i]];
        }
    }

    function _requireHolder(uint256 id) private view {
        require(dayInfo[id].minted && msg.sender == holderOf[id], Unauthorized());
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        for (uint256 i; i < ids.length; ++i) {
            if (!dayInfo[ids[i]].minted) continue;
            if (to == address(0)) revert NeverBurn();
            require(values[i] == 1, InvalidDay());
        }
        super._update(from, to, ids, values);
        for (uint256 i; i < ids.length; ++i) {
            if (!dayInfo[ids[i]].minted) continue;
            holderOf[ids[i]] = to;
        }
    }
}
