/** Browser entry: everything in `.` plus the WebAuthn PRF ceremony. */
export * from "./index.js";
export type { RegisterPasskeyOptions, WebAuthnPrfOptions } from "./webauthn/WebAuthnPrfSource.js";
export { registerPasskey, WebAuthnPrfSource } from "./webauthn/WebAuthnPrfSource.js";
