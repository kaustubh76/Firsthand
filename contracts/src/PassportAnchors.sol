// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPassportAnchors} from "./interfaces/IPassportAnchors.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {AuthorityDigests} from "./libraries/AuthorityDigests.sol";
import {MerkleLib} from "./libraries/MerkleLib.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {AnchorRecord, BatchProof} from "./types/Structs.sol";

/// @title PassportAnchors
/// @notice Anchors passport batches (README §7.1): the chain holds only Merkle roots and terms hashes; passports and
///         ciphertext live off-chain. Validation is identical across layouts; subclasses only decide *where* the
///         record lands (`_store` / `_load` / `_pageAppend`), which is what the H1 experiment measures (ADR-0010).
abstract contract PassportAnchors is IPassportAnchors {
    uint32 internal constant MAX_NAMESPACES = 16;

    IPrincipalRegistry internal immutable _registry;
    mapping(bytes32 principalId => mapping(bytes32 nonce => bool)) internal _nonceUsed;

    constructor(
        IPrincipalRegistry registry_
    ) {
        _registry = registry_;
    }

    // ── mutation ────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPassportAnchors
    function anchor(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        bytes32 batchRoot,
        bytes32 termsHash,
        bytes32 nonce,
        address[16] calldata depositKeys,
        bytes calldata depositSig
    ) external returns (uint256 batchIndex) {
        if (ns >= MAX_NAMESPACES) revert NamespaceOutOfRange(ns);
        if (batchRoot == bytes32(0)) revert ZeroRoot();
        if (_exists(batchRoot)) revert DuplicateRoot(batchRoot);
        _requireAttestedEpoch(principalId, epoch, depositKeys);
        if (_nonceUsed[principalId][nonce]) revert NonceAlreadyUsed(nonce);
        _nonceUsed[principalId][nonce] = true;

        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.anchor(principalId, ns, epoch, batchRoot, termsHash, nonce), domainSeparator()
        );
        address recovered = PassportLib.recoverOrigin(digest, depositSig);
        if (recovered == address(0) || recovered != depositKeys[ns]) {
            revert InvalidDepositSignature(recovered, depositKeys[ns]);
        }

        batchIndex = _pageAppend(principalId, ns, epoch, batchRoot);
        _store(
            batchRoot,
            AnchorRecord({
                principalId: principalId,
                termsHash: termsHash,
                epoch: epoch,
                blockNumber: uint64(block.number),
                ns: ns,
                batchIndex: uint32(batchIndex)
            })
        );
        emit BatchAnchored(principalId, ns, epoch, batchRoot, termsHash, batchIndex);
    }

    // ── views ───────────────────────────────────────────────────────────────────────────────────

    function isAnchored(
        bytes32 batchRoot
    ) external view returns (bool) {
        return _exists(batchRoot);
    }

    function anchorBlock(
        bytes32 batchRoot
    ) external view returns (uint64) {
        return _load(batchRoot).blockNumber;
    }

    function termsOf(
        bytes32 batchRoot
    ) external view returns (bytes32) {
        return _load(batchRoot).termsHash;
    }

    function anchorOf(
        bytes32 batchRoot
    ) external view returns (AnchorRecord memory) {
        return _load(batchRoot);
    }

    function isIncluded(
        bytes32 batchRoot,
        bytes32 passportId,
        BatchProof calldata proof
    ) external view returns (bool) {
        return _exists(batchRoot) && MerkleLib.verifyPassport(batchRoot, passportId, proof);
    }

    function nonceUsed(bytes32 principalId, bytes32 nonce) external view returns (bool) {
        return _nonceUsed[principalId][nonce];
    }

    function domainSeparator() public view returns (bytes32) {
        return PassportLib.domainSeparator(block.chainid, address(this));
    }

    function registry() external view returns (address) {
        return address(_registry);
    }

    // ── layout hooks ────────────────────────────────────────────────────────────────────────────

    /// @dev Appends `batchRoot` to the (principal, ns, epoch) page; returns its index within the page.
    function _pageAppend(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        bytes32 batchRoot
    ) internal virtual returns (uint256 batchIndex);
    function _store(bytes32 batchRoot, AnchorRecord memory record) internal virtual;
    function _load(
        bytes32 batchRoot
    ) internal view virtual returns (AnchorRecord memory);
    function _exists(
        bytes32 batchRoot
    ) internal view virtual returns (bool);

    // ── internals ───────────────────────────────────────────────────────────────────────────────

    function _requireAttestedEpoch(bytes32 principalId, uint64 epoch, address[16] calldata depositKeys) internal view {
        uint64 current = _registry.currentEpoch();
        if (epoch > current) revert EpochInFuture(epoch, current);
        bytes32 expected = _registry.depositKeysRoot(principalId, epoch);
        if (expected == bytes32(0)) revert EpochNotAttested(principalId, epoch);
        bytes32 actual = keccak256(abi.encodePacked(depositKeys));
        if (actual != expected) revert DepositKeysMismatch(expected, actual);
    }
}
