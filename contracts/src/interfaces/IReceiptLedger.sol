// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Receipt} from "../types/Structs.sol";

/// @title IReceiptLedger
/// @notice Query receipts and per-grant, per-epoch rate-limit counters (README §9, decisions #3/#4).
/// @dev    Written only by the immutable RoyaltyRouter (the settlement path). Receipts are unique per
///         `(grantId, queryNonce)` where `queryNonce` is the EIP-3009 authorization nonce, so payment dedup and
///         receipt dedup coincide.
interface IReceiptLedger {
    event ReceiptRecorded(
        bytes32 indexed receiptId,
        bytes32 indexed grantId,
        address indexed payer,
        uint32 ns,
        bytes32 termsHash,
        uint64 epoch
    );

    error NotRouter(address caller);
    error DuplicateReceipt(bytes32 receiptId);
    error RateLimitExceeded(bytes32 grantId, uint64 epoch, uint32 limit);

    function record(
        bytes32 grantId,
        bytes32 queryNonce,
        address payer,
        uint32 ns,
        bytes32 termsHash,
        uint32 rateLimit
    ) external returns (bytes32 receiptId);

    function receipt(
        bytes32 receiptId
    ) external view returns (Receipt memory);
    function queriesThisEpoch(bytes32 grantId, uint64 epoch) external view returns (uint32);
    function receiptIdOf(bytes32 grantId, bytes32 queryNonce) external pure returns (bytes32);
    function router() external view returns (address);
}
