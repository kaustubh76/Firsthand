// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PrincipalState} from "../types/Structs.sol";

/// @title IPrincipalRegistry
/// @notice Enrolls principals (P-256 key commitment), records epoch attestations, exposes liveness (README §9).
/// @dev    `principalId == keccak256(abi.encode(x, y))`. Attestation publishes `depositKeysRoot =
///         keccak256(abi.encodePacked(address[16] depositKeys))` for the epoch; PassportAnchors checks anchors
///         against it. Enroll is permissionless (anyone with a valid P-256 signature); attest is principal-only.
interface IPrincipalRegistry {
    event PrincipalEnrolled(bytes32 indexed principalId, uint256 x, uint256 y, uint64 epoch);
    event PrincipalAttested(bytes32 indexed principalId, uint64 indexed epoch, bytes32 depositKeysRoot);

    error AlreadyEnrolled(bytes32 principalId);
    error UnknownPrincipal(bytes32 principalId);
    error InvalidAuthoritySignature();
    error NonceAlreadyUsed(bytes32 nonce);
    error EpochNotCurrent(uint64 epoch, uint64 current);
    error EpochNotMonotone(uint64 epoch, uint64 last);

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
    function genesis() external view returns (uint64);
    function epochLength() external view returns (uint64);
}
