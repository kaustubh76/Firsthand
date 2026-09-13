// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NotImplemented} from "./Errors.sol";
import {IPassportAnchors} from "./interfaces/IPassportAnchors.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";

/// @title PassportAnchors
/// @notice Phase 2 stub base. Concrete layouts (`Baseline`, `Paged`) differ only in `_store` / `_load` so the H1
///         experiment compares storage cost with identical semantics (README §8 claim 2, §15).
abstract contract PassportAnchors is IPassportAnchors {
    IPrincipalRegistry public immutable registry;

    constructor(
        IPrincipalRegistry registry_
    ) {
        registry = registry_;
    }

    function anchor(
        bytes32,
        uint32,
        uint64,
        bytes32,
        bytes32,
        bytes32,
        address[16] calldata,
        bytes calldata
    ) external pure returns (uint256) {
        revert NotImplemented("PassportAnchors.anchor");
    }

    function isAnchored(
        bytes32
    ) external pure returns (bool) {
        return false;
    }

    function anchorBlock(
        bytes32
    ) external pure returns (uint64) {
        return 0;
    }

    function termsOf(
        bytes32
    ) external pure returns (bytes32) {
        return bytes32(0);
    }

    function batchCount(bytes32, uint32, uint64) external pure returns (uint256) {
        return 0;
    }

    function batchRootAt(bytes32, uint32, uint64, uint256) external pure returns (bytes32) {
        return bytes32(0);
    }

    function layout() external pure virtual returns (string memory);
}
