import type { Certificate } from "./certificate.js";
import { findExtension } from "./certificate.js";
import {
  children,
  content,
  DerError,
  expectChildren,
  readUniversal,
  smallInteger,
  Tag,
  TagClass,
  type Tlv,
} from "./der.js";

/**
 * Android key attestation's `KeyDescription` extension (ADR-0015).
 *
 * This is what makes a hardware claim checkable rather than asserted: the extension says which
 * security level generated the key, whether the key was generated or merely imported, what the
 * device's verified-boot state was at generation time, and — the part that binds it to us — the
 * `attestationChallenge` the caller supplied, which Google signs without inspecting.
 *
 * **What it does not say.** Nothing here attests the *content* of a capture. The secure element
 * signs a digest handed to it by app code and never sees a sensor, so a `KeyDescription` proves
 * key provenance and nothing about what a camera saw (README §14 limitation 3).
 */

/** `1.3.6.1.4.1.11129.2.1.17` — the Android key attestation extension. */
export const OID_KEY_DESCRIPTION = Uint8Array.of(
  0x2b,
  0x06,
  0x01,
  0x04,
  0x01,
  0xd6,
  0x79,
  0x02,
  0x01,
  0x11,
);

/** Where a key lives. `STRONG_BOX` needs a discrete secure element; most phones only reach TEE. */
export const SecurityLevel = {
  SOFTWARE: 0,
  TRUSTED_ENVIRONMENT: 1,
  STRONG_BOX: 2,
} as const;
export type SecurityLevel = (typeof SecurityLevel)[keyof typeof SecurityLevel];

/** How the key came to exist. Only `GENERATED` means the private half never existed outside. */
export const KeyOrigin = {
  GENERATED: 0,
  DERIVED: 1,
  IMPORTED: 2,
  UNKNOWN: 3,
} as const;

export const VerifiedBootState = {
  VERIFIED: 0,
  SELF_SIGNED: 1,
  UNVERIFIED: 2,
  FAILED: 3,
} as const;

/** `AuthorizationList` tag numbers this module reads. */
const TAG_ORIGIN = 702;
const TAG_ROOT_OF_TRUST = 704;

/**
 * The tags that carry a device identifier, populated only when an app with privileged access
 * requests ID attestation. They are **personally identifying** — IMEI, MEID, serial number — and a
 * chain committed to a public repository must not contain them.
 *
 * Deliberately not the whole 710–723 range: 718 `vendorPatchLevel`, 719 `bootPatchLevel` and
 * 720 `deviceUniqueAttestation` live inside it and are present on ordinary devices. Asserting
 * against the range rather than the set would reject perfectly clean chains.
 */
const DEVICE_IDENTIFIER_TAGS: readonly number[] = [
  710, // attestationIdBrand
  711, // attestationIdDevice
  712, // attestationIdProduct
  713, // attestationIdSerial
  714, // attestationIdImei
  715, // attestationIdMeid
  716, // attestationIdManufacturer
  717, // attestationIdModel
  723, // attestationIdSecondImei
];

export interface RootOfTrust {
  readonly verifiedBootKey: Uint8Array;
  readonly deviceLocked: boolean;
  /** `VerifiedBootState.*` — `VERIFIED` means the boot chain was signed by the OEM key. */
  readonly verifiedBootState: number;
}

export interface AuthorizationList {
  /** `KeyOrigin.*`, or `null` when the list does not constrain it. */
  readonly origin: number | null;
  readonly rootOfTrust: RootOfTrust | null;
  /** Which `DEVICE_IDENTIFIER_TAGS` this list carries — empty on a privacy-clean chain. */
  readonly deviceIdentifierTags: readonly number[];
}

export interface KeyDescription {
  readonly attestationVersion: number;
  /** `SecurityLevel.*` — the measured level, never a level we asked for. */
  readonly attestationSecurityLevel: number;
  readonly keymasterVersion: number;
  readonly keymasterSecurityLevel: number;
  /** The bytes the caller passed to `setAttestationChallenge`. Attacker-controlled; never scan it. */
  readonly attestationChallenge: Uint8Array;
  readonly uniqueId: Uint8Array;
  readonly softwareEnforced: AuthorizationList;
  readonly teeEnforced: AuthorizationList;
}

/** Parses the DER payload of the key attestation extension. */
export function parseKeyDescription(value: Uint8Array): KeyDescription {
  const sequence = readUniversal(value, 0, Tag.SEQUENCE);
  if (sequence.end !== value.length) {
    throw new DerError("trailing bytes after KeyDescription", sequence.end);
  }

  const fields = children(value, sequence);
  expectChildren(fields, 8, "KeyDescription", sequence.start);

  return {
    attestationVersion: smallInteger(value, fields[0] as Tlv),
    attestationSecurityLevel: smallInteger(value, fields[1] as Tlv),
    keymasterVersion: smallInteger(value, fields[2] as Tlv),
    keymasterSecurityLevel: smallInteger(value, fields[3] as Tlv),
    attestationChallenge: octetString(value, fields[4] as Tlv, "attestationChallenge"),
    uniqueId: octetString(value, fields[5] as Tlv, "uniqueId"),
    softwareEnforced: readAuthorizationList(value, fields[6] as Tlv),
    teeEnforced: readAuthorizationList(value, fields[7] as Tlv),
  };
}

/** The `KeyDescription` carried by a certificate, or `null` when it carries none. */
export function keyDescriptionOf(certificate: Certificate): KeyDescription | null {
  const extension = findExtension(certificate, OID_KEY_DESCRIPTION);
  return extension === null ? null : parseKeyDescription(extension.value);
}

/**
 * Every device-identifier tag present anywhere in a `KeyDescription`. A chain destined for a
 * public repository must produce an empty array here, and the fixture test asserts exactly that —
 * a glance at a hex dump is not evidence.
 */
export function deviceIdentifierTags(description: KeyDescription): readonly number[] {
  return [
    ...description.softwareEnforced.deviceIdentifierTags,
    ...description.teeEnforced.deviceIdentifierTags,
  ].sort((a, b) => a - b);
}

/**
 * The effective security level of an attested key: the weaker of the attestation's own level and
 * the level enforcing the key's authorizations. Reporting the stronger of the two would let a
 * TEE-enforced key claim StrongBox because the certificate happened to be StrongBox-signed.
 */
export function effectiveSecurityLevel(description: KeyDescription): number {
  return Math.min(description.attestationSecurityLevel, description.keymasterSecurityLevel);
}

/** True when the private half provably never existed outside the secure element. */
export function isHardwareGenerated(description: KeyDescription): boolean {
  const origin = description.teeEnforced.origin;
  return (
    origin === KeyOrigin.GENERATED &&
    effectiveSecurityLevel(description) >= SecurityLevel.TRUSTED_ENVIRONMENT
  );
}

function octetString(bytes: Uint8Array, tlv: Tlv, label: string): Uint8Array {
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== Tag.OCTET_STRING) {
    throw new DerError(`${label} is not an OCTET STRING`, tlv.start);
  }
  return content(bytes, tlv);
}

function readAuthorizationList(bytes: Uint8Array, tlv: Tlv): AuthorizationList {
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== Tag.SEQUENCE) {
    throw new DerError("AuthorizationList is not a SEQUENCE", tlv.start);
  }

  let origin: number | null = null;
  let rootOfTrust: RootOfTrust | null = null;
  const present: number[] = [];

  // Every entry is `[tag] EXPLICIT value`, so the value is the single child of the context tag.
  for (const entry of children(bytes, tlv)) {
    if (entry.tagClass !== TagClass.CONTEXT) {
      throw new DerError("AuthorizationList entry is not context-tagged", entry.start);
    }
    if (DEVICE_IDENTIFIER_TAGS.includes(entry.tagNumber)) present.push(entry.tagNumber);
    if (entry.tagNumber !== TAG_ORIGIN && entry.tagNumber !== TAG_ROOT_OF_TRUST) continue;

    const inner = children(bytes, entry);
    expectChildren(inner, 1, `AuthorizationList[${entry.tagNumber}]`, entry.start);
    const value = inner[0] as Tlv;
    if (entry.tagNumber === TAG_ORIGIN) origin = smallInteger(bytes, value);
    else rootOfTrust = readRootOfTrust(bytes, value);
  }

  return { origin, rootOfTrust, deviceIdentifierTags: present };
}

function readRootOfTrust(bytes: Uint8Array, tlv: Tlv): RootOfTrust {
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== Tag.SEQUENCE) {
    throw new DerError("RootOfTrust is not a SEQUENCE", tlv.start);
  }
  const fields = children(bytes, tlv);
  expectChildren(fields, 3, "RootOfTrust", tlv.start);

  const lockedTlv = fields[1] as Tlv;
  if (lockedTlv.contentLength !== 1)
    throw new DerError("deviceLocked is not a BOOLEAN", lockedTlv.start);

  return {
    verifiedBootKey: octetString(bytes, fields[0] as Tlv, "verifiedBootKey"),
    deviceLocked: bytes[lockedTlv.contentStart] !== 0,
    verifiedBootState: smallInteger(bytes, fields[2] as Tlv),
  };
}
