// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NotImplemented} from "./Errors.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {EpochLib} from "./libraries/EpochLib.sol";
import {PrincipalState} from "./types/Structs.sol";

/// @title PrincipalRegistry
/// @notice Phase 1 stub (README §16). Immutable epoch parameters are final; entry points revert NotImplemented.
contract PrincipalRegistry is IPrincipalRegistry {
    uint64 public immutable override genesis;
    uint64 public immutable override epochLength;
    uint64 public immutable livenessGrace;

    mapping(bytes32 principalId => PrincipalState) internal _principals;
    mapping(bytes32 principalId => uint256[2] xy) internal _keys;
    mapping(bytes32 principalId => mapping(uint64 epoch => bytes32)) internal _depositKeysRoot;
    mapping(bytes32 nonce => bool) internal _nonceUsed;

    constructor(uint64 genesis_, uint64 epochLength_, uint64 livenessGrace_) {
        if (epochLength_ == 0) revert EpochLib.ZeroEpochLength();
        genesis = genesis_;
        epochLength = epochLength_;
        livenessGrace = livenessGrace_;
    }

    function enroll(uint256, uint256, uint64, bytes32, bytes calldata) external pure returns (bytes32) {
        revert NotImplemented("PrincipalRegistry.enroll");
    }

    function attest(bytes32, uint64, bytes32, bytes32, bytes calldata) external pure {
        revert NotImplemented("PrincipalRegistry.attest");
    }

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
        PrincipalState storage p = _principals[principalId];
        if (p.p256KeyCommit == bytes32(0)) return false;
        return EpochLib.withinGrace(currentEpoch(), p.lastAttestedEpoch, livenessGrace);
    }
}
