import { hashTerms } from "@firsthand/core";
import { publishWrap } from "@firsthand/sdk/browser";
import { useEffect, useState } from "react";
import { formatUsdc } from "../../lib/agent.js";
import { type AgentInfo, bindingHolds, fetchAgent } from "../../lib/agents.js";
import type { Liveness } from "../../lib/liveness.js";
import { readerFor } from "../../lib/liveness.js";
import { dismissRequest, type GrantRequest } from "../../lib/requests.js";
import { PRICE_UNITS, termsFor } from "../../lib/terms.js";
import { Button, Card, Hash, Notice, Pill } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

type Known = { info: AgentInfo | null; verified: boolean; owner: string | null };

/**
 * A buyer asked for access by sending a link. Who is asking is checked against the chain — the
 * requester's ERC-8004 identity against the card in the link — before the one passkey tap.
 */
export function RequestsCard({
  ctx,
  liveness,
  requests,
  onRequests,
}: {
  ctx: LockerCtx;
  liveness: Liveness;
  requests: GrantRequest[];
  onRequests: (list: GrantRequest[]) => void;
}) {
  const { session, config, client, mutate, actions, refreshLedger } = ctx;
  const [agents, setAgents] = useState<Record<string, Known>>({});
  useEffect(() => {
    if (!config.live || !config.gatewayUrl || !client.publicClient) return;
    for (const r of requests) {
      if (!r.agentId || agents[`${r.card}:${r.agentId}`]) continue;
      const key = `${r.card}:${r.agentId}`;
      void (async () => {
        const [info, card] = await Promise.all([
          fetchAgent(config.gatewayUrl as string, r.agentId as string).catch(() => null),
          readerFor(config, client.publicClient as NonNullable<typeof client.publicClient>)
            .cardOf(r.card)
            .catch(() => null),
        ]);
        const owner = card?.owner ?? null;
        setAgents((a) => ({
          ...a,
          [key]: { info, verified: bindingHolds(info, r.card, owner), owner },
        }));
      })();
    }
  }, [requests, config, client.publicClient, agents]);

  const approve = (r: GrantRequest) =>
    actions.run(`approve:${r.card}`, async () => {
      if (!config.gatewayUrl) throw new Error("no gateway");
      const termsHash = hashTerms(termsFor(session, r.ns));
      // Grant, wait for inclusion, then hand the gateway the wrap: its ingest checks the grant on
      // chain, and a relayed transaction is accepted long before it is mined.
      const { plan, sent } = await session.grant({
        granteeCard: r.card,
        granteeEncryptionPubKey: r.pub,
        ns: r.ns,
        termsHash,
        term: 4n,
      });
      await client.waitForTx?.(sent.txHash, "Granted");
      await publishWrap({ gatewayUrl: config.gatewayUrl }, plan.grantId, plan.wrap);
      const known = r.agentId ? agents[`${r.card}:${r.agentId}`] : undefined;
      mutate((j) =>
        j.grants.unshift({
          grantId: plan.grantId,
          granteeCard: r.card,
          ns: r.ns,
          termsHash,
          txHash: sent.txHash,
          at: Date.now(),
          ...(known?.verified && r.agentId
            ? { agentId: r.agentId, ...(known.info?.name ? { agentName: known.info.name } : {}) }
            : {}),
        }),
      );
      onRequests(dismissRequest(r.card, r.ns));
      await refreshLedger();
    });

  if (requests.length === 0) return null;
  return (
    <Card
      id="locker-requests"
      icon="inbox"
      tone="accent"
      title="Access requests"
      subtitle={`Approving is one passkey-signed grant under your terms (${formatUsdc(PRICE_UNITS)} per query); the vault key is sealed to their card, the gateway gets only the wrap.`}
      actions={<Pill tone="accent">{requests.length} waiting</Pill>}
    >
      <ul className="cards" data-testid="requests">
        {requests.map((r) => {
          const known = r.agentId ? agents[`${r.card}:${r.agentId}`] : undefined;
          const identity = !r.agentId
            ? { text: "no ERC-8004 identity — an unverified card", tone: "warn" as const }
            : !known
              ? { text: `ERC-8004 agent #${r.agentId} — checking…`, tone: "pending" as const }
              : !known.info
                ? {
                    text: `ERC-8004 agent #${r.agentId} — not found in the registry`,
                    tone: "warn" as const,
                  }
                : known.verified
                  ? {
                      text: `ERC-8004 agent #${r.agentId}${known.info.name ? ` “${known.info.name}”` : ""} · owner ${known.info.owner.slice(0, 10)}… · binding verified ✓ · ${known.info.reputation.paidQueriesHere} paid quer${known.info.reputation.paidQueriesHere === "1" ? "y" : "ies"} credited here`,
                      tone: "ok" as const,
                    }
                  : {
                      text: `ERC-8004 agent #${r.agentId} — binding does NOT match this card ✗`,
                      tone: "bad" as const,
                    };
          const err = actions.errorFor(`approve:${r.card}`);
          return (
            <li key={`${r.card}-${r.ns}`} className="grant-row">
              <div className="row-head">
                <strong>{r.label}</strong>
                <span className="row-meta">
                  <span>asks for namespace {r.ns}</span>
                  <span>
                    card <Hash value={r.card} n={6} />
                  </span>
                </span>
              </div>
              <div className="row-meta">
                <Pill tone={identity.tone} dot data-testid="agent-identity">
                  {identity.text}
                </Pill>
              </div>
              <div className="row-actions">
                <Button
                  variant="primary"
                  size="sm"
                  icon="key"
                  disabled={!config.live || actions.busy !== null || liveness.kind !== "live"}
                  pending={actions.is(`approve:${r.card}`)}
                  pendingLabel="Granting…"
                  onClick={() => approve(r)}
                >
                  Approve with passkey
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRequests(dismissRequest(r.card, r.ns))}
                >
                  dismiss
                </Button>
              </div>
              {err && <Notice tone="bad">{err}</Notice>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
