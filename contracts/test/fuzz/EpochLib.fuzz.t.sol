// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {EpochHarness} from "../Harnesses.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";

/// @dev Epochs decide liveness, and liveness decides whether a grant still serves (README §7.6), so
///      the calendar has to hold for every timestamp rather than the handful a unit test picked.
///      The boundaries are the interesting part: the last second of an epoch, and the first second
///      past grace — a principal whose data stops being served one second early is a bug nobody
///      would see in a fixture.
contract EpochLibFuzzTest is Test {
    EpochHarness internal h;

    function setUp() public {
        h = new EpochHarness();
    }

    /// @dev `epochStart` is a left inverse of `epochAt`, and the epoch changes on exactly the right second.
    function testFuzz_startRoundTripsAndTurnsOverOnTime(uint64 epoch, uint64 genesis, uint64 length) public pure {
        length = uint64(bound(length, 1, 365 days));
        genesis = uint64(bound(genesis, 0, type(uint32).max));
        epoch = uint64(bound(epoch, 0, 10_000));

        uint64 start = EpochLib.epochStart(epoch, genesis, length);
        assertEq(EpochLib.epochAt(start, genesis, length), epoch, "the start of an epoch is in it");
        assertEq(EpochLib.epochAt(start + length - 1, genesis, length), epoch, "so is its last second");
        assertEq(EpochLib.epochAt(start + length, genesis, length), epoch + 1, "the next second is not");
    }

    /// @dev Time only moves forward: a later timestamp is never an earlier epoch.
    function testFuzz_epochIsMonotoneInTime(uint64 a, uint64 b, uint64 genesis, uint64 length) public pure {
        length = uint64(bound(length, 1, 365 days));
        genesis = uint64(bound(genesis, 0, type(uint32).max));
        a = uint64(bound(a, genesis, genesis + 10_000 * length));
        b = uint64(bound(b, a, genesis + 10_000 * length));
        assertLe(EpochLib.epochAt(a, genesis, length), EpochLib.epochAt(b, genesis, length));
    }

    /// @dev Before genesis there is no epoch to be in, and a zero-length epoch is not a calendar.
    function testFuzz_refusesNonsense(uint64 timestamp, uint64 genesis, uint64 length) public {
        genesis = uint64(bound(genesis, 1, type(uint32).max));
        timestamp = uint64(bound(timestamp, 0, genesis - 1));
        length = uint64(bound(length, 1, 365 days));
        vm.expectRevert(abi.encodeWithSelector(EpochLib.BeforeGenesis.selector, timestamp, genesis));
        h.epochAt(timestamp, genesis, length);

        vm.expectRevert(EpochLib.ZeroEpochLength.selector);
        h.epochAt(genesis, genesis, 0);
    }

    /// @dev The dead-man's switch: live exactly up to `attested + grace`, dead one second of an epoch later.
    function testFuzz_graceBoundaryIsExact(uint64 attested, uint64 grace) public pure {
        attested = uint64(bound(attested, 0, type(uint32).max));
        grace = uint64(bound(grace, 0, 64));
        assertTrue(EpochLib.withinGrace(attested, attested, grace), "attesting now is live");
        assertTrue(EpochLib.withinGrace(attested + grace, attested, grace), "the last epoch of grace is live");
        assertFalse(EpochLib.withinGrace(attested + grace + 1, attested, grace), "one past grace is not");
    }

    /// @dev More grace never makes a principal less live — the property a shortened window would break.
    function testFuzz_graceIsMonotone(uint64 epochNow, uint64 attested, uint64 grace) public pure {
        attested = uint64(bound(attested, 0, type(uint32).max));
        epochNow = uint64(bound(epochNow, 0, type(uint32).max));
        grace = uint64(bound(grace, 0, 64));
        if (EpochLib.withinGrace(epochNow, attested, grace)) {
            assertTrue(EpochLib.withinGrace(epochNow, attested, grace + 1), "widening grace cannot kill liveness");
        }
    }
}
