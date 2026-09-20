import {
  type Bytes32,
  Bytes32Schema,
  bytesToHex,
  keccak256,
  type PassportSidecar,
  PassportSidecarSchema,
  parseSidecar,
  passportId,
  sidecarToWire,
  ValidationError,
} from "@firsthand/core";
import { z } from "zod";
import { publishBlob, publishPassport, publishWrap } from "../verbs/publish.js";

/**
 * Exit (README §4 "exit = keys + blobs walk away", §12 "any conformant client resumes", §13 "us").
 *
 * Everything a gateway holds for a locker is public and content-addressed: per passport the
 * sidecar, the ciphertext and the wrapped DEK; per grant the wrap bytes. A bundle is those
 * objects and nothing else — no plaintext, no key, nothing a passkey did not already publish —
 * so it can be carried by anyone and re-published to any conformant gateway, which verifies each
 * sidecar against the chain before hosting it (`Serving.ingestPassport`) and each wrap against
 * the grant's on-chain `wrapRef`. The chain is the source of truth; the gateway is a cache.
 */
export const LockerBundleSchema = z.object({
  v: z.literal(1),
  chainId: z.string().regex(/^\d+$/),
  principalId: Bytes32Schema,
  /** Unix seconds. */
  exportedAt: z.string().regex(/^\d+$/),
  /** The gateway the bundle was read from — provenance, not a dependency. */
  gateway: z.string(),
  passports: z.array(
    z.object({
      sidecar: PassportSidecarSchema,
      /** Base64 ciphertext; `keccak256` must equal `sidecar.blobRef`. */
      blob: z.string(),
      /** Base64 wrapped DEK; `keccak256` must equal `sidecar.wrappedDekRef`. */
      wrappedDek: z.string(),
    }),
  ),
  wraps: z.array(z.object({ grantId: Bytes32Schema, wrap: z.string() })),
});

export type LockerBundleWire = z.input<typeof LockerBundleSchema>;

/** In-memory bundle: sidecars in the core's readonly form (see `parseBundle`). */
export interface LockerBundle {
  readonly v: 1;
  readonly chainId: string;
  readonly principalId: Bytes32;
  readonly exportedAt: string;
  readonly gateway: string;
  readonly passports: readonly {
    readonly sidecar: PassportSidecar;
    readonly blob: string;
    readonly wrappedDek: string;
  }[];
  readonly wraps: readonly { readonly grantId: Bytes32; readonly wrap: string }[];
}

export interface ExportLockerInput {
  readonly gatewayUrl: string;
  readonly principalId: Bytes32;
  readonly chainId: bigint;
  /** Grants whose wrap bytes should travel too (the buyer's key to the namespace-epoch vault). */
  readonly grantIds?: readonly Bytes32[];
  readonly fetch?: typeof fetch;
  readonly now?: () => bigint;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface ImportLockerInput {
  readonly gatewayUrl: string;
  readonly bundle: LockerBundle | unknown;
  readonly fetch?: typeof fetch;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface ImportReport {
  readonly passports: number;
  readonly blobs: number;
  readonly wraps: number;
  /** What the gateway would not take, and why — a bundle is verified, not trusted. */
  readonly skipped: { readonly id: Bytes32; readonly reason: string }[];
}

const blobId = (bytes: Uint8Array): Bytes32 => bytesToHex(keccak256(bytes)) as Bytes32;
const base = (url: string) => url.replace(/\/+$/, "");

/** Portable base64 — browsers and Node alike, no Buffer. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function getBytes(doFetch: typeof fetch, url: string): Promise<Uint8Array | null> {
  const res = await doFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new ValidationError(`gateway answered ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Reads a locker's public objects from a gateway into one file. Never plaintext, never a key. */
export async function exportLocker(input: ExportLockerInput): Promise<LockerBundle> {
  const doFetch = input.fetch ?? fetch.bind(globalThis);
  const host = base(input.gatewayUrl);
  const listed = await doFetch(`${host}/v1/principals/${input.principalId}/passports?limit=500`);
  if (!listed.ok) throw new ValidationError(`gateway answered ${listed.status} listing the locker`);
  const ids = ((await listed.json()) as { passports: { passportId: Bytes32 }[] }).passports.map(
    (p) => p.passportId,
  );
  const grantIds = input.grantIds ?? [];
  const total = ids.length + grantIds.length;
  let done = 0;
  const passports: { sidecar: PassportSidecar; blob: string; wrappedDek: string }[] = [];
  for (const id of ids) {
    const res = await doFetch(`${host}/v1/passports/${id}`);
    if (!res.ok) throw new ValidationError(`gateway answered ${res.status} for passport ${id}`);
    const sidecar = parseSidecar(await res.json());
    const [blob, wrappedDek] = await Promise.all([
      getBytes(doFetch, `${host}/v1/blobs/${sidecar.blobRef}`),
      getBytes(doFetch, `${host}/v1/blobs/${sidecar.wrappedDekRef}`),
    ]);
    if (!blob || !wrappedDek) {
      throw new ValidationError(`gateway hosts the sidecar of ${id} but not its ciphertext`);
    }
    if (blobId(blob) !== sidecar.blobRef || blobId(wrappedDek) !== sidecar.wrappedDekRef) {
      throw new ValidationError(`ciphertext of ${id} does not hash to its sidecar's references`);
    }
    passports.push({ sidecar, blob: toBase64(blob), wrappedDek: toBase64(wrappedDek) });
    input.onProgress?.(++done, total);
  }
  const wraps: { grantId: Bytes32; wrap: string }[] = [];
  for (const grantId of grantIds) {
    const wrap = await getBytes(doFetch, `${host}/v1/grants/${grantId}/wrap`);
    if (wrap) wraps.push({ grantId, wrap: toBase64(wrap) });
    input.onProgress?.(++done, total);
  }
  return {
    v: 1,
    chainId: input.chainId.toString(),
    principalId: input.principalId,
    exportedAt: (input.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))().toString(),
    gateway: host,
    passports,
    wraps,
  };
}

/** The bundle as a file: the wire form with bigints as strings, two-space indented. */
export function serialiseBundle(bundle: LockerBundle): string {
  const wire = {
    ...bundle,
    passports: bundle.passports.map((p) => ({ ...p, sidecar: sidecarToWire(p.sidecar) })),
    wraps: [...bundle.wraps],
  };
  return JSON.stringify(wire, null, 2);
}

export function parseBundle(input: unknown): LockerBundle {
  // Accept the file, its parsed JSON, or an in-memory bundle (bigints) alike.
  const raw =
    typeof input === "string"
      ? JSON.parse(input)
      : isInMemory(input)
        ? JSON.parse(serialiseBundle(input))
        : input;
  const wire = LockerBundleSchema.parse(raw);
  return {
    ...wire,
    principalId: wire.principalId as Bytes32,
    // `parseSidecar` on the raw wire normalises the optional attestation (exactOptionalPropertyTypes).
    passports: wire.passports.map((p, i) => ({
      ...p,
      sidecar: parseSidecar((raw as LockerBundleWire).passports[i]?.sidecar),
    })),
    wraps: wire.wraps.map((w) => ({ grantId: w.grantId as Bytes32, wrap: w.wrap })),
  };
}

/**
 * Re-publishes a bundle to a gateway through the same verified ingest every publisher uses. A
 * sidecar the gateway cannot verify against the chain, or a wrap that does not hash to the grant's
 * on-chain reference, is skipped with the gateway's reason — never forced.
 */
export async function importLocker(input: ImportLockerInput): Promise<ImportReport> {
  const bundle = parseBundle(input.bundle);
  const target = { gatewayUrl: input.gatewayUrl, ...(input.fetch ? { fetch: input.fetch } : {}) };
  const report = { passports: 0, blobs: 0, wraps: 0, skipped: [] as ImportReport["skipped"] };
  const total = bundle.passports.length + bundle.wraps.length;
  let done = 0;
  for (const entry of bundle.passports) {
    const sidecar: PassportSidecar = entry.sidecar;
    const id = passportId(sidecar.signed.passport);
    const blob = fromBase64(entry.blob);
    const wrappedDek = fromBase64(entry.wrappedDek);
    if (blobId(blob) !== sidecar.blobRef || blobId(wrappedDek) !== sidecar.wrappedDekRef) {
      report.skipped.push({ id, reason: "ciphertext does not hash to the sidecar's references" });
      input.onProgress?.(++done, total);
      continue;
    }
    try {
      await publishBlob(target, blob);
      await publishBlob(target, wrappedDek);
      report.blobs += 2;
      await publishPassport(target, sidecar);
      report.passports++;
    } catch (error) {
      report.skipped.push({ id, reason: (error as Error).message });
    }
    input.onProgress?.(++done, total);
  }
  for (const entry of bundle.wraps) {
    try {
      await publishWrap(target, entry.grantId, fromBase64(entry.wrap));
      report.wraps++;
    } catch (error) {
      report.skipped.push({ id: entry.grantId, reason: (error as Error).message });
    }
    input.onProgress?.(++done, total);
  }
  return report;
}

function isInMemory(value: unknown): value is LockerBundle {
  const first = (
    value as { passports?: { sidecar?: { signed?: { passport?: { epoch?: unknown } } } }[] }
  )?.passports?.[0];
  return typeof first?.sidecar?.signed?.passport?.epoch === "bigint";
}
