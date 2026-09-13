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
  const res = await doFetch(`${target.gatewayUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const text = await res.text();
  if (!res.ok)
    throw new ValidationError(`gateway rejected ${path}: ${res.status} ${text}`, {
      context: { status: res.status },
    });
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
