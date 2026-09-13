// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRescissions} from "./interfaces/IRescissions.sol";

/// @title Rescissions
/// @notice Pure commit store for commit-reveal rescission (README §8 claim 1 fallback; decision #10).
/// @dev    Immutable, permissionless, no dependencies — GrantManager holds this address as an immutable and
///         validates `commitBlock` at reveal. Recording the relayer in the event is deliberate: it shows that
///         the sender carries no information about the principal.
contract Rescissions is IRescissions {
    mapping(bytes32 commitment => uint64 blockNumber) private _commitBlock;

    /// @inheritdoc IRescissions
    function commit(
        bytes32 commitment
    ) external {
        if (_commitBlock[commitment] != 0) revert AlreadyCommitted(commitment);
        _commitBlock[commitment] = uint64(block.number);
        emit RescissionCommitted(commitment, uint64(block.number), msg.sender);
    }

    /// @inheritdoc IRescissions
    function commitBlock(
        bytes32 commitment
    ) external view returns (uint64) {
        return _commitBlock[commitment];
    }

    /// @inheritdoc IRescissions
    function commitmentOf(bytes32 grantId, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(grantId, salt));
    }
}
