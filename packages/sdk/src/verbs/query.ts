import {
  buildPaymentPayload,
  encodePaymentHeader,
  type PaymentRequirements,
  PaymentRequirementsSchema,
  type TypedDataSigner,
} from "@firsthand/adapters/x402";
import {
  type Bytes32,
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

export async function query(request: QueryRequest, deps: QueryDeps): Promise<QueryResult> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${request.gatewayUrl.replace(/\/+$/, "")}/v1/query/${request.grantId}/${request.passportId}`;

  const first = await doFetch(url);
  if (first.status === 404) throw new NotFoundError(`gateway does not host ${request.passportId}`);
  if (first.status !== 402)
    throw new PaymentError("FH_PAYMENT_INVALID", `expected 402, got ${first.status}`);
  const offer = (await first.json()) as { accepts?: unknown[] };
  const requirements = PaymentRequirementsSchema.safeParse(offer.accepts?.[0]);
  if (!requirements.success)
    throw new PaymentError("FH_PAYMENT_INVALID", "402 carried no usable payment requirements");
  if (deps.approve && !(await deps.approve(requirements.data))) {
    throw new PaymentError("FH_PAYMENT_REQUIRED", "payment declined by the buyer");
  }

  const payment = await buildPaymentPayload(deps.signer, requirements.data);
  const paid = await doFetch(url, { headers: { "x-payment": encodePaymentHeader(payment) } });
  if (!paid.ok) {
    const body = (await paid.json().catch(() => ({}))) as { code?: string; detail?: string };
    throw new PaymentError(
      "FH_PAYMENT_INVALID",
      `gateway refused: ${body.code ?? paid.status} ${body.detail ?? ""}`.trim(),
      {
        context: { status: paid.status, code: body.code },
      },
    );
  }
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
      requirements: requirements.data,
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
