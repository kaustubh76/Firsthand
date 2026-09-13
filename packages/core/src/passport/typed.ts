import {
  type Address,
  assertAddress,
  assertBytes32,
  assertUintRange,
  type Bytes32,
  bytesToHex,
  concat,
  hexToBytes,
  pad32,
  u8,
  u256be,
} from "../bytes.js";
import { EIP712_NAME, EIP712_VERSION, MAX_RECIPIENTS } from "../constants.js";
import { ValidationError } from "../errors.js";
import { keccak256, keccak256Hex, keccak256Utf8 } from "../hash.js";
import type { Attestation, Eip712Domain, Passport, Terms } from "./types.js";

/**
 * EIP-712 typed hashing for passports, terms and attestations (ADR-0002).
 *
 * Solidity gets these for free via `abi.encode`; this file is a hand-rolled, dependency-light
 * twin so that `@firsthand/core` stays free of viem. Type strings and field order are normative
 * — they are hashed into every passport id.
 */

export const PASSPORT_TYPE =
  "Passport(bytes32 h,address origin,bytes32 attest,bytes32 termsHash,uint64 epoch,bytes32 nonce)";
export const TERMS_TYPE =
  "Terms(uint64 price,bytes32 licenseId,uint32 scope,uint32 ns,uint32 rateLimit,address[] payees,uint256[] weights)";
export const ATTESTATION_TYPE =
  "Attestation(uint8 class,uint64 capturedAt,bytes32 sourceTag,bytes32 deviceClass,bytes32 metaHash)";
export const DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

export const PASSPORT_TYPEHASH: Bytes32 = keccak256Utf8(PASSPORT_TYPE);
export const TERMS_TYPEHASH: Bytes32 = keccak256Utf8(TERMS_TYPE);
export const ATTESTATION_TYPEHASH: Bytes32 = keccak256Utf8(ATTESTATION_TYPE);
export const DOMAIN_TYPEHASH: Bytes32 = keccak256Utf8(DOMAIN_TYPE);

const NAME_HASH = hexToBytes(keccak256Utf8(EIP712_NAME));
const VERSION_HASH = hexToBytes(keccak256Utf8(EIP712_VERSION));

function word(hex: Bytes32): Uint8Array {
  return hexToBytes(hex);
}

function addressWord(address: Address): Uint8Array {
  assertAddress(address, "address");
  return pad32(hexToBytes(address));
}

function uintWord(value: bigint | number, bits: bigint, label: string): Uint8Array {
  const v = typeof value === "number" ? BigInt(value) : value;
  assertUintRange(v, bits, label);
  return u256be(v);
}

/** `keccak256(abi.encodePacked(address[]))` — each element occupies a full 32-byte word. */
function addressArrayHash(items: readonly Address[]): Uint8Array {
  return keccak256(concat(...items.map(addressWord)));
}

function uint256ArrayHash(items: readonly bigint[]): Uint8Array {
  return keccak256(concat(...items.map((w, i) => uintWord(w, 256n, `weights[${i}]`))));
}

export function domainSeparator(domain: Eip712Domain): Bytes32 {
  return keccak256Hex(
    concat(
      word(DOMAIN_TYPEHASH),
      NAME_HASH,
      VERSION_HASH,
      uintWord(domain.chainId, 256n, "chainId"),
      addressWord(domain.verifyingContract),
    ),
  );
}

export function hashTerms(terms: Terms): Bytes32 {
  if (terms.payees.length !== terms.weights.length) {
    throw new ValidationError("terms: payees and weights must have the same length");
  }
  if (terms.payees.length === 0 || terms.payees.length > MAX_RECIPIENTS) {
    throw new ValidationError(`terms: payees must have 1..${MAX_RECIPIENTS} entries`);
  }
  assertBytes32(terms.licenseId, "terms.licenseId");
  return keccak256Hex(
    concat(
      word(TERMS_TYPEHASH),
      uintWord(terms.price, 64n, "terms.price"),
      word(terms.licenseId),
      uintWord(terms.scope, 32n, "terms.scope"),
      uintWord(terms.ns, 32n, "terms.ns"),
      uintWord(terms.rateLimit, 32n, "terms.rateLimit"),
      addressArrayHash(terms.payees),
      uint256ArrayHash(terms.weights),
    ),
  );
}

export function hashAttestation(attestation: Attestation): Bytes32 {
  assertBytes32(attestation.sourceTag, "attestation.sourceTag");
  assertBytes32(attestation.deviceClass, "attestation.deviceClass");
  assertBytes32(attestation.metaHash, "attestation.metaHash");
  return keccak256Hex(
    concat(
      word(ATTESTATION_TYPEHASH),
      uintWord(attestation.class, 8n, "attestation.class"),
      uintWord(attestation.capturedAt, 64n, "attestation.capturedAt"),
      word(attestation.sourceTag),
      word(attestation.deviceClass),
      word(attestation.metaHash),
    ),
  );
}

/** EIP-712 struct hash of the passport — this is the `passportId` and the Merkle leaf preimage. */
export function passportId(passport: Passport): Bytes32 {
  assertBytes32(passport.h, "passport.h");
  assertBytes32(passport.attest, "passport.attest");
  assertBytes32(passport.termsHash, "passport.termsHash");
  assertBytes32(passport.nonce, "passport.nonce");
  return keccak256Hex(
    concat(
      word(PASSPORT_TYPEHASH),
      word(passport.h),
      addressWord(passport.origin),
      word(passport.attest),
      word(passport.termsHash),
      uintWord(passport.epoch, 64n, "passport.epoch"),
      word(passport.nonce),
    ),
  );
}

/** `keccak256(0x1901 ‖ domainSeparator ‖ passportId)` — the bytes the deposit key signs. */
export function passportDigest(passport: Passport, domain: Eip712Domain): Bytes32 {
  return digestOf(passportId(passport), domainSeparator(domain));
}

/** Generic EIP-712 final digest for any struct hash under a given domain separator. */
export function digestOf(structHash: Bytes32, domainSep: Bytes32): Bytes32 {
  return bytesToHex(
    keccak256(concat(u8(0x19), u8(0x01), hexToBytes(domainSep), hexToBytes(structHash))),
  );
}

/** Helper for string identifiers such as license ids and source tags. */
export function tag(text: string): Bytes32 {
  return keccak256Utf8(text);
}

export const LICENSE_FH_1_0: Bytes32 = tag("FH-1.0");
