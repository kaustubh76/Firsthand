// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Rescissions} from "../../src/Rescissions.sol";
import {IRescissions} from "../../src/interfaces/IRescissions.sol";

contract RescissionsTest is Test {
    Rescissions internal r;

    function setUp() public {
        r = new Rescissions();
    }

    function test_commitRecordsBlockAndRelayer() public {
        bytes32 c = r.commitmentOf(bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(c, keccak256(abi.encode(bytes32(uint256(1)), bytes32(uint256(2)))));
        vm.roll(42);
        address relayer = address(0xBEEF);
        vm.prank(relayer);
        vm.expectEmit(true, false, false, true);
        emit IRescissions.RescissionCommitted(c, 42, relayer);
        r.commit(c);
        assertEq(r.commitBlock(c), 42);
        assertEq(r.commitBlock(bytes32(uint256(99))), 0);
    }

    function test_commitIsIdempotentlyRejected() public {
        bytes32 c = bytes32(uint256(7));
        r.commit(c);
        vm.expectRevert(abi.encodeWithSelector(IRescissions.AlreadyCommitted.selector, c));
        r.commit(c);
    }

    function testFuzz_anyoneCanCommitAnything(address who, bytes32 c) public {
        vm.assume(who != address(0));
        vm.prank(who);
        r.commit(c);
        assertGt(r.commitBlock(c), 0);
    }
}
