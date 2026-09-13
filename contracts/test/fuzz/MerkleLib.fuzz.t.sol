// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MerkleLib} from "../../src/libraries/MerkleLib.sol";
import {BatchProof} from "../../src/types/Structs.sol";

contract MerkleLibFuzzTest is Test {
    /// @dev Reference full-tree builder (256 slots, all levels materialised) used only to produce proofs.
    function buildLayers(
        bytes32[] memory leaves
    ) internal pure returns (bytes32[][] memory layers) {
        layers = new bytes32[][](MerkleLib.DEPTH + 1);
        layers[0] = new bytes32[](MerkleLib.BATCH_SIZE);
        for (uint256 i = 0; i < leaves.length; ++i) {
            layers[0][i] = leaves[i];
        }
        for (uint256 level = 0; level < MerkleLib.DEPTH; ++level) {
            uint256 size = layers[level].length / 2;
            layers[level + 1] = new bytes32[](size);
            for (uint256 i = 0; i < size; ++i) {
                layers[level + 1][i] = MerkleLib.hashNode(layers[level][2 * i], layers[level][2 * i + 1]);
            }
        }
    }

    function prove(bytes32[][] memory layers, uint256 index) internal pure returns (BatchProof memory proof) {
        proof.index = uint8(index);
        uint256 pos = index;
        for (uint256 level = 0; level < MerkleLib.DEPTH; ++level) {
            proof.siblings[level] = layers[level][pos ^ 1];
            pos >>= 1;
        }
    }

    function testFuzz_sparseRootEqualsFullTree(bytes32[] memory ids, uint8 indexSeed) public pure {
        vm.assume(ids.length > 0 && ids.length <= MerkleLib.BATCH_SIZE);
        bytes32[] memory leaves = new bytes32[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            leaves[i] = MerkleLib.hashLeaf(ids[i]);
        }
        bytes32[][] memory layers = buildLayers(leaves);
        bytes32 root = MerkleLib.computeRoot(leaves);
        assertEq(root, layers[MerkleLib.DEPTH][0], "sparse root != full-tree root");

        uint256 index = uint256(indexSeed) % ids.length;
        BatchProof memory proof = prove(layers, index);
        assertTrue(MerkleLib.verifyPassport(root, ids[index], proof), "own index must verify");
        // Swapping to the sibling slot must fail — unless the sibling holds the very same id, which real
        // batches never do (structural dedup) but the fuzzer will happily generate.
        uint256 sibling = index ^ 1;
        vm.assume(sibling >= ids.length || ids[sibling] != ids[index]);
        proof.index = uint8(sibling);
        assertFalse(MerkleLib.verifyPassport(root, ids[index], proof), "sibling index must not verify");
    }

    function testFuzz_paddingSlotsAreUnprovable(bytes32 id, uint8 slot) public pure {
        vm.assume(slot != 0);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = MerkleLib.hashLeaf(id);
        bytes32[][] memory layers = buildLayers(leaves);
        BatchProof memory proof = prove(layers, slot);
        // The slot is a valid position for the raw padding value…
        assertTrue(MerkleLib.verify(layers[MerkleLib.DEPTH][0], MerkleLib.Z0, proof));
        // …but no passport id (including zero) can be proved there, because leaves are always prefixed-hashed.
        assertFalse(MerkleLib.verifyPassport(layers[MerkleLib.DEPTH][0], bytes32(0), proof));
    }
}
