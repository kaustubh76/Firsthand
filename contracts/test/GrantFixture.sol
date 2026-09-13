// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {GrantManager} from "../src/GrantManager.sol";
import {PrincipalRegistry} from "../src/PrincipalRegistry.sol";
import {Rescissions} from "../src/Rescissions.sol";
import {AuthorityDigests} from "../src/libraries/AuthorityDigests.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {P256} from "../src/libraries/P256.sol";
import {PassportLib} from "../src/libraries/PassportLib.sol";
import {TermsInput} from "../src/types/Structs.sol";
import {P256Double} from "./doubles/P256Double.sol";
import {P256Signer} from "./P256Signer.sol";
import {SecpSigner} from "./SecpSigner.sol";

/// @dev Shared fixture for the demand-side tests: registry + rescissions + grant manager, one enrolled principal,
///      one registered card, one accepted terms set. Helpers sign with the fixture keys.
abstract contract GrantFixture is Test {
    uint64 internal constant GENESIS = 1_700_000_000;
    uint64 internal constant LEN = EpochLib.DEFAULT_EPOCH_SECONDS;
    uint64 internal constant EPOCH = 5;
    uint64 internal constant REVEAL_WINDOW = 100;
    uint256 internal constant AUTHORITY_SK = 0xA11CE;
    uint256 internal constant CARD_SK = 0xCA4D;
    bytes32 internal constant CARD_X25519 = bytes32(uint256(0x25519));

    PrincipalRegistry internal registry;
    Rescissions internal rescissions;
    GrantManager internal grants;

    bytes32 internal principalId;
    address internal cardOwner;
    bytes32 internal cardId;
    address internal payee = address(0xFEE);
    bytes32 internal termsHash;

    function setUp() public virtual {
        P256Double.etch(vm);
        vm.warp(GENESIS + EPOCH * LEN + 1);
        vm.roll(1000);
        registry = new PrincipalRegistry(GENESIS, LEN, EpochLib.LIVENESS_GRACE_EPOCHS);
        rescissions = new Rescissions();
        grants = new GrantManager(registry, rescissions, 0, 0, REVEAL_WINDOW);
        principalId = enroll(AUTHORITY_SK, EPOCH);
        cardOwner = vm.addr(CARD_SK);
        cardId = grants.registerCard(cardOwner, CARD_X25519);
        termsHash = acceptDefaultTerms();
    }

    // ── principal ───────────────────────────────────────────────────────────────────────────────

    function enroll(uint256 sk, uint64 epoch) internal returns (bytes32 id) {
        (uint256 x, uint256 y) = P256Signer.publicKey(vm, sk);
        id = P256.commitment(x, y);
        bytes32 nonce = bytes32(uint256(1));
        bytes32 digest = PassportLib.digestOf(AuthorityDigests.enroll(id, epoch, nonce), registry.domainSeparator());
        registry.enroll(x, y, epoch, nonce, P256Signer.sign(vm, sk, digest));
    }

    function attest(uint256 sk, bytes32 id, uint64 epoch, bytes32 nonce) internal {
        bytes32 root = keccak256(abi.encode("keys", epoch));
        bytes32 digest =
            PassportLib.digestOf(AuthorityDigests.attest(id, epoch, root, nonce), registry.domainSeparator());
        registry.attest(id, epoch, root, nonce, P256Signer.sign(vm, sk, digest));
    }

    // ── terms & cards ───────────────────────────────────────────────────────────────────────────

    function defaultTerms() internal view returns (TermsInput memory t) {
        t.price = 1000;
        t.licenseId = keccak256("FH-1.0");
        t.scope = 3;
        t.ns = 0;
        t.rateLimit = 3;
        t.payees = new address[](1);
        t.payees[0] = payee;
        t.weights = new uint256[](1);
        t.weights[0] = 1e18;
    }

    function hashOf(
        TermsInput memory t
    ) internal pure returns (bytes32) {
        return PassportLib.hashTerms(t.price, t.licenseId, t.scope, t.ns, t.rateLimit, t.payees, t.weights);
    }

    function acceptSig(
        uint256 sk,
        bytes32 card,
        bytes32 principal,
        TermsInput memory t,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = AuthorityDigests.acceptTerms(card, principal, t.ns, hashOf(t), nonce);
        return SecpSigner.sign(vm, sk, PassportLib.digestOf(structHash, grants.domainSeparator()));
    }

    function acceptDefaultTerms() internal returns (bytes32) {
        TermsInput memory t = defaultTerms();
        bytes32 nonce = bytes32(uint256(1));
        return grants.acceptTerms(cardId, principalId, t, nonce, acceptSig(CARD_SK, cardId, principalId, t, nonce));
    }

    // ── grants ──────────────────────────────────────────────────────────────────────────────────

    struct GrantArgs {
        bytes32 principalId;
        bytes32 granteeCard;
        uint32 ns;
        uint64 epochStart;
        uint64 term;
        bytes32 termsHash;
        bytes32 wrapRef;
        bytes32 nonce;
    }

    function defaultGrant() internal view returns (GrantArgs memory g) {
        g.principalId = principalId;
        g.granteeCard = cardId;
        g.ns = 0;
        g.epochStart = EPOCH;
        g.term = 4;
        g.termsHash = termsHash;
        g.wrapRef = keccak256("wrap");
        g.nonce = bytes32(uint256(100));
    }

    function grantSig(uint256 sk, GrantArgs memory g) internal view returns (bytes memory) {
        bytes32 structHash = AuthorityDigests.grant(
            g.principalId, g.granteeCard, g.ns, g.epochStart, g.term, g.termsHash, g.wrapRef, g.nonce
        );
        return P256Signer.sign(vm, sk, PassportLib.digestOf(structHash, grants.domainSeparator()));
    }

    function submitGrant(GrantArgs memory g, bytes memory sig) internal returns (bytes32) {
        return
            grants.grant(g.principalId, g.granteeCard, g.ns, g.epochStart, g.term, g.termsHash, g.wrapRef, g.nonce, sig);
    }

    function doGrant() internal returns (bytes32) {
        GrantArgs memory g = defaultGrant();
        return submitGrant(g, grantSig(AUTHORITY_SK, g));
    }

    function rescindSig(
        uint256 sk,
        bytes32 grantId,
        uint64 epoch,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 digest = PassportLib.digestOf(AuthorityDigests.rescind(grantId, epoch, nonce), grants.domainSeparator());
        return P256Signer.sign(vm, sk, digest);
    }

    function revealSig(uint256 sk, bytes32 commitment, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 digest =
            PassportLib.digestOf(AuthorityDigests.rescindCommit(commitment, nonce), grants.domainSeparator());
        return P256Signer.sign(vm, sk, digest);
    }

    function warpToEpoch(
        uint64 epoch
    ) internal {
        vm.warp(GENESIS + epoch * LEN + 1);
    }
}
