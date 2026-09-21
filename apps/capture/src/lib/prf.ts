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

export async function enrol(
  userName: string,
): Promise<{ credentialId: Uint8Array; prfEnabled: boolean }> {
  const result = await registerPasskey({
    rpId: location.hostname,
    rpName: "FIRSTHAND",
    userId: crypto.getRandomValues(new Uint8Array(16)),
    userName,
  });
  saveCredentialId(result.credentialId);
  return result;
}

export function prfSourceFor(credentialId: Uint8Array): WebAuthnPrfSource {
  return new WebAuthnPrfSource({ rpId: location.hostname, credentialId });
}
