// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {P256Harness} from "../Harnesses.sol";
import {P256Double} from "../doubles/P256Double.sol";
import {P256} from "../../src/libraries/P256.sol";

/// @dev The precompile at 0x100 verifies a P-256 signature; it does **not** enforce low-s, so this
///      library does (README §8 claim 3). That guard is the whole reason a passkey authorisation
///      cannot be presented twice with two different signatures, and it runs before the staticcall —
///      so it has to hold for every r and s, including the ones no vector file thought to include.
///      The known-good signatures are covered by the shared vectors in `test/unit/P256.t.sol`;
///      what is fuzzed here is everything the guard must refuse.
contract P256FuzzTest is Test {
    P256Harness internal h;

    function setUp() public {
        P256Double.etch(vm);
        h = new P256Harness();
    }

    /// @dev Out-of-range scalars are refused before the precompile is ever consulted.
    function testFuzz_refusesOutOfRangeScalars(
        bytes32 digest,
        uint256 r,
        uint256 s,
        uint256 x,
        uint256 y
    ) public view {
        assertFalse(h.verify(digest, 0, bound(s, 1, P256.HALF_N), x, y), "r = 0");
        assertFalse(h.verify(digest, bound(r, P256.N, type(uint256).max), s, x, y), "r >= N");
        assertFalse(h.verify(digest, bound(r, 1, P256.N - 1), 0, x, y), "s = 0");
    }

    /// @dev Malleability: for any s past the halfway point the answer is no, whatever the precompile
    ///      would have said. This is the half of the signature space Ethereum learned to reject.
    function testFuzz_refusesHighS(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y) public view {
        uint256 highS = bound(s, P256.HALF_N + 1, type(uint256).max);
        assertFalse(h.verify(digest, bound(r, 1, P256.N - 1), highS, x, y), "high-s must never verify");
    }

    /// @dev A 64-byte `r ‖ s` is the only shape there is; anything else is refused, never guessed at.
    function testFuzz_signatureMustBeSixtyFourBytes(
        bytes32 digest,
        bytes memory signature,
        uint256 x,
        uint256 y
    ) public view {
        vm.assume(signature.length != 64);
        assertFalse(h.verifySignature(digest, signature, x, y), "only 64 bytes is a signature");
    }

    /// @dev The principal id is the key: two different public keys are two different principals, and
    ///      swapping the coordinates is a different key too — `keccak(x, y)` is not symmetric.
    function testFuzz_commitmentIsInjective(uint256 x, uint256 y) public pure {
        vm.assume(x != y);
        assertTrue(P256.commitment(x, y) != P256.commitment(y, x), "x and y are not interchangeable");
        assertTrue(P256.commitment(x, y) != P256.commitment(x, ~y), "y is covered");
        assertTrue(P256.commitment(x, y) != P256.commitment(~x, y), "x is covered");
        assertEq(P256.commitment(x, y), keccak256(abi.encode(x, y)), "the id is keccak(abi.encode(x, y))");
    }

    /// @dev Whatever it is handed, it answers — a malformed key must not make enrolment revert.
    function testFuzz_neverReverts(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y) public view {
        h.verify(digest, r, s, x, y);
    }
}
