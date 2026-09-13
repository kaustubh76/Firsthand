// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRescissions
/// @notice Commit store for the commit-reveal rescission fallback (README §8 claim 1, §12 liveness).
/// @dev    Anyone may post a commitment — the principal, a relayer, or the gateway — so the sender is
///         unlinkable to the grant. `commitment = keccak256(abi.encode(grantId, salt))`. GrantManager treats
///         the commit block as the effective end of consent when the reveal lands within one epoch.
///         When BTX is available the direct `GrantManager.rescind` travels the encrypted mempool instead.
interface IRescissions {
    event RescissionCommitted(bytes32 indexed commitment, uint64 blockNumber, address relayer);

    error AlreadyCommitted(bytes32 commitment);

    function commit(
        bytes32 commitment
    ) external;
    function commitBlock(
        bytes32 commitment
    ) external view returns (uint64);
    function commitmentOf(bytes32 grantId, bytes32 salt) external pure returns (bytes32);
}
