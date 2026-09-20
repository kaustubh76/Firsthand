import type { Bytes32 } from "@firsthand/core";
import { encodeDelegation, issueDelegation, KeyTree } from "@firsthand/crypto";
import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import type { AppConfig } from "../lib/config.js";
import { explainFailure } from "../lib/failures.js";
import { updateJournal } from "../lib/journal.js";
import { NS } from "../lib/terms.js";

/**
 * The MCP↔PWA handoff (README §10 `firsthand-mcp`, §12 key hygiene). The passkey stays here; an
 * agent on a laptop gets a *deposit delegation*: the three keys of one namespace for this epoch —
 * enough to mint, anchor and publish passports under this principal, nothing else. No authority
 * key, so it cannot enrol, attest, grant or rescind; no other namespace or epoch; it expires at
 * the epoch boundary. A capability attenuated like a grant wrap — "scope is enforced by which key
 * exists" — issued by the person, for their own agent.
 */
export function Delegate({
  session,
  config,
  principalId,
}: {
  session: LockerSession;
  config: AppConfig;
  principalId: Bytes32;
}) {
  const [ns, setNs] = useState<number>(NS.imports);
  const [code, setCode] = useState<string | null>(null);
  const [until, setUntil] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = () => {
    setError(null);
    setCopied(false);
    try {
      const keys = session.locker.keys;
      if (!(keys instanceof KeyTree)) {
        throw new Error(
          "this session is itself a delegation — only the passkey's locker can issue one",
        );
      }
      const epoch = session.locker.currentEpoch();
      const expiresAt = config.epochs.genesis + (epoch + 1n) * config.epochs.length;
      const delegation = issueDelegation(keys, {
        ns,
        epoch,
        chainId: config.chainId,
        expiresAt,
      });
      setCode(encodeDelegation(delegation));
      setUntil(new Date(Number(expiresAt) * 1000));
      updateJournal(principalId, (j) => {
        j.delegations = [...(j.delegations ?? []), { ns, epoch: epoch.toString(), at: Date.now() }];
      });
    } catch (e) {
      setError(explainFailure(e));
    }
  };

  return (
    <>
      <h2>Let an agent deposit for you</h2>
      <p className="hint">
        Your passkey stays here. A deposit code carries the keys of <em>one</em> namespace for{" "}
        <em>this</em> epoch — enough for <code>firsthand-mcp</code> on your laptop (
        <code>FIRSTHAND_DELEGATION=…</code>) to mint, anchor and publish passports into your locker,
        under your principal. It cannot grant, rescind, attest, or touch another namespace or epoch,
        and it expires at the epoch boundary. Paste it only into your own agent: whoever holds it
        can deposit as you in that namespace until then.
      </p>
      <p>
        <label>
          namespace{" "}
          <select
            value={ns}
            onChange={(e) => setNs(Number(e.target.value))}
            data-testid="delegate-ns"
          >
            <option value={NS.captures}>{NS.captures} · captures</option>
            <option value={NS.imports}>{NS.imports} · imports</option>
          </select>
        </label>{" "}
        <button type="button" onClick={issue} data-testid="delegate-issue">
          Issue a deposit code
        </button>
      </p>
      {code && (
        <>
          <p>
            <code className="hex" data-testid="delegation-code">
              {code}
            </code>{" "}
            <button
              type="button"
              className="inline"
              onClick={() => {
                void navigator.clipboard?.writeText(code);
                setCopied(true);
              }}
            >
              {copied ? "copied" : "copy"}
            </button>
          </p>
          <p className="hint" data-testid="delegation-scope">
            deposit-only · namespace {ns} · epoch {session.locker.currentEpoch().toString()} · valid
            until {until?.toISOString() ?? "the epoch boundary"} · cannot grant, rescind or attest
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
