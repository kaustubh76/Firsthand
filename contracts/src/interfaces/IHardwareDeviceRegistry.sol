// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeviceRecord} from "../types/Structs.sol";

/// @title IHardwareDeviceRegistry
/// @notice Binds secure elements to principals (README §13, ADR-0015). A device is registered by
///         submitting its attestation certificate chain; the chain is verified here, so what the
///         registry stores about a device is read out of a signed certificate rather than
///         asserted by whoever submitted it.
/// @dev    `keyCommitment == keccak256(abi.encode(x, y))` — the same commitment `PrincipalRegistry`
///         uses for an authority key, so naming a P-256 key means one thing across the protocol.
///         Both mutations are relayable: authorization is the principal's P-256 signature over an
///         EIP-712 digest under *this contract's* domain (ADR-0009), never `msg.sender`.
///
///         What this proves is that a key was generated inside a certified secure element and that
///         a given capture was signed by that key — transplantation resistance. It does not prove
///         what a sensor saw: a secure element signs a digest handed to it by app code, and
///         README §14 limitation 3 stands.
interface IHardwareDeviceRegistry {
    event DeviceRegistered(
        bytes32 indexed principalId,
        bytes32 indexed keyCommitment,
        uint8 securityLevel,
        uint8 verifiedBootState,
        bool hasRootOfTrust
    );
    event DeviceRevoked(bytes32 indexed principalId, bytes32 indexed keyCommitment, uint64 at);

    /// @dev Why a certificate chain was not accepted. `index` is the certificate it failed at.
    error ChainRejected(uint8 code, uint256 index);
    /// @dev Why the attested key itself was not accepted.
    error DeviceRejected(uint8 code);

    error UnknownPrincipal(bytes32 principalId);
    error InvalidAuthoritySignature();
    error NonceAlreadyUsed(bytes32 nonce);
    error AlreadyRegistered(bytes32 keyCommitment);
    error UnknownDevice(bytes32 keyCommitment);
    error NotYourDevice(bytes32 keyCommitment);
    error AlreadyRevoked(bytes32 keyCommitment);
    error NoTrustAnchors();

    /// @notice Verifies `chain` to a pinned anchor and records the device it attests.
    /// @param  chain Leaf first, as Android and WebAuthn both return it. Signatures must be low-s;
    ///         roughly half of real certificates are not, and normalising is the submitter's job
    ///         because only the submitter can re-encode.
    function registerDevice(
        bytes32 principalId,
        bytes[] calldata chain,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external returns (bytes32 keyCommitment);

    /// @notice Ends a device's ability to witness captures. The record stays: a buyer auditing an
    ///         older Lineage Manifest still needs to see that the device existed and when it
    ///         stopped being live.
    function revokeDevice(
        bytes32 principalId,
        bytes32 keyCommitment,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external;

    /// @notice What the chain recorded about one device; `registeredAt == 0` when it knows none.
    function device(
        bytes32 keyCommitment
    ) external view returns (DeviceRecord memory);

    /// @notice Whether `signature` over `hwDigest` came from a live, registered device. False —
    ///         rather than a reason — because a caller that wants the reason reads `device`.
    function verifyCapture(
        bytes32 keyCommitment,
        bytes32 hwDigest,
        bytes calldata signature
    ) external view returns (bool);

    /// @notice The pinned trust anchors, as key commitments. Set once, in the constructor: §22
    ///         forbids admin keys, so there is no setter and a rotation is a redeployment.
    function anchors() external view returns (bytes32[] memory);

    function minimumSecurityLevel() external view returns (uint8);
    function nonceUsed(bytes32 principalId, bytes32 nonce) external view returns (bool);
    /// @notice EIP-712 domain separator this registry verifies authority signatures under.
    function domainSeparator() external view returns (bytes32);
}
