// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {PassportAnchors} from "../../src/PassportAnchors.sol";
import {PassportAnchorsBaseline} from "../../src/PassportAnchorsBaseline.sol";
import {PassportAnchorsPaged} from "../../src/PassportAnchorsPaged.sol";
import {PassportAnchorsBehaviour} from "./PassportAnchors.behaviour.sol";

contract PassportAnchorsBaselineTest is PassportAnchorsBehaviour {
    function deployAnchors(
        PrincipalRegistry registry_
    ) internal override returns (PassportAnchors) {
        return new PassportAnchorsBaseline(registry_);
    }

    function test_layoutLabel() public view {
        assertEq(anchors.layout(), "baseline");
    }
}

contract PassportAnchorsPagedTest is PassportAnchorsBehaviour {
    function deployAnchors(
        PrincipalRegistry registry_
    ) internal override returns (PassportAnchors) {
        return new PassportAnchorsPaged(registry_);
    }

    function test_layoutLabel() public view {
        assertEq(anchors.layout(), "paged");
    }

    function test_pagesDoNotCollideAcrossNamespacesOrEpochs() public {
        // 16 namespaces × 2 anchors each on one principal: every record reads back intact.
        for (uint32 ns = 0; ns < 16; ++ns) {
            for (uint256 i = 0; i < 2; ++i) {
                bytes32 root = keccak256(abi.encode("p", ns, i));
                assertEq(doAnchor(ns, root, keccak256(abi.encode("n", ns, i))), i);
            }
        }
        for (uint32 ns = 0; ns < 16; ++ns) {
            assertEq(anchors.batchCount(principalId, ns, EPOCH), 2);
            for (uint256 i = 0; i < 2; ++i) {
                bytes32 root = keccak256(abi.encode("p", ns, i));
                assertEq(anchors.batchRootAt(principalId, ns, EPOCH, i), root);
                assertEq(anchors.anchorOf(root).ns, ns);
                assertEq(anchors.anchorOf(root).batchIndex, uint32(i));
                assertEq(anchors.anchorOf(root).termsHash, keccak256("terms"));
            }
        }
    }
}
