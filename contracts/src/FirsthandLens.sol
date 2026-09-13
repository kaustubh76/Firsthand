// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NotImplemented} from "./Errors.sol";
import {IFirsthandLens} from "./interfaces/IFirsthandLens.sol";
import {IGrantManager} from "./interfaces/IGrantManager.sol";
import {IPassportAnchors} from "./interfaces/IPassportAnchors.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {BatchProof, GrantStatus, VerifyFailure} from "./types/Structs.sol";

/// @title FirsthandLens
/// @notice Phase 3 stub. View-only aggregation; `domainSeparator` is final (binds chain id + PassportAnchors).
contract FirsthandLens is IFirsthandLens {
    IPrincipalRegistry public immutable registry;
    IPassportAnchors public immutable anchors;
    IGrantManager public immutable grants;

    constructor(IPrincipalRegistry registry_, IPassportAnchors anchors_, IGrantManager grants_) {
        registry = registry_;
        anchors = anchors_;
        grants = grants_;
    }

    function verify(
        PassportLib.Passport calldata,
        bytes calldata,
        bytes32,
        BatchProof calldata,
        bytes32
    ) external pure returns (bool, VerifyFailure) {
        revert NotImplemented("FirsthandLens.verify");
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

    function domainSeparator() public view returns (bytes32) {
        return PassportLib.domainSeparator(block.chainid, address(anchors));
    }

    function currentEpoch() external view returns (uint64) {
        return registry.currentEpoch();
    }
}
