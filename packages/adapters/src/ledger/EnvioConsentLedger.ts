import { type Bytes32, NotImplementedError } from "@firsthand/core";
import type {
  AnchorView,
  ConsentEvent,
  ConsentLedger,
  ReceiptView,
} from "../ports/ConsentLedger.js";

export interface EnvioConsentLedgerOptions {
  /** GraphQL endpoint of the Envio indexer (packages/indexer). */
  readonly graphqlUrl: string;
  readonly fetch?: typeof fetch;
}

/** Typed shell over the Envio Consent Ledger GraphQL API; queries land with the indexer schema (Phase 5). */
export class EnvioConsentLedger implements ConsentLedger {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: EnvioConsentLedgerOptions) {
    this.#url = options.graphqlUrl;
    this.#fetch = options.fetch ?? fetch;
  }

  get url(): string {
    return this.#url;
  }

  receiptsForGrant(grantId: Bytes32): Promise<readonly ReceiptView[]> {
    return this.unimplemented("receiptsForGrant", { grantId });
  }

  anchorsFor(principalId: Bytes32, ns: number): Promise<readonly AnchorView[]> {
    return this.unimplemented("anchorsFor", { principalId, ns });
  }

  consentTimeline(principalId: Bytes32): Promise<readonly ConsentEvent[]> {
    return this.unimplemented("consentTimeline", { principalId });
  }

  /** Raw GraphQL call, kept so the Phase 5 queries only need to add documents. */
  async query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
    return body.data as T;
  }

  private unimplemented<T>(method: string, context: Record<string, unknown>): Promise<T> {
    return Promise.reject(new NotImplementedError(`EnvioConsentLedger.${method}`, { context }));
  }
}
