import type { Bytes32 } from "@firsthand/core";
import { encodeDelegation, issueDelegation, KeyTree } from "@firsthand/crypto";
import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import type { AppConfig } from "../lib/config.js";
import { explainFailure } from "../lib/failures.js";
import { updateJournal } from "../lib/journal.js";
import { NS } from "../lib/terms.js";
import { Button, Card, CopyButton, Field, Notice, Pill } from "../ui/index.js";

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
  const [issued, setIssued] = useState<{ code: string; ns: number; until: Date } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issue = () => {
    setError(null);
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
      setIssued({
        code: encodeDelegation(delegation),
        ns,
        until: new Date(Number(expiresAt) * 1000),
      });
      updateJournal(principalId, (j) => {
        j.delegations = [...(j.delegations ?? []), { ns, epoch: epoch.toString(), at: Date.now() }];
      });
    } catch (e) {
      setError(explainFailure(e));
    }
  };

  return (
    <Card
      id="locker-handoff"
      icon="send"
      title="Let an agent deposit for you"
      subtitle="Your passkey stays here. A deposit code carries the keys of one namespace for this epoch."
    >
      <p className="hint">
        Enough for <code>firsthand-mcp</code> on your laptop (<code>FIRSTHAND_DELEGATION=…</code>)
        to mint, anchor and publish passports into your locker, under your principal. It cannot
        grant, rescind, attest, or touch another namespace or epoch, and it expires at the epoch
        boundary. Paste it only into your own agent: whoever holds it can deposit as you in that
        namespace until then.
      </p>
      <div className="field-row">
        <Field label="Namespace">
          {(id) => (
            <select
              id={id}
              value={ns}
              onChange={(e) => setNs(Number(e.target.value))}
              data-testid="delegate-ns"
            >
              <option value={NS.captures}>{NS.captures} · captures</option>
              <option value={NS.imports}>{NS.imports} · imports</option>
            </select>
          )}
        </Field>
        <Button icon="key" onClick={issue} data-testid="delegate-issue">
          Issue a deposit code
        </Button>
      </div>
      {issued && (
        <>
          <div className="row-head">
            <span className="row-meta" data-testid="delegation-scope">
              <Pill tone="accent">deposit-only</Pill>
              <span>namespace {issued.ns}</span>
              <span>epoch {session.locker.currentEpoch().toString()}</span>
              <span>valid until {issued.until.toISOString()}</span>
              <span>cannot grant, rescind or attest</span>
            </span>
            <CopyButton text={issued.code} label="Copy deposit code" />
          </div>
          <code className="code-box" data-testid="delegation-code">
            {issued.code}
          </code>
        </>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </Card>
  );
}
