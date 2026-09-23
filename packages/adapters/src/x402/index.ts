/**
 * Browser-safe x402 surface: the payment header codec, the requirement schemas and the EIP-3009
 * typed-data builder. No node built-ins — the buyer side of the SDK (and the capture PWA) import
 * this subpath so the fs-backed adapters in the root entry never reach a browser bundle.
 */
export type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifiedBy,
  VerifyResponse,
  X402Facilitator,
} from "../ports/X402Facilitator.js";
export {
  decodePaymentHeader,
  encodePaymentHeader,
  LEGACY_PAYMENT_HEADER,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
} from "../ports/X402Facilitator.js";
export type { AssetDomain, BuildPaymentOptions, TypedDataSigner } from "./typedData.js";
export {
  assetDomainFrom,
  buildPaymentPayload,
  transferWithAuthorizationTypes,
  USDC_DOMAIN_DEFAULTS,
} from "./typedData.js";
export type { FacilitatorEnvelope, PaymentRequirementsV2 } from "./wire.js";
export {
  facilitatorBody,
  fromRequirementsV2,
  PaymentRequirementsV2Schema,
  selectRequirements,
  toRequirementsV2,
} from "./wire.js";
