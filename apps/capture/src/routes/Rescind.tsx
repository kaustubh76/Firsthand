import type { Bytes32 } from "@firsthand/core";
import type { LockerSession, RescindResult } from "@firsthand/sdk/browser";
import { useState } from "react";

export function Rescind({ session }: { session: LockerSession }) {
  const [grantId, setGrantId] = useState("");
  const [result, setResult] = useState<RescindResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRescind() {
    setError(null);
    try {
      // Phase 4 adds the passkey-signed direct path over BTX; commit-reveal is live now.
      const plan = session.planCommit(grantId as Bytes32);
      setResult(await session.sendRescind(plan));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <h1>Rescind</h1>
      <input
        value={grantId}
        onChange={(e) => setGrantId(e.target.value)}
        placeholder="0x… grant id"
      />
      <button type="button" onClick={handleRescind} disabled={!/^0x[0-9a-f]{64}$/.test(grantId)}>
        Withdraw consent
      </button>
      {error && <p className="error">{error}</p>}
      {result && (
        <p>
          {result.plan.path} · tx <code>{result.txHash}</code> · encrypted mempool:{" "}
          {String(result.encryptedMempool)}
        </p>
      )}
    </section>
  );
}
