// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {PassportAnchors} from "./PassportAnchors.sol";
import {AnchorRecord} from "./types/Structs.sol";

/// @title PassportAnchorsBaseline
/// @notice Plain-mapping layout — the H1 baseline arm. Each anchor touches two keccak-scattered locations:
///         the record mapping (3 slots) and the page array (length + element).
contract PassportAnchorsBaseline is PassportAnchors {
    mapping(bytes32 batchRoot => AnchorRecord) internal _records;
    mapping(bytes32 pageKey => bytes32[] roots) internal _pages;

    constructor(
        IPrincipalRegistry registry_
    ) PassportAnchors(registry_) {}

    function layout() external pure override returns (string memory) {
        return "baseline";
    }

    function batchCount(bytes32 principalId, uint32 ns, uint64 epoch) external view returns (uint256) {
        return _pages[_pageKey(principalId, ns, epoch)].length;
    }

    function batchRootAt(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        uint256 batchIndex
    ) external view returns (bytes32) {
        bytes32[] storage roots = _pages[_pageKey(principalId, ns, epoch)];
        return batchIndex < roots.length ? roots[batchIndex] : bytes32(0);
    }

    function _pageAppend(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        bytes32 batchRoot
    ) internal override returns (uint256 batchIndex) {
        bytes32[] storage roots = _pages[_pageKey(principalId, ns, epoch)];
        batchIndex = roots.length;
        roots.push(batchRoot);
    }

    function _store(bytes32 batchRoot, AnchorRecord memory record) internal override {
        _records[batchRoot] = record;
    }

    function _load(
        bytes32 batchRoot
    ) internal view override returns (AnchorRecord memory) {
        return _records[batchRoot];
    }

    function _exists(
        bytes32 batchRoot
    ) internal view override returns (bool) {
        return _records[batchRoot].principalId != bytes32(0);
    }

    function _pageKey(bytes32 principalId, uint32 ns, uint64 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encode(principalId, ns, epoch));
    }
}
