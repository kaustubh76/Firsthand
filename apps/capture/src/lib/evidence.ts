import s1 from "../../../../experiments/results/s1.json";
import s2 from "../../../../experiments/results/s2.json";
import s3 from "../../../../experiments/results/s3.json";
import s4 from "../../../../experiments/results/s4.json";

/**
 * The measured claims, straight from `experiments/results/*.json` at build time — the same files
 * `experiments/README.md` reports from. Nothing here is typed in by hand; a re-run of a scenario
 * changes this screen. Where a claim failed, the failure is shown with the same prominence.
 */
interface Metric {
  readonly value: number;
  readonly unit: string;
}
interface Trial {
  readonly scenario: string;
  readonly arm: string;
  readonly hypothesis: string;
  readonly startedAt: string;
  readonly metrics: Record<string, Metric>;
  readonly onChain: boolean;
  readonly notes: readonly string[];
}
const trials = (file: { trials: readonly unknown[] }) => file.trials as readonly Trial[];

/** The result files record the date, not the chain; the runs are identified in experiments/README.md. */
export const CHAIN_BY_DATE: Readonly<Record<string, string>> = {
  "2026-09-13": "anvil (vanilla EVM)",
  // S3. Monad testnet has no readable global mempool, so the race cannot be run there at all;
  // the arms are anvil with the harness driving 400 ms blocks (experiments/README.md).
  "2026-09-15": "local anvil (--odyssey), 400 ms blocks",
  "2026-09-16": "Monad testnet (10143)",
};
export const chainOf = (t: { startedAt: string }): string =>
  CHAIN_BY_DATE[t.startedAt.slice(0, 10)] ?? (t.startedAt.slice(0, 10) as string);

const latest = (list: readonly Trial[], arm: string, onChain = true): Trial | undefined =>
  [...list]
    .filter((t) => t.arm === arm && t.onChain === onChain)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
const byDate = (list: readonly Trial[], arm: string, date: string): Trial | undefined =>
  list.find((t) => t.arm === arm && t.startedAt.startsWith(date));
const m = (t: Trial | undefined, key: string): number | null => t?.metrics[key]?.value ?? null;

export interface H1Row {
  readonly chain: string;
  readonly baselinePerBatch: number | null;
  readonly pagedPerBatch: number | null;
  readonly baselinePerPassport: number | null;
  readonly pagedPerPassport: number | null;
  /** paged relative to baseline, in percent; negative = paged cheaper. */
  readonly deltaPct: number | null;
}

export function h1(): { rows: H1Row[]; verdict: string } {
  const rows: H1Row[] = [];
  for (const date of Object.keys(CHAIN_BY_DATE)) {
    const b = byDate(trials(s1), "anchors-baseline", date);
    const p = byDate(trials(s1), "anchors-paged", date);
    if (!b || !p) continue;
    const bb = m(b, "anchorGasPerBatch");
    const pb = m(p, "anchorGasPerBatch");
    rows.push({
      chain: CHAIN_BY_DATE[date] as string,
      baselinePerBatch: bb,
      pagedPerBatch: pb,
      baselinePerPassport:
        m(b, "anchorGasPer1k") === null ? null : (m(b, "anchorGasPer1k") as number) / 1000,
      pagedPerPassport:
        m(p, "anchorGasPer1k") === null ? null : (m(p, "anchorGasPer1k") as number) / 1000,
      deltaPct: bb && pb ? ((pb - bb) / bb) * 100 : null,
    });
  }
  const monad = rows.find((r) => r.chain.startsWith("Monad"));
  const evm = rows.find((r) => r.chain.startsWith("anvil"));
  const verdict =
    monad && evm && monad.deltaPct !== null && evm.deltaPct !== null
      ? `Paged storage is ${evm.deltaPct > 0 ? "worse" : "better"} by ${Math.abs(evm.deltaPct).toFixed(1)} % on a vanilla EVM and ${monad.deltaPct < 0 ? "better" : "worse"} by ${Math.abs(monad.deltaPct).toFixed(1)} % on Monad — the sign flips under Monad's storage pricing. H1 is not supported on a vanilla EVM and is supported on Monad.`
      : "H1 needs both on-chain arms.";
  return { rows, verdict };
}

export interface H2Row {
  readonly arm: string;
  readonly label: string;
  readonly success: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly detection: number | null;
  readonly extractions: number | null;
  readonly paid: number | null;
  readonly note: string;
}

export function h2(): { rows: H2Row[]; verdict: string; trialsPerArm: number; chain: string } {
  const arms: [string, string, string][] = [
    [
      "B2-public-mempool",
      "public mempool (B2)",
      "the bot decodes the pending rescind and outbids it",
    ],
    [
      "commit-reveal",
      "commit-reveal",
      "consent ends at the commit block; the bot reacts to every commit",
    ],
    [
      "btx-blind",
      "btx-blind — not BTX",
      "no signal, the bot extracts continuously: the bound an encrypted mempool leaves",
    ],
  ];
  const rows: H2Row[] = arms.map(([arm, label, note]) => {
    const t = latest(trials(s3), arm);
    return {
      arm,
      label,
      success: m(t, "extractionSuccessRate"),
      p50: m(t, "deltaRaceP50Ms"),
      p95: m(t, "deltaRaceP95Ms"),
      detection: m(t, "detectionLatencyP50Ms"),
      extractions: m(t, "extractionsBeforeEndP50"),
      paid: m(t, "queriesPaidP50"),
      note,
    };
  });
  rows.push({
    arm: "btx",
    label: "BTX encrypted mempool",
    success: null,
    p50: null,
    p95: null,
    detection: null,
    extractions: null,
    paid: null,
    note: "not measurable — BTX is not deployed on Monad testnet (2026-09); the harness refuses to fake it",
  });
  const b2 = rows[0];
  const venue = latest(trials(s3), "B2-public-mempool");
  return {
    rows,
    // Named, because this card sits between two that say "Monad testnet (10143)" and its arms did
    // not run there — Monad exposes no global mempool, so the race is not reproducible on it.
    chain: venue ? chainOf(venue) : "unknown",
    trialsPerArm: m(latest(trials(s3), "B2-public-mempool"), "trials") ?? 0,
    verdict: `The public-mempool race is real and cheap: the bot sees the pending rescission in ~${b2?.detection?.toFixed(0) ?? "?"} ms and wins ${((b2?.success ?? 0) * 100).toFixed(0)} % of trials. Commit-reveal removes the signal but not same-block fee competition — it dates the end of consent, it does not stop the last extraction. H2 as worded could not be measured without BTX: the no-signal bound suggests the honest claim is "no targeted burst at zero idle cost", not "the race never starts". The obvious mitigation — the principal bidding a high priority fee so the rescission is ordered first in its block — is not yet measured.`,
  };
}

export interface H3Card {
  readonly passports: number | null;
  readonly merkleMs: number | null;
  readonly perAssetUs: number | null;
  readonly fullMs: number | null;
  readonly signatureUs: number | null;
  readonly hashesPerAsset: number | null;
  readonly manifestMb: number | null;
  readonly verdict: string;
}

export function h3(): H3Card {
  const t = latest(trials(s1), "memory", false);
  const merkleMs = m(t, "verifyMerkleMs");
  const fullMs = m(t, "verifyFullMs");
  return {
    passports: m(t, "passports"),
    merkleMs,
    perAssetUs: m(t, "verifyMerklePerAssetUs"),
    fullMs,
    signatureUs: m(t, "verifySignaturePerAssetUs"),
    hashesPerAsset: m(t, "hashesPerAsset"),
    manifestMb:
      m(t, "manifestBytes") === null ? null : (m(t, "manifestBytes") as number) / 1_048_576,
    verdict:
      merkleMs !== null && fullMs !== null
        ? `Inclusion proofs for ${m(t, "passports")?.toLocaleString()} assets verify in ${(merkleMs / 1000).toFixed(2)} s — H3 holds for Merkle-only verification. Re-proving every origin signature takes ${(fullMs / 1000).toFixed(0)} s in pure JS: that needs a native verifier or sampling, and is reported as the regression it is.`
        : "no S1 memory run",
  };
}

export interface S2Card {
  readonly chain: string;
  readonly queries: number | null;
  readonly receipts: number | null;
  readonly settleGas: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly refusedAfterRescind: boolean;
  readonly manifestVerified: boolean;
}

export function s2Cards(): S2Card[] {
  return trials(s2)
    .filter((t) => t.onChain)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .map((t) => ({
      chain: chainOf(t),
      queries: m(t, "queries"),
      receipts: m(t, "receiptsRecorded"),
      settleGas: m(t, "settleGasPerQuery"),
      p50: m(t, "queryLatencyP50Ms"),
      p95: m(t, "queryLatencyP95Ms"),
      refusedAfterRescind: m(t, "refusedAfterRescind") === 1,
      manifestVerified: m(t, "manifestWithReceiptsVerified") === 1,
    }));
}

export interface S4Card {
  readonly chain: string;
  readonly injected: number | null;
  readonly refused: number | null;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly forged: number | null;
  readonly forgedRefused: number | null;
}

export function s4Card(): S4Card | null {
  const t = latest(trials(s4), "anchors-baseline");
  if (!t) return null;
  return {
    chain: chainOf(t),
    injected: m(t, "injected"),
    refused: m(t, "refused"),
    precision: m(t, "precision"),
    recall: m(t, "recall"),
    forged: m(t, "onchainForgedAttempts"),
    forgedRefused: m(t, "onchainRefused"),
  };
}
