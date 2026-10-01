import type { BlobStore } from "@firsthand/adapters";
import {
  type Bytes32,
  type PassportSidecar,
  passportId,
  sidecarToWire,
  type Terms,
  ValidationError,
} from "@firsthand/core";
import type { AnchoredBatch, Batcher } from "../batch/Batcher.js";
import type { Locker } from "../locker/Locker.js";
import type { DepositResult } from "./deposit.js";

/**
 * Publishing: after a batch is anchored, the public sidecar plus the ciphertext go to a gateway
 * (self-hosted or anyone's — ingest is verified, README §4). Plaintext never travels.
 */
export interface PublishTarget {
  readonly gatewayUrl: string;
  readonly fetch?: typeof fetch;
  /** Retries when the request itself fails (no HTTP answer). Publishing is idempotent: default 1. */
  readonly retries?: number;
}

/** Builds the sidecar for a deposited passport once its batch has been anchored. */
export function sidecarFor(
  locker: Locker,
  batcher: Batcher,
  result: DepositResult,
  terms: Terms,
): PassportSidecar {
  const found = batcher.proofFor(result.passportId);
  if (!found)
    throw new ValidationError(
      "passport is not in an anchored batch yet — flush the batcher first",
      { context: { passportId: result.passportId } },
    );
  return {
    signed: result.signed,
    principalId: locker.principalId,
    ns: found.batch.ns,
    batchRoot: found.batch.root,
    proof: found.proof,
    terms,
    ...(result.attestation ? { attestation: result.attestation } : {}),
    ...(result.hardware ? { hardware: result.hardware } : {}),
    blobRef: result.blob.id,
    wrappedDekRef: result.wrappedDek.id,
  };
}

/** All sidecars of an anchored batch (terms must be the batch's terms). */
export function sidecarsForBatch(
  locker: Locker,
  batch: AnchoredBatch,
  terms: Terms,
  results: readonly DepositResult[],
): PassportSidecar[] {
  const byId = new Map(results.map((r) => [r.passportId, r] as const));
  return batch.passports.map((signed) => {
    const id = passportId(signed.passport);
    const r = byId.get(id);
    const proof = batch.proofs.get(id);
    if (!r || !proof) throw new ValidationError(`no deposit result for ${id}`);
    return {
      signed,
      principalId: locker.principalId,
      ns: batch.ns,
      batchRoot: batch.root,
      proof,
      terms,
      ...(r.attestation ? { attestation: r.attestation } : {}),
      ...(r.hardware ? { hardware: r.hardware } : {}),
      blobRef: r.blob.id,
      wrappedDekRef: r.wrappedDek.id,
    };
  });
}

async function post(
  target: PublishTarget,
  path: string,
  body: BodyInit,
  contentType: string,
): Promise<unknown> {
  const doFetch = target.fetch ?? fetch;
  const url = `${target.gatewayUrl.replace(/\/+$/, "")}${path}`;
  const retries = Math.max(0, target.retries ?? 1);
  let res: Response | null = null;
  let unreachable: unknown = null;
  // Every publish is idempotent (content-addressed objects, verified sidecars), so a dropped
  // connection is retried once rather than surfaced as a failed step after a successful anchor.
  for (let attempt = 0; attempt <= retries && res === null; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_500 * attempt));
    try {
      res = await doFetch(url, { method: "POST", headers: { "content-type": contentType }, body });
    } catch (cause) {
      unreachable = cause;
    }
  }
  if (res === null) {
    throw new ValidationError(`gateway unreachable for ${path}`, {
      cause: unreachable,
      retryable: true,
      context: { path },
    });
  }
  const text = await res.text();
  if (!res.ok) {
    // A host's edge can refuse a body before the gateway sees it (Vercel: 413 above ~4.5 MB, as
    // an HTML page); say what it means rather than echoing the markup.
    if (res.status === 413) {
      throw new ValidationError(
        `gateway rejected ${path}: the upload is larger than this gateway accepts (413)`,
        { context: { status: 413 } },
      );
    }
    const detail = (() => {
      try {
        const body = JSON.parse(text) as { detail?: string; error?: string; code?: string };
        return [body.code, body.detail ?? body.error].filter(Boolean).join(" ");
      } catch {
        return text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
    })();
    throw new ValidationError(`gateway rejected ${path}: ${res.status} ${detail}`.trim(), {
      context: { status: res.status },
    });
  }
  return text ? JSON.parse(text) : null;
}

export async function publishBlob(target: PublishTarget, bytes: Uint8Array): Promise<Bytes32> {
  const out = (await post(
    target,
    "/v1/blobs",
    bytes.slice().buffer as ArrayBuffer,
    "application/octet-stream",
  )) as { id: Bytes32 };
  return out.id;
}

export async function publishPassport(
  target: PublishTarget,
  sidecar: PassportSidecar,
): Promise<Bytes32> {
  const out = (await post(
    target,
    "/v1/passports",
    JSON.stringify(sidecarToWire(sidecar)),
    "application/json",
  )) as { passportId: Bytes32 };
  return out.passportId;
}

export async function publishWrap(
  target: PublishTarget,
  grantId: Bytes32,
  wrap: Uint8Array,
): Promise<Bytes32> {
  const out = (await post(
    target,
    `/v1/grants/${grantId}/wrap`,
    wrap.slice().buffer as ArrayBuffer,
    "application/octet-stream",
  )) as { wrapRef: Bytes32 };
  return out.wrapRef;
}

/** Publishes ciphertext + sidecar for one deposit; the gateway verifies the sidecar before hosting it. */
export async function publishDeposit(
  target: PublishTarget,
  locker: Locker,
  batcher: Batcher,
  result: DepositResult,
  terms: Terms,
  blobs: BlobStore = locker.blobs,
): Promise<Bytes32> {
  const [blob, wrapped] = await Promise.all([blobs.get(result.blob), blobs.get(result.wrappedDek)]);
  if (!blob || !wrapped)
    throw new ValidationError("ciphertext missing from the locker's blob store");
  await publishBlob(target, blob);
  await publishBlob(target, wrapped);
  return publishPassport(target, sidecarFor(locker, batcher, result, terms));
}
