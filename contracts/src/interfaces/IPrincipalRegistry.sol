// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PrincipalState, PrincipalStatus} from "../types/Structs.sol";

/// @title IPrincipalRegistry
/// @notice Enrolls principals (P-256 key commitment), records epoch attestations, exposes liveness (README §9).
/// @dev    `principalId == keccak256(abi.encode(x, y))`. Attestation publishes `depositKeysRoot =
///         keccak256(abi.encodePacked(address[16] depositKeys))` for the epoch; PassportAnchors checks anchors
///         against it. Both entry points are relayable: authorization is the P-256 signature over the
///         EIP-712 digest under *this contract's* domain (ADR-0009), never `msg.sender`. Nonces are scoped
///         per principal so a stranger cannot burn them.
interface IPrincipalRegistry {
    event PrincipalEnrolled(bytes32 indexed principalId, uint256 x, uint256 y, uint64 epoch);
    event PrincipalAttested(bytes32 indexed principalId, uint64 indexed epoch, bytes32 depositKeysRoot);
    /// @notice A principal re-attested after its liveness grace lapsed; grants stay FROZEN until `thawEpoch`
    ///         (one full epoch boundary, README §7.6) so flapping attestation cannot oscillate consent.
    event PrincipalThawScheduled(bytes32 indexed principalId, uint64 frozenFromEpoch, uint64 thawEpoch);

    error AlreadyEnrolled(bytes32 principalId);
    error UnknownPrincipal(bytes32 principalId);
    error InvalidAuthoritySignature();
    error NonceAlreadyUsed(bytes32 nonce);
    error EpochNotCurrent(uint64 epoch, uint64 current);
    error EpochNotMonotone(uint64 epoch, uint64 last);
    error AlreadyAttested(bytes32 principalId, uint64 epoch);

    function enroll(
        uint256 x,
        uint256 y,
        uint64 epoch,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external returns (bytes32 principalId);

    function attest(
        bytes32 principalId,
        uint64 epoch,
        bytes32 depositKeysRoot,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external;

    function principal(
        bytes32 principalId
    ) external view returns (PrincipalState memory);
    function authorityKey(
        bytes32 principalId
    ) external view returns (uint256 x, uint256 y);
    function depositKeysRoot(bytes32 principalId, uint64 epoch) external view returns (bytes32);
    function currentEpoch() external view returns (uint64);
    /// @notice Lazily-evaluated liveness at the current epoch (README §7.3 dead-man's switch).
    function isLive(
        bytes32 principalId
    ) external view returns (bool);
    /// @notice ACTIVE, FROZEN (derived: past liveness grace, or before a scheduled `thawEpoch`) or NONE
    ///         (not enrolled). Never stored as FROZEN.
    function effectiveStatus(
        bytes32 principalId
    ) external view returns (PrincipalStatus);
    function nonceUsed(bytes32 principalId, bytes32 nonce) external view returns (bool);
    /// @notice EIP-712 domain separator this registry verifies authority signatures under (ADR-0009).
    function domainSeparator() external view returns (bytes32);
    function genesis() external view returns (uint64);
    function epochLength() external view returns (uint64);
    function livenessGrace() external view returns (uint64);
}
