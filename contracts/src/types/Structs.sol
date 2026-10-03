// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title FIRSTHAND shared types
/// @notice Numeric values of every enum are mirrored in the core TS package (grant/state.ts, passport/types.ts).
///         Changing an order here is a protocol change.

/// @dev README §7.1 / §13 — what a passport certifies about capture, never about semantic quality.
enum AttestationClass {
    UNATTESTED,
    IMPORT,
    DEVICE_CAPTURE,
    HARDWARE
}

/// @dev README §11.
enum PrincipalStatus {
    NONE,
    ACTIVE,
    FROZEN
}

/// @dev README §7.5: `NONE → ACTIVE → (RESCINDED | EXPIRED | FROZEN)`.
///      Only ACTIVE and RESCINDED are ever *written*; EXPIRED / FROZEN are derived lazily.
enum GrantStatus {
    NONE,
    ACTIVE,
    RESCINDED,
    EXPIRED,
    FROZEN
}

/// @dev Reason codes returned by `FirsthandLens.verify`; mirrored by `VerifyFailure` in core.
enum VerifyFailure {
    NONE,
    SIG_INVALID,
    MERKLE_INVALID,
    ROOT_UNKNOWN,
    TERMS_MISMATCH,
    EPOCH_OUT_OF_GRANT,
    GRANT_NOT_LIVE,
    GRANT_RESCINDED,
    GRANT_EXPIRED,
    GRANT_FROZEN,
    SCOPE_MISMATCH
}

/// @dev README §11 `PrincipalState`.
struct PrincipalState {
    bytes32 p256KeyCommit; // keccak256(abi.encode(x, y)) of the enrolled authority key
    uint64 lastAttestedEpoch; // liveness
    PrincipalStatus status;
    uint64 thawEpoch; // first epoch a re-attested principal counts as live again (README §7.6); 0 = none scheduled
}

/// @dev README §11 `GrantState`. `queriesThisEpoch` lives in ReceiptLedger (decision #3).
struct GrantState {
    bytes32 granteeCard; // ERC-8004 card reference
    uint32 ns;
    uint64 epochStart;
    uint64 epochEnd; // 0 while ACTIVE
    bytes32 termsHash;
    GrantStatus status;
}

/// @dev Fixed-depth batch proof (ADR-0004). ABI size: 32 + 8 * 32 bytes.
struct BatchProof {
    uint8 index;
    bytes32[8] siblings;
}

/// @dev Preimage of `PassportLib.hashTerms`; supplied to RoyaltyRouter.settle so the split can run on-chain.
struct TermsInput {
    uint64 price;
    bytes32 licenseId;
    uint32 scope;
    uint32 ns;
    uint32 rateLimit;
    address[] payees;
    uint256[] weights;
}

/// @dev Query receipt (README §9 ReceiptLedger). `receiptId = keccak256(abi.encode(grantId, queryNonce))`.
struct Receipt {
    bytes32 grantId;
    address payer;
    uint32 ns;
    bytes32 termsHash;
    uint64 blockNumber;
    uint64 epoch;
}

/// @dev EIP-3009 `transferWithAuthorization` parameters carried by an x402 payment payload.
struct TransferAuthorization {
    address from;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

/// @dev What PassportAnchors records per batch root, independent of storage layout (ADR-0010).
struct AnchorRecord {
    bytes32 principalId;
    bytes32 termsHash;
    uint64 epoch;
    uint64 blockNumber;
    uint32 ns;
    uint32 batchIndex;
}

/// @dev One attested secure element, as `HardwareDeviceRegistry` records it (ADR-0015).
///      `securityLevel` and `verifiedBootState` are *measurements* read out of a signed
///      certificate, never values a depositor asserted — and the boot state is recorded rather
///      than enforced, because a developer handset with an unlocked bootloader reports UNVERIFIED
///      and refusing it on chain would make the device unusable rather than make it honest.
struct DeviceRecord {
    uint256 x;
    uint256 y;
    bytes32 principalId;
    uint64 registeredAt; // 0 when this commitment was never registered
    uint64 revokedAt; // 0 while live
    uint8 securityLevel; // 1 TrustedEnvironment, 2 StrongBox
    uint8 verifiedBootState; // 0 Verified, 1 SelfSigned, 2 Unverified, 3 Failed
    bool hasRootOfTrust;
}

/// @dev Grantee card commitment: `cardId = keccak256(abi.encode(owner, encryptionPubKey))` (ADR-0011).
struct Card {
    address owner; // secp256k1 key that signs terms acceptance
    bytes32 encryptionPubKey; // X25519 public key vault keys are wrapped to
}

/// @dev Terms registered by preimage at acceptance so grant() and the ledger need no re-supply (ADR-0011).
struct RegisteredTerms {
    uint64 price;
    uint32 rateLimit;
    uint32 ns;
    bool exists;
}
