// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IPassportAnchors
/// @notice Per-namespace batch roots and terms hashes, append-only (README §7.1, §9).
/// @dev    `anchor` is relayable by anyone: authorization is the secp256k1 deposit-key signature over
///         `AuthorityDigests.anchor(...)`, and the key must be `depositKeys[ns]` under the epoch's attested
///         `depositKeysRoot`. Deposit keys therefore never hold funds (decision #11).
///         Two implementations share this interface: `PassportAnchorsBaseline` (plain SSTORE) and
///         `PassportAnchorsPaged` (MIP-8 clustered layout) — the H1 experiment arms.
interface IPassportAnchors {
    event BatchAnchored(
        bytes32 indexed principalId,
        uint32 indexed ns,
        uint64 indexed epoch,
        bytes32 batchRoot,
        bytes32 termsHash,
        uint256 batchIndex
    );

    error DuplicateRoot(bytes32 batchRoot);
    error DepositKeysMismatch(bytes32 expectedRoot);
    error InvalidDepositSignature(address recovered, address expected);
    error NonceAlreadyUsed(bytes32 nonce);
    error NamespaceOutOfRange(uint32 ns);
    error PrincipalNotLive(bytes32 principalId);

    function anchor(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        bytes32 batchRoot,
        bytes32 termsHash,
        bytes32 nonce,
        address[16] calldata depositKeys,
        bytes calldata depositSig
    ) external returns (uint256 batchIndex);

    function isAnchored(
        bytes32 batchRoot
    ) external view returns (bool);
    function anchorBlock(
        bytes32 batchRoot
    ) external view returns (uint64);
    function termsOf(
        bytes32 batchRoot
    ) external view returns (bytes32);
    function batchCount(bytes32 principalId, uint32 ns, uint64 epoch) external view returns (uint256);
    function batchRootAt(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        uint256 batchIndex
    ) external view returns (bytes32);
    /// @notice "paged" or "baseline" — lets the experiment harness label the arm it deployed.
    function layout() external pure returns (string memory);
}
