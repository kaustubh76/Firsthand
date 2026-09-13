// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IReceiptLedger} from "../../src/interfaces/IReceiptLedger.sol";
import {IRoyaltyRouter} from "../../src/interfaces/IRoyaltyRouter.sol";
import {IGrantManager} from "../../src/interfaces/IGrantManager.sol";
import {SplitMath} from "../../src/libraries/SplitMath.sol";
import {Receipt as FhReceipt, TermsInput, TransferAuthorization} from "../../src/types/Structs.sol";
import {MockUSDC} from "../doubles/MockUSDC.sol";
import {SettlementFixture} from "../SettlementFixture.sol";

contract RoyaltyRouterTest is SettlementFixture {
    function test_settlePullsSplitsRecordsAndEmits() public {
        bytes32 nonce = keccak256("q1");
        bytes32 expectedReceipt = ledger.receiptIdOf(grantId, nonce);
        vm.expectEmit(true, true, true, true);
        emit IReceiptLedger.ReceiptRecorded(expectedReceipt, grantId, buyer, 0, termsHash, EPOCH);
        vm.expectEmit(true, true, false, true);
        emit IRoyaltyRouter.RoyaltyPaid(expectedReceipt, grantId, 1000, 0);
        vm.prank(address(0xBEEF)); // relayed settlement
        bytes32 receiptId = settle(nonce);

        assertEq(receiptId, expectedReceipt);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000 - 1000);
        assertEq(usdc.balanceOf(payee), 1000);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(router.dustBalance(), 0);
        FhReceipt memory r = ledger.receipt(receiptId);
        assertEq(r.grantId, grantId);
        assertEq(r.payer, buyer);
        assertEq(r.termsHash, termsHash);
        assertEq(r.epoch, EPOCH);
        assertEq(r.blockNumber, 1000);
        assertTrue(ledger.exists(receiptId));
        assertEq(ledger.queriesThisEpoch(grantId, EPOCH), 1);
        assertTrue(usdc.authorizationState(buyer, nonce));
    }

    function test_settleRoutesResidualToDustAndSweeps() public {
        // Three equal payees on price 1_000 → 333 each, residual 1.
        TermsInput memory t = defaultTerms();
        t.payees = new address[](3);
        t.payees[0] = address(0xA);
        t.payees[1] = address(0xB);
        t.payees[2] = address(0xC);
        t.weights = new uint256[](3);
        t.weights[0] = 333_333_333_333_333_333;
        t.weights[1] = 333_333_333_333_333_333;
        t.weights[2] = 333_333_333_333_333_334;
        bytes32 th = acceptExtra(t, bytes32(uint256(9)));
        bytes32 g = grantFor(th, bytes32(uint256(901)));

        router.settle(g, t, authorization(BUYER_SK, 1000, keccak256("q")));
        assertEq(usdc.balanceOf(address(0xA)), 333);
        assertEq(usdc.balanceOf(address(0xC)), 333);
        assertEq(router.dustBalance(), 1);
        assertEq(usdc.balanceOf(address(router)), 1);

        vm.expectEmit(true, false, false, true);
        emit IRoyaltyRouter.DustSwept(dustPool, 1);
        assertEq(router.sweepDust(), 1);
        assertEq(usdc.balanceOf(dustPool), 1);
        assertEq(router.dustBalance(), 0);
        vm.expectRevert(IRoyaltyRouter.NothingToSweep.selector);
        router.sweepDust();
    }

    function test_settleRejectsMismatchedTermsValueAndDeadGrants() public {
        TermsInput memory wrong = defaultTerms();
        wrong.price = 999;
        bytes32 wrongHash = hashOf(wrong);
        TransferAuthorization memory a999 = authorization(BUYER_SK, 999, keccak256("a"));
        vm.expectRevert(abi.encodeWithSelector(IRoyaltyRouter.TermsMismatch.selector, termsHash, wrongHash));
        router.settle(grantId, wrong, a999);

        TransferAuthorization memory b999 = authorization(BUYER_SK, 999, keccak256("b"));
        vm.expectRevert(abi.encodeWithSelector(IRoyaltyRouter.ValueMismatch.selector, 1000, 999));
        router.settle(grantId, defaultTerms(), b999);

        // Tampered signature fails inside the token.
        TransferAuthorization memory a = authorization(BUYER_SK, 1000, keccak256("c"));
        a.r = bytes32(uint256(a.r) ^ 1);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        router.settle(grantId, defaultTerms(), a);

        // Unknown grant is not live.
        TransferAuthorization memory d = authorization(BUYER_SK, 1000, keccak256("d"));
        vm.expectRevert(abi.encodeWithSelector(IRoyaltyRouter.GrantNotLive.selector, keccak256("none")));
        router.settle(keccak256("none"), defaultTerms(), d);

        // Rescinded grant: the next settlement fails, nothing is pulled.
        bytes32 nonce = bytes32(uint256(777));
        bytes memory sig = rescindSig(AUTHORITY_SK, grantId, EPOCH, nonce);
        grants.rescind(grantId, EPOCH, nonce, sig);
        uint256 before = usdc.balanceOf(buyer);
        TransferAuthorization memory e = authorization(BUYER_SK, 1000, keccak256("e"));
        vm.expectRevert(abi.encodeWithSelector(IRoyaltyRouter.GrantNotLive.selector, grantId));
        router.settle(grantId, defaultTerms(), e);
        assertEq(usdc.balanceOf(buyer), before);
    }

    function test_settleEnforcesRateLimitAndReceiptUniqueness() public {
        settle(keccak256("1"));
        settle(keccak256("2"));
        settle(keccak256("3")); // rateLimit == 3
        TransferAuthorization memory fourth = authorization(BUYER_SK, 1000, keccak256("4"));
        vm.expectRevert(abi.encodeWithSelector(IReceiptLedger.RateLimitExceeded.selector, grantId, EPOCH, 3));
        router.settle(grantId, defaultTerms(), fourth);
        // New epoch resets the counter (grant still live: term 4, principal attested).
        warpToEpoch(EPOCH + 1);
        attest(AUTHORITY_SK, principalId, EPOCH + 1, bytes32(uint256(51)));
        settle(keccak256("5"));
        assertEq(ledger.queriesThisEpoch(grantId, EPOCH + 1), 1);
        // A reused authorization nonce fails at the token before any receipt logic.
        TransferAuthorization memory again = authorization(BUYER_SK, 1000, keccak256("5"));
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationAlreadyUsed.selector, buyer, keccak256("5")));
        router.settle(grantId, defaultTerms(), again);
    }

    function test_ledgerRejectsNonRouterAndDuplicates() public {
        vm.expectRevert(abi.encodeWithSelector(IReceiptLedger.NotRouter.selector, address(this)));
        ledger.record(grantId, bytes32(0), buyer, 0, termsHash, 0, EPOCH);
        vm.startPrank(address(router));
        bytes32 id = ledger.record(grantId, bytes32(uint256(1)), buyer, 0, termsHash, 0, EPOCH);
        vm.expectRevert(abi.encodeWithSelector(IReceiptLedger.DuplicateReceipt.selector, id));
        ledger.record(grantId, bytes32(uint256(1)), buyer, 0, termsHash, 0, EPOCH);
        // rateLimit 0 = unlimited
        for (uint256 i = 2; i < 12; ++i) {
            ledger.record(grantId, bytes32(i), buyer, 0, termsHash, 0, EPOCH);
        }
        vm.stopPrank();
        assertEq(ledger.queriesThisEpoch(grantId, EPOCH), 11);
        assertFalse(ledger.exists(keccak256("none")));
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────────

    function acceptExtra(TermsInput memory t, bytes32 nonce) internal returns (bytes32) {
        return grants.acceptTerms(cardId, principalId, t, nonce, acceptSig(CARD_SK, cardId, principalId, t, nonce));
    }

    function grantFor(bytes32 th, bytes32 nonce) internal returns (bytes32) {
        GrantArgs memory g = defaultGrant();
        g.termsHash = th;
        g.nonce = nonce;
        g.granteeCard = cardId;
        // A second grant for the same (principal, card, ns, epoch) would collide on grantId; use ns via a new card.
        bytes32 c2 = grants.registerCard(vm.addr(0xCA4D2), bytes32(uint256(2)));
        g.granteeCard = c2;
        TermsInput memory t = defaultTermsFromHash(th);
        grants.acceptTerms(c2, principalId, t, nonce, acceptSig(0xCA4D2, c2, principalId, t, nonce));
        return submitGrant(g, grantSig(AUTHORITY_SK, g));
    }

    /// @dev Reconstructs the three-payee terms used above (kept in one place for the helper).
    function defaultTermsFromHash(
        bytes32
    ) internal view returns (TermsInput memory t) {
        t = defaultTerms();
        t.payees = new address[](3);
        t.payees[0] = address(0xA);
        t.payees[1] = address(0xB);
        t.payees[2] = address(0xC);
        t.weights = new uint256[](3);
        t.weights[0] = 333_333_333_333_333_333;
        t.weights[1] = 333_333_333_333_333_333;
        t.weights[2] = 333_333_333_333_333_334;
    }
}
