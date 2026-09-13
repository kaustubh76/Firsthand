// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {NotImplemented} from "../../src/Errors.sol";
import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {Rescissions} from "../../src/Rescissions.sol";
import {PassportAnchorsBaseline} from "../../src/PassportAnchorsBaseline.sol";
import {PassportAnchorsPaged} from "../../src/PassportAnchorsPaged.sol";
import {GrantManager} from "../../src/GrantManager.sol";
import {ReceiptLedger} from "../../src/ReceiptLedger.sol";
import {RoyaltyRouter} from "../../src/RoyaltyRouter.sol";
import {FirsthandLens} from "../../src/FirsthandLens.sol";
import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {IReceiptLedger} from "../../src/interfaces/IReceiptLedger.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {BatchProof, GrantStatus, TermsInput, TransferAuthorization} from "../../src/types/Structs.sol";

/// @dev Every stub deploys, wires its immutables, answers its views, and reverts NotImplemented where expected.
contract StubsTest is Test {
    uint64 internal constant GENESIS = 1_700_000_000;
    PrincipalRegistry internal registry;
    Rescissions internal rescissions;
    PassportAnchorsBaseline internal anchors;
    GrantManager internal grants;
    ReceiptLedger internal ledger;
    RoyaltyRouter internal router;
    FirsthandLens internal lens;
    address internal usdc = address(0x05DC);

    function setUp() public {
        vm.warp(GENESIS + 3 * EpochLib.DEFAULT_EPOCH_SECONDS + 1);
        registry = new PrincipalRegistry(GENESIS, EpochLib.DEFAULT_EPOCH_SECONDS, EpochLib.LIVENESS_GRACE_EPOCHS);
        rescissions = new Rescissions();
        anchors = new PassportAnchorsBaseline(registry);
        grants = new GrantManager(registry, rescissions, 0, 0);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        ledger = new ReceiptLedger(predicted);
        router = new RoyaltyRouter(IERC3009(usdc), grants, ledger, address(0xD057));
        assertEq(address(router), predicted);
        lens = new FirsthandLens(registry, anchors, grants);
    }

    function test_registryWiringAndViews() public {
        assertEq(registry.currentEpoch(), 3);
        assertFalse(registry.isLive(bytes32(uint256(1))));
        (uint256 x, uint256 y) = registry.authorityKey(bytes32(uint256(1)));
        assertEq(x + y, 0);
        // PrincipalRegistry is implemented (Phase 1) — see PrincipalRegistry.t.sol; only wiring is checked here.
        assertEq(registry.livenessGrace(), EpochLib.LIVENESS_GRACE_EPOCHS);
        vm.expectRevert(EpochLib.ZeroEpochLength.selector);
        new PrincipalRegistry(GENESIS, 0, 2);
    }

    function test_anchorsLayoutsAndStub() public {
        assertEq(anchors.layout(), "baseline");
        assertEq(new PassportAnchorsPaged(registry).layout(), "paged");
        assertFalse(anchors.isAnchored(bytes32(0)));
        assertEq(anchors.batchCount(bytes32(0), 0, 0), 0);
        address[16] memory keys;
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "PassportAnchors.anchor"));
        anchors.anchor(bytes32(0), 0, 0, bytes32(0), bytes32(0), bytes32(0), keys, "");
    }

    function test_grantManagerDefaultsAndStub() public {
        assertEq(grants.maxTerm(), EpochLib.MAX_GRANT_TERM_EPOCHS);
        assertEq(grants.priceFloor(), 1);
        assertEq(address(grants.rescissions()), address(rescissions));
        bytes32 id = grants.grantIdOf(bytes32(uint256(1)), bytes32(uint256(2)), 3, 4);
        assertEq(id, keccak256(abi.encode(bytes32(uint256(1)), bytes32(uint256(2)), uint32(3), uint64(4))));
        assertEq(uint8(grants.effectiveStatus(id)), uint8(GrantStatus.NONE));
        assertFalse(grants.termsAccepted(bytes32(0), bytes32(0), 0, bytes32(0)));
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "GrantManager.grant"));
        grants.grant(bytes32(0), bytes32(0), 0, 0, 1, bytes32(0), bytes32(0), bytes32(0), "");
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "GrantManager.rescind"));
        grants.rescind(id, 0, bytes32(0), "");
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "GrantManager.revealRescind"));
        grants.revealRescind(id, bytes32(0), bytes32(0), "");
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "GrantManager.acceptTerms"));
        grants.acceptTerms(bytes32(0), bytes32(0), 0, bytes32(0), bytes32(0), "");
    }

    function test_ledgerOnlyRouterMayRecord() public {
        assertEq(ledger.router(), address(router));
        assertEq(
            ledger.receiptIdOf(bytes32(uint256(1)), bytes32(uint256(2))),
            keccak256(abi.encode(bytes32(uint256(1)), bytes32(uint256(2))))
        );
        vm.expectRevert(abi.encodeWithSelector(IReceiptLedger.NotRouter.selector, address(this)));
        ledger.record(bytes32(0), bytes32(0), address(0), 0, bytes32(0), 0);
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "ReceiptLedger.record"));
        ledger.record(bytes32(0), bytes32(0), address(0), 0, bytes32(0), 0);
        assertEq(ledger.queriesThisEpoch(bytes32(0), 0), 0);
    }

    function test_routerWiringAndStub() public {
        assertEq(router.usdc(), usdc);
        assertEq(router.dustPool(), address(0xD057));
        assertEq(router.dustBalance(), 0);
        TermsInput memory terms;
        TransferAuthorization memory auth;
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "RoyaltyRouter.settle"));
        router.settle(bytes32(0), terms, auth);
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "RoyaltyRouter.sweepDust"));
        router.sweepDust();
    }

    function test_lensViewsAndDomain() public {
        assertEq(lens.currentEpoch(), 3);
        assertFalse(lens.principalIsLive(bytes32(0)));
        assertEq(uint8(lens.grantStatus(bytes32(0))), uint8(GrantStatus.NONE));
        assertEq(lens.domainSeparator(), PassportLib.domainSeparator(block.chainid, address(anchors)));
        PassportLib.Passport memory p;
        BatchProof memory proof;
        vm.expectRevert(abi.encodeWithSelector(NotImplemented.selector, "FirsthandLens.verify"));
        lens.verify(p, "", bytes32(0), proof, bytes32(0));
    }
}
