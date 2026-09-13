// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Card, GrantState, GrantStatus, RegisteredTerms, TermsInput} from "../types/Structs.sol";

/// @title IGrantManager
/// @notice Grant lifecycle state machine (README §7.2, §7.5, §11), terms acceptance and grantee cards (ADR-0011).
/// @dev    grant / rescind: principal P-256 signature only. acceptTerms: the card owner's secp256k1 signature.
///         Only ACTIVE and RESCINDED are written; EXPIRED and FROZEN are derived in `effectiveStatus`.
///         No transition ever re-releases a wrapped key: the wrap reference is immutable per grant.
///         All signatures verify under this contract's own EIP-712 domain (ADR-0009).
interface IGrantManager {
    event CardRegistered(bytes32 indexed cardId, address indexed owner, bytes32 encryptionPubKey);
    event TermsAccepted(bytes32 indexed granteeCard, bytes32 indexed principalId, uint32 ns, bytes32 termsHash);
    event GrantCreated(
        bytes32 indexed grantId,
        bytes32 indexed principalId,
        bytes32 indexed granteeCard,
        uint32 ns,
        uint64 epochStart,
        uint64 term,
        bytes32 termsHash,
        bytes32 wrapRef
    );
    event GrantRescinded(bytes32 indexed grantId, uint64 epochEnd, uint64 effectiveBlock, bool viaCommitReveal);

    error UnknownCard(bytes32 cardId);
    error UnknownPrincipal(bytes32 principalId);
    error TermsNotAccepted(bytes32 granteeCard, bytes32 termsHash);
    error GrantExists(bytes32 grantId);
    error GrantNotLive(bytes32 grantId);
    error GrantAlreadyRescinded(bytes32 grantId);
    error TermTooLong(uint64 term);
    error ZeroTerm();
    error PriceBelowFloor(uint64 price);
    error EpochNotCurrent(uint64 epoch, uint64 current);
    error InvalidAuthoritySignature();
    error InvalidCardSignature();
    error NonceAlreadyUsed(bytes32 nonce);
    error CommitMissing(bytes32 commitment);
    error RevealWindowElapsed(uint64 commitBlock, uint64 window);

    /// @notice Permissionless, idempotent. `cardId = keccak256(abi.encode(owner, encryptionPubKey))`.
    function registerCard(address owner, bytes32 encryptionPubKey) external returns (bytes32 cardId);

    /// @notice Grantee accepts `terms` (registered by preimage) for a principal's namespace. Signed by the card owner.
    function acceptTerms(
        bytes32 granteeCard,
        bytes32 principalId,
        TermsInput calldata terms,
        bytes32 nonce,
        bytes calldata cardSig
    ) external returns (bytes32 termsHash);

    function grant(
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart,
        uint64 term,
        bytes32 termsHash,
        bytes32 wrapRef,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external returns (bytes32 grantId);

    /// @notice Direct rescission — transported over BTX where available.
    function rescind(bytes32 grantId, uint64 epoch, bytes32 nonce, bytes calldata authoritySig) external;

    /// @notice Commit-reveal fallback: the commit was posted to `IRescissions` earlier; the end of consent is the
    ///         commit block, not the reveal block.
    function revealRescind(bytes32 grantId, bytes32 salt, bytes32 nonce, bytes calldata authoritySig) external;

    function cardOf(
        bytes32 cardId
    ) external view returns (Card memory);
    function cardIdOf(address owner, bytes32 encryptionPubKey) external pure returns (bytes32);
    function termsOf(
        bytes32 termsHash
    ) external view returns (RegisteredTerms memory);
    function grantState(
        bytes32 grantId
    ) external view returns (GrantState memory);
    function principalOf(
        bytes32 grantId
    ) external view returns (bytes32);
    function wrapRefOf(
        bytes32 grantId
    ) external view returns (bytes32);
    function termsAccepted(
        bytes32 granteeCard,
        bytes32 principalId,
        uint32 ns,
        bytes32 termsHash
    ) external view returns (bool);
    /// @notice Lazily-derived status at the current epoch (RESCINDED > EXPIRED > FROZEN > ACTIVE).
    function effectiveStatus(
        bytes32 grantId
    ) external view returns (GrantStatus);
    function grantIdOf(
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart
    ) external pure returns (bytes32);
    function nonceUsed(bytes32 scope, bytes32 nonce) external view returns (bool);
    function domainSeparator() external view returns (bytes32);
    function currentEpoch() external view returns (uint64);
    function registry() external view returns (address);
    function rescissions() external view returns (address);
    function maxTerm() external view returns (uint64);
    function priceFloor() external view returns (uint64);
    function revealWindowBlocks() external view returns (uint64);
}
