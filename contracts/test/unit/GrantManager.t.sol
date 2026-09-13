// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {GrantManager} from "../../src/GrantManager.sol";
import {IGrantManager} from "../../src/interfaces/IGrantManager.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {Card, GrantState, GrantStatus, RegisteredTerms, TermsInput} from "../../src/types/Structs.sol";
import {GrantFixture} from "../GrantFixture.sol";

contract GrantManagerTest is GrantFixture {
    // ── cards & terms ───────────────────────────────────────────────────────────────────────────

    function test_registerCardIsIdempotentCommitment() public {
        assertEq(cardId, keccak256(abi.encode(cardOwner, CARD_X25519)));
        Card memory c = grants.cardOf(cardId);
        assertEq(c.owner, cardOwner);
        assertEq(c.encryptionPubKey, CARD_X25519);
        assertEq(grants.registerCard(cardOwner, CARD_X25519), cardId); // no second event, same id
        assertEq(grants.cardIdOf(cardOwner, CARD_X25519), cardId);
        assertEq(grants.cardOf(keccak256("nope")).owner, address(0));
    }

    function test_acceptTermsRegistersPreimageAndAcceptance() public view {
        RegisteredTerms memory rt = grants.termsOf(termsHash);
        assertTrue(rt.exists);
        assertEq(rt.price, 1000);
        assertEq(rt.rateLimit, 3);
        assertEq(rt.ns, 0);
        assertTrue(grants.termsAccepted(cardId, principalId, 0, termsHash));
        assertFalse(grants.termsAccepted(cardId, principalId, 1, termsHash));
        assertTrue(grants.nonceUsed(cardId, bytes32(uint256(1))));
        assertEq(grants.currentEpoch(), EPOCH);
        assertEq(grants.domainSeparator(), PassportLib.domainSeparator(block.chainid, address(grants)));
    }

    function test_acceptTermsRejectsUnknownCardPrincipalReplayAndForeignSigner() public {
        TermsInput memory t = defaultTerms();
        bytes32 nonce = bytes32(uint256(2));
        bytes memory sig = acceptSig(CARD_SK, cardId, principalId, t, nonce);

        vm.expectRevert(abi.encodeWithSelector(IGrantManager.UnknownCard.selector, keccak256("x")));
        grants.acceptTerms(keccak256("x"), principalId, t, nonce, sig);

        bytes memory sigStranger = acceptSig(CARD_SK, cardId, keccak256("stranger"), t, nonce);
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.UnknownPrincipal.selector, keccak256("stranger")));
        grants.acceptTerms(cardId, keccak256("stranger"), t, nonce, sigStranger);

        bytes memory replay = acceptSig(CARD_SK, cardId, principalId, t, bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.NonceAlreadyUsed.selector, bytes32(uint256(1))));
        grants.acceptTerms(cardId, principalId, t, bytes32(uint256(1)), replay);

        bytes memory foreign = acceptSig(0xBAD, cardId, principalId, t, nonce);
        vm.expectRevert(IGrantManager.InvalidCardSignature.selector);
        grants.acceptTerms(cardId, principalId, t, nonce, foreign);

        // Signature over different terms than submitted.
        TermsInput memory other = defaultTerms();
        other.price = 2000;
        vm.expectRevert(IGrantManager.InvalidCardSignature.selector);
        grants.acceptTerms(cardId, principalId, other, nonce, sig);
    }

    // ── grant ───────────────────────────────────────────────────────────────────────────────────

    function test_grantStoresStateAndWrapRef() public {
        GrantArgs memory g = defaultGrant();
        bytes32 expectedId = grants.grantIdOf(principalId, cardId, 0, EPOCH);
        vm.expectEmit(true, true, true, true);
        emit IGrantManager.GrantCreated(expectedId, principalId, cardId, 0, EPOCH, 4, termsHash, g.wrapRef);
        vm.prank(address(0xBEEF)); // relayed
        bytes32 grantId = submitGrant(g, grantSig(AUTHORITY_SK, g));
        assertEq(grantId, expectedId);

        GrantState memory s = grants.grantState(grantId);
        assertEq(s.granteeCard, cardId);
        assertEq(s.ns, 0);
        assertEq(s.epochStart, EPOCH);
        assertEq(s.epochEnd, 0);
        assertEq(s.termsHash, termsHash);
        assertEq(uint8(s.status), uint8(GrantStatus.ACTIVE));
        assertEq(grants.termOf(grantId), 4);
        assertEq(grants.principalOf(grantId), principalId);
        assertEq(grants.wrapRefOf(grantId), g.wrapRef);
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.ACTIVE));
        assertTrue(grants.nonceUsed(principalId, g.nonce));
    }

    function test_grantRejectsEveryPrecondition() public {
        GrantArgs memory g = defaultGrant();
        bytes memory good = grantSig(AUTHORITY_SK, g);

        GrantArgs memory a = defaultGrant();
        a.granteeCard = keccak256("nocard");
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.UnknownCard.selector, a.granteeCard));
        submitGrant(a, good);

        a = defaultGrant();
        a.termsHash = keccak256("unaccepted");
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.TermsNotAccepted.selector, cardId, a.termsHash));
        submitGrant(a, good);

        a = defaultGrant();
        a.term = 0;
        vm.expectRevert(IGrantManager.ZeroTerm.selector);
        submitGrant(a, good);

        a = defaultGrant();
        a.term = uint64(EpochLib.MAX_GRANT_TERM_EPOCHS + 1);
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.TermTooLong.selector, a.term));
        submitGrant(a, good);

        a = defaultGrant();
        a.epochStart = EPOCH - 1;
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.EpochNotCurrent.selector, EPOCH - 1, EPOCH));
        submitGrant(a, good);

        // Wrong signer / tampered wrapRef.
        bytes memory foreign = grantSig(0xBAD1, g);
        vm.expectRevert(IGrantManager.InvalidAuthoritySignature.selector);
        submitGrant(g, foreign);
        a = defaultGrant();
        a.wrapRef = keccak256("other wrap");
        vm.expectRevert(IGrantManager.InvalidAuthoritySignature.selector);
        submitGrant(a, good);

        // Success, then duplicate.
        submitGrant(g, good);
        vm.expectRevert(
            abi.encodeWithSelector(IGrantManager.GrantExists.selector, grants.grantIdOf(principalId, cardId, 0, EPOCH))
        );
        submitGrant(g, good);
    }

    function test_grantEnforcesPriceFloorAndNamespaceBinding() public {
        GrantManager strict = new GrantManager(registry, rescissions, 0, 5000, REVEAL_WINDOW);
        bytes32 c = strict.registerCard(cardOwner, CARD_X25519);
        TermsInput memory t = defaultTerms(); // price 1_000 < floor 5_000
        bytes32 nonce = bytes32(uint256(7));
        bytes32 structHash = AuthorityDigests_acceptTerms(c, principalId, t.ns, hashOf(t), nonce);
        bytes memory cardSig = SecpSigner_sign(CARD_SK, PassportLib.digestOf(structHash, strict.domainSeparator()));
        bytes32 th = strict.acceptTerms(c, principalId, t, nonce, cardSig);
        GrantArgs memory g = defaultGrant();
        g.granteeCard = c;
        g.termsHash = th;
        bytes memory sig =
            P256Signer_sign(AUTHORITY_SK, PassportLib.digestOf(AuthorityDigests_grant(g), strict.domainSeparator()));
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.PriceBelowFloor.selector, 1000));
        strict.grant(g.principalId, g.granteeCard, g.ns, g.epochStart, g.term, g.termsHash, g.wrapRef, g.nonce, sig);

        // Terms registered for ns 0 cannot back a grant on ns 1 (acceptance key already binds ns; check the error
        // path).
        GrantArgs memory n = defaultGrant();
        n.ns = 1;
        bytes memory nsig = grantSig(AUTHORITY_SK, n);
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.TermsNotAccepted.selector, cardId, termsHash));
        submitGrant(n, nsig);
    }

    // ── status derivation ───────────────────────────────────────────────────────────────────────

    function test_statusPrecedence_expiredBeatsFrozen_frozenDerivedFromRegistry() public {
        bytes32 grantId = doGrant(); // start 5, term 4 → expires at 9 ; principal attested 5, grace 2 → frozen at 8
        warpToEpoch(7);
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.ACTIVE));
        warpToEpoch(8);
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.FROZEN));
        // Re-attest → thaws (Phase 4 adds the one-epoch-boundary rule).
        attest(AUTHORITY_SK, principalId, 8, bytes32(uint256(50)));
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.ACTIVE));
        warpToEpoch(9);
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.EXPIRED));
        warpToEpoch(20); // both expired and frozen: EXPIRED wins
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.EXPIRED));
        assertEq(uint8(grants.grantState(grantId).status), uint8(GrantStatus.ACTIVE), "derived, never stored");
    }

    // ── rescind ─────────────────────────────────────────────────────────────────────────────────

    function test_rescindDirect() public {
        bytes32 grantId = doGrant();
        vm.roll(1234);
        bytes32 nonce = bytes32(uint256(200));
        bytes memory sig = rescindSig(AUTHORITY_SK, grantId, EPOCH, nonce);
        vm.expectEmit(true, false, false, true);
        emit IGrantManager.GrantRescinded(grantId, EPOCH, 1234, false);
        grants.rescind(grantId, EPOCH, nonce, sig);
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.RESCINDED));
        assertEq(grants.grantState(grantId).epochEnd, EPOCH);
        assertEq(grants.wrapRefOf(grantId), keccak256("wrap"), "wrap reference never changes");

        bytes memory again = rescindSig(AUTHORITY_SK, grantId, EPOCH, bytes32(uint256(201)));
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.GrantAlreadyRescinded.selector, grantId));
        grants.rescind(grantId, EPOCH, bytes32(uint256(201)), again);
    }

    function test_rescindRejectsUnknownWrongEpochForeignAndReplay() public {
        bytes32 none = keccak256("none");
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.GrantNotLive.selector, none));
        grants.rescind(none, EPOCH, bytes32(0), "");

        bytes32 grantId = doGrant();
        bytes memory sig = rescindSig(AUTHORITY_SK, grantId, EPOCH + 1, bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.EpochNotCurrent.selector, EPOCH + 1, EPOCH));
        grants.rescind(grantId, EPOCH + 1, bytes32(uint256(1)), sig);

        bytes memory foreign = rescindSig(0xBAD1, grantId, EPOCH, bytes32(uint256(2)));
        vm.expectRevert(IGrantManager.InvalidAuthoritySignature.selector);
        grants.rescind(grantId, EPOCH, bytes32(uint256(2)), foreign);

        // nonce 100 was consumed by grant()
        bytes memory replay = rescindSig(AUTHORITY_SK, grantId, EPOCH, bytes32(uint256(100)));
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.NonceAlreadyUsed.selector, bytes32(uint256(100))));
        grants.rescind(grantId, EPOCH, bytes32(uint256(100)), replay);
    }

    function test_revealRescindUsesCommitBlockAsEffectiveEnd() public {
        bytes32 grantId = doGrant();
        bytes32 salt = keccak256("salt");
        bytes32 commitment = rescissions.commitmentOf(grantId, salt);
        bytes32 nonce = bytes32(uint256(300));

        bytes memory sig = revealSig(AUTHORITY_SK, commitment, nonce);
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.CommitMissing.selector, commitment));
        grants.revealRescind(grantId, salt, nonce, sig);

        vm.roll(2000);
        vm.prank(address(0xC0FFEE)); // anyone may commit
        rescissions.commit(commitment);
        vm.roll(2000 + REVEAL_WINDOW);
        vm.expectEmit(true, false, false, true);
        emit IGrantManager.GrantRescinded(grantId, EPOCH, 2000, true);
        grants.revealRescind(grantId, salt, nonce, sig);
        assertEq(uint8(grants.effectiveStatus(grantId)), uint8(GrantStatus.RESCINDED));
    }

    function test_revealRescindRejectsLateRevealAndForeignSigner() public {
        bytes32 grantId = doGrant();
        bytes32 salt = keccak256("salt");
        bytes32 commitment = rescissions.commitmentOf(grantId, salt);
        vm.roll(3000);
        rescissions.commit(commitment);
        vm.roll(3000 + REVEAL_WINDOW + 1);
        bytes memory sig = revealSig(AUTHORITY_SK, commitment, bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(IGrantManager.RevealWindowElapsed.selector, 3000, REVEAL_WINDOW));
        grants.revealRescind(grantId, salt, bytes32(uint256(1)), sig);

        vm.roll(3000 + REVEAL_WINDOW);
        bytes memory foreign = revealSig(0xBAD1, commitment, bytes32(uint256(1)));
        vm.expectRevert(IGrantManager.InvalidAuthoritySignature.selector);
        grants.revealRescind(grantId, salt, bytes32(uint256(1)), foreign);
    }

    function test_constructorDefaults() public {
        GrantManager g = new GrantManager(registry, rescissions, 3, 42, 7);
        assertEq(g.maxTerm(), 3);
        assertEq(g.priceFloor(), 42);
        assertEq(g.revealWindowBlocks(), 7);
    }

    // small wrappers so the strict-floor test stays under the stack limit
    function AuthorityDigests_acceptTerms(
        bytes32 c,
        bytes32 p,
        uint32 ns,
        bytes32 th,
        bytes32 nonce
    ) internal pure returns (bytes32) {
        return AuthorityDigestsLib.acceptTerms(c, p, ns, th, nonce);
    }

    function AuthorityDigests_grant(
        GrantArgs memory g
    ) internal pure returns (bytes32) {
        return AuthorityDigestsLib.grant(
            g.principalId, g.granteeCard, g.ns, g.epochStart, g.term, g.termsHash, g.wrapRef, g.nonce
        );
    }

    function SecpSigner_sign(uint256 sk, bytes32 digest) internal pure returns (bytes memory) {
        return SecpSignerLib.sign(vm, sk, digest);
    }

    function P256Signer_sign(uint256 sk, bytes32 digest) internal pure returns (bytes memory) {
        return P256SignerLib.sign(vm, sk, digest);
    }
}

import {AuthorityDigests as AuthorityDigestsLib} from "../../src/libraries/AuthorityDigests.sol";
import {SecpSigner as SecpSignerLib} from "../SecpSigner.sol";
import {P256Signer as P256SignerLib} from "../P256Signer.sol";
