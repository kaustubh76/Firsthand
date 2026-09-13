import {
  type Address,
  assertBytes32,
  type Bytes32,
  concat,
  hexToBytes,
  pad32,
  u256be,
} from "../bytes.js";
import { keccak256Hex, keccak256Utf8 } from "../hash.js";
import { digestOf, domainSeparator } from "../passport/typed.js";
import type { Eip712Domain } from "../passport/types.js";

/**
 * EIP-712 struct hashes for authority operations — twin of `AuthorityDigests.sol`.
 * Every struct carries a nonce for replay protection. Type strings are normative.
 */
export const ENROLL_TYPE = "Enroll(bytes32 keyCommit,uint64 epoch,bytes32 nonce)";
export const ATTEST_TYPE =
  "Attest(bytes32 principalId,uint64 epoch,bytes32 depositKeysRoot,bytes32 nonce)";
export const GRANT_TYPE =
  "Grant(bytes32 principalId,bytes32 granteeCard,uint32 ns,uint64 epochStart,uint64 term,bytes32 termsHash,bytes32 wrapRef,bytes32 nonce)";
export const ACCEPT_TERMS_TYPE =
  "AcceptTerms(bytes32 granteeCard,bytes32 principalId,uint32 ns,bytes32 termsHash,bytes32 nonce)";
export const RESCIND_TYPE = "Rescind(bytes32 grantId,uint64 epoch,bytes32 nonce)";
export const RESCIND_COMMIT_TYPE = "RescindCommit(bytes32 commitment,bytes32 nonce)";
export const ANCHOR_TYPE =
  "Anchor(bytes32 principalId,uint32 ns,uint64 epoch,bytes32 batchRoot,bytes32 termsHash,bytes32 nonce)";

export const ENROLL_TYPEHASH = keccak256Utf8(ENROLL_TYPE);
export const ATTEST_TYPEHASH = keccak256Utf8(ATTEST_TYPE);
export const GRANT_TYPEHASH = keccak256Utf8(GRANT_TYPE);
export const ACCEPT_TERMS_TYPEHASH = keccak256Utf8(ACCEPT_TERMS_TYPE);
export const RESCIND_TYPEHASH = keccak256Utf8(RESCIND_TYPE);
export const RESCIND_COMMIT_TYPEHASH = keccak256Utf8(RESCIND_COMMIT_TYPE);
export const ANCHOR_TYPEHASH = keccak256Utf8(ANCHOR_TYPE);

function w(hex: Bytes32): Uint8Array {
  assertBytes32(hex, "bytes32");
  return hexToBytes(hex);
}

function u(value: bigint | number): Uint8Array {
  return u256be(typeof value === "number" ? BigInt(value) : value);
}

export function enrollStructHash(keyCommit: Bytes32, epoch: bigint, nonce: Bytes32): Bytes32 {
  return keccak256Hex(concat(w(ENROLL_TYPEHASH), w(keyCommit), u(epoch), w(nonce)));
}

export function attestStructHash(
  principalId: Bytes32,
  epoch: bigint,
  depositKeysRoot: Bytes32,
  nonce: Bytes32,
): Bytes32 {
  return keccak256Hex(
    concat(w(ATTEST_TYPEHASH), w(principalId), u(epoch), w(depositKeysRoot), w(nonce)),
  );
}

export interface GrantFields {
  readonly principalId: Bytes32;
  readonly granteeCard: Bytes32;
  readonly ns: number;
  readonly epochStart: bigint;
  readonly term: bigint;
  readonly termsHash: Bytes32;
  readonly wrapRef: Bytes32;
  readonly nonce: Bytes32;
}

export function grantStructHash(g: GrantFields): Bytes32 {
  return keccak256Hex(
    concat(
      w(GRANT_TYPEHASH),
      w(g.principalId),
      w(g.granteeCard),
      u(g.ns),
      u(g.epochStart),
      u(g.term),
      w(g.termsHash),
      w(g.wrapRef),
      w(g.nonce),
    ),
  );
}

export function acceptTermsStructHash(
  granteeCard: Bytes32,
  principalId: Bytes32,
  ns: number,
  termsHash: Bytes32,
  nonce: Bytes32,
): Bytes32 {
  return keccak256Hex(
    concat(w(ACCEPT_TERMS_TYPEHASH), w(granteeCard), w(principalId), u(ns), w(termsHash), w(nonce)),
  );
}

export function rescindStructHash(grantId: Bytes32, epoch: bigint, nonce: Bytes32): Bytes32 {
  return keccak256Hex(concat(w(RESCIND_TYPEHASH), w(grantId), u(epoch), w(nonce)));
}

export function rescindCommitStructHash(commitment: Bytes32, nonce: Bytes32): Bytes32 {
  return keccak256Hex(concat(w(RESCIND_COMMIT_TYPEHASH), w(commitment), w(nonce)));
}

export interface AnchorFields {
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly epoch: bigint;
  readonly batchRoot: Bytes32;
  readonly termsHash: Bytes32;
  readonly nonce: Bytes32;
}

export function anchorStructHash(a: AnchorFields): Bytes32 {
  return keccak256Hex(
    concat(
      w(ANCHOR_TYPEHASH),
      w(a.principalId),
      u(a.ns),
      u(a.epoch),
      w(a.batchRoot),
      w(a.termsHash),
      w(a.nonce),
    ),
  );
}

/** `keccak256(abi.encode(grantId, salt))` — matches `Rescissions.commitmentOf`. */
export function rescissionCommitment(grantId: Bytes32, salt: Bytes32): Bytes32 {
  return keccak256Hex(concat(w(grantId), w(salt)));
}

/** `keccak256(abi.encode(principalId, granteeCard, ns, epochStart))` — matches `GrantManager.grantIdOf`. */
export function grantIdOf(
  principalId: Bytes32,
  granteeCard: Bytes32,
  ns: number,
  epochStart: bigint,
): Bytes32 {
  return keccak256Hex(concat(w(principalId), w(granteeCard), u(ns), u(epochStart)));
}

/** `keccak256(abi.encodePacked(address[16]))` — the attested deposit-key commitment. */
export function depositKeysRoot(keys: readonly Address[]): Bytes32 {
  if (keys.length !== 16) throw new TypeError("depositKeysRoot: expected 16 addresses");
  return keccak256Hex(concat(...keys.map((k) => pad32(hexToBytes(k)))));
}

/** Final digest under the FIRSTHAND domain of `verifyingContract`. */
export function authorityDigest(structHash: Bytes32, domain: Eip712Domain): Bytes32 {
  return digestOf(structHash, domainSeparator(domain));
}

/** `keccak256(abi.encode(owner, encryptionPubKey))` — matches `GrantManager.cardIdOf` (ADR-0011). */
export function cardIdOf(owner: Address, encryptionPubKey: Bytes32): Bytes32 {
  return keccak256Hex(concat(pad32(hexToBytes(owner)), w(encryptionPubKey)));
}
