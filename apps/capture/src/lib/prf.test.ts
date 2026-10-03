import { CryptoError } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { isPrfAbsent } from "./prf.js";

describe("isPrfAbsent", () => {
  it("is true only for the SDK's PRF-absent failure", () => {
    const absent = new CryptoError(
      "passkey did not return a PRF output (prf extension unsupported?)",
      {
        context: { prf: "absent" },
      },
    );
    expect(isPrfAbsent(absent)).toBe(true);
  });

  it("is false for a cancelled prompt, a timeout or anything else", () => {
    // A dismissed biometric prompt must never be reported as an unsupported authenticator.
    expect(isPrfAbsent(new CryptoError("passkey assertion cancelled"))).toBe(false);
    expect(isPrfAbsent(new DOMException("The operation either timed out", "NotAllowedError"))).toBe(
      false,
    );
    expect(isPrfAbsent(new Error("relay unreachable"))).toBe(false);
    expect(isPrfAbsent(null)).toBe(false);
    expect(isPrfAbsent(undefined)).toBe(false);
  });
});
