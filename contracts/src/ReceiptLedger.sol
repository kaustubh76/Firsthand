// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NotImplemented} from "./Errors.sol";
import {IReceiptLedger} from "./interfaces/IReceiptLedger.sol";
import {Receipt} from "./types/Structs.sol";

/// @title ReceiptLedger
/// @notice Phase 3 stub. `router` is immutable — precomputed at deploy time to break the router↔ledger cycle.
contract ReceiptLedger is IReceiptLedger {
    address public immutable override router;

    mapping(bytes32 receiptId => Receipt) internal _receipts;
    mapping(bytes32 grantId => mapping(uint64 epoch => uint32)) internal _queries;

    constructor(
        address router_
    ) {
        router = router_;
    }

    function record(bytes32, bytes32, address, uint32, bytes32, uint32) external view returns (bytes32) {
        if (msg.sender != router) revert NotRouter(msg.sender);
        revert NotImplemented("ReceiptLedger.record");
    }

    function receipt(
        bytes32 receiptId
    ) external view returns (Receipt memory) {
        return _receipts[receiptId];
    }

    function queriesThisEpoch(bytes32 grantId, uint64 epoch) external view returns (uint32) {
        return _queries[grantId][epoch];
    }

    function receiptIdOf(bytes32 grantId, bytes32 queryNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(grantId, queryNonce));
    }
}
