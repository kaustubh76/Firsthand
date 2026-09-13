// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {PassportAnchors} from "./PassportAnchors.sol";
import {AnchorRecord} from "./types/Structs.sol";

/// @title PassportAnchorsPaged
/// @notice Clustered "storage page" layout — the H1 treatment arm for MIP-8 (README §8 claim 2).
/// @dev    All state for one (principal, ns, epoch) lives in ONE contiguous run of slots:
///
///           base + 0        count
///           base + 1        principalId
///           base + 2        packed(ns, epoch)
///           base + 3 + 3i   batchRoot_i
///           base + 4 + 3i   termsHash_i
///           base + 5 + 3i   packed(blockNumber_i, batchIndex_i)
///
///         `base = keccak256(principalId ‖ ns ‖ epoch ‖ salt)` with the low 32 bits cleared, so a single
///         scattered pointer slot per root can carry `base | (index + 1)` for O(1) lookup by root. Compared to the
///         baseline, a page-local anchor writes 3 contiguous slots + 1 pointer instead of 5 slots across 2 keccak
///         locations. Whether Monad's MIP-8 pricing rewards this exact clustering is what S1's on-chain arms
///         measure; the layout is a best-guess pending the MIP-8 spec (Phase 0 gate) and is isolated here so it
///         can change without touching validation or the interface.
contract PassportAnchorsPaged is PassportAnchors {
    bytes32 internal constant PAGE_SALT = keccak256("firsthand.anchors.page.v1");
    uint256 internal constant HEADER = 3;
    uint256 internal constant STRIDE = 3;
    uint256 internal constant LOW32 = 0xffffffff;

    /// @dev batchRoot → base | (index + 1); zero when unknown.
    mapping(bytes32 batchRoot => uint256 pointer) internal _pointer;

    constructor(
        IPrincipalRegistry registry_
    ) PassportAnchors(registry_) {}

    function layout() external pure override returns (string memory) {
        return "paged";
    }

    function batchCount(bytes32 principalId, uint32 ns, uint64 epoch) external view returns (uint256) {
        return _sload(_base(principalId, ns, epoch));
    }

    function batchRootAt(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        uint256 batchIndex
    ) external view returns (bytes32) {
        uint256 base = _base(principalId, ns, epoch);
        if (batchIndex >= _sload(base)) return bytes32(0);
        return bytes32(_sload(base + HEADER + STRIDE * batchIndex));
    }

    function _pageAppend(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        bytes32 batchRoot
    ) internal override returns (uint256 batchIndex) {
        uint256 base = _base(principalId, ns, epoch);
        batchIndex = _sload(base);
        if (batchIndex == 0) {
            _sstore(base + 1, uint256(principalId));
            _sstore(base + 2, (uint256(ns) << 64) | uint256(epoch));
        }
        _sstore(base, batchIndex + 1);
        _sstore(base + HEADER + STRIDE * batchIndex, uint256(batchRoot));
        _pointer[batchRoot] = base | (batchIndex + 1);
    }

    function _store(bytes32 batchRoot, AnchorRecord memory record) internal override {
        uint256 pointer = _pointer[batchRoot];
        uint256 slot = (pointer & ~LOW32) + HEADER + STRIDE * ((pointer & LOW32) - 1);
        _sstore(slot + 1, uint256(record.termsHash));
        _sstore(slot + 2, (uint256(record.blockNumber) << 32) | uint256(record.batchIndex));
    }

    function _load(
        bytes32 batchRoot
    ) internal view override returns (AnchorRecord memory record) {
        uint256 pointer = _pointer[batchRoot];
        if (pointer == 0) return record;
        uint256 base = pointer & ~LOW32;
        uint256 slot = base + HEADER + STRIDE * ((pointer & LOW32) - 1);
        uint256 nsEpoch = _sload(base + 2);
        uint256 meta = _sload(slot + 2);
        record.principalId = bytes32(_sload(base + 1));
        record.termsHash = bytes32(_sload(slot + 1));
        record.ns = uint32(nsEpoch >> 64);
        record.epoch = uint64(nsEpoch);
        record.blockNumber = uint64(meta >> 32);
        record.batchIndex = uint32(meta);
    }

    function _exists(
        bytes32 batchRoot
    ) internal view override returns (bool) {
        return _pointer[batchRoot] != 0;
    }

    function _base(bytes32 principalId, uint32 ns, uint64 epoch) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(principalId, ns, epoch, PAGE_SALT))) & ~LOW32;
    }

    function _sload(
        uint256 slot
    ) internal view returns (uint256 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    function _sstore(uint256 slot, uint256 value) internal {
        assembly ("memory-safe") {
            sstore(slot, value)
        }
    }
}
