// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {PassportAnchors} from "./PassportAnchors.sol";

/// @title PassportAnchorsPaged
/// @notice MIP-8 clustered storage-page layout — the H1 treatment arm.
/// @dev    // MIP-8: page layout to be confirmed against the Sep 4 2026 upgrade docs (Phase 0 gate). Until then
///         this contract is behaviourally identical to Baseline; only `layout()` differs so the harness can label it.
contract PassportAnchorsPaged is PassportAnchors {
    constructor(
        IPrincipalRegistry registry_
    ) PassportAnchors(registry_) {}

    function layout() external pure override returns (string memory) {
        return "paged";
    }
}
