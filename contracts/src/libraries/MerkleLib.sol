// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BatchProof} from "../types/Structs.sol";

/// @title MerkleLib
/// @notice Fixed-depth (8), index-addressed batch Merkle trees (ADR-0004). Twin of the core TS `merkle` module.
/// @dev    hashLeaf(id) = keccak256(0x00 ‖ id); hashNode(l, r) = keccak256(0x01 ‖ l ‖ r).
///         Ordered pairs: the leaf index selects the side at each level, so a proof also proves position.
///         Padding slots hold Z0 = bytes32(0) which is not `keccak256(0x00 ‖ x)` for any known x.
library MerkleLib {
    uint256 internal constant DEPTH = 8;
    uint256 internal constant BATCH_SIZE = 256;

    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error IndexOutOfRange(uint256 index);

    // Z_k = root of an all-padding subtree of height k. Values cross-checked by test-vectors (`cast keccak`).
    bytes32 internal constant Z0 = bytes32(0);
    bytes32 internal constant Z1 = 0xc07a1e8b7e0057673fdc2affe190d8a960c5fe615663f27b7ce84f3d93ef92a6;
    bytes32 internal constant Z2 = 0xfd47517474a597637d54038a0663d1d03b931b238de06b73e3c12cf443de6e8d;
    bytes32 internal constant Z3 = 0x47a8f5e8fa70be2760378067c9c6d410dd96be07820b4230c11254c7ff10c298;
    bytes32 internal constant Z4 = 0xaed19ca4bfe2365b1b33fa94744cd0c6a2d550506c7e7efc073879cb79459b9a;
    bytes32 internal constant Z5 = 0x6e6998a7da8b2db5c98eb853099d8caec63797b5283b7dac37b2ffb630a86e24;
    bytes32 internal constant Z6 = 0x181c19735bff23b55bc295fc0b60c1c5c7288209b261a08e26924598ce72404e;
    bytes32 internal constant Z7 = 0xecb408b290ab2920e63611ef1e8ca964aebb66ea5739f19d24b92094f28e44f8;
    bytes32 internal constant Z8 = 0x294bf9785e1391d24d52abf915636a73bdaa12ed29e85e21dae14c09d0f2e34b;

    function zeroHash(
        uint256 level
    ) internal pure returns (bytes32) {
        if (level == 0) return Z0;
        if (level == 1) return Z1;
        if (level == 2) return Z2;
        if (level == 3) return Z3;
        if (level == 4) return Z4;
        if (level == 5) return Z5;
        if (level == 6) return Z6;
        if (level == 7) return Z7;
        if (level == 8) return Z8;
        revert IndexOutOfRange(level);
    }

    function hashLeaf(
        bytes32 passportId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint8(0x00), passportId));
    }

    function hashNode(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint8(0x01), left, right));
    }

    /// @notice Root over already-hashed leaves (1..256), padding with zero subtrees.
    /// @dev    O(n) hashes: once the working layer is exhausted, the remaining right siblings are Z_k.
    function computeRoot(
        bytes32[] memory leaves
    ) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) revert EmptyBatch();
        if (n > BATCH_SIZE) revert BatchTooLarge(n);

        // Work on a copy so the caller's array is untouched; levels shrink in place from there.
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            layer[i] = leaves[i];
        }
        for (uint256 level = 0; level < DEPTH; ++level) {
            bytes32 z = zeroHash(level);
            uint256 next = (n + 1) / 2;
            for (uint256 i = 0; i < next; ++i) {
                bytes32 left = layer[2 * i];
                bytes32 right = 2 * i + 1 < n ? layer[2 * i + 1] : z;
                layer[i] = hashNode(left, right);
            }
            n = next;
        }
        return layer[0];
    }

    /// @notice Convenience: hashes ids as leaves first.
    function computeRootFromIds(
        bytes32[] memory passportIds
    ) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](passportIds.length);
        for (uint256 i = 0; i < passportIds.length; ++i) {
            leaves[i] = hashLeaf(passportIds[i]);
        }
        return computeRoot(leaves);
    }

    /// @notice Recomputes the root from `leaf` at `proof.index` and compares to `root`. Never reverts.
    function verify(bytes32 root, bytes32 leaf, BatchProof memory proof) internal pure returns (bool) {
        bytes32 node = leaf;
        uint256 index = proof.index;
        for (uint256 level = 0; level < DEPTH; ++level) {
            bytes32 sibling = proof.siblings[level];
            node = ((index >> level) & 1) == 0 ? hashNode(node, sibling) : hashNode(sibling, node);
        }
        return node == root;
    }

    /// @notice Verifies that `passportId` sits at `proof.index` of the batch with `root`.
    function verifyPassport(bytes32 root, bytes32 passportId, BatchProof memory proof) internal pure returns (bool) {
        return verify(root, hashLeaf(passportId), proof);
    }
}
