// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHardwareDeviceRegistry} from "./interfaces/IHardwareDeviceRegistry.sol";
import {AndroidKeyAttestation} from "./libraries/AndroidKeyAttestation.sol";
import {AuthorityDigests} from "./libraries/AuthorityDigests.sol";
import {P256} from "./libraries/P256.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {PrincipalRegistry} from "./PrincipalRegistry.sol";
import {DeviceRecord} from "./types/Structs.sol";

/// @title HardwareDeviceRegistry
/// @notice Hardware capture attestation on chain (README §13, ADR-0015): a principal registers a
///         secure element by submitting its attestation certificate chain, which is verified here
///         against a pinned anchor, and every class-3 passport is then witnessed by that device.
/// @dev    Immutable; no admin. Both mutations are authorised by the principal's P-256 signature
///         over an EIP-712 digest under this contract's own domain (ADR-0009) and verified through
///         the RIP-7212 precompile — the same precompile, and the same curve, the device itself
///         signs with.
contract HardwareDeviceRegistry is IHardwareDeviceRegistry {
    /// @dev `ChainRejected` codes.
    uint8 internal constant C_TOO_SHORT = 1;
    uint8 internal constant C_NOT_SHA256 = 2;
    uint8 internal constant C_ISSUER_MISMATCH = 3;
    uint8 internal constant C_BAD_SIGNATURE = 4;
    uint8 internal constant C_NO_ANCHOR = 5;

    /// @dev `DeviceRejected` codes.
    uint8 internal constant D_NO_KEY_DESCRIPTION = 1;
    uint8 internal constant D_NOT_GENERATED = 2;
    uint8 internal constant D_SECURITY_LEVEL = 3;
    uint8 internal constant D_CHALLENGE = 4;

    /// @dev `KeyOrigin.GENERATED` — the private half provably never existed outside the element.
    uint256 internal constant ORIGIN_GENERATED = 0;

    PrincipalRegistry public immutable principals;
    uint8 public immutable override minimumSecurityLevel;

    /// @dev Written once, in the constructor, and never again. Solidity has no immutable array;
    ///      the absence of a setter is what satisfies §22's ban on admin keys.
    bytes32[] private _anchors;

    mapping(bytes32 keyCommitment => DeviceRecord) internal _devices;
    mapping(bytes32 principalId => mapping(bytes32 nonce => bool)) internal _nonceUsed;

    constructor(PrincipalRegistry principals_, uint8 minimumSecurityLevel_, bytes32[] memory anchors_) {
        if (anchors_.length == 0) revert NoTrustAnchors();
        principals = principals_;
        minimumSecurityLevel = minimumSecurityLevel_;
        _anchors = anchors_;
    }

    // ── mutations ───────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IHardwareDeviceRegistry
    function registerDevice(
        bytes32 principalId,
        bytes[] calldata chain,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external returns (bytes32 keyCommitment) {
        (uint256 ax, uint256 ay) = principals.authorityKey(principalId);
        if (ax == 0 && ay == 0) revert UnknownPrincipal(principalId);
        _useNonce(principalId, nonce);

        AndroidKeyAttestation.Certificate memory leaf = _verifyChain(chain);
        keyCommitment = P256.commitment(leaf.x, leaf.y);
        if (_devices[keyCommitment].registeredAt != 0) revert AlreadyRegistered(keyCommitment);

        AndroidKeyAttestation.KeyDescription memory described = AndroidKeyAttestation.keyDescriptionOf(chain[0]);
        uint8 level = _requireAttested(described, principalId, nonce);

        // Signed last, over the commitment the certificate named: the human is authorising *this*
        // device, not one a caller asserted alongside somebody else's chain.
        bytes32 digest = _digest(AuthorityDigests.registerDevice(principalId, keyCommitment, nonce));
        if (!P256.verifySignature(digest, authoritySig, ax, ay)) revert InvalidAuthoritySignature();

        _devices[keyCommitment] = DeviceRecord({
            x: leaf.x,
            y: leaf.y,
            principalId: principalId,
            registeredAt: uint64(block.timestamp),
            revokedAt: 0,
            securityLevel: level,
            verifiedBootState: uint8(described.verifiedBootState),
            hasRootOfTrust: described.hasRootOfTrust
        });
        emit DeviceRegistered(
            principalId, keyCommitment, level, uint8(described.verifiedBootState), described.hasRootOfTrust
        );
    }

    /// @inheritdoc IHardwareDeviceRegistry
    function revokeDevice(
        bytes32 principalId,
        bytes32 keyCommitment,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external {
        DeviceRecord storage d = _devices[keyCommitment];
        if (d.registeredAt == 0) revert UnknownDevice(keyCommitment);
        if (d.principalId != principalId) revert NotYourDevice(keyCommitment);
        if (d.revokedAt != 0) revert AlreadyRevoked(keyCommitment);
        _useNonce(principalId, nonce);

        bytes32 digest = _digest(AuthorityDigests.revokeDevice(principalId, keyCommitment, nonce));
        (uint256 ax, uint256 ay) = principals.authorityKey(principalId);
        if (!P256.verifySignature(digest, authoritySig, ax, ay)) revert InvalidAuthoritySignature();

        d.revokedAt = uint64(block.timestamp);
        emit DeviceRevoked(principalId, keyCommitment, d.revokedAt);
    }

    // ── views ───────────────────────────────────────────────────────────────────────────────────

    function device(
        bytes32 keyCommitment
    ) external view returns (DeviceRecord memory) {
        return _devices[keyCommitment];
    }

    function verifyCapture(
        bytes32 keyCommitment,
        bytes32 hwDigest,
        bytes calldata signature
    ) external view returns (bool) {
        DeviceRecord storage d = _devices[keyCommitment];
        if (d.registeredAt == 0 || d.revokedAt != 0) return false;
        return P256.verifySignature(hwDigest, signature, d.x, d.y);
    }

    function anchors() external view returns (bytes32[] memory) {
        return _anchors;
    }

    function nonceUsed(bytes32 principalId, bytes32 nonce) external view returns (bool) {
        return _nonceUsed[principalId][nonce];
    }

    function domainSeparator() public view returns (bytes32) {
        return PassportLib.domainSeparator(block.chainid, address(this));
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────

    /// @dev Walks upward from the leaf and stops at the first certificate whose key commitment is
    ///      pinned, so every link below the anchor is verified here.
    ///
    ///      Certificates *above* the anchor are never parsed, which is deliberate: an attestation
    ///      root uses stronger parameters than the leaves it certifies — Google's is RSA or P-384
    ///      — and RIP-7212 verifies P-256 and nothing else. The link from the pinned certificate
    ///      upward is checked once, off chain, and the pin records that result. That is a real
    ///      limitation and `docs/SECURITY.md` prints it rather than rounding it off.
    function _verifyChain(
        bytes[] calldata chain
    ) private view returns (AndroidKeyAttestation.Certificate memory leaf) {
        if (chain.length < 2) revert ChainRejected(C_TOO_SHORT, 0);
        leaf = AndroidKeyAttestation.parseCertificate(chain[0]);

        AndroidKeyAttestation.Certificate memory subject = leaf;
        for (uint256 i = 1; i < chain.length; ++i) {
            AndroidKeyAttestation.Certificate memory issuer = AndroidKeyAttestation.parseCertificate(chain[i]);
            if (!subject.sha256Ecdsa) revert ChainRejected(C_NOT_SHA256, i - 1);
            if (subject.issuerHash != issuer.subjectHash) revert ChainRejected(C_ISSUER_MISMATCH, i - 1);
            if (!P256.verify(subject.tbsHash, subject.r, subject.s, issuer.x, issuer.y)) {
                revert ChainRejected(C_BAD_SIGNATURE, i - 1);
            }
            if (_isAnchor(P256.commitment(issuer.x, issuer.y))) return leaf;
            subject = issuer;
        }
        revert ChainRejected(C_NO_ANCHOR, chain.length);
    }

    /// @dev What the certificate must say about the key before the chain will record it. The
    ///      effective level is the weaker of the two the certificate carries: reporting the
    ///      stronger would let a TEE-enforced key claim StrongBox because the attestation above it
    ///      happened to be StrongBox-signed.
    function _requireAttested(
        AndroidKeyAttestation.KeyDescription memory described,
        bytes32 principalId,
        bytes32 nonce
    ) private view returns (uint8) {
        if (!described.present) revert DeviceRejected(D_NO_KEY_DESCRIPTION);
        if (!described.hasOrigin || described.origin != ORIGIN_GENERATED) {
            revert DeviceRejected(D_NOT_GENERATED);
        }
        uint256 level = described.attestationSecurityLevel < described.keymasterSecurityLevel
            ? described.attestationSecurityLevel
            : described.keymasterSecurityLevel;
        if (level < minimumSecurityLevel) revert DeviceRejected(D_SECURITY_LEVEL);
        // The challenge the key was generated under has to name this principal and spend this
        // nonce, so a chain cannot be lifted from one registration and replayed into another.
        if (described.challengeHash != keccak256(abi.encodePacked(principalId, nonce))) {
            revert DeviceRejected(D_CHALLENGE);
        }
        return uint8(level);
    }

    function _isAnchor(
        bytes32 commitment
    ) private view returns (bool) {
        for (uint256 i = 0; i < _anchors.length; ++i) {
            if (_anchors[i] == commitment) return true;
        }
        return false;
    }

    function _digest(
        bytes32 structHash
    ) internal view returns (bytes32) {
        return PassportLib.digestOf(structHash, domainSeparator());
    }

    function _useNonce(bytes32 principalId, bytes32 nonce) internal {
        if (_nonceUsed[principalId][nonce]) revert NonceAlreadyUsed(nonce);
        _nonceUsed[principalId][nonce] = true;
    }
}
