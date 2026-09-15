// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {IPrincipalRegistry} from "../../src/interfaces/IPrincipalRegistry.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {P256} from "../../src/libraries/P256.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {PrincipalState, PrincipalStatus} from "../../src/types/Structs.sol";
import {P256Double} from "../doubles/P256Double.sol";
import {P256Signer} from "../P256Signer.sol";

contract PrincipalRegistryTest is Test {
    uint64 internal constant GENESIS = 1_700_000_000;
    uint64 internal constant LEN = EpochLib.DEFAULT_EPOCH_SECONDS;
    uint64 internal constant GRACE = EpochLib.LIVENESS_GRACE_EPOCHS;

    PrincipalRegistry internal registry;

    // Golden key from packages/test-vectors/vectors/keys.v1.json case 0 (OpenSSL-derived).
    uint256 internal scalar;
    uint256 internal x;
    uint256 internal y;
    bytes32 internal principalId;

    function setUp() public {
        P256Double.etch(vm);
        vm.warp(GENESIS + 5 * LEN + 17); // epoch 5
        registry = new PrincipalRegistry(GENESIS, LEN, GRACE);

        string memory keys = vm.readFile("../packages/test-vectors/vectors/keys.v1.json");
        scalar = uint256(vm.parseJsonBytes32(keys, ".cases[0].expected.kIdScalar"));
        x = uint256(vm.parseJsonBytes32(keys, ".cases[0].expected.p256X"));
        y = uint256(vm.parseJsonBytes32(keys, ".cases[0].expected.p256Y"));
        principalId = vm.parseJsonBytes32(keys, ".cases[0].expected.p256Commit");
        (uint256 px, uint256 py) = P256Signer.publicKey(vm, scalar);
        assertEq(px, x, "cheatcode pubkey x != vector");
        assertEq(py, y, "cheatcode pubkey y != vector");
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────────

    function enrollDigest(bytes32 id, uint64 epoch, bytes32 nonce) internal view returns (bytes32) {
        return PassportLib.digestOf(AuthorityDigests.enroll(id, epoch, nonce), registry.domainSeparator());
    }

    function attestDigest(bytes32 id, uint64 epoch, bytes32 root, bytes32 nonce) internal view returns (bytes32) {
        return PassportLib.digestOf(AuthorityDigests.attest(id, epoch, root, nonce), registry.domainSeparator());
    }

    function doEnroll(
        bytes32 nonce
    ) internal returns (bytes32) {
        bytes memory sig = P256Signer.sign(vm, scalar, enrollDigest(principalId, 5, nonce));
        return registry.enroll(x, y, 5, nonce, sig);
    }

    function doAttest(uint64 epoch, bytes32 root, bytes32 nonce) internal {
        bytes memory sig = P256Signer.sign(vm, scalar, attestDigest(principalId, epoch, root, nonce));
        registry.attest(principalId, epoch, root, nonce, sig);
    }

    // ── enroll ──────────────────────────────────────────────────────────────────────────────────

    function test_enrollStoresKeyAndLiveness() public {
        assertEq(uint8(registry.effectiveStatus(principalId)), uint8(PrincipalStatus.NONE));
        vm.expectEmit(true, false, false, true);
        emit IPrincipalRegistry.PrincipalEnrolled(principalId, x, y, 5);
        // Relayed by a stranger: authorisation is the signature, not msg.sender.
        vm.prank(address(0xBEEF));
        bytes32 id = doEnroll(bytes32(uint256(1)));
        assertEq(id, principalId);
        assertEq(id, P256.commitment(x, y));

        PrincipalState memory p = registry.principal(id);
        assertEq(p.p256KeyCommit, id);
        assertEq(p.lastAttestedEpoch, 5);
        assertEq(uint8(p.status), uint8(PrincipalStatus.ACTIVE));
        (uint256 kx, uint256 ky) = registry.authorityKey(id);
        assertEq(kx, x);
        assertEq(ky, y);
        assertTrue(registry.isLive(id));
        assertTrue(registry.nonceUsed(id, bytes32(uint256(1))));
        assertFalse(registry.nonceUsed(id, bytes32(uint256(2))));
        assertEq(registry.domainSeparator(), PassportLib.domainSeparator(block.chainid, address(registry)));
    }

    function test_enrollRejectsDoubleEnrollWrongEpochReplayAndForeignSignature() public {
        doEnroll(bytes32(uint256(1)));
        bytes memory again = P256Signer.sign(vm, scalar, enrollDigest(principalId, 5, bytes32(uint256(2))));
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.AlreadyEnrolled.selector, principalId));
        registry.enroll(x, y, 5, bytes32(uint256(2)), again);

        // Fresh key so the AlreadyEnrolled path does not mask the others.
        uint256 other = 0xC0FFEE;
        (uint256 ox, uint256 oy) = P256Signer.publicKey(vm, other);
        bytes32 oid = P256.commitment(ox, oy);

        bytes memory sig4 = P256Signer.sign(vm, other, enrollDigest(oid, 4, bytes32(uint256(3))));
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.EpochNotCurrent.selector, 4, 5));
        registry.enroll(ox, oy, 4, bytes32(uint256(3)), sig4);

        // Signature by the golden key over the other key's digest: verifies for nobody.
        bytes memory foreign = P256Signer.sign(vm, scalar, enrollDigest(oid, 5, bytes32(uint256(3))));
        vm.expectRevert(IPrincipalRegistry.InvalidAuthoritySignature.selector);
        registry.enroll(ox, oy, 5, bytes32(uint256(3)), foreign);

        // Signature over a different nonce than the one submitted.
        bytes memory wrongNonce = P256Signer.sign(vm, other, enrollDigest(oid, 5, bytes32(uint256(9))));
        vm.expectRevert(IPrincipalRegistry.InvalidAuthoritySignature.selector);
        registry.enroll(ox, oy, 5, bytes32(uint256(3)), wrongNonce);

        // Off-curve key (y tampered) is rejected by the precompile.
        bytes memory good =
            P256Signer.sign(vm, other, enrollDigest(P256.commitment(ox, oy + 1), 5, bytes32(uint256(3))));
        vm.expectRevert(IPrincipalRegistry.InvalidAuthoritySignature.selector);
        registry.enroll(ox, oy + 1, 5, bytes32(uint256(3)), good);
    }

    function test_enrollRejectsHighSAndWrongLength() public {
        bytes32 nonce = bytes32(uint256(7));
        (bytes32 r, bytes32 s) = vm.signP256(scalar, enrollDigest(principalId, 5, nonce));
        uint256 sv = uint256(s);
        uint256 highS = sv > P256.HALF_N ? sv : P256.N - sv;
        vm.expectRevert(IPrincipalRegistry.InvalidAuthoritySignature.selector);
        registry.enroll(x, y, 5, nonce, abi.encode(uint256(r), highS));
        vm.expectRevert(IPrincipalRegistry.InvalidAuthoritySignature.selector);
        registry.enroll(x, y, 5, nonce, abi.encodePacked(r, s, uint8(1)));
    }

    // ── attest ──────────────────────────────────────────────────────────────────────────────────

    function test_attestPublishesRootAndAdvancesLiveness() public {
        doEnroll(bytes32(uint256(1)));
        bytes32 root = keccak256("deposit keys epoch 5");
        vm.expectEmit(true, true, false, true);
        emit IPrincipalRegistry.PrincipalAttested(principalId, 5, root);
        doAttest(5, root, bytes32(uint256(2)));
        assertEq(registry.depositKeysRoot(principalId, 5), root);
        assertEq(registry.principal(principalId).lastAttestedEpoch, 5);

        // Same epoch again: no overwrite.
        bytes memory again =
            P256Signer.sign(vm, scalar, attestDigest(principalId, 5, keccak256("other"), bytes32(uint256(3))));
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.AlreadyAttested.selector, principalId, 5));
        registry.attest(principalId, 5, keccak256("other"), bytes32(uint256(3)), again);

        // Next epoch.
        vm.warp(GENESIS + 6 * LEN);
        bytes32 root6 = keccak256("deposit keys epoch 6");
        doAttest(6, root6, bytes32(uint256(4)));
        assertEq(registry.depositKeysRoot(principalId, 6), root6);
        assertEq(registry.principal(principalId).lastAttestedEpoch, 6);
        assertEq(registry.depositKeysRoot(principalId, 5), root, "earlier roots are immutable");
    }

    function test_attestRejectsUnknownWrongEpochReplayAndForeign() public {
        bytes32 root = keccak256("root");
        bytes memory anySig = abi.encode(uint256(1), uint256(1));
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.UnknownPrincipal.selector, principalId));
        registry.attest(principalId, 5, root, bytes32(uint256(1)), anySig);

        doEnroll(bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.EpochNotCurrent.selector, 6, 5));
        registry.attest(principalId, 6, root, bytes32(uint256(2)), anySig);

        // Nonce 1 was consumed by enroll — nonces are shared across both verbs for a principal.
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.NonceAlreadyUsed.selector, bytes32(uint256(1))));
        registry.attest(principalId, 5, root, bytes32(uint256(1)), anySig);

        bytes memory foreign = P256Signer.sign(vm, 0xC0FFEE, attestDigest(principalId, 5, root, bytes32(uint256(2))));
        vm.expectRevert(IPrincipalRegistry.InvalidAuthoritySignature.selector);
        registry.attest(principalId, 5, root, bytes32(uint256(2)), foreign);
        // A failed attempt does not burn the nonce? It does: nonces are consumed before verification
        // fails — but the revert rolls the whole call back, so the nonce stays available.
        assertFalse(registry.nonceUsed(principalId, bytes32(uint256(2))));
        doAttest(5, root, bytes32(uint256(2)));
    }

    function test_attestOlderEpochIsNotMonotone() public {
        doEnroll(bytes32(uint256(1)));
        vm.warp(GENESIS + 7 * LEN);
        doAttest(7, keccak256("7"), bytes32(uint256(2)));
        // Rewind the clock (only possible in tests) to show the monotonicity guard is independent of AlreadyAttested.
        vm.warp(GENESIS + 6 * LEN);
        vm.expectRevert(abi.encodeWithSelector(IPrincipalRegistry.EpochNotMonotone.selector, 6, 7));
        registry.attest(principalId, 6, keccak256("6"), bytes32(uint256(3)), abi.encode(uint256(1), uint256(1)));
    }

    // ── liveness (dead-man's switch) ────────────────────────────────────────────────────────────

    function test_livenessFreezesLazilyAfterGraceAndThawsOnAttest() public {
        doEnroll(bytes32(uint256(1))); // lastAttested = 5, grace = 2
        vm.warp(GENESIS + 7 * LEN);
        assertTrue(registry.isLive(principalId), "epoch 7 == 5 + grace is still live");
        vm.warp(GENESIS + 8 * LEN);
        assertFalse(registry.isLive(principalId), "epoch 8 > 5 + grace freezes");
        assertEq(uint8(registry.effectiveStatus(principalId)), uint8(PrincipalStatus.FROZEN));
        assertEq(uint8(registry.principal(principalId).status), uint8(PrincipalStatus.ACTIVE), "FROZEN is never stored");

        // Re-attesting after a gap schedules the thaw one full boundary later (README §7.6): frozen from
        // epoch 8 (= 5 + grace + 1), live again from epoch 9.
        bytes memory sig =
            P256Signer.sign(vm, scalar, attestDigest(principalId, 8, keccak256("back"), bytes32(uint256(2))));
        vm.expectEmit(true, false, false, true);
        emit IPrincipalRegistry.PrincipalThawScheduled(principalId, 8, 9);
        registry.attest(principalId, 8, keccak256("back"), bytes32(uint256(2)), sig);
        assertFalse(registry.isLive(principalId), "same epoch: still frozen");
        assertEq(uint8(registry.effectiveStatus(principalId)), uint8(PrincipalStatus.FROZEN));
        assertEq(registry.principal(principalId).thawEpoch, 9);
        assertEq(registry.principal(principalId).lastAttestedEpoch, 8);

        vm.warp(GENESIS + 9 * LEN);
        assertTrue(registry.isLive(principalId), "one boundary later: live");
        assertEq(uint8(registry.effectiveStatus(principalId)), uint8(PrincipalStatus.ACTIVE));
        vm.warp(GENESIS + 11 * LEN);
        assertFalse(registry.isLive(principalId), "8 + grace + 1: frozen again without a new attest");
    }

    function test_attestWithinGraceDoesNotScheduleThaw() public {
        doEnroll(bytes32(uint256(1))); // lastAttested = 5
        vm.warp(GENESIS + 7 * LEN); // 7 == 5 + grace: still live
        vm.recordLogs();
        doAttest(7, keccak256("ok"), bytes32(uint256(2)));
        assertEq(vm.getRecordedLogs().length, 1, "only PrincipalAttested");
        assertEq(registry.principal(principalId).thawEpoch, 0);
        assertTrue(registry.isLive(principalId));
    }

    function test_thawEpochSurvivesLaterAttests() public {
        doEnroll(bytes32(uint256(1)));
        vm.warp(GENESIS + 8 * LEN);
        doAttest(8, keccak256("back"), bytes32(uint256(2))); // thaw at 9
        vm.warp(GENESIS + 9 * LEN);
        doAttest(9, keccak256("again"), bytes32(uint256(3)));
        assertEq(registry.principal(principalId).thawEpoch, 9, "a passed thaw is never cleared");
        assertTrue(registry.isLive(principalId));
        // A second gap reschedules.
        vm.warp(GENESIS + 15 * LEN);
        doAttest(15, keccak256("late"), bytes32(uint256(4)));
        assertEq(registry.principal(principalId).thawEpoch, 16);
        assertFalse(registry.isLive(principalId));
    }

    function test_enrollHasNoThaw() public {
        doEnroll(bytes32(uint256(1)));
        assertEq(registry.principal(principalId).thawEpoch, 0);
        assertTrue(registry.isLive(principalId));
    }

    function test_noncesAreScopedPerPrincipal() public {
        doEnroll(bytes32(uint256(42)));
        uint256 other = 0xABCDEF;
        (uint256 ox, uint256 oy) = P256Signer.publicKey(vm, other);
        bytes32 oid = P256.commitment(ox, oy);
        bytes memory sig = P256Signer.sign(vm, other, enrollDigest(oid, 5, bytes32(uint256(42))));
        registry.enroll(ox, oy, 5, bytes32(uint256(42)), sig); // same nonce, different principal: fine
        assertTrue(registry.nonceUsed(oid, bytes32(uint256(42))));
    }

    function test_constructorRejectsZeroEpochLength() public {
        vm.expectRevert(EpochLib.ZeroEpochLength.selector);
        new PrincipalRegistry(GENESIS, 0, GRACE);
    }
}
