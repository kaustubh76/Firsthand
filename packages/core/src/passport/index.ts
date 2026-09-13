export { contentHash, jcs } from "./canonical.js";
export {
  ATTESTATION_TYPE,
  ATTESTATION_TYPEHASH,
  DOMAIN_TYPE,
  DOMAIN_TYPEHASH,
  digestOf,
  domainSeparator,
  hashAttestation,
  hashTerms,
  LICENSE_FH_1_0,
  PASSPORT_TYPE,
  PASSPORT_TYPEHASH,
  passportDigest,
  passportId,
  TERMS_TYPE,
  TERMS_TYPEHASH,
  tag,
} from "./typed.js";
export type {
  Attestation,
  Datum,
  Eip712Domain,
  JsonValue,
  Passport,
  PassportSignature,
  ScopeFlag,
  SignedPassport,
  Terms,
} from "./types.js";
export { AttestationClass, Scope } from "./types.js";
export type { RecoveredSignature } from "./verify.js";
export {
  addressOfPublicKey,
  parseSignature,
  recoverSigner,
  verifyPassportSignature,
} from "./verify.js";
