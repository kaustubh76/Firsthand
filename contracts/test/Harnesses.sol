// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SplitMath} from "../src/libraries/SplitMath.sol";
import {MerkleLib} from "../src/libraries/MerkleLib.sol";
import {PassportLib} from "../src/libraries/PassportLib.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {P256} from "../src/libraries/P256.sol";
import {BatchProof} from "../src/types/Structs.sol";

/// @dev External wrappers so `vm.expectRevert` and gas reports can target library code.
contract SplitMathHarness {
    function split(uint256 price, uint256[] memory weights) external pure returns (uint256[] memory, uint256) {
        return SplitMath.split(price, weights);
    }

    function validateWeights(
        uint256[] memory weights
    ) external pure {
        SplitMath.validateWeights(weights);
    }
}

contract MerkleHarness {
    function computeRoot(
        bytes32[] memory leaves
    ) external pure returns (bytes32) {
        return MerkleLib.computeRoot(leaves);
    }

    function computeRootFromIds(
        bytes32[] memory ids
    ) external pure returns (bytes32) {
        return MerkleLib.computeRootFromIds(ids);
    }

    function verify(bytes32 root, bytes32 leaf, BatchProof memory proof) external pure returns (bool) {
        return MerkleLib.verify(root, leaf, proof);
    }

    function verifyPassport(bytes32 root, bytes32 id, BatchProof memory proof) external pure returns (bool) {
        return MerkleLib.verifyPassport(root, id, proof);
    }

    function zeroHash(
        uint256 level
    ) external pure returns (bytes32) {
        return MerkleLib.zeroHash(level);
    }

    function hashLeaf(
        bytes32 id
    ) external pure returns (bytes32) {
        return MerkleLib.hashLeaf(id);
    }
}

contract PassportHarness {
    function verify(PassportLib.Passport memory p, bytes memory sig, bytes32 ds) external pure returns (bool) {
        return PassportLib.verify(p, sig, ds);
    }

    function recoverOrigin(bytes32 digest, bytes memory sig) external pure returns (address) {
        return PassportLib.recoverOrigin(digest, sig);
    }
}

contract EpochHarness {
    function epochAt(uint64 ts, uint64 genesis, uint64 length) external pure returns (uint64) {
        return EpochLib.epochAt(ts, genesis, length);
    }
}

contract P256Harness {
    function verify(bytes32 h, uint256 r, uint256 s, uint256 x, uint256 y) external view returns (bool) {
        return P256.verify(h, r, s, x, y);
    }

    function verifySignature(bytes32 h, bytes memory sig, uint256 x, uint256 y) external view returns (bool) {
        return P256.verifySignature(h, sig, x, y);
    }
}
