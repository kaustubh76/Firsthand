// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FirsthandLens} from "../../src/FirsthandLens.sol";
import {PassportAnchorsBaseline} from "../../src/PassportAnchorsBaseline.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {MerkleLib} from "../../src/libraries/MerkleLib.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {BatchProof, VerifyFailure} from "../../src/types/Structs.sol";
import {GrantFixture} from "../GrantFixture.sol";
import {SecpSigner} from "../SecpSigner.sol";

/// @dev End-to-end predicate: a passport minted by the principal's epoch deposit key, anchored under an attested
///      deposit-key set, checked against a live grant — then each failure reason in check order.
contract FirsthandLensTest is GrantFixture {
    uint256 internal constant DEPOSIT_BASE = 0xD3B0;
    PassportAnchorsBaseline internal anchors;
    FirsthandLens internal lens;
    address[16] internal depositKeys;
    bytes32 internal grantId;

    PassportLib.Passport internal passport;
    bytes internal passportSig;
    bytes32 internal root;
    BatchProof internal proof;

    function setUp() public override {
        super.setUp();
        anchors = new PassportAnchorsBaseline(registry);
        lens = new FirsthandLens(registry, anchors, grants);
        for (uint256 i = 0; i < 16; ++i) {
            depositKeys[i] = vm.addr(DEPOSIT_BASE + i);
        }
        // Re-attest epoch 5 with the real deposit keys (the fixture attested a dummy root at enroll time only).
        attestKeys(EPOCH, bytes32(uint256(77)));
        grantId = doGrant();
        mintAndAnchor();
    }

    function attestKeys(uint64 epoch, bytes32 nonce) internal {
        bytes32 keysRoot = keccak256(abi.encodePacked(depositKeys));
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.attest(principalId, epoch, keysRoot, nonce), registry.domainSeparator()
        );
        registry.attest(principalId, epoch, keysRoot, nonce, P256SignerLib.sign(vm, AUTHORITY_SK, digest));
    }

    function mintAndAnchor() internal {
        passport = PassportLib.Passport({
            h: keccak256("datum"),
            origin: depositKeys[0],
            attest: keccak256("attest"),
            termsHash: termsHash,
            epoch: EPOCH,
            nonce: keccak256("nonce")
        });
        passportSig = SecpSigner.sign(vm, DEPOSIT_BASE, PassportLib.digest(passport, lens.domainSeparator()));
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = PassportLib.id(passport);
        ids[1] = keccak256("other passport");
        root = MerkleLib.computeRootFromIds(ids);
        // Proof for index 0 of a two-leaf batch: sibling0 = hashLeaf(ids[1]), then zero subtrees.
        proof.index = 0;
        proof.siblings[0] = MerkleLib.hashLeaf(ids[1]);
        for (uint256 level = 1; level < 8; ++level) {
            proof.siblings[level] = MerkleLib.zeroHash(level);
        }
        bytes32 anchorNonce = keccak256("anchor");
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.anchor(principalId, 0, EPOCH, root, termsHash, anchorNonce), anchors.domainSeparator()
        );
        anchors.anchor(
            principalId, 0, EPOCH, root, termsHash, anchorNonce, depositKeys, SecpSigner.sign(vm, DEPOSIT_BASE, digest)
        );
    }

    function verifyWith(
        PassportLib.Passport memory p,
        bytes memory sig,
        bytes32 r,
        BatchProof memory pr,
        bytes32 g
    ) internal view returns (bool, VerifyFailure) {
        return lens.verify(p, sig, r, pr, g);
    }

    function test_verifyAcceptsTheFullTuple() public view {
        (bool ok, VerifyFailure reason) = verifyWith(passport, passportSig, root, proof, grantId);
        assertTrue(ok);
        assertEq(uint8(reason), uint8(VerifyFailure.NONE));
        assertEq(lens.currentEpoch(), EPOCH);
        assertTrue(lens.principalIsLive(principalId));
        assertEq(uint8(lens.grantStatus(grantId)), 1);
        assertEq(lens.domainSeparator(), PassportLib.domainSeparator(block.chainid, address(anchors)));
    }

    function test_verifyReportsReasonsInPredicateOrder() public {
        PassportLib.Passport memory p = passport;
        p.h = keccak256("tampered");
        (bool ok, VerifyFailure reason) = verifyWith(p, passportSig, root, proof, grantId);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(VerifyFailure.SIG_INVALID));

        (, reason) = verifyWith(passport, passportSig, keccak256("unknown root"), proof, grantId);
        assertEq(uint8(reason), uint8(VerifyFailure.ROOT_UNKNOWN));

        BatchProof memory bad = proof;
        bad.index = 1;
        (, reason) = verifyWith(passport, passportSig, root, bad, grantId);
        assertEq(uint8(reason), uint8(VerifyFailure.MERKLE_INVALID));

        // Root belongs to this principal/ns 0; a grant on a different card is still ns 0 — use a grant whose
        // principal differs: an unknown grant id has principalOf == 0 → SCOPE_MISMATCH.
        (, reason) = verifyWith(passport, passportSig, root, proof, keccak256("no grant"));
        assertEq(uint8(reason), uint8(VerifyFailure.SCOPE_MISMATCH));

        // Terms mismatch: passport signed under other terms, anchored separately.
        (, reason) = termsMismatchCase();
        assertEq(uint8(reason), uint8(VerifyFailure.TERMS_MISMATCH));

        // Status: frozen (no re-attest by epoch 8), then expired (epoch 9), then rescinded.
        warpToEpoch(8);
        (, reason) = verifyWith(passport, passportSig, root, proof, grantId);
        assertEq(uint8(reason), uint8(VerifyFailure.GRANT_FROZEN));
        warpToEpoch(9);
        (, reason) = verifyWith(passport, passportSig, root, proof, grantId);
        assertEq(uint8(reason), uint8(VerifyFailure.GRANT_EXPIRED));
        warpToEpoch(EPOCH);
        bytes32 nonce = bytes32(uint256(500));
        bytes memory rs = rescindSig(AUTHORITY_SK, grantId, EPOCH, nonce);
        grants.rescind(grantId, EPOCH, nonce, rs);
        (, reason) = verifyWith(passport, passportSig, root, proof, grantId);
        assertEq(uint8(reason), uint8(VerifyFailure.GRANT_RESCINDED));
    }

    PassportLib.Passport internal q;
    BatchProof internal pr2;

    function termsMismatchCase() internal returns (bool, VerifyFailure) {
        q = passport;
        q.termsHash = keccak256("other terms");
        q.nonce = keccak256("n2");
        bytes memory qsig = SecpSigner.sign(vm, DEPOSIT_BASE, PassportLib.digest(q, lens.domainSeparator()));
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = PassportLib.id(q);
        bytes32 r2 = MerkleLib.computeRootFromIds(ids);
        for (uint256 level = 0; level < 8; ++level) {
            pr2.siblings[level] = MerkleLib.zeroHash(level);
        }
        anchorRoot(r2, q.termsHash, keccak256("anchor2"));
        return lens.verify(q, qsig, r2, pr2, grantId);
    }

    function anchorRoot(bytes32 r, bytes32 th, bytes32 nonce) internal {
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.anchor(principalId, 0, EPOCH, r, th, nonce), anchors.domainSeparator()
        );
        anchors.anchor(principalId, 0, EPOCH, r, th, nonce, depositKeys, SecpSigner.sign(vm, DEPOSIT_BASE, digest));
    }

    function test_verifyRejectsPassportEpochsOutsideTheGrant() public {
        // Passport from epoch 6 (future relative to now = 5) anchored... cannot anchor a future epoch; instead
        // create a grant starting at epoch 6 and verify the epoch-5 passport against it.
        warpToEpoch(6);
        attestKeys(6, bytes32(uint256(78)));
        GrantArgs memory g = defaultGrant();
        g.epochStart = 6;
        g.nonce = bytes32(uint256(601));
        bytes32 later = submitGrant(g, grantSig(AUTHORITY_SK, g));
        (bool ok, VerifyFailure reason) = verifyWith(passport, passportSig, root, proof, later);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(VerifyFailure.EPOCH_OUT_OF_GRANT));
    }
}

import {P256Signer as P256SignerLib} from "../P256Signer.sol";
