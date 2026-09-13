// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IFirsthandLens} from "./interfaces/IFirsthandLens.sol";
import {IGrantManager} from "./interfaces/IGrantManager.sol";
import {IPassportAnchors} from "./interfaces/IPassportAnchors.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {MerkleLib} from "./libraries/MerkleLib.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {AnchorRecord, BatchProof, GrantState, GrantStatus, VerifyFailure} from "./types/Structs.sol";

/// @title FirsthandLens
/// @notice The one verification call (README §7.3) as a view, plus dashboard reads. Twin of core's
///         `verifyPredicate`: identical check order and reason codes.
contract FirsthandLens is IFirsthandLens {
    IPrincipalRegistry public immutable registry;
    IPassportAnchors public immutable anchors;
    IGrantManager public immutable grants;

    constructor(IPrincipalRegistry registry_, IPassportAnchors anchors_, IGrantManager grants_) {
        registry = registry_;
        anchors = anchors_;
        grants = grants_;
    }

    /// @inheritdoc IFirsthandLens
    function verify(
        PassportLib.Passport calldata passport,
        bytes calldata signature,
        bytes32 batchRoot,
        BatchProof calldata proof,
        bytes32 grantId
    ) external view returns (bool ok, VerifyFailure reason) {
        if (!PassportLib.verify(passport, signature, domainSeparator())) return (false, VerifyFailure.SIG_INVALID);
        if (!anchors.isAnchored(batchRoot)) return (false, VerifyFailure.ROOT_UNKNOWN);
        if (!MerkleLib.verifyPassport(batchRoot, PassportLib.id(passport), proof)) {
            return (false, VerifyFailure.MERKLE_INVALID);
        }
        GrantState memory g = grants.grantState(grantId);
        AnchorRecord memory a = anchors.anchorOf(batchRoot);
        if (a.principalId != grants.principalOf(grantId) || a.ns != g.ns) {
            return (false, VerifyFailure.SCOPE_MISMATCH);
        }
        if (passport.termsHash != g.termsHash) return (false, VerifyFailure.TERMS_MISMATCH);

        GrantStatus status = grants.effectiveStatus(grantId);
        if (status == GrantStatus.RESCINDED) return (false, VerifyFailure.GRANT_RESCINDED);
        if (status == GrantStatus.EXPIRED) return (false, VerifyFailure.GRANT_EXPIRED);
        if (status == GrantStatus.FROZEN) return (false, VerifyFailure.GRANT_FROZEN);
        if (status != GrantStatus.ACTIVE) return (false, VerifyFailure.GRANT_NOT_LIVE);

        uint64 now_ = registry.currentEpoch();
        if (passport.epoch < g.epochStart || passport.epoch > now_) {
            return (false, VerifyFailure.EPOCH_OUT_OF_GRANT);
        }
        return (true, VerifyFailure.NONE);
    }

    function grantStatus(
        bytes32 grantId
    ) external view returns (GrantStatus) {
        return grants.effectiveStatus(grantId);
    }

    function principalIsLive(
        bytes32 principalId
    ) external view returns (bool) {
        return registry.isLive(principalId);
    }

    /// @notice Passport domain: chain id + PassportAnchors (ADR-0002).
    function domainSeparator() public view returns (bytes32) {
        return PassportLib.domainSeparator(block.chainid, address(anchors));
    }

    function currentEpoch() external view returns (uint64) {
        return registry.currentEpoch();
    }
}
