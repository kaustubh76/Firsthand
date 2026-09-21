import { h1, h2, h3, s2Cards, s4Card } from "../lib/evidence.js";

const n = (v: number | null, digits = 0) =>
  v === null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
const REPO = "https://github.com/kaustubh76/Firsthand";

/**
 * Readme §19's last beat: the three claims with their measured numbers on screen, including the
 * two that did not go the protocol's way. Everything is read from experiments/results at build.
 */
export function Evidence() {
  const H1 = h1();
  const H2 = h2();
  const H3 = h3();
  const S2 = s2Cards();
  const S4 = s4Card();
  return (
    <section data-testid="evidence" id="evidence">
      <h1>Evidence</h1>
      <p className="lede">
        Measured, not narrated. Every number below is read from{" "}
        <a href={`${REPO}/tree/main/experiments/results`} target="_blank" rel="noreferrer">
          experiments/results
        </a>{" "}
        at build time; the write-up with method and caveats is{" "}
        <a href={`${REPO}/blob/main/experiments/README.md`} target="_blank" rel="noreferrer">
          experiments/README.md
        </a>
        ; the three-minute script against this app is{" "}
        <a href={`${REPO}/blob/main/docs/JUDGES.md`} target="_blank" rel="noreferrer">
          docs/JUDGES.md
        </a>
        .
      </p>

      <h2>H1 — per-asset anchoring is cheap on Monad (MIP-8 storage pricing)</h2>
      <p className="hint">
        2 560 passports in 10 batches per layout; the paged layout clusters anchors into storage
        pages. Gas per batch of 256 and per passport.
      </p>
      <table className="ledger">
        <thead>
          <tr>
            <th>chain</th>
            <th>baseline /batch</th>
            <th>paged /batch</th>
            <th>baseline /passport</th>
            <th>paged /passport</th>
            <th>paged vs baseline</th>
          </tr>
        </thead>
        <tbody>
          {H1.rows.map((r) => (
            <tr key={r.chain}>
              <td>{r.chain}</td>
              <td>{n(r.baselinePerBatch)}</td>
              <td>{n(r.pagedPerBatch)}</td>
              <td>{n(r.baselinePerPassport)}</td>
              <td>{n(r.pagedPerPassport)}</td>
              <td data-testid="h1-delta">
                {r.deltaPct === null
                  ? "—"
                  : `${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(1)} %`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{H1.verdict}</p>

      <h2>H2 — rescission cannot be raced (S3, {H2.trialsPerArm} trials per arm)</h2>
      <p className="hint">
        The grantee's own bot watches the mempool and fires settlements to beat the rescission;
        success = ordered before the effective point on chain, blocks every 400 ms.
      </p>
      <table className="ledger">
        <thead>
          <tr>
            <th>arm</th>
            <th>extraction success</th>
            <th>Δ_race p50 / p95</th>
            <th>detection</th>
            <th>extractions before end</th>
            <th>queries paid</th>
          </tr>
        </thead>
        <tbody>
          {H2.rows.map((r) => (
            <tr key={r.arm}>
              <td>
                {r.label}
                <br />
                <span className="hint">{r.note}</span>
              </td>
              <td>{r.success === null ? "—" : r.success.toFixed(2)}</td>
              <td>{r.p50 === null ? "—" : `${n(r.p50)} / ${n(r.p95)} ms`}</td>
              <td>{r.detection === null ? "—" : `${n(r.detection)} ms`}</td>
              <td>{n(r.extractions)}</td>
              <td>{n(r.paid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{H2.verdict}</p>

      <h2>H3 — a buyer verifies a corpus offline in seconds</h2>
      <p data-testid="h3">
        {n(H3.passports)} passports · Merkle-only <strong>{n(H3.merkleMs)} ms</strong> (
        {n(H3.perAssetUs)} µs/asset, {n(H3.hashesPerAsset)} hashes/asset, manifest{" "}
        {n(H3.manifestMb, 1)} MB) · full re-proof of every origin signature{" "}
        <strong>{n(H3.fullMs)} ms</strong> ({n(H3.signatureUs)} µs/asset)
      </p>
      <p>{H3.verdict}</p>

      <h2>S2 — paid queries settle on chain and stop at rescission</h2>
      <ul>
        {S2.map((c) => (
          <li key={c.chain}>
            <strong>{c.chain}</strong>: {n(c.queries)} queries → {n(c.receipts)} receipts ·{" "}
            {n(c.settleGas)} gas per <code>RoyaltyRouter.settle</code> · p50 {n(c.p50)} ms / p95{" "}
            {n(c.p95)} ms · manifest with receipts {c.manifestVerified ? "verifies" : "FAILS"} ·
            after rescission the next settlement{" "}
            {c.refusedAfterRescind ? "is refused" : "WENT THROUGH"}
          </li>
        ))}
      </ul>

      <h2>S4 — the locker refuses what it cannot prove</h2>
      {S4 && (
        <p data-testid="s4">
          {S4.chain}: {n(S4.injected)} unprovable deposits injected, {n(S4.refused)} refused ·
          precision {S4.precision} · recall {S4.recall} · {n(S4.forged)} forged anchors sent to the
          contract, {n(S4.forgedRefused)} refused (<code>InvalidDepositSignature</code>)
        </p>
      )}
      <p className="hint">
        The refusal is also one button on the Capture tab, and the whole loop — deposit, paid query,
        withdrawal, refusal — runs against the same contracts from this app.
      </p>
    </section>
  );
}
