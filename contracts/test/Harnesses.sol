// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SplitMath} from "../src/libraries/SplitMath.sol";
import {MerkleLib} from "../src/libraries/MerkleLib.sol";
import {PassportLib} from "../src/libraries/PassportLib.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {P256} from "../src/libraries/P256.sol";
import {Der} from "../src/libraries/Der.sol";
import {AndroidKeyAttestation} from "../src/libraries/AndroidKeyAttestation.sol";
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

/// @dev `Der`'s surface, reachable from a test. An `internal` library revert cannot be caught by
///      `vm.expectRevert` and is mis-attributed by `forge coverage`, so every entry point gets a
///      wrapper. Offsets rather than `Tlv` arguments, so a test names a position in the fixture
///      rather than reconstructing a struct the library just built.
contract DerHarness {
    function readTlv(bytes calldata data, uint256 offset) external pure returns (Der.Tlv memory) {
        return Der.readTlv(data, offset);
    }

    function firstChild(bytes calldata data, uint256 offset) external pure returns (Der.Tlv memory) {
        return Der.firstChild(data, Der.readTlv(data, offset));
    }

    function nthChild(bytes calldata data, uint256 offset, uint256 n) external pure returns (Der.Tlv memory) {
        Der.Tlv memory parent = Der.readTlv(data, offset);
        return Der.skip(data, parent, Der.firstChild(data, parent), n);
    }

    /// @dev Walks every sibling, so one call exercises `hasNext` and `nextSibling` to exhaustion.
    function childCount(bytes calldata data, uint256 offset) external pure returns (uint256 count) {
        Der.Tlv memory parent = Der.readTlv(data, offset);
        Der.Tlv memory child = Der.firstChild(data, parent);
        count = 1;
        while (Der.hasNext(parent, child)) {
            child = Der.nextSibling(data, parent, child);
            ++count;
        }
    }

    /// @dev Asks for a sibling the parent does not have — the one arm `childCount` never reaches.
    function siblingPastEnd(bytes calldata data, uint256 offset) external pure returns (Der.Tlv memory) {
        Der.Tlv memory parent = Der.readTlv(data, offset);
        Der.Tlv memory child = Der.firstChild(data, parent);
        while (Der.hasNext(parent, child)) {
            child = Der.nextSibling(data, parent, child);
        }
        return Der.nextSibling(data, parent, child);
    }

    function requireTag(bytes calldata data, uint256 offset, uint8 tagClass, uint32 tagNumber) external pure {
        Der.requireTag(Der.readTlv(data, offset), tagClass, tagNumber);
    }

    function content(bytes calldata data, uint256 offset) external pure returns (bytes memory) {
        return Der.content(data, Der.readTlv(data, offset));
    }

    function element(bytes calldata data, uint256 offset) external pure returns (bytes memory) {
        return Der.element(data, Der.readTlv(data, offset));
    }

    function bitString(bytes calldata data, uint256 offset) external pure returns (bytes memory) {
        return Der.bitString(data, Der.readTlv(data, offset));
    }

    function smallUint(bytes calldata data, uint256 offset) external pure returns (uint256) {
        return Der.smallUint(data, Der.readTlv(data, offset));
    }

    function unsignedInteger(bytes calldata data, uint256 offset) external pure returns (uint256) {
        return Der.unsignedInteger(data, Der.readTlv(data, offset));
    }

    function isOid(bytes calldata data, uint256 offset, bytes calldata oid) external pure returns (bool) {
        return Der.isOid(data, Der.readTlv(data, offset), oid);
    }

    function word(bytes calldata data, uint256 offset) external pure returns (uint256) {
        return Der.word(data, offset);
    }
}

/// @dev Same reason as `DerHarness`: an `internal` library revert is uncatchable without a wrapper.
contract AndroidKeyAttestationHarness {
    function parseCertificate(
        bytes calldata cert
    ) external pure returns (AndroidKeyAttestation.Certificate memory) {
        return AndroidKeyAttestation.parseCertificate(cert);
    }

    function keyDescriptionOf(
        bytes calldata cert
    ) external pure returns (AndroidKeyAttestation.KeyDescription memory) {
        return AndroidKeyAttestation.keyDescriptionOf(cert);
    }
}
