import { CryptoError } from "@firsthand/core";
import { PRF_OUTPUT_LENGTH, type PrfSource } from "@firsthand/crypto";

/**
 * Browser PRF source: evaluates the WebAuthn `prf` extension on an existing passkey (README §7.3).
 * The PRF output is handed straight to `KeyTree.fromPrf`, which zeroizes it. Nothing is stored.
 *
 * Phase 0 gate: confirm the wallet/passkey provider exposes `prf` for external HKDF derivation.
 * `isSupported()` is the runtime check the capture PWA shows before enrolling.
 */
export interface WebAuthnPrfOptions {
  readonly rpId: string;
  /** Credential id of the enrolled passkey. */
  readonly credentialId: Uint8Array;
  readonly credentials?: CredentialsContainer;
  readonly timeoutMs?: number;
}

/** WebAuthn wants `ArrayBuffer`-backed views; copy so SharedArrayBuffer-typed inputs are accepted. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

interface PrfExtensionResults {
  readonly prf?: { readonly results?: { readonly first?: ArrayBuffer } };
}

export class WebAuthnPrfSource implements PrfSource {
  readonly kind = "webauthn-prf";
  readonly #options: WebAuthnPrfOptions;

  constructor(options: WebAuthnPrfOptions) {
    this.#options = options;
  }

  static isSupported(
    scope: { PublicKeyCredential?: unknown; navigator?: { credentials?: unknown } } = globalThis,
  ): boolean {
    return (
      typeof scope.PublicKeyCredential === "function" && scope.navigator?.credentials !== undefined
    );
  }

  async evaluate(salt: Uint8Array): Promise<Uint8Array> {
    const credentials = this.#options.credentials ?? globalThis.navigator?.credentials;
    if (!credentials) throw new CryptoError("WebAuthn is not available in this environment");
    const assertion = (await credentials.get({
      publicKey: {
        rpId: this.#options.rpId,
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: toBuffer(this.#options.credentialId) }],
        userVerification: "required",
        timeout: this.#options.timeoutMs ?? 60_000,
        extensions: {
          prf: { eval: { first: toBuffer(salt) } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) throw new CryptoError("passkey assertion cancelled");
    const results = assertion.getClientExtensionResults() as PrfExtensionResults;
    const first = results.prf?.results?.first;
    if (!first)
      throw new CryptoError("passkey did not return a PRF output (prf extension unsupported?)", {
        // The one failure that means "this authenticator cannot root a locker", as opposed to a
        // cancelled prompt or a timeout. Callers gate enrolment on it; see `registerPasskey`.
        context: { prf: "absent" },
      });
    const out = new Uint8Array(first);
    if (out.length !== PRF_OUTPUT_LENGTH)
      throw new CryptoError(`unexpected PRF length ${out.length}`);
    return out;
  }
}

/**
 * Creates the passkey and asks the authenticator to associate a PRF key with it.
 *
 * `prfEnabled` is the authenticator's *advertisement* at creation time and is **not** a reliable
 * gate: the PRF extension only returns a secret during an assertion, several platforms that do
 * support it never set `enabled` on create (Chrome/Edge ≤ 146 with Windows Hello, measured), and
 * the WebAuthn guidance is explicitly not to treat a missing flag as a hard error. Use it as a
 * hint; gate on an actual `evaluate()`, which throws with `context.prf === "absent"` when the
 * authenticator genuinely cannot derive.
 */
export interface RegisterPasskeyOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: Uint8Array;
  readonly userName: string;
  readonly credentials?: CredentialsContainer;
}

/** Creates a passkey with the `prf` extension requested; returns the credential id to persist. */
export async function registerPasskey(
  options: RegisterPasskeyOptions,
): Promise<{ credentialId: Uint8Array; prfEnabled: boolean }> {
  const credentials = options.credentials ?? globalThis.navigator?.credentials;
  if (!credentials) throw new CryptoError("WebAuthn is not available in this environment");
  const created = (await credentials.create({
    publicKey: {
      rp: { id: options.rpId, name: options.rpName },
      user: { id: toBuffer(options.userId), name: options.userName, displayName: options.userName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new CryptoError("passkey creation cancelled");
  const ext = created.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  return { credentialId: new Uint8Array(created.rawId), prfEnabled: ext.prf?.enabled === true };
}
