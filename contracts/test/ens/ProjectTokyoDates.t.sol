// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProjectTokyoDates} from "../../src/ens/ProjectTokyoDates.sol";

contract ProjectTokyoDatesTest is Test {
    function testUnixEpochAndKnownDates() public pure {
        assertEq(ProjectTokyoDates.dateLabel(0), "1970-01-01");
        assertEq(ProjectTokyoDates.dateLabel(1), "1970-01-02");
        assertEq(ProjectTokyoDates.parseDateLabel("1970-01-01"), 0);
        assertEq(ProjectTokyoDates.parseDateLabel("1970-01-02"), 1);
        assertEq(ProjectTokyoDates.dateLabel(20454), "2026-01-01");
        assertEq(ProjectTokyoDates.parseDateLabel("2026-01-01"), 20454);
        assertEq(ProjectTokyoDates.dateLabel(20718), "2026-09-22");
        assertEq(ProjectTokyoDates.parseDateLabel("2026-09-22"), 20718);
        assertEq(ProjectTokyoDates.dateLabel(20727), "2026-10-01");
        assertEq(ProjectTokyoDates.parseDateLabel("2026-02-28"), 20512);
        assertEq(ProjectTokyoDates.parseDateLabel(bytes(ProjectTokyoDates.dateLabel(21254))), 21254);
    }

    function testRejectsMalformedAndImpossibleDates() public {
        _assertInvalid("2026/10/01");
        _assertInvalid("2026-13-01");
        _assertInvalid("2026-02-29");
        _assertInvalid("2026-10-1");
        _assertInvalid("");
    }

    function _assertInvalid(string memory label) internal {
        vm.expectRevert(ProjectTokyoDates.InvalidDate.selector);
        this.parse(label);
    }

    function parse(string memory label) external pure returns (uint32) {
        return ProjectTokyoDates.parseDateLabel(bytes(label));
    }

    function testTokyoDayUsesUtcPlusNine() public pure {
        assertEq(ProjectTokyoDates.tokyoDay(0), 0);
        assertEq(ProjectTokyoDates.tokyoDay(15 hours), 1);
        assertEq(ProjectTokyoDates.tokyoDay(1_800_000_000), uint32((uint256(1_800_000_000) + 9 hours) / 1 days));
    }

    function testFuzzRoundTrip(uint32 day) public pure {
        day = uint32(bound(day, 0, 365 * 200));
        string memory label = ProjectTokyoDates.dateLabel(day);
        assertEq(ProjectTokyoDates.parseDateLabel(bytes(label)), day);
    }
}
