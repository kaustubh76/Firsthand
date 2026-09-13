import type {
  AnchorWriter,
  BlobStore,
  PaymentPayload,
  PaymentRequirements,
  X402Facilitator,
} from "@firsthand/adapters";
import { type Bytes32, NotImplementedError } from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";

/**
 * The serving path (README §11/§12): every response is gated by `verify()` and paid via x402.
 * This service holds adapters only — no keys, no plaintext. Phase 3 fills `serve()`.
 */
export interface ServingDeps {
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly facilitator: X402Facilitator;
  readonly logger: Logger;
}

export interface ServeRequest {
  readonly grantId: Bytes32;
  readonly passportId: Bytes32;
  readonly payment: PaymentPayload;
  readonly requirements: PaymentRequirements;
}

export class Serving {
  readonly #deps: ServingDeps;

  constructor(deps: ServingDeps) {
    this.#deps = deps;
  }

  /** Phase 3: verify → settle → record receipt → return ciphertext + passport + proof. */
  serve(request: ServeRequest): Promise<never> {
    this.#deps.logger.debug("serve requested", {
      grantId: request.grantId,
      passportId: request.passportId,
    });
    return Promise.reject(new NotImplementedError("gateway.serve (Phase 3)"));
  }

  blob(id: `0x${string}`): Promise<Uint8Array | null> {
    return this.#deps.blobs.get(id);
  }

  isAnchored(root: Bytes32): Promise<boolean> {
    return this.#deps.anchors.isAnchored(root);
  }
}
