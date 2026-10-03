// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PassportLib} from "./PassportLib.sol";

/// @title AuthorityDigests
/// @notice EIP-712 struct hashes for every P-256 (human authority) operation: enroll, attest, grant, accept
///         terms, rescind, and the commit-reveal rescission fallback. Signed by the derived authority key,
///         verified via `P256.verify` against the enrolled commitment.
/// @dev    Phase 1 fills in the TypeScript twin (core TS `authority/digests`). Type strings here are
///         the source of truth; a `nonce` on every struct gives replay protection across contracts.
library AuthorityDigests {
    bytes32 internal constant ENROLL_TYPEHASH = keccak256("Enroll(bytes32 keyCommit,uint64 epoch,bytes32 nonce)");
    bytes32 internal constant ATTEST_TYPEHASH =
        keccak256("Attest(bytes32 principalId,uint64 epoch,bytes32 depositKeysRoot,bytes32 nonce)");
    bytes32 internal constant GRANT_TYPEHASH = keccak256(
        "Grant(bytes32 principalId,bytes32 granteeCard,uint32 ns,uint64 epochStart,uint64 term,bytes32 termsHash,bytes32 wrapRef,bytes32 nonce)"
    );
    bytes32 internal constant ACCEPT_TERMS_TYPEHASH =
        keccak256("AcceptTerms(bytes32 granteeCard,bytes32 principalId,uint32 ns,bytes32 termsHash,bytes32 nonce)");
    bytes32 internal constant RESCIND_TYPEHASH = keccak256("Rescind(bytes32 grantId,uint64 epoch,bytes32 nonce)");
    bytes32 internal constant RESCIND_COMMIT_TYPEHASH = keccak256("RescindCommit(bytes32 commitment,bytes32 nonce)");
    bytes32 internal constant REGISTER_DEVICE_TYPEHASH =
        keccak256("RegisterDevice(bytes32 principalId,bytes32 keyCommitment,bytes32 nonce)");
    bytes32 internal constant REVOKE_DEVICE_TYPEHASH =
        keccak256("RevokeDevice(bytes32 principalId,bytes32 keyCommitment,bytes32 nonce)");
    bytes32 internal constant ANCHOR_TYPEHASH = keccak256(
        "Anchor(bytes32 principalId,uint32 ns,uint64 epoch,bytes32 batchRoot,bytes32 termsHash,bytes32 nonce)"
    );

    function enroll(bytes32 keyCommit, uint64 epoch, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(ENROLL_TYPEHASH, keyCommit, epoch, nonce));
    }

    function attest(
        bytes32 principalId,
        uint64 epoch,
        bytes32 depositKeysRoot,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(ATTEST_TYPEHASH, principalId, epoch, depositKeysRoot, nonce));
    }

    function grant(
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart,
        uint64 term,
        bytes32 termsHash,
        bytes32 wrapRef,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(GRANT_TYPEHASH, principalId, granteeCard, ns, epochStart, term, termsHash, wrapRef, nonce)
        );
    }

    function acceptTerms(
        bytes32 granteeCard,
        bytes32 principalId,
        uint32 ns,
        bytes32 termsHash,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(ACCEPT_TERMS_TYPEHASH, granteeCard, principalId, ns, termsHash, nonce));
    }

    function rescind(bytes32 grantId, uint64 epoch, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(RESCIND_TYPEHASH, grantId, epoch, nonce));
    }

    function rescindCommit(bytes32 commitment, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(RESCIND_COMMIT_TYPEHASH, commitment, nonce));
    }

    /// @notice Binds one secure element to one principal (ADR-0015). The key commitment comes
    ///         from the attestation chain, so the human is signing over a device the certificate
    ///         named, not one the caller asserted.
    function registerDevice(
        bytes32 principalId,
        bytes32 keyCommitment,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(REGISTER_DEVICE_TYPEHASH, principalId, keyCommitment, nonce));
    }

    /// @notice Ends a device's ability to witness captures — what a stolen phone needs.
    function revokeDevice(bytes32 principalId, bytes32 keyCommitment, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(REVOKE_DEVICE_TYPEHASH, principalId, keyCommitment, nonce));
    }

    /// @dev Signed by the secp256k1 deposit key; relayable by anyone (decision #11).
    function anchor(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        bytes32 batchRoot,
        bytes32 termsHash,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(ANCHOR_TYPEHASH, principalId, ns, epoch, batchRoot, termsHash, nonce));
    }

    /// @notice Final EIP-712 digest under the FIRSTHAND domain for `verifyingContract`.
    function digest(bytes32 structHash, uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return PassportLib.digestOf(structHash, PassportLib.domainSeparator(chainId, verifyingContract));
    }
}
