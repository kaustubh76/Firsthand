// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title EpochLib
/// @notice Epoch arithmetic (README §7.4, ADR-0008). Twin of the core TS `epoch` module.
/// @dev    epoch(t) = (t - genesis) / length. `genesis` and `length` are immutable per deployment.
library EpochLib {
    uint64 internal constant DEFAULT_EPOCH_SECONDS = 604_800; // 7 days
    uint64 internal constant LIVENESS_GRACE_EPOCHS = 2;
    uint64 internal constant MAX_GRANT_TERM_EPOCHS = 8;

    error BeforeGenesis(uint64 timestamp, uint64 genesis);
    error ZeroEpochLength();

    function epochAt(uint64 timestamp, uint64 genesis, uint64 length) internal pure returns (uint64) {
        if (length == 0) revert ZeroEpochLength();
        if (timestamp < genesis) revert BeforeGenesis(timestamp, genesis);
        return (timestamp - genesis) / length;
    }

    function epochStart(uint64 epoch, uint64 genesis, uint64 length) internal pure returns (uint64) {
        return genesis + epoch * length;
    }

    /// @notice Liveness: `e_now <= e_attested + grace` — the dead-man's switch check.
    function withinGrace(uint64 epochNow, uint64 epochAttested, uint64 grace) internal pure returns (bool) {
        return epochNow <= epochAttested + grace;
    }
}
