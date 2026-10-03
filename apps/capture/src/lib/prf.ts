import { registerPasskey, WebAuthnPrfSource } from "@firsthand/sdk/browser";

/**
 * Passkey enrolment for the capture flow (README §7.3). The credential id is the only thing
 * persisted; the PRF output is evaluated on demand and zeroized by the key tree.
 */
const STORAGE_KEY = "firsthand.credentialId";

export function savedCredentialId(): Uint8Array | null {
  const hex = localStorage.getItem(STORAGE_KEY);
  return hex ? Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)) : null;
}

export function saveCredentialId(id: Uint8Array): void {
  localStorage.setItem(
    STORAGE_KEY,
    Array.from(id, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

/** Forget the credential on this device. The passkey itself stays in the authenticator. */
export function forgetCredentialId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

export function prfSupported(): boolean {
  return WebAuthnPrfSource.isSupported();
}

/** What this *browser* says about PRF, before a passkey exists to ask. */
export type PrfCapability = "yes" | "no" | "unknown";

/**
 * A pre-flight, not a gate.
 *
 * `getClientCapabilities()` answers for the client, not for whichever authenticator the person
 * ends up choosing — a browser that supports PRF can still be handed a passkey that does not (over
 * the cross-device QR flow Apple passes no PRF at all). So an explicit `false` is worth warning
 * about before someone creates a credential they cannot use, and everything else is `unknown`:
 * the spec is explicit that a missing key means *no assumption may be made*, not "false". The gate
 * stays the first real derivation.
 */
export async function prfCapability(): Promise<PrfCapability> {
  try {
    const get = (
      PublicKeyCredential as unknown as {
        getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
      }
    ).getClientCapabilities;
    if (typeof get !== "function") return "unknown";
    const caps = await get.call(PublicKeyCredential);
    const prf = caps?.["extension:prf"];
    return prf === true ? "yes" : prf === false ? "no" : "unknown";
  } catch {
    // Older browsers throw rather than omit the method, and it can reject on an invalid RP domain.
    return "unknown";
  }
}

/**
 * True when a failure means "this authenticator cannot derive a locker key" — as opposed to a
 * cancelled prompt, a timeout or an unreachable gateway. Only the SDK's PRF-absent error carries
 * the marker, so a user who dismisses the biometric prompt is never told their device is
 * unsupported.
 */
export function isPrfAbsent(error: unknown): boolean {
  return (error as { context?: { prf?: unknown } })?.context?.prf === "absent";
}

/**
 * Creates the passkey. Deliberately does NOT persist the credential id: the authenticator's
 * create-time `prf.enabled` flag is only a hint (several platforms that support PRF never set it),
 * so the real gate is the first derivation. The caller stores the id once that succeeds —
 * otherwise a passkey that can never open a locker would be remembered and retried on every load.
 */
export async function enrol(
  userName: string,
): Promise<{ credentialId: Uint8Array; prfEnabled: boolean }> {
  return registerPasskey({
    rpId: location.hostname,
    rpName: "FIRSTHAND",
    userId: crypto.getRandomValues(new Uint8Array(16)),
    userName,
  });
}

export function prfSourceFor(credentialId: Uint8Array): WebAuthnPrfSource {
  return new WebAuthnPrfSource({ rpId: location.hostname, credentialId });
}
