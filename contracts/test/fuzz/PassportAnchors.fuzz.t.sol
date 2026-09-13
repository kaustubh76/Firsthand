// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {PassportAnchors} from "../../src/PassportAnchors.sol";
import {PassportAnchorsBaseline} from "../../src/PassportAnchorsBaseline.sol";
import {PassportAnchorsPaged} from "../../src/PassportAnchorsPaged.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {PassportAnchorsBehaviour} from "../unit/PassportAnchors.behaviour.sol";
import {SecpSigner} from "../SecpSigner.sol";

/// @dev Layout-independent properties; run for both layouts.
abstract contract PassportAnchorsFuzz is PassportAnchorsBehaviour {
    struct Req {
        uint32 ns;
        bytes32 root;
        bytes32 termsHash;
        bytes32 nonce;
        bytes sig;
    }

    function build(uint32 ns, bytes32 root, bytes32 termsHash, bytes32 nonce) internal view returns (Req memory r) {
        r.ns = ns;
        r.root = root;
        r.termsHash = termsHash;
        r.nonce = nonce;
        r.sig = SecpSigner.sign(vm, DEPOSIT_BASE + ns, anchorDigest(principalId, ns, EPOCH, root, termsHash, nonce));
    }

    function submit(
        Req memory r
    ) internal returns (uint256) {
        return anchors.anchor(principalId, r.ns, EPOCH, r.root, r.termsHash, r.nonce, depositKeys, r.sig);
    }

    /// @notice Any valid request anchors exactly once and reads back intact; the same root twice is refused.
    function testFuzz_anchorOnce(uint8 nsSeed, bytes32 root, bytes32 termsHash, bytes32 nonce) public {
        vm.assume(root != bytes32(0));
        uint32 ns = uint32(nsSeed % 16);
        Req memory r = build(ns, root, termsHash, nonce);
        assertEq(submit(r), 0);
        assertTrue(anchors.isAnchored(root));
        assertEq(anchors.termsOf(root), termsHash);
        assertEq(anchors.anchorOf(root).ns, ns);
        assertEq(anchors.batchRootAt(principalId, ns, EPOCH, 0), root);
        r.nonce = ~nonce;
        r.sig = SecpSigner.sign(vm, DEPOSIT_BASE + ns, anchorDigest(principalId, ns, EPOCH, root, termsHash, r.nonce));
        vm.expectPartialRevert(bytes4(keccak256("DuplicateRoot(bytes32)")));
        submit(r);
    }

    /// @notice Flipping any field or the signing key invalidates the request.
    function testFuzz_anchorRejectsTampered(
        uint8 nsSeed,
        bytes32 root,
        bytes32 termsHash,
        bytes32 nonce,
        uint8 which,
        uint8 bit
    ) public {
        vm.assume(root != bytes32(0));
        uint32 ns = uint32(nsSeed % 16);
        Req memory r = build(ns, root, termsHash, nonce);
        uint256 mask = 1 << (bit % 256);
        uint8 mode = which % 5;
        if (mode == 0) {
            r.root ^= bytes32(mask);
        } else if (mode == 1) {
            r.termsHash ^= bytes32(mask);
        } else if (mode == 2) {
            r.nonce ^= bytes32(mask);
        } else if (mode == 3) {
            r.ns = (ns + 1 + (bit % 15)) % 16;
        } // another (attested) namespace's slot
        else {
            uint256 k = 32 + (bit % 32);
            r.sig[k] = bytes1(uint8(r.sig[k]) ^ 1);
        }
        if (mode == 0 && r.root == bytes32(0)) return; // ZeroRoot is covered elsewhere
        vm.expectRevert();
        submit(r);
        assertFalse(anchors.isAnchored(root));
        assertFalse(anchors.isAnchored(r.root));
    }

    /// @notice Batch indices are dense per (principal, ns, epoch) page, in submission order.
    function testFuzz_denseIndices(uint8 nsSeed, uint8 countSeed) public {
        uint32 ns = uint32(nsSeed % 16);
        uint256 count = 1 + (countSeed % 6);
        for (uint256 i = 0; i < count; ++i) {
            bytes32 root = keccak256(abi.encode(ns, i, "dense"));
            assertEq(submit(build(ns, root, keccak256("t"), bytes32(i + 1))), i);
            assertEq(anchors.anchorOf(root).batchIndex, uint32(i));
        }
        assertEq(anchors.batchCount(principalId, ns, EPOCH), count);
    }
}

contract PassportAnchorsBaselineFuzzTest is PassportAnchorsFuzz {
    function deployAnchors(
        PrincipalRegistry registry_
    ) internal override returns (PassportAnchors) {
        return new PassportAnchorsBaseline(registry_);
    }
}

contract PassportAnchorsPagedFuzzTest is PassportAnchorsFuzz {
    function deployAnchors(
        PrincipalRegistry registry_
    ) internal override returns (PassportAnchors) {
        return new PassportAnchorsPaged(registry_);
    }
}
