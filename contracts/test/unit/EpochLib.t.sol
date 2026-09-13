// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {EpochHarness} from "../Harnesses.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";

contract EpochLibTest is Test {
    uint64 internal constant GENESIS = 1000;
    uint64 internal constant LEN = EpochLib.DEFAULT_EPOCH_SECONDS;
    EpochHarness internal h;

    function setUp() public {
        h = new EpochHarness();
    }

    function test_boundaries() public pure {
        assertEq(EpochLib.epochAt(GENESIS, GENESIS, LEN), 0);
        assertEq(EpochLib.epochAt(GENESIS + LEN - 1, GENESIS, LEN), 0);
        assertEq(EpochLib.epochAt(GENESIS + LEN, GENESIS, LEN), 1);
        assertEq(EpochLib.epochStart(3, GENESIS, LEN), GENESIS + 3 * LEN);
    }

    function test_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(EpochLib.BeforeGenesis.selector, 999, GENESIS));
        h.epochAt(999, GENESIS, LEN);
        vm.expectRevert(EpochLib.ZeroEpochLength.selector);
        h.epochAt(GENESIS, GENESIS, 0);
    }

    function test_grace() public pure {
        assertTrue(EpochLib.withinGrace(10, 8, 2));
        assertFalse(EpochLib.withinGrace(11, 8, 2));
        assertEq(EpochLib.LIVENESS_GRACE_EPOCHS, 2);
        assertEq(EpochLib.MAX_GRANT_TERM_EPOCHS, 8);
    }

    function testFuzz_startBracketsTimestamp(
        uint64 ts
    ) public pure {
        vm.assume(ts >= GENESIS);
        uint64 e = EpochLib.epochAt(ts, GENESIS, LEN);
        uint64 start = EpochLib.epochStart(e, GENESIS, LEN);
        assertLe(start, ts);
        assertLt(ts - start, LEN);
    }
}
