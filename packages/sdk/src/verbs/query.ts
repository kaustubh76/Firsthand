import {
  buildPaymentPayload,
  encodePaymentHeader,
  LEGACY_PAYMENT_HEADER,
  PAYMENT_HEADER,
  type PaymentRequirements,
  selectRequirements,
  type TypedDataSigner,
} from "@firsthand/adapters/x402";
import {
  type Bytes32,
  ChainError,
  type FirsthandError,
  GrantError,
  hexToBytes,
  NotFoundError,
  type PassportSidecar,
  PaymentError,
  parseSidecar,
  passportId,
  type SignedPassport,
  ValidationError,
  verifyPassportInBatch,
  verifyPassportSignature,
} from "@firsthand/core";
import { openBlob, type SecretBytes, unwrapDek, unwrapVaultKey } from "@firsthand/crypto";
import { z } from "zod";

/**
 * `query` (README §7.2, §8 claim 4) — buyer side. GET → 402 with requirements → sign the x402
 * exact payment → retry with `X-PAYMENT` → ciphertext + passport + proof + receipt. Then `openQueried`
 * unwraps the vault key from the grant wrap, the DEK from the wrapped DEK, and opens the blob.
 */
export interface QueryRequest {
  readonly gatewayUrl: string;
  readonly grantId: Bytes32;
  readonly passportId: Bytes32;
  /** The buyer's ERC-8004 agent id: the gateway then credits this paid query to its reputation. */
  readonly agentId?: bigint;
}

export interface QueryDeps {
  /** Buyer's EIP-712 signer (viem account or wallet client). */
  readonly signer: TypedDataSigner;
  readonly fetch?: typeof fetch;
  /** Called with the 402 requirements before paying; return false to abort. */
  readonly approve?: (requirements: PaymentRequirements) => boolean | Promise<boolean>;
}

const ServedQuerySchema = z.object({
  passportId: z.string(),
  sidecar: z.unknown(),
  blob: z.string().regex(/^0x[0-9a-f]*$/),
  wrappedDek: z.string().regex(/^0x[0-9a-f]*$/),
  receipt: z.object({
    receiptId: z.string(),
    txHash: z.string().nullable(),
    blockNumber: z.string().nullable(),
  }),
});

export interface QueryResult {
  readonly passportId: Bytes32;
  readonly sidecar: PassportSidecar;
  readonly signed: SignedPassport;
  readonly blob: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly receipt: {
    readonly receiptId: Bytes32;
    readonly txHash: Bytes32 | null;
    readonly blockNumber: bigint | null;
  };
  readonly paid: { readonly requirements: PaymentRequirements; readonly nonce: Bytes32 };
}

/**
 * A gateway's "no" as the typed error it is: the RFC 9457 body's code decides the class, so a
 * rescinded grant is a `GrantError`, a rate limit carries its `retry-after`, an empty relayer float
 * keeps `FH_INSUFFICIENT_FUNDS`, and anything else stays a payment failure. `context` always has
 * `{ status, code }` — the Recall screen prints exactly those two.
 */
async function refusal(res: Response, passport: Bytes32): Promise<FirsthandError> {
  const body = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
  const retryAfter = Number(res.headers.get("retry-after"));
  const context = {
    status: res.status,
    code: body.code,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
  };
  const detail = body.detail ?? `HTTP ${res.status}`;
  switch (body.code) {
    case "FH_RATE_LIMITED":
      return new GrantError(
        "FH_RATE_LIMITED",
        `the gateway is rate-limiting this network — retry in ${context.retryAfter ?? "a few"} s`,
        { retryable: true, context },
      );
    case "FH_GRANT_NOT_LIVE":
    case "FH_GRANT_RESCINDED":
    case "FH_GRANT_FROZEN":
    case "FH_GRANT_EXPIRED":
      return new GrantError(body.code, `gateway refused: ${body.code} ${detail}`, { context });
    case "FH_INSUFFICIENT_FUNDS":
      return new ChainError(`gateway refused: ${detail}`, {
        code: "FH_INSUFFICIENT_FUNDS",
        context,
      });
    case "FH_NOT_FOUND":
      return new NotFoundError(`gateway does not host ${passport}`, { context });
    default:
      return new PaymentError(
        "FH_PAYMENT_INVALID",
        `gateway refused: ${body.code ?? res.status} ${detail}`.trim(),
        { context },
      );
  }
}

export async function query(request: QueryRequest, deps: QueryDeps): Promise<QueryResult> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${request.gatewayUrl.replace(/\/+$/, "")}/v1/query/${request.grantId}/${request.passportId}${
    request.agentId === undefined ? "" : `?agent=${request.agentId}`
  }`;

  const first = await doFetch(url);
  if (first.status === 404) throw new NotFoundError(`gateway does not host ${request.passportId}`);
  if (first.status !== 402) throw await refusal(first, request.passportId);
  const offer = (await first.json()) as { accepts?: unknown[]; x402Version?: number };
  // A gateway may offer the same price in both versions' spelling; take the one this buyer can pay
  // rather than trusting the order (ADR-0014).
  const requirements = selectRequirements(offer.accepts);
  if (requirements === null)
    throw new PaymentError("FH_PAYMENT_INVALID", "402 carried no usable payment requirements");
  if (deps.approve && !(await deps.approve(requirements))) {
    throw new PaymentError("FH_PAYMENT_REQUIRED", "payment declined by the buyer");
  }

  const x402Version = offer.x402Version === 2 ? 2 : 1;
  const payment = await buildPaymentPayload(deps.signer, requirements, { x402Version });
  const header = encodePaymentHeader(payment);
  // Both header names: v2 renamed `X-PAYMENT`, and a gateway may know only one of them.
  const paid = await doFetch(url, {
    headers: { [PAYMENT_HEADER]: header, [LEGACY_PAYMENT_HEADER]: header },
  });
  if (!paid.ok) throw await refusal(paid, request.passportId);
  const served = ServedQuerySchema.parse(await paid.json());
  const sidecar = parseSidecar(served.sidecar);
  const id = passportId(sidecar.signed.passport);
  if (id !== request.passportId || served.passportId !== request.passportId) {
    throw new ValidationError("gateway returned a different passport than requested");
  }
  return {
    passportId: id,
    sidecar,
    signed: sidecar.signed,
    blob: hexToBytes(served.blob as `0x${string}`),
    wrappedDek: hexToBytes(served.wrappedDek as `0x${string}`),
    receipt: {
      receiptId: served.receipt.receiptId as Bytes32,
      txHash: served.receipt.txHash as Bytes32 | null,
      blockNumber: served.receipt.blockNumber === null ? null : BigInt(served.receipt.blockNumber),
    },
    paid: {
      requirements,
      nonce: payment.payload.authorization.nonce as Bytes32,
    },
  };
}

/** Fetches the grant wrap bytes the gateway hosts (hash-checked against the chain by the gateway on ingest). */
export async function fetchWrap(
  gatewayUrl: string,
  grantId: Bytes32,
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array> {
  const res = await doFetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/grants/${grantId}/wrap`);
  if (res.status === 404) throw new NotFoundError(`wrap for grant ${grantId} not published`);
  if (!res.ok) throw new ValidationError(`wrap fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Buyer-side offline check of what was served: signature under the domain and Merkle inclusion. */
export function checkServed(
  result: QueryResult,
  domain: { chainId: bigint; verifyingContract: `0x${string}` },
): boolean {
  return (
    verifyPassportSignature(result.signed.passport, result.signed.signature, domain) &&
    verifyPassportInBatch(result.sidecar.batchRoot, result.passportId, result.sidecar.proof)
  );
}

/** Opens served ciphertext with the grantee's X25519 secret key and the grant wrap. */
export function openQueried(
  result: QueryResult,
  granteeSecretKey: SecretBytes,
  wrap: Uint8Array,
  grantId: Bytes32,
): Uint8Array {
  const { ns } = result.sidecar;
  const epoch = result.sidecar.signed.passport.epoch;
  const vault = unwrapVaultKey(granteeSecretKey, wrap, { grantId, ns, epoch });
  try {
    const dek = unwrapDek(vault, result.wrappedDek, result.passportId, ns, epoch);
    try {
      return openBlob(dek, result.blob, result.passportId);
    } finally {
      dek.dispose();
    }
  } finally {
    vault.dispose();
  }
}
