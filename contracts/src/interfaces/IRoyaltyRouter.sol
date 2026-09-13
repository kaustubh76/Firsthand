// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TermsInput, TransferAuthorization} from "../types/Structs.sol";

/// @title IRoyaltyRouter
/// @notice x402 settlement: pulls USDC via EIP-3009, splits by SplitMath, pays payees, pools the residual,
///         and records the receipt — in one transaction, with no admin keys (README §7.3, §9, decision #9).
interface IRoyaltyRouter {
    event RoyaltyPaid(bytes32 indexed receiptId, bytes32 indexed grantId, uint256 price, uint256 residual);
    event DustSwept(address indexed to, uint256 amount);

    error TermsMismatch(bytes32 expected, bytes32 actual);
    error GrantNotLive(bytes32 grantId);
    error ValueMismatch(uint256 expected, uint256 actual);
    error NothingToSweep();

    /// @param grantId  the live grant the query is served under
    /// @param terms    preimage of the grant's termsHash (payees + weights drive the split)
    /// @param auth     buyer's EIP-3009 authorization for exactly `terms.price` to this router
    function settle(
        bytes32 grantId,
        TermsInput calldata terms,
        TransferAuthorization calldata auth
    ) external returns (bytes32 receiptId);

    /// @notice Sends the accumulated residual to the immutable dust pool. Permissionless (README §7.5 "monthly").
    function sweepDust() external returns (uint256 amount);

    function usdc() external view returns (address);
    function dustPool() external view returns (address);
    function dustBalance() external view returns (uint256);
}
