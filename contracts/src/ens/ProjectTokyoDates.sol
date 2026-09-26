// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice UTC-day index helpers. Tokyo calendar day is (timestamp + 9 hours) / 1 days.
library ProjectTokyoDates {
    error InvalidDate();

    function tokyoDay(uint256 timestamp) internal pure returns (uint32) {
        return uint32((timestamp + 9 hours) / 1 days);
    }

    function dateLabel(uint32 day) internal pure returns (string memory) {
        (uint256 year, uint256 month, uint256 dom) = civilFromDays(int256(uint256(day)));
        return string.concat(_pad4(year), "-", _pad2(month), "-", _pad2(dom));
    }

    function parseDateLabel(bytes memory label) internal pure returns (uint32) {
        if (label.length != 10 || label[4] != "-" || label[7] != "-") revert InvalidDate();
        uint256 year = _digits(label, 0, 4);
        uint256 month = _digits(label, 5, 2);
        uint256 dom = _digits(label, 8, 2);
        if (month == 0 || month > 12 || dom == 0 || dom > 31) revert InvalidDate();
        int256 z = daysFromCivil(int256(year), int256(month), int256(dom));
        if (z < 0 || z > int256(uint256(type(uint32).max))) revert InvalidDate();
        uint32 day = uint32(uint256(z));
        if (keccak256(bytes(dateLabel(day))) != keccak256(label)) revert InvalidDate();
        return day;
    }

    /// @dev Howard Hinnant civil_from_days; z is days since 1970-01-01.
    function civilFromDays(int256 z) internal pure returns (uint256 year, uint256 month, uint256 day) {
        z += 719468;
        int256 era = (z >= 0 ? z : z - 146096) / 146097;
        int256 doe = z - era * 146097;
        int256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        int256 y = yoe + era * 400;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        int256 mp = (5 * doy + 2) / 153;
        int256 d = doy - (153 * mp + 2) / 5 + 1;
        int256 m = mp < 10 ? mp + 3 : mp - 9;
        y += (m <= 2 ? int256(1) : int256(0));
        if (y < 1970) revert InvalidDate();
        year = uint256(y);
        month = uint256(m);
        day = uint256(d);
    }

    function daysFromCivil(int256 y, int256 m, int256 d) internal pure returns (int256) {
        y -= m <= 2 ? int256(1) : int256(0);
        int256 era = (y >= 0 ? y : y - 399) / 400;
        int256 yoe = y - era * 400;
        int256 doy = (153 * (m + (m > 2 ? int256(-3) : int256(9))) + 2) / 5 + d - 1;
        int256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }

    function _digits(bytes memory s, uint256 start, uint256 n) private pure returns (uint256 v) {
        for (uint256 i; i < n; ++i) {
            uint8 c = uint8(s[start + i]);
            if (c < 48 || c > 57) revert InvalidDate();
            v = v * 10 + (c - 48);
        }
    }

    function _pad2(uint256 n) private pure returns (string memory) {
        bytes memory s = new bytes(2);
        s[0] = bytes1(uint8(48 + n / 10));
        s[1] = bytes1(uint8(48 + n % 10));
        return string(s);
    }

    function _pad4(uint256 n) private pure returns (string memory) {
        bytes memory s = new bytes(4);
        s[0] = bytes1(uint8(48 + n / 1000));
        s[1] = bytes1(uint8(48 + (n / 100) % 10));
        s[2] = bytes1(uint8(48 + (n / 10) % 10));
        s[3] = bytes1(uint8(48 + n % 10));
        return string(s);
    }
}
