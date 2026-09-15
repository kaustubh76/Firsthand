// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {AuthorityDigests} from "./libraries/AuthorityDigests.sol";
import {EpochLib} from "./libraries/EpochLib.sol";
import {P256} from "./libraries/P256.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {PrincipalState, PrincipalStatus} from "./types/Structs.sol";

/// @title PrincipalRegistry
/// @notice Human authority on-chain (README §7.3, §9, §11): one passkey-derived P-256 key per principal,
///         enrolled once, re-attested every epoch. Liveness is evaluated lazily — no keepers.
/// @dev    Immutable; no admin. Every mutation is authorised by a P-256 signature over an EIP-712 digest
///         under this contract's own domain and verified through the RIP-7212 precompile (ADR-0009).
contract PrincipalRegistry is IPrincipalRegistry {
    uint64 public immutable override genesis;
    uint64 public immutable override epochLength;
    uint64 public immutable override livenessGrace;

    mapping(bytes32 principalId => PrincipalState) internal _principals;
    mapping(bytes32 principalId => uint256[2] xy) internal _keys;
    mapping(bytes32 principalId => mapping(uint64 epoch => bytes32)) internal _depositKeysRoot;
    mapping(bytes32 principalId => mapping(bytes32 nonce => bool)) internal _nonceUsed;

    constructor(uint64 genesis_, uint64 epochLength_, uint64 livenessGrace_) {
        if (epochLength_ == 0) revert EpochLib.ZeroEpochLength();
        genesis = genesis_;
        epochLength = epochLength_;
        livenessGrace = livenessGrace_;
    }

    // ── mutations ───────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPrincipalRegistry
    function enroll(
        uint256 x,
        uint256 y,
        uint64 epoch,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external returns (bytes32 principalId) {
        principalId = P256.commitment(x, y);
        if (_principals[principalId].p256KeyCommit != bytes32(0)) revert AlreadyEnrolled(principalId);
        _requireCurrentEpoch(epoch);
        _useNonce(principalId, nonce);

        bytes32 digest = _digest(AuthorityDigests.enroll(principalId, epoch, nonce));
        // The precompile rejects off-curve points, so key validity is checked here as well.
        if (!P256.verifySignature(digest, authoritySig, x, y)) revert InvalidAuthoritySignature();

        _principals[principalId] = PrincipalState({
            p256KeyCommit: principalId,
            lastAttestedEpoch: epoch,
            status: PrincipalStatus.ACTIVE,
            thawEpoch: 0
        });
        _keys[principalId] = [x, y];
        emit PrincipalEnrolled(principalId, x, y, epoch);
    }

    /// @inheritdoc IPrincipalRegistry
    function attest(
        bytes32 principalId,
        uint64 epoch,
        bytes32 depositKeysRoot_,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external {
        PrincipalState storage p = _principals[principalId];
        if (p.p256KeyCommit == bytes32(0)) revert UnknownPrincipal(principalId);
        _requireCurrentEpoch(epoch);
        if (epoch < p.lastAttestedEpoch) revert EpochNotMonotone(epoch, p.lastAttestedEpoch);
        if (_depositKeysRoot[principalId][epoch] != bytes32(0)) revert AlreadyAttested(principalId, epoch);
        _useNonce(principalId, nonce);

        bytes32 digest = _digest(AuthorityDigests.attest(principalId, epoch, depositKeysRoot_, nonce));
        uint256[2] storage xy = _keys[principalId];
        if (!P256.verifySignature(digest, authoritySig, xy[0], xy[1])) revert InvalidAuthoritySignature();

        // README §7.6: leaving FROZEN restores future epochs only after one full boundary. Gap epochs can
        // never be attested (hence never anchored), so only the grant's return to ACTIVE is delayed.
        if (!EpochLib.withinGrace(epoch, p.lastAttestedEpoch, livenessGrace)) {
            p.thawEpoch = epoch + 1;
            emit PrincipalThawScheduled(principalId, p.lastAttestedEpoch + livenessGrace + 1, epoch + 1);
        }
        p.lastAttestedEpoch = epoch;
        _depositKeysRoot[principalId][epoch] = depositKeysRoot_;
        emit PrincipalAttested(principalId, epoch, depositKeysRoot_);
    }

    // ── views ───────────────────────────────────────────────────────────────────────────────────

    function principal(
        bytes32 principalId
    ) external view returns (PrincipalState memory) {
        return _principals[principalId];
    }

    function authorityKey(
        bytes32 principalId
    ) external view returns (uint256 x, uint256 y) {
        uint256[2] storage xy = _keys[principalId];
        return (xy[0], xy[1]);
    }

    function depositKeysRoot(bytes32 principalId, uint64 epoch) external view returns (bytes32) {
        return _depositKeysRoot[principalId][epoch];
    }

    function currentEpoch() public view returns (uint64) {
        return EpochLib.epochAt(uint64(block.timestamp), genesis, epochLength);
    }

    function isLive(
        bytes32 principalId
    ) external view returns (bool) {
        return effectiveStatus(principalId) == PrincipalStatus.ACTIVE;
    }

    function effectiveStatus(
        bytes32 principalId
    ) public view returns (PrincipalStatus) {
        PrincipalState storage p = _principals[principalId];
        if (p.p256KeyCommit == bytes32(0)) return PrincipalStatus.NONE;
        uint64 now_ = currentEpoch();
        if (now_ < p.thawEpoch) return PrincipalStatus.FROZEN;
        return EpochLib.withinGrace(now_, p.lastAttestedEpoch, livenessGrace)
            ? PrincipalStatus.ACTIVE
            : PrincipalStatus.FROZEN;
    }

    function nonceUsed(bytes32 principalId, bytes32 nonce) external view returns (bool) {
        return _nonceUsed[principalId][nonce];
    }

    function domainSeparator() public view returns (bytes32) {
        return PassportLib.domainSeparator(block.chainid, address(this));
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────

    function _digest(
        bytes32 structHash
    ) internal view returns (bytes32) {
        return PassportLib.digestOf(structHash, domainSeparator());
    }

    function _requireCurrentEpoch(
        uint64 epoch
    ) internal view {
        uint64 current = currentEpoch();
        if (epoch != current) revert EpochNotCurrent(epoch, current);
    }

    function _useNonce(bytes32 principalId, bytes32 nonce) internal {
        if (_nonceUsed[principalId][nonce]) revert NonceAlreadyUsed(nonce);
        _nonceUsed[principalId][nonce] = true;
    }
}
