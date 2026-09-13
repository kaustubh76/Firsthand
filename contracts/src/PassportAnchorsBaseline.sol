// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {PassportAnchors} from "./PassportAnchors.sol";

/// @title PassportAnchorsBaseline
/// @notice Plain per-root SSTORE layout — the H1 baseline arm.
contract PassportAnchorsBaseline is PassportAnchors {
    constructor(
        IPrincipalRegistry registry_
    ) PassportAnchors(registry_) {}

    function layout() external pure override returns (string memory) {
        return "baseline";
    }
}
