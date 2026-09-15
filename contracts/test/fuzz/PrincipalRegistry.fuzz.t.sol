// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {IPrincipalRegistry} from "../../src/interfaces/IPrincipalRegistry.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {P256} from "../../src/libraries/P256.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {P256Double} from "../doubles/P256Double.sol";
import {P256Signer} from "../P256Signer.sol";

contract PrincipalRegistryFuzzTest is Test {
    uint64 internal constant GENESIS = 1_700_000_000;
    uint64 internal constant LEN = EpochLib.DEFAULT_EPOCH_SECONDS;
    PrincipalRegistry internal registry;

    function setUp() public {
        P256Double.etch(vm);
        registry = new PrincipalRegistry(GENESIS, LEN, EpochLib.LIVENESS_GRACE_EPOCHS);
    }

    struct Enrol {
        uint256 x;
        uint256 y;
        uint64 epoch;
        bytes32 nonce;
        bytes sig;
    }

    function boundKey(
        uint256 seed
    ) internal pure returns (uint256) {
        return bound(seed, 1, P256.N - 1);
    }

    function warpTo(
        uint64 epoch
    ) internal {
        vm.warp(uint256(GENESIS) + uint256(epoch) * LEN + 1);
    }

    /// @dev Builds a fully valid enrolment tuple for `sk` at `epoch`.
    function enrolFor(uint256 sk, uint64 epoch, bytes32 nonce) internal view returns (Enrol memory e, bytes32 id) {
        (e.x, e.y) = P256Signer.publicKey(vm, sk);
        id = P256.commitment(e.x, e.y);
        e.epoch = epoch;
        e.nonce = nonce;
        e.sig = P256Signer.sign(
            vm, sk, PassportLib.digestOf(AuthorityDigests.enroll(id, epoch, nonce), registry.domainSeparator())
        );
    }

    function submit(
        Enrol memory e
    ) internal returns (bytes32) {
        return registry.enroll(e.x, e.y, e.epoch, e.nonce, e.sig);
    }

    function attestFor(uint256 sk, bytes32 id, uint64 epoch, bytes32 root, bytes32 nonce) internal {
        bytes memory sig = P256Signer.sign(
            vm, sk, PassportLib.digestOf(AuthorityDigests.attest(id, epoch, root, nonce), registry.domainSeparator())
        );
        registry.attest(id, epoch, root, nonce, sig);
    }

    /// @notice Any valid (key, current epoch, nonce) enrolls exactly once, from any sender.
    function testFuzz_enrollOnce(uint256 seed, uint32 epochSeed, bytes32 nonce, address relayer) public {
        uint64 epoch = uint64(epochSeed);
        warpTo(epoch);
        (Enrol memory e, bytes32 id) = enrolFor(boundKey(seed), epoch, nonce);

        vm.prank(relayer);
        assertEq(submit(e), id);
        assertTrue(registry.isLive(id));
        assertEq(registry.principal(id).lastAttestedEpoch, epoch);

        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.AlreadyEnrolled.selector, id));
        submit(e);
    }

    /// @notice Flipping any bit of the submitted tuple invalidates the enrolment.
    function testFuzz_enrollRejectsTamperedInputs(uint256 seed, bytes32 nonce, uint8 which, uint8 bit) public {
        warpTo(3);
        (Enrol memory e, bytes32 id) = enrolFor(boundKey(seed), 3, nonce);

        uint256 mask = 1 << (bit % 256);
        uint8 mode = which % 5;
        if (mode == 0) {
            e.x ^= mask;
        } else if (mode == 1) {
            e.y ^= mask;
        } else if (mode == 2) {
            e.nonce ^= bytes32(mask);
        } else if (mode == 3) {
            e.epoch ^= uint64(1 << (bit % 8));
        } else {
            uint256 k = 32 + (bit % 32); // flip inside s; r flips are equivalent
            e.sig[k] = bytes1(uint8(e.sig[k]) ^ 1);
        }

        vm.expectRevert();
        submit(e);
        assertEq(uint8(registry.effectiveStatus(id)), 0, "nothing enrolled");
    }

    /// @notice Nonces are scoped per principal: two principals may share one nonce; one principal may not reuse it.
    function testFuzz_noncesScopedPerPrincipal(uint256 seedA, uint256 seedB, bytes32 nonce) public {
        uint256 a = boundKey(seedA);
        uint256 b = boundKey(seedB);
        vm.assume(a != b);
        warpTo(1);
        (Enrol memory ea, bytes32 ida) = enrolFor(a, 1, nonce);
        (Enrol memory eb,) = enrolFor(b, 1, nonce);
        submit(ea);
        submit(eb);

        bytes memory sig = P256Signer.sign(
            vm,
            a,
            PassportLib.digestOf(AuthorityDigests.attest(ida, 1, keccak256("r"), nonce), registry.domainSeparator())
        );
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.NonceAlreadyUsed.selector, nonce));
        registry.attest(ida, 1, keccak256("r"), nonce, sig);
    }

    /// @notice After enrolling at e0 the principal is live through e0 + grace and frozen after; attesting at any
    ///         later epoch restores liveness and moves the watermark forward.
    function testFuzz_livenessWindow(uint256 seed, uint16 e0Seed, uint8 skip) public {
        uint256 sk = boundKey(seed);
        uint64 e0 = uint64(e0Seed);
        warpTo(e0);
        (Enrol memory e, bytes32 id) = enrolFor(sk, e0, bytes32(uint256(1)));
        submit(e);

        uint64 later = e0 + uint64(skip);
        warpTo(later);
        assertEq(registry.isLive(id), later <= e0 + registry.livenessGrace(), "liveness window");

        bytes32 root = keccak256(abi.encode(later));
        attestFor(sk, id, later, root, bytes32(uint256(2)));
        uint64 grace = registry.livenessGrace();
        bool gap = later > e0 + grace;
        assertEq(registry.isLive(id), !gap, "a gap attest stays frozen until the next boundary");
        assertEq(registry.principal(id).thawEpoch, gap ? later + 1 : 0, "thaw scheduled only after a gap");
        assertEq(registry.principal(id).lastAttestedEpoch, later);
        assertEq(registry.depositKeysRoot(id, later), root);
        warpTo(later + 1);
        assertTrue(registry.isLive(id), "one boundary after any attest the principal is live");
    }

    /// @notice Liveness is exactly `withinGrace(now, lastAttested, grace) && now >= thawEpoch` across any sequence
    ///         of attests with arbitrary gaps (the invariant both twins implement).
    function testFuzz_thawInvariant(uint256 seed, uint16 e0Seed, uint8[4] memory skips, uint8 probe) public {
        uint256 sk = boundKey(seed);
        uint64 e0 = uint64(e0Seed);
        warpTo(e0);
        (Enrol memory e, bytes32 id) = enrolFor(sk, e0, bytes32(uint256(1)));
        submit(e);
        uint64 grace = registry.livenessGrace();
        uint64 at = e0;
        uint64 expectedThaw = 0;
        for (uint256 i = 0; i < skips.length; i++) {
            if (skips[i] == 0) continue; // AlreadyAttested otherwise
            uint64 next = at + uint64(skips[i]);
            if (next > at + grace) expectedThaw = next + 1;
            warpTo(next);
            attestFor(sk, id, next, keccak256(abi.encode(next)), bytes32(uint256(2 + i)));
            at = next;
        }
        assertEq(registry.principal(id).thawEpoch, expectedThaw);
        uint64 now_ = at + uint64(probe);
        warpTo(now_);
        bool expectLive = now_ <= at + grace && now_ >= expectedThaw;
        assertEq(registry.isLive(id), expectLive, "isLive == withinGrace && now >= thawEpoch");
    }
}
