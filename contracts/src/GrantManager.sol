// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IGrantManager} from "./interfaces/IGrantManager.sol";
import {IPrincipalRegistry} from "./interfaces/IPrincipalRegistry.sol";
import {IRescissions} from "./interfaces/IRescissions.sol";
import {AuthorityDigests} from "./libraries/AuthorityDigests.sol";
import {EpochLib} from "./libraries/EpochLib.sol";
import {P256} from "./libraries/P256.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {Card, GrantState, GrantStatus, RegisteredTerms, TermsInput} from "./types/Structs.sol";

/// @title GrantManager
/// @notice Grant lifecycle (README §7.2, §7.5, §11): terms accepted by a grantee card, grants and rescissions
///         signed by the principal's passkey-derived P-256 authority key, status derived lazily — no keepers.
/// @dev    Immutable; no admin. Nonces are scoped: card nonces under the card id, principal nonces under the
///         principal id. FROZEN thaw-after-boundary (README §7.6) lands with Phase 4.
contract GrantManager is IGrantManager {
    IPrincipalRegistry internal immutable _registry;
    IRescissions internal immutable _rescissions;
    uint64 public immutable override maxTerm;
    uint64 public immutable override priceFloor;
    uint64 public immutable override revealWindowBlocks;

    mapping(bytes32 cardId => Card) internal _cards;
    mapping(bytes32 termsHash => RegisteredTerms) internal _terms;
    mapping(bytes32 acceptanceKey => bool) internal _accepted;
    mapping(bytes32 grantId => GrantState) internal _grants;
    mapping(bytes32 grantId => bytes32) internal _principalOf;
    mapping(bytes32 grantId => bytes32) internal _wrapRef;
    mapping(bytes32 grantId => uint64) internal _termOf;
    mapping(bytes32 scope => mapping(bytes32 nonce => bool)) internal _nonceUsed;

    constructor(
        IPrincipalRegistry registry_,
        IRescissions rescissions_,
        uint64 maxTerm_,
        uint64 priceFloor_,
        uint64 revealWindowBlocks_
    ) {
        _registry = registry_;
        _rescissions = rescissions_;
        maxTerm = maxTerm_ == 0 ? EpochLib.MAX_GRANT_TERM_EPOCHS : maxTerm_;
        priceFloor = priceFloor_ == 0 ? 1 : priceFloor_;
        revealWindowBlocks = revealWindowBlocks_;
    }

    // ── cards & terms ───────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IGrantManager
    function registerCard(address owner, bytes32 encryptionPubKey) external returns (bytes32 cardId) {
        cardId = cardIdOf(owner, encryptionPubKey);
        if (_cards[cardId].owner == address(0)) {
            _cards[cardId] = Card({owner: owner, encryptionPubKey: encryptionPubKey});
            emit CardRegistered(cardId, owner, encryptionPubKey);
        }
    }

    /// @inheritdoc IGrantManager
    function acceptTerms(
        bytes32 granteeCard,
        bytes32 principalId,
        TermsInput calldata terms,
        bytes32 nonce,
        bytes calldata cardSig
    ) external returns (bytes32 termsHash) {
        Card storage card = _cards[granteeCard];
        if (card.owner == address(0)) revert UnknownCard(granteeCard);
        _requirePrincipal(principalId);
        _useNonce(granteeCard, nonce);

        termsHash = PassportLib.hashTerms(
            terms.price, terms.licenseId, terms.scope, terms.ns, terms.rateLimit, terms.payees, terms.weights
        );
        bytes32 digest = _digest(AuthorityDigests.acceptTerms(granteeCard, principalId, terms.ns, termsHash, nonce));
        if (PassportLib.recoverOrigin(digest, cardSig) != card.owner) revert InvalidCardSignature();

        if (!_terms[termsHash].exists) {
            _terms[termsHash] =
                RegisteredTerms({price: terms.price, rateLimit: terms.rateLimit, ns: terms.ns, exists: true});
        }
        _accepted[_acceptanceKey(granteeCard, principalId, terms.ns, termsHash)] = true;
        emit TermsAccepted(granteeCard, principalId, terms.ns, termsHash);
    }

    // ── grants ──────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IGrantManager
    function grant(
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart,
        uint64 term,
        bytes32 termsHash,
        bytes32 wrapRef,
        bytes32 nonce,
        bytes calldata authoritySig
    ) external returns (bytes32 grantId) {
        grantId = grantIdOf(principalId, granteeCard, ns, epochStart);
        _validateGrant(grantId, principalId, granteeCard, ns, epochStart, term, termsHash);
        _useNonce(principalId, nonce);
        _requireAuthority(
            principalId,
            _digest(AuthorityDigests.grant(principalId, granteeCard, ns, epochStart, term, termsHash, wrapRef, nonce)),
            authoritySig
        );
        _grants[grantId] = GrantState({
            granteeCard: granteeCard,
            ns: ns,
            epochStart: epochStart,
            epochEnd: 0,
            termsHash: termsHash,
            status: GrantStatus.ACTIVE
        });
        _termOf[grantId] = term;
        _principalOf[grantId] = principalId;
        _wrapRef[grantId] = wrapRef;
        emit GrantCreated(grantId, principalId, granteeCard, ns, epochStart, term, termsHash, wrapRef);
    }

    function _validateGrant(
        bytes32 grantId,
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart,
        uint64 term,
        bytes32 termsHash
    ) internal view {
        if (_grants[grantId].status != GrantStatus.NONE) revert GrantExists(grantId);
        if (_cards[granteeCard].owner == address(0)) revert UnknownCard(granteeCard);
        if (!_accepted[_acceptanceKey(granteeCard, principalId, ns, termsHash)]) {
            revert TermsNotAccepted(granteeCard, termsHash);
        }
        RegisteredTerms storage rt = _terms[termsHash];
        if (rt.ns != ns) revert TermsNamespaceMismatch(rt.ns, ns);
        if (rt.price < priceFloor) revert PriceBelowFloor(rt.price);
        if (term == 0) revert ZeroTerm();
        if (term > maxTerm) revert TermTooLong(term);
        _requireCurrentEpoch(epochStart);
    }

    /// @inheritdoc IGrantManager
    function rescind(bytes32 grantId, uint64 epoch, bytes32 nonce, bytes calldata authoritySig) external {
        bytes32 principalId = _requireRescindable(grantId);
        _requireCurrentEpoch(epoch);
        _useNonce(principalId, nonce);
        _requireAuthority(principalId, _digest(AuthorityDigests.rescind(grantId, epoch, nonce)), authoritySig);
        _finalise(grantId, epoch, uint64(block.number), false);
    }

    /// @inheritdoc IGrantManager
    function revealRescind(bytes32 grantId, bytes32 salt, bytes32 nonce, bytes calldata authoritySig) external {
        bytes32 principalId = _requireRescindable(grantId);
        bytes32 commitment = _rescissions.commitmentOf(grantId, salt);
        uint64 commitBlock = _rescissions.commitBlock(commitment);
        if (commitBlock == 0) revert CommitMissing(commitment);
        if (uint64(block.number) - commitBlock > revealWindowBlocks) {
            revert RevealWindowElapsed(commitBlock, revealWindowBlocks);
        }
        _useNonce(principalId, nonce);
        _requireAuthority(principalId, _digest(AuthorityDigests.rescindCommit(commitment, nonce)), authoritySig);
        _finalise(grantId, currentEpoch(), commitBlock, true);
    }

    // ── views ───────────────────────────────────────────────────────────────────────────────────

    function cardOf(
        bytes32 cardId
    ) external view returns (Card memory) {
        return _cards[cardId];
    }

    function cardIdOf(address owner, bytes32 encryptionPubKey) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, encryptionPubKey));
    }

    function termsOf(
        bytes32 termsHash
    ) external view returns (RegisteredTerms memory) {
        return _terms[termsHash];
    }

    function grantState(
        bytes32 grantId
    ) external view returns (GrantState memory) {
        return _grants[grantId];
    }

    function termOf(
        bytes32 grantId
    ) external view returns (uint64) {
        return _termOf[grantId];
    }

    function principalOf(
        bytes32 grantId
    ) external view returns (bytes32) {
        return _principalOf[grantId];
    }

    function wrapRefOf(
        bytes32 grantId
    ) external view returns (bytes32) {
        return _wrapRef[grantId];
    }

    function termsAccepted(
        bytes32 granteeCard,
        bytes32 principalId,
        uint32 ns,
        bytes32 termsHash
    ) external view returns (bool) {
        return _accepted[_acceptanceKey(granteeCard, principalId, ns, termsHash)];
    }

    /// @inheritdoc IGrantManager
    function effectiveStatus(
        bytes32 grantId
    ) public view returns (GrantStatus) {
        GrantState storage g = _grants[grantId];
        if (g.status == GrantStatus.NONE) return GrantStatus.NONE;
        if (g.status == GrantStatus.RESCINDED) return GrantStatus.RESCINDED;
        if (currentEpoch() >= g.epochStart + _termOf[grantId]) return GrantStatus.EXPIRED;
        if (!_registry.isLive(_principalOf[grantId])) return GrantStatus.FROZEN;
        return GrantStatus.ACTIVE;
    }

    function grantIdOf(
        bytes32 principalId,
        bytes32 granteeCard,
        uint32 ns,
        uint64 epochStart
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(principalId, granteeCard, ns, epochStart));
    }

    function nonceUsed(bytes32 scope, bytes32 nonce) external view returns (bool) {
        return _nonceUsed[scope][nonce];
    }

    function domainSeparator() public view returns (bytes32) {
        return PassportLib.domainSeparator(block.chainid, address(this));
    }

    function currentEpoch() public view returns (uint64) {
        return _registry.currentEpoch();
    }

    function registry() external view returns (address) {
        return address(_registry);
    }

    function rescissions() external view returns (address) {
        return address(_rescissions);
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────

    function _requireRescindable(
        bytes32 grantId
    ) internal view returns (bytes32 principalId) {
        GrantState storage g = _grants[grantId];
        if (g.status == GrantStatus.RESCINDED) revert GrantAlreadyRescinded(grantId);
        if (g.status != GrantStatus.ACTIVE) revert GrantNotLive(grantId);
        principalId = _principalOf[grantId];
    }

    function _finalise(bytes32 grantId, uint64 epochEnd, uint64 effectiveBlock, bool viaCommitReveal) internal {
        GrantState storage g = _grants[grantId];
        g.status = GrantStatus.RESCINDED;
        g.epochEnd = epochEnd;
        emit GrantRescinded(grantId, epochEnd, effectiveBlock, viaCommitReveal);
    }

    function _requirePrincipal(
        bytes32 principalId
    ) internal view {
        (uint256 x,) = _registry.authorityKey(principalId);
        if (x == 0) revert UnknownPrincipal(principalId);
    }

    function _requireAuthority(bytes32 principalId, bytes32 digest, bytes calldata authoritySig) internal view {
        (uint256 x, uint256 y) = _registry.authorityKey(principalId);
        if (x == 0) revert UnknownPrincipal(principalId);
        if (!P256.verifySignature(digest, authoritySig, x, y)) revert InvalidAuthoritySignature();
    }

    function _digest(
        bytes32 structHash
    ) internal view returns (bytes32) {
        return PassportLib.digestOf(structHash, domainSeparator());
    }

    function _requireCurrentEpoch(
        uint64 epoch
    ) internal view {
        uint64 current = currentEpoch();
        if (epoch != current) revert EpochNotCurrent(epoch, current);
    }

    function _useNonce(bytes32 scope, bytes32 nonce) internal {
        if (_nonceUsed[scope][nonce]) revert NonceAlreadyUsed(nonce);
        _nonceUsed[scope][nonce] = true;
    }

    function _acceptanceKey(
        bytes32 granteeCard,
        bytes32 principalId,
        uint32 ns,
        bytes32 termsHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(granteeCard, principalId, ns, termsHash));
    }
}
