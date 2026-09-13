// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VectorTest} from "../Vectors.sol";
import {MerkleHarness} from "../Harnesses.sol";
import {MerkleLib} from "../../src/libraries/MerkleLib.sol";
import {BatchProof} from "../../src/types/Structs.sol";

contract MerkleLibTest is VectorTest {
    MerkleHarness internal h;

    function setUp() public {
        loadSuite("merkle");
        h = new MerkleHarness();
    }

    function test_zeroHashesMatchVectors() public view {
        bytes32[] memory zs = vm.parseJsonBytes32Array(json, ".extra.zeroHashes");
        assertEq(zs.length, MerkleLib.DEPTH + 1);
        for (uint256 i = 0; i <= MerkleLib.DEPTH; ++i) {
            assertEq(h.zeroHash(i), zs[i], "zero hash");
        }
        // The zero *id* hashes to something other than the padding value: padding is unprovable.
        assertEq(h.hashLeaf(bytes32(0)), vm.parseJsonBytes32(json, ".extra.leafOfZeroId"));
        assertTrue(h.hashLeaf(bytes32(0)) != MerkleLib.Z0);
    }

    function test_zeroHashOutOfRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MerkleLib.IndexOutOfRange.selector, 9));
        h.zeroHash(9);
    }

    function test_vectors() public view {
        assertHandCases(3);
        for (uint256 i = 0; i < count; ++i) {
            string memory name = caseName(i);
            bytes32[] memory ids = b32Arr(i, ".input.passportIds");
            bytes32 root = h.computeRootFromIds(ids);
            assertEq(root, b32(i, ".expected.root"), name);
            bytes32 pid = b32(i, ".input.passportId");
            assertEq(h.hashLeaf(pid), b32(i, ".expected.leaf"), name);
            BatchProof memory proof = proofFrom(i);
            assertEq(h.verifyPassport(root, pid, proof), boolean(i, ".expected.valid"), name);
        }
    }

    function test_emptyAndOversizedBatchesRevert() public {
        vm.expectRevert(MerkleLib.EmptyBatch.selector);
        h.computeRoot(new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(MerkleLib.BatchTooLarge.selector, 257));
        h.computeRoot(new bytes32[](257));
    }

    function test_computeRootDoesNotMutateInput() public view {
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = bytes32(uint256(1));
        leaves[1] = bytes32(uint256(2));
        leaves[2] = bytes32(uint256(3));
        h.computeRoot(leaves);
        assertEq(leaves[1], bytes32(uint256(2)));
    }

    function proofFrom(
        uint256 i
    ) internal view returns (BatchProof memory proof) {
        proof.index = uint8(u(i, ".input.index"));
        bytes32[] memory sib = b32Arr(i, ".input.siblings");
        for (uint256 k = 0; k < 8; ++k) {
            proof.siblings[k] = sib[k];
        }
    }
}
