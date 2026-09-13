// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {PassportAnchors} from "../../src/PassportAnchors.sol";
import {IPassportAnchors} from "../../src/interfaces/IPassportAnchors.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {MerkleLib} from "../../src/libraries/MerkleLib.sol";
import {P256} from "../../src/libraries/P256.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {AnchorRecord, BatchProof} from "../../src/types/Structs.sol";
import {P256Double} from "../doubles/P256Double.sol";
import {P256Signer} from "../P256Signer.sol";
import {SecpSigner} from "../SecpSigner.sol";

/// @dev Layout-independent conformance suite. Concrete tests pick the implementation in `deployAnchors`.
abstract contract PassportAnchorsBehaviour is Test {
    uint64 internal constant GENESIS = 1_700_000_000;
    uint64 internal constant LEN = EpochLib.DEFAULT_EPOCH_SECONDS;
    uint64 internal constant EPOCH = 5;
    uint256 internal constant AUTHORITY_SK = 0xA11CE;
    uint256 internal constant DEPOSIT_BASE = 0xD3B0;

    PrincipalRegistry internal registry;
    PassportAnchors internal anchors;
    bytes32 internal principalId;
    address[16] internal depositKeys;

    function deployAnchors(
        PrincipalRegistry registry_
    ) internal virtual returns (PassportAnchors);

    function setUp() public virtual {
        P256Double.etch(vm);
        vm.warp(GENESIS + EPOCH * LEN + 1);
        vm.roll(1000);
        registry = new PrincipalRegistry(GENESIS, LEN, EpochLib.LIVENESS_GRACE_EPOCHS);
        anchors = deployAnchors(registry);
        principalId = enrollAndAttest(AUTHORITY_SK, DEPOSIT_BASE, EPOCH);
        for (uint256 i = 0; i < 16; ++i) {
            depositKeys[i] = vm.addr(DEPOSIT_BASE + i);
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────────

    function keysFor(
        uint256 base
    ) internal pure returns (address[16] memory keys) {
        for (uint256 i = 0; i < 16; ++i) {
            keys[i] = vm.addr(base + i);
        }
    }

    function enrollAndAttest(uint256 authoritySk, uint256 depositBase, uint64 epoch) internal returns (bytes32 id) {
        (uint256 x, uint256 y) = P256Signer.publicKey(vm, authoritySk);
        id = P256.commitment(x, y);
        bytes memory enrollSig =
            P256Signer.sign(vm, authoritySk, registryDigest(AuthorityDigests.enroll(id, epoch, bytes32(uint256(1)))));
        registry.enroll(x, y, epoch, bytes32(uint256(1)), enrollSig);
        bytes32 root = keccak256(abi.encodePacked(keysFor(depositBase)));
        bytes memory attestSig = P256Signer.sign(
            vm, authoritySk, registryDigest(AuthorityDigests.attest(id, epoch, root, bytes32(uint256(2))))
        );
        registry.attest(id, epoch, root, bytes32(uint256(2)), attestSig);
    }

    function registryDigest(
        bytes32 structHash
    ) internal view returns (bytes32) {
        return PassportLib.digestOf(structHash, registry.domainSeparator());
    }

    function anchorDigest(
        bytes32 id,
        uint32 ns,
        uint64 epoch,
        bytes32 root,
        bytes32 termsHash,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = AuthorityDigests.anchor(id, ns, epoch, root, termsHash, nonce);
        return PassportLib.digestOf(structHash, anchors.domainSeparator());
    }

    function anchorSig(
        uint256 sk,
        bytes32 id,
        uint32 ns,
        uint64 epoch,
        bytes32 root,
        bytes32 termsHash,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        return SecpSigner.sign(vm, sk, anchorDigest(id, ns, epoch, root, termsHash, nonce));
    }

    function doAnchor(uint32 ns, bytes32 root, bytes32 nonce) internal returns (uint256) {
        bytes32 termsHash = keccak256("terms");
        bytes memory sig = anchorSig(DEPOSIT_BASE + ns, principalId, ns, EPOCH, root, termsHash, nonce);
        return anchors.anchor(principalId, ns, EPOCH, root, termsHash, nonce, depositKeys, sig);
    }

    // ── conformance ─────────────────────────────────────────────────────────────────────────────

    function test_anchorRecordsAndIndexesPerPage() public {
        bytes32 r1 = keccak256("root-1");
        vm.expectEmit(true, true, true, true);
        emit IPassportAnchors.BatchAnchored(principalId, 0, EPOCH, r1, keccak256("terms"), 0);
        vm.prank(address(0xBEEF)); // relayed by a stranger
        assertEq(doAnchor(0, r1, bytes32(uint256(10))), 0);

        assertTrue(anchors.isAnchored(r1));
        assertEq(anchors.anchorBlock(r1), 1000);
        assertEq(anchors.termsOf(r1), keccak256("terms"));
        AnchorRecord memory rec = anchors.anchorOf(r1);
        assertEq(rec.principalId, principalId);
        assertEq(rec.ns, 0);
        assertEq(rec.epoch, EPOCH);
        assertEq(rec.batchIndex, 0);
        assertEq(rec.blockNumber, 1000);
        assertEq(anchors.batchCount(principalId, 0, EPOCH), 1);
        assertEq(anchors.batchRootAt(principalId, 0, EPOCH, 0), r1);
        assertEq(anchors.batchRootAt(principalId, 0, EPOCH, 1), bytes32(0));
        assertTrue(anchors.nonceUsed(principalId, bytes32(uint256(10))));

        vm.roll(1001);
        bytes32 r2 = keccak256("root-2");
        assertEq(doAnchor(0, r2, bytes32(uint256(11))), 1);
        assertEq(anchors.batchCount(principalId, 0, EPOCH), 2);
        assertEq(anchors.batchRootAt(principalId, 0, EPOCH, 1), r2);
        assertEq(anchors.anchorOf(r2).batchIndex, 1);
        assertEq(anchors.anchorOf(r2).blockNumber, 1001);
        assertEq(anchors.anchorOf(r1).blockNumber, 1000, "earlier records untouched");

        // Another namespace has its own page.
        bytes32 r3 = keccak256("root-3");
        assertEq(doAnchor(7, r3, bytes32(uint256(12))), 0);
        assertEq(anchors.batchCount(principalId, 7, EPOCH), 1);
        assertEq(anchors.anchorOf(r3).ns, 7);
        assertEq(anchors.batchCount(principalId, 0, EPOCH), 2);
        assertEq(anchors.registry(), address(registry));
    }

    function test_unknownRootReadsAsEmpty() public view {
        bytes32 none = keccak256("none");
        assertFalse(anchors.isAnchored(none));
        assertEq(anchors.anchorBlock(none), 0);
        assertEq(anchors.termsOf(none), bytes32(0));
        assertEq(anchors.anchorOf(none).principalId, bytes32(0));
        assertEq(anchors.batchCount(principalId, 3, EPOCH), 0);
        assertEq(anchors.batchRootAt(principalId, 3, EPOCH, 0), bytes32(0));
    }

    function test_rejectsWrongKeySlotForeignKeysAndTamperedRoot() public {
        bytes32 root = keccak256("root");
        bytes32 termsHash = keccak256("terms");
        // Signed by depositKeys[1] but submitted for ns 0.
        bytes memory wrongSlot =
            anchorSig(DEPOSIT_BASE + 1, principalId, 0, EPOCH, root, termsHash, bytes32(uint256(1)));
        vm.expectRevert(
            abi.encodeWithSelector(IPassportAnchors.InvalidDepositSignature.selector, depositKeys[1], depositKeys[0])
        );
        anchors.anchor(principalId, 0, EPOCH, root, termsHash, bytes32(uint256(1)), depositKeys, wrongSlot);

        // A different set of 16 keys does not match the attested commitment.
        address[16] memory foreign = keysFor(0xF00D);
        bytes memory foreignSig = anchorSig(0xF00D, principalId, 0, EPOCH, root, termsHash, bytes32(uint256(1)));
        bytes32 expected = keccak256(abi.encodePacked(depositKeys));
        vm.expectRevert(
            abi.encodeWithSelector(
                IPassportAnchors.DepositKeysMismatch.selector, expected, keccak256(abi.encodePacked(foreign))
            )
        );
        anchors.anchor(principalId, 0, EPOCH, root, termsHash, bytes32(uint256(1)), foreign, foreignSig);

        // Valid signature over root A submitted with root B.
        bytes memory sigA = anchorSig(DEPOSIT_BASE, principalId, 0, EPOCH, root, termsHash, bytes32(uint256(1)));
        vm.expectPartialRevert(IPassportAnchors.InvalidDepositSignature.selector);
        anchors.anchor(principalId, 0, EPOCH, keccak256("other"), termsHash, bytes32(uint256(1)), depositKeys, sigA);

        // Malformed signature length surfaces PassportLib's error.
        vm.expectRevert(abi.encodeWithSelector(PassportLib.InvalidSignatureLength.selector, 64));
        anchors.anchor(principalId, 0, EPOCH, root, termsHash, bytes32(uint256(1)), depositKeys, new bytes(64));
    }

    function test_rejectsDuplicateZeroRootNamespaceEpochAndNonce() public {
        bytes32 root = keccak256("root");
        doAnchor(2, root, bytes32(uint256(1)));

        bytes memory sig =
            anchorSig(DEPOSIT_BASE + 2, principalId, 2, EPOCH, root, keccak256("terms"), bytes32(uint256(2)));
        vm.expectRevert(abi.encodeWithSelector(IPassportAnchors.DuplicateRoot.selector, root));
        anchors.anchor(principalId, 2, EPOCH, root, keccak256("terms"), bytes32(uint256(2)), depositKeys, sig);

        vm.expectRevert(IPassportAnchors.ZeroRoot.selector);
        anchors.anchor(principalId, 2, EPOCH, bytes32(0), keccak256("terms"), bytes32(uint256(2)), depositKeys, sig);

        vm.expectRevert(abi.encodeWithSelector(IPassportAnchors.NamespaceOutOfRange.selector, 16));
        anchors.anchor(
            principalId, 16, EPOCH, keccak256("r"), keccak256("terms"), bytes32(uint256(2)), depositKeys, sig
        );

        vm.expectRevert(abi.encodeWithSelector(IPassportAnchors.NonceAlreadyUsed.selector, bytes32(uint256(1))));
        anchors.anchor(principalId, 2, EPOCH, keccak256("r"), keccak256("terms"), bytes32(uint256(1)), depositKeys, sig);

        vm.expectRevert(abi.encodeWithSelector(IPassportAnchors.EpochInFuture.selector, EPOCH + 1, EPOCH));
        anchors.anchor(
            principalId, 2, EPOCH + 1, keccak256("r"), keccak256("terms"), bytes32(uint256(2)), depositKeys, sig
        );

        vm.expectRevert(abi.encodeWithSelector(IPassportAnchors.EpochNotAttested.selector, principalId, EPOCH - 1));
        anchors.anchor(
            principalId, 2, EPOCH - 1, keccak256("r"), keccak256("terms"), bytes32(uint256(2)), depositKeys, sig
        );

        bytes32 stranger = keccak256("nobody");
        vm.expectRevert(abi.encodeWithSelector(IPassportAnchors.EpochNotAttested.selector, stranger, EPOCH));
        anchors.anchor(stranger, 2, EPOCH, keccak256("r"), keccak256("terms"), bytes32(uint256(2)), depositKeys, sig);
    }

    function test_anchorsPastEpochOnceAttested() public {
        // Epoch 5 was attested; the batch may be anchored after the boundary (late flush).
        vm.warp(GENESIS + (EPOCH + 1) * LEN + 1);
        assertEq(doAnchor(0, keccak256("late"), bytes32(uint256(1))), 0);
        assertEq(anchors.anchorOf(keccak256("late")).epoch, EPOCH);
    }

    function test_isIncludedUsesRealMerkleVectors() public {
        // merkle.v1.json "hand/pair-index0": ids 0x11…, 0x22… ; root and 8 siblings from the golden file.
        string memory json = vm.readFile("../packages/test-vectors/vectors/merkle.v1.json");
        bytes32 root = vm.parseJsonBytes32(json, ".cases[1].expected.root");
        bytes32 id = vm.parseJsonBytes32(json, ".cases[1].input.passportId");
        bytes32[] memory sib = vm.parseJsonBytes32Array(json, ".cases[1].input.siblings");
        BatchProof memory proof;
        proof.index = uint8(vm.parseJsonUint(json, ".cases[1].input.index"));
        for (uint256 k = 0; k < 8; ++k) {
            proof.siblings[k] = sib[k];
        }
        assertFalse(anchors.isIncluded(root, id, proof), "not anchored yet");
        doAnchor(0, root, bytes32(uint256(1)));
        assertTrue(anchors.isIncluded(root, id, proof));
        proof.index = 1;
        assertFalse(anchors.isIncluded(root, id, proof), "wrong position");
        assertTrue(MerkleLib.verifyPassport(root, id, BatchProof(0, proof.siblings)));
    }

    function test_depositKeysRootEncodingMatchesCast() public pure {
        // keccak256 of sixteen 32-byte-padded addresses 0x…01 … 0x…10 — `cast keccak` hand value.
        address[16] memory keys;
        for (uint256 i = 0; i < 16; ++i) {
            keys[i] = address(uint160(i + 1));
        }
        assertEq(keccak256(abi.encodePacked(keys)), 0xf2195b02971f2ea2803b2195c5862918df0320b990fb97dfbfcdb48a87b83234);
    }

    /// @dev Emits the gas of a first and a second anchor on a page so the two layouts can be compared in logs.
    function test_gasProfile() public {
        uint256 g0 = gasleft();
        doAnchor(0, keccak256("g1"), bytes32(uint256(1)));
        uint256 first = g0 - gasleft();
        g0 = gasleft();
        doAnchor(0, keccak256("g2"), bytes32(uint256(2)));
        uint256 second = g0 - gasleft();
        emit log_named_string("layout", anchors.layout());
        emit log_named_uint("anchor gas (first on page)", first);
        emit log_named_uint("anchor gas (subsequent)", second);
    }
}
