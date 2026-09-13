import { CryptoError } from "@firsthand/core";
import { PRF_OUTPUT_LENGTH, type PrfSource } from "./PrfSource.js";

export interface StaticPrfOptions {
  /** Required. Forces every test/demo to say out loud that it is using a fixed PRF. */
  readonly unsafeAcknowledged: true;
  /** Optional hook so tests can assert the warning fired; defaults to `console.warn` once. */
  readonly warn?: (message: string) => void;
}

let warnedOnce = false;

/**
 * Fixed-output PRF for tests, fixtures and demos. NOT a WebAuthn PRF — anyone holding the bytes
 * holds the whole key tree. Construction requires `{ unsafeAcknowledged: true }`.
 */
export class StaticPrfSource implements PrfSource {
  readonly kind = "static-unsafe";
  readonly #output: Uint8Array;

  constructor(output: Uint8Array, options: StaticPrfOptions) {
    if (options.unsafeAcknowledged !== true) {
      throw new CryptoError("StaticPrfSource requires { unsafeAcknowledged: true }");
    }
    if (output.length !== PRF_OUTPUT_LENGTH) {
      throw new CryptoError(`StaticPrfSource: expected ${PRF_OUTPUT_LENGTH} bytes`, {
        context: { length: output.length },
      });
    }
    this.#output = new Uint8Array(output);
    if (!warnedOnce) {
      warnedOnce = true;
      (options.warn ?? ((m: string) => console.warn(m)))(
        "[firsthand/crypto] StaticPrfSource in use — keys are NOT rooted in a passkey.",
      );
    }
  }

  evaluate(_salt: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.#output));
  }

  /** Test helper: allow the one-time warning to fire again in a fresh test. */
  static resetWarning(): void {
    warnedOnce = false;
  }
}
