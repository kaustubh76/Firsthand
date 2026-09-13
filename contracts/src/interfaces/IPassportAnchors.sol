// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AnchorRecord, BatchProof} from "../types/Structs.sol";

/// @title IPassportAnchors
/// @notice Per-namespace batch roots and terms hashes, append-only (README §7.1, §9, ADR-0010).
/// @dev    `anchor` is relayable by anyone: authorisation is the secp256k1 deposit-key signature over
///         `AuthorityDigests.anchor(...)` under this contract's domain, and the signer must be `depositKeys[ns]`
///         whose commitment the principal attested for `epoch` in PrincipalRegistry. Deposit keys therefore never
///         hold funds (decision #11). Two implementations share this interface — `PassportAnchorsBaseline` (plain
///         mappings) and `PassportAnchorsPaged` (MIP-8 clustered layout) — the H1 experiment arms.
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
    error ZeroRoot();
    error DepositKeysMismatch(bytes32 expectedRoot, bytes32 actualRoot);
    error EpochNotAttested(bytes32 principalId, uint64 epoch);
    error EpochInFuture(uint64 epoch, uint64 current);
    error InvalidDepositSignature(address recovered, address expected);
    error NonceAlreadyUsed(bytes32 nonce);
    error NamespaceOutOfRange(uint32 ns);

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
    function anchorOf(
        bytes32 batchRoot
    ) external view returns (AnchorRecord memory);
    function batchCount(bytes32 principalId, uint32 ns, uint64 epoch) external view returns (uint256);
    function batchRootAt(
        bytes32 principalId,
        uint32 ns,
        uint64 epoch,
        uint256 batchIndex
    ) external view returns (bytes32);
    /// @notice On-chain half of verify(): the root is anchored AND `passportId` sits at `proof.index` under it.
    function isIncluded(
        bytes32 batchRoot,
        bytes32 passportId,
        BatchProof calldata proof
    ) external view returns (bool);
    function nonceUsed(bytes32 principalId, bytes32 nonce) external view returns (bool);
    /// @notice EIP-712 domain separator this contract verifies deposit-key signatures under (ADR-0009).
    function domainSeparator() external view returns (bytes32);
    function registry() external view returns (address);
    /// @notice "paged" or "baseline" — lets the experiment harness label the arm it deployed.
    function layout() external pure returns (string memory);
}
