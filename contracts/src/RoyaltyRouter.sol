// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC3009} from "./interfaces/IERC3009.sol";
import {IGrantManager} from "./interfaces/IGrantManager.sol";
import {IReceiptLedger} from "./interfaces/IReceiptLedger.sol";
import {IRoyaltyRouter} from "./interfaces/IRoyaltyRouter.sol";
import {PassportLib} from "./libraries/PassportLib.sol";
import {SplitMath} from "./libraries/SplitMath.sol";
import {GrantState, GrantStatus, TermsInput, TransferAuthorization} from "./types/Structs.sol";

/// @title RoyaltyRouter
/// @notice x402 settlement (README §7.3, §8 claim 4, ADR-0011): pull the buyer's USDC with an EIP-3009
///         authorization, split it integer-exactly, pay the payees, pool the residual, record the receipt — one
///         transaction, no admin keys. `payTo` in every 402 is this contract.
/// @dev    Immutable wiring. Anyone may relay a settlement: the buyer's authorization is bound to this router as
///         `to`, and the receipt is what the buyer paid for. Replaying a raw authorization directly at the token
///         only moves the same funds here as dust (documented, accepted for the hackathon; receiveWithAuthorization
///         is the hardening path).
contract RoyaltyRouter is IRoyaltyRouter {
    IERC3009 internal immutable _usdc;
    IGrantManager public immutable grants;
    IReceiptLedger public immutable ledger;
    address internal immutable _dustPool;

    uint256 internal _dust;

    constructor(IERC3009 usdc_, IGrantManager grants_, IReceiptLedger ledger_, address dustPool_) {
        _usdc = usdc_;
        grants = grants_;
        ledger = ledger_;
        _dustPool = dustPool_;
    }

    /// @inheritdoc IRoyaltyRouter
    function settle(
        bytes32 grantId,
        TermsInput calldata terms,
        TransferAuthorization calldata auth
    ) external returns (bytes32 receiptId) {
        if (grants.effectiveStatus(grantId) != GrantStatus.ACTIVE) revert GrantNotLive(grantId);
        GrantState memory g = grants.grantState(grantId);
        bytes32 termsHash = PassportLib.hashTerms(
            terms.price, terms.licenseId, terms.scope, terms.ns, terms.rateLimit, terms.payees, terms.weights
        );
        if (termsHash != g.termsHash) revert TermsMismatch(g.termsHash, termsHash);
        if (auth.value != terms.price) revert ValueMismatch(terms.price, auth.value);

        // Pull. The token verifies the buyer's signature over (from, to = this, value, validity, nonce).
        _usdc.transferWithAuthorization(
            auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );

        // Split and pay. SplitMath validates weights; zero pays are skipped.
        (uint256[] memory pays, uint256 residual) = SplitMath.split(auth.value, terms.weights);
        for (uint256 i = 0; i < pays.length; ++i) {
            if (pays[i] != 0) _usdc.transfer(terms.payees[i], pays[i]);
        }
        _dust += residual;

        receiptId =
            ledger.record(grantId, auth.nonce, auth.from, terms.ns, termsHash, terms.rateLimit, grants.currentEpoch());
        emit RoyaltyPaid(receiptId, grantId, auth.value, residual);
    }

    /// @inheritdoc IRoyaltyRouter
    function sweepDust() external returns (uint256 amount) {
        amount = _dust;
        if (amount == 0) revert NothingToSweep();
        _dust = 0;
        _usdc.transfer(_dustPool, amount);
        emit DustSwept(_dustPool, amount);
    }

    function usdc() external view returns (address) {
        return address(_usdc);
    }

    function dustPool() external view returns (address) {
        return _dustPool;
    }

    function dustBalance() external view returns (uint256) {
        return _dust;
    }
}
