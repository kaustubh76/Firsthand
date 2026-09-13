// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IReceiptLedger} from "./interfaces/IReceiptLedger.sol";
import {Receipt} from "./types/Structs.sol";

/// @title ReceiptLedger
/// @notice Every served query leaves a receipt (README §7.3 "adverse" = a served query without one). Rate-limit
///         counters live here, keyed by (grant, epoch), so the chain — not the gateway — is the source of truth.
/// @dev    `router` is immutable and precomputed at deploy time to break the router↔ledger cycle.
contract ReceiptLedger is IReceiptLedger {
    address public immutable override router;

    mapping(bytes32 receiptId => Receipt) internal _receipts;
    mapping(bytes32 receiptId => bool) internal _exists;
    mapping(bytes32 grantId => mapping(uint64 epoch => uint32)) internal _queries;

    constructor(
        address router_
    ) {
        router = router_;
    }

    /// @inheritdoc IReceiptLedger
    function record(
        bytes32 grantId,
        bytes32 queryNonce,
        address payer,
        uint32 ns,
        bytes32 termsHash,
        uint32 rateLimit,
        uint64 epoch
    ) external returns (bytes32 receiptId) {
        if (msg.sender != router) revert NotRouter(msg.sender);
        receiptId = receiptIdOf(grantId, queryNonce);
        if (_exists[receiptId]) revert DuplicateReceipt(receiptId);
        uint32 used = _queries[grantId][epoch];
        if (rateLimit != 0 && used >= rateLimit) revert RateLimitExceeded(grantId, epoch, rateLimit);
        _queries[grantId][epoch] = used + 1;
        _exists[receiptId] = true;
        _receipts[receiptId] = Receipt({
            grantId: grantId,
            payer: payer,
            ns: ns,
            termsHash: termsHash,
            blockNumber: uint64(block.number),
            epoch: epoch
        });
        emit ReceiptRecorded(receiptId, grantId, payer, ns, termsHash, epoch);
    }

    function receipt(
        bytes32 receiptId
    ) external view returns (Receipt memory) {
        return _receipts[receiptId];
    }

    function exists(
        bytes32 receiptId
    ) external view returns (bool) {
        return _exists[receiptId];
    }

    function queriesThisEpoch(bytes32 grantId, uint64 epoch) external view returns (uint32) {
        return _queries[grantId][epoch];
    }

    function receiptIdOf(bytes32 grantId, bytes32 queryNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(grantId, queryNonce));
    }
}
