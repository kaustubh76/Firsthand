// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NotImplemented} from "./Errors.sol";
import {IGrantManager} from "./interfaces/IGrantManager.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {IRescissions} from "./interfaces/IRescissions.sol";
import {EpochLib} from "./libraries/EpochLib.sol";
import {GrantState, GrantStatus} from "./types/Structs.sol";

/// @title GrantManager
/// @notice Phase 3/4 stub. Immutable wiring and the pure id derivation are final.
contract GrantManager is IGrantManager {
    IPrincipalRegistry public immutable registry;
    IRescissions public immutable rescissions;
    uint64 public immutable maxTerm;
    uint64 public immutable priceFloor;

    mapping(bytes32 grantId => GrantState) internal _grants;
    mapping(bytes32 grantId => bytes32) internal _principalOf;
    mapping(bytes32 grantId => bytes32) internal _wrapRef;
    mapping(bytes32 acceptanceKey => bool) internal _accepted;
    mapping(bytes32 nonce => bool) internal _nonceUsed;

    constructor(IPrincipalRegistry registry_, IRescissions rescissions_, uint64 maxTerm_, uint64 priceFloor_) {
        registry = registry_;
        rescissions = rescissions_;
        maxTerm = maxTerm_ == 0 ? EpochLib.MAX_GRANT_TERM_EPOCHS : maxTerm_;
        priceFloor = priceFloor_ == 0 ? 1 : priceFloor_;
    }

    function acceptTerms(bytes32, bytes32, uint32, bytes32, bytes32, bytes calldata) external pure {
        revert NotImplemented("GrantManager.acceptTerms");
    }

    function grant(
        bytes32,
        bytes32,
        uint32,
        uint64,
        uint64,
        bytes32,
        bytes32,
        bytes32,
        bytes calldata
    ) external pure returns (bytes32) {
        revert NotImplemented("GrantManager.grant");
    }

    function rescind(bytes32, uint64, bytes32, bytes calldata) external pure {
        revert NotImplemented("GrantManager.rescind");
    }

    function revealRescind(bytes32, bytes32, bytes32, bytes calldata) external pure {
        revert NotImplemented("GrantManager.revealRescind");
    }

    function grantState(
        bytes32 grantId
    ) external view returns (GrantState memory) {
        return _grants[grantId];
    }

    function principalOf(
        bytes32 grantId
    ) external view returns (bytes32) {
        return _principalOf[grantId];
    }

    function wrapRefOf(
        bytes32 grantId
    ) external view returns (bytes32) {
        return _wrapRef[grantId];
    }

    function termsAccepted(
        bytes32 granteeCard,
        bytes32 principalId,
        uint32 ns,
        bytes32 termsHash
    ) external view returns (bool) {
        return _accepted[keccak256(abi.encode(granteeCard, principalId, ns, termsHash))];
    }

    function effectiveStatus(
        bytes32 grantId
    ) external view returns (GrantStatus) {
        return _grants[grantId].status; // lazily-derived EXPIRED / FROZEN land in Phase 3
    }

    function grantIdOf(
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(principalId, granteeCard, ns, epochStart));
    }
}
