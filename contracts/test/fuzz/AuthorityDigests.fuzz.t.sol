// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";

/// @dev ADR-0009 in one property: every authority action is signed under its own typehash, so a
///      signature harvested for one action can never be replayed as another. Two of these are
///      structurally identical — `enroll(bytes32,uint64,bytes32)` and `rescind(bytes32,uint64,bytes32)`
///      take the same three values in the same order — and only the typehash keeps an enrolment
///      signature from also being a valid rescission. That is worth fuzzing rather than asserting once.
contract AuthorityDigestsFuzzTest is Test {
    /// @dev The same bytes under every action must produce seven different digests, always.
    function testFuzz_actionsNeverCollide(bytes32 a, bytes32 b, uint64 e, uint32 ns, bytes32 n) public pure {
        bytes32[7] memory d = [
            AuthorityDigests.enroll(a, e, n),
            AuthorityDigests.attest(a, e, b, n),
            AuthorityDigests.grant(a, b, ns, e, e, b, a, n),
            AuthorityDigests.acceptTerms(b, a, ns, b, n),
            AuthorityDigests.rescind(a, e, n),
            AuthorityDigests.rescindCommit(a, n),
            AuthorityDigests.anchor(a, ns, e, b, b, n)
        ];
        for (uint256 i = 0; i < d.length; ++i) {
            for (uint256 j = i + 1; j < d.length; ++j) {
                assertTrue(d[i] != d[j], "two authority actions share a digest");
            }
        }
    }

    /// @dev The pair that would collide without typehashes: identical arguments, identical order.
    function testFuzz_enrollIsNotARescission(bytes32 x, uint64 epoch, bytes32 nonce) public pure {
        assertTrue(
            AuthorityDigests.enroll(x, epoch, nonce) != AuthorityDigests.rescind(x, epoch, nonce),
            "an enrolment signature would also rescind"
        );
    }

    /// @dev Changing any single field changes the digest — otherwise a signature covers more than it says.
    function testFuzz_everyFieldIsCovered(bytes32 principal, uint64 epoch, bytes32 root, bytes32 nonce) public pure {
        bytes32 base = AuthorityDigests.attest(principal, epoch, root, nonce);
        assertTrue(base != AuthorityDigests.attest(~principal, epoch, root, nonce), "principal is covered");
        assertTrue(base != AuthorityDigests.attest(principal, epoch ^ 1, root, nonce), "epoch is covered");
        assertTrue(base != AuthorityDigests.attest(principal, epoch, ~root, nonce), "deposit-keys root is covered");
        assertTrue(base != AuthorityDigests.attest(principal, epoch, root, ~nonce), "nonce is covered");
    }

    /// @dev A grant digest covers all eight fields; the term and the wrap reference especially, since
    ///      those are what bound how long access lasts and which sealed key it releases.
    function testFuzz_grantCoversTermAndWrap(
        bytes32 principal,
        bytes32 card,
        uint32 ns,
        uint64 start,
        uint64 term,
        bytes32 termsHash,
        bytes32 wrapRef,
        bytes32 nonce
    ) public pure {
        term = uint64(bound(term, 0, type(uint64).max - 1));
        bytes32 base = AuthorityDigests.grant(principal, card, ns, start, term, termsHash, wrapRef, nonce);
        assertTrue(
            base != AuthorityDigests.grant(principal, card, ns, start, term + 1, termsHash, wrapRef, nonce),
            "term is covered"
        );
        assertTrue(
            base != AuthorityDigests.grant(principal, card, ns, start, term, termsHash, ~wrapRef, nonce),
            "wrapRef is covered"
        );
    }
}
