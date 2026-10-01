/**
 * Hardware capture attestation (README §13, ADR-0015).
 *
 * A curated surface on purpose: the DER walker's helpers (`children`, `content`, `element`,
 * `smallInteger`, …) are deliberately **not** re-exported, because they are generic enough to
 * collide with anything and they are only meaningful to the readers in this folder. Import them
 * from `./der.js` directly if you are extending the parser.
 */

export {
  type AuthorizationList,
  deviceIdentifierTags,
  effectiveSecurityLevel,
  isHardwareGenerated,
  type KeyDescription,
  KeyOrigin,
  keyDescriptionOf,
  OID_KEY_DESCRIPTION,
  parseKeyDescription,
  type RootOfTrust,
  SecurityLevel,
  VerifiedBootState,
} from "./androidKey.js";
export {
  type Certificate,
  type Extension,
  findExtension,
  issuedBy,
  parseCertificate,
} from "./certificate.js";
export {
  AttestationError,
  type ChainPolicy,
  type VerifiedDevice,
  verifyAttestationChain,
  verifyCaptureWitness,
} from "./chain.js";
export { DerError } from "./der.js";
export {
  deviceKeyCommitment,
  HARDWARE_CAPTURE_DOMAIN,
  type HardwareCaptureInput,
  hardwareCaptureDigest,
} from "./hardwareDigest.js";
