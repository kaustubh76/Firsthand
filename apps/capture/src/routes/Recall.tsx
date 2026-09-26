import { type Bytes32, hashTerms } from "@firsthand/core";
import {
  type LockerSession,
  manifestFromQueries,
  publishWrap,
  type QueryResult,
  serialiseManifest,
  verifyManifest,
} from "@firsthand/sdk/browser";
import { type ReactNode, useMemo, useState } from "react";
import { ActivationCard } from "../components/ActivationCard.js";
import { useJournal } from "../hooks/useJournal.js";
import { useToasts } from "../hooks/useToasts.js";
import {
  type DemoAgent,
  formatUsdc,
  mintUsdc,
  openAgent,
  saveAgentRecord,
  usdcBalance,
} from "../lib/agent.js";
import type { AppConfig } from "../lib/config.js";
import { downloadJson } from "../lib/download.js";
import { reportFailure } from "../lib/failures.js";
import { pluralise } from "../lib/format.js";
import { describeLiveness, type Liveness } from "../lib/liveness.js";
import type { CaptureClient } from "../lib/locker.js";
import { PRICE_UNITS, termsFor } from "../lib/terms.js";
import { useNavigation } from "../shell/navigation.js";
import {
  Button,
  Card,
  Field,
  Hash,
  Notice,
  Pill,
  Timeline,
  type TimelineItem,
  Tx,
} from "../ui/index.js";

type StepId = "buyer" | "grant" | "query" | "rescind" | "refused";
interface StepState {
  status: "idle" | "running" | "done" | "failed";
  lines: ReactNode[];
}
const STEPS: { id: StepId; title: string; what: string }[] = [
  {
    id: "buyer",
    title: "An agent accepts your terms",
    what: "A demo AI buyer in this browser funds itself from the testnet faucet double, registers its ERC-8004-style card and accepts your price by preimage. It never holds gas; the relay submits.",
  },
  {
    id: "grant",
    title: "You grant",
    what: "One passkey-signed transaction seals the vault key to the buyer's card and records the grant. The gateway gets the wrap bytes, never the key.",
  },
  {
    id: "query",
    title: "The agent pays per query",
    what: "GET → 402 → the buyer signs an EIP-3009 payment → the gateway re-runs verify() against the chain, settles through the RoyaltyRouter, writes a receipt, and only then serves the ciphertext — which the buyer opens with the wrap.",
  },
  {
    id: "rescind",
    title: "You withdraw consent",
    what: "One passkey-signed transaction. Effective at its own block; the Consent Ledger dates it.",
  },
  {
    id: "refused",
    title: "The same query is refused",
    what: "Same buyer, same payment, same passport: the gateway's verify() now says RESCINDED. No data, no charge.",
  },
];

const idle = (): Record<StepId, StepState> => ({
  buyer: { status: "idle", lines: [] },
  grant: { status: "idle", lines: [] },
  query: { status: "idle", lines: [] },
  rescind: { status: "idle", lines: [] },
  refused: { status: "idle", lines: [] },
});

/**
 * The first recall, from the same public link the capture came from: the demand side of the
 * protocol run against this locker's own passport, with real transactions on the chain the app is
 * connected to. This is Readme §19 minutes 1:05–2:25, minus the split screen.
 */
export function Recall({
  session,
  config,
  client,
  liveness,
  onActivated,
}: {
  session: LockerSession;
  config: AppConfig;
  client: CaptureClient;
  liveness: Liveness;
  onActivated: () => void;
}) {
  const principalId = session.locker.principalId;
  const [journal, mutate] = useJournal(principalId);
  const toasts = useToasts();
  const nav = useNavigation();
  const published = journal.deposits.filter((d) => d.published);
  const [passportId, setPassportId] = useState<Bytes32 | "">(
    (published.find((d) => d.kind === "text") ?? published[0])?.passportId ?? "",
  );
  const [steps, setSteps] = useState<Record<StepId, StepState>>(idle);
  const [running, setRunning] = useState(false);
  const [grantId, setGrantId] = useState<Bytes32 | null>(null);
  const [buyerFile, setBuyerFile] = useState<{ text: string; ok: boolean; assets: number } | null>(
    null,
  );
  const agent: DemoAgent | null = useMemo(
    () => (client.relay ? openAgent(config, client.relay) : null),
    [client.relay, config],
  );

  const target = published.find((d) => d.passportId === passportId) ?? null;
  const blocked =
    config.live && liveness.kind !== "live" && liveness.kind !== "unknown"
      ? describeLiveness(liveness)
      : null;
  const ready = Boolean(
    config.live && agent && client.publicClient && config.usdc && target && !blocked,
  );
  const waitForTx = client.waitForTx;
  const gatewayUrl = config.gatewayUrl as string;
  const domain = session.locker.domain;

  const set = (id: StepId, patch: Partial<StepState>) =>
    setSteps((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  const say = (id: StepId, line: ReactNode) =>
    setSteps((s) => ({ ...s, [id]: { ...s[id], lines: [...s[id].lines, line] } }));

  async function step(id: StepId, fn: () => Promise<void>): Promise<boolean> {
    set(id, { status: "running", lines: [] });
    try {
      await fn();
      set(id, { status: "done" });
      return true;
    } catch (e) {
      say(id, <span className="error">{reportFailure(e)}</span>);
      set(id, { status: "failed" });
      return false;
    }
  }

  const tx = (hash: string, label?: string) => (
    <Tx hash={hash} chainId={config.chainId} {...(label ? { label } : {})} />
  );

  async function runAll() {
    if (!agent || !client.publicClient || !config.usdc || !target || !client.relay) return;
    const relay = client.relay;
    const publicClient = client.publicClient;
    const usdc = config.usdc;
    const ns = target.ns;
    const terms = termsFor(session, ns);
    const termsHash = hashTerms(terms);
    const payee = terms.payees[0] as `0x${string}`;
    setRunning(true);
    setSteps(idle());
    setGrantId(null);
    setBuyerFile(null);
    let grant: Bytes32 | null = null;
    let query: QueryResult | null = null;

    const ok1 = await step("buyer", async () => {
      say(
        "buyer",
        <>
          buyer <Hash value={agent.address} n={6} /> · card <Hash value={agent.cardId} n={6} /> · no
          ERC-8004 identity (a demo agent holds no gas; a real one registers with its own key)
        </>,
      );
      const balance = await usdcBalance(publicClient, usdc, agent.address);
      if (balance < PRICE_UNITS * 10n) {
        if (!config.faucet)
          throw new Error(
            "this gateway does not relay the faucet mint; the buyer cannot fund itself",
          );
        const minted = await mintUsdc(relay, usdc, agent.address, 100_000n);
        await waitForTx?.(minted.hash, "Buyer funded");
        say("buyer", <>funded with 0.1 USDC from the faucet double — {tx(minted.hash)}</>);
      } else {
        say("buyer", <>already holds {formatUsdc(balance)}</>);
      }
      if (!agent.persisted.cardRegisteredTx) {
        const sent = await agent.session.registerCard();
        await waitForTx?.(sent.txHash, "Buyer card registered");
        agent.persisted.cardRegisteredTx = sent.txHash;
        saveAgentRecord(agent.persisted);
        say("buyer", <>card registered — {tx(sent.txHash)}</>);
      } else {
        say("buyer", <>card already registered — {tx(agent.persisted.cardRegisteredTx)}</>);
      }
      const acceptKey = `${principalId}:${termsHash}`;
      if (!agent.persisted.accepted[acceptKey]) {
        const accept = agent.session.acceptTerms(principalId, terms);
        const sent = await accept.send();
        await waitForTx?.(sent.txHash, "Terms accepted");
        agent.persisted.accepted[acceptKey] = accept.plan.termsHash;
        saveAgentRecord(agent.persisted);
        say(
          "buyer",
          <>
            accepted {formatUsdc(PRICE_UNITS)} per query — {tx(sent.txHash)}
          </>,
        );
      } else {
        say("buyer", <>terms already accepted this session</>);
      }
    });
    if (!ok1) return setRunning(false);

    const ok2 = await step("grant", async () => {
      // Grant first, wait for inclusion, then hand the gateway the wrap: its ingest checks the
      // grant on chain, and a relayed transaction is accepted long before it is mined.
      const { plan, sent } = await session.grant({
        granteeCard: agent.cardId,
        granteeEncryptionPubKey: agent.encryptionPubKey,
        ns,
        termsHash,
        term: 4n,
      });
      await waitForTx?.(sent.txHash, "Granted");
      await publishWrap({ gatewayUrl }, plan.grantId, plan.wrap);
      grant = plan.grantId;
      setGrantId(plan.grantId);
      mutate((j) =>
        j.grants.unshift({
          grantId: plan.grantId,
          granteeCard: agent.cardId,
          ns,
          termsHash,
          txHash: sent.txHash,
          at: Date.now(),
        }),
      );
      say(
        "grant",
        <>
          grant <Hash value={plan.grantId} n={6} /> — {tx(sent.txHash)} · wrap published
        </>,
      );
    });
    if (!ok2) return setRunning(false);

    const ok3 = await step("query", async () => {
      if (!grant) throw new Error("no grant");
      const before = await usdcBalance(publicClient, usdc, payee);
      const opened = await agent.session.queryAndOpen(
        { gatewayUrl, grantId: grant, passportId: target.passportId },
        domain,
      );
      query = opened.result;
      const text = new TextDecoder().decode(opened.plaintext);
      const printable = /^[\x20-\x7e\s]*$/.test(text);
      const shown = printable ? (text.length > 140 ? `${text.slice(0, 140)}…` : text) : null;
      say(
        "query",
        <>
          opened {opened.plaintext.length} bytes
          {shown === null ? " (binary — hash matches the passport)" : <>: “{shown}”</>}
        </>,
      );
      const req = opened.result.paid.requirements;
      say(
        "query",
        <>
          paid {req.maxAmountRequired} units to <Hash value={req.payTo} n={6} /> over x402 (
          {req.scheme} · {req.network})
        </>,
      );
      say(
        "query",
        <>
          receipt <Hash value={opened.result.receipt.receiptId} n={6} />
          {opened.result.receipt.txHash && <> — {tx(opened.result.receipt.txHash, "settled")}</>}
        </>,
      );
      const after = await usdcBalance(publicClient, usdc, payee);
      say(
        "query",
        <>you earned {formatUsdc(after - before)}, split on chain to your deposit key</>,
      );
      // The buyer walks away with its compliance file: sidecar + receipt per served query, verified
      // against the chain before it is handed over. No locker, no gateway call.
      const file = await manifestFromQueries({
        domain,
        results: [opened.result],
        anchors: client.anchors,
        payer: agent.address,
        finalityDepth: 0,
      });
      const headBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const verdict = await verifyManifest(file, {
        anchors: client.anchors,
        headBlock,
        ...(client.receipts ? { receipts: client.receipts } : {}),
      });
      setBuyerFile({
        text: serialiseManifest(file),
        ok: verdict.ok,
        assets: verdict.assets.length,
      });
      say(
        "query",
        <span data-testid="buyer-file">
          buyer's Lineage Manifest: {verdict.assets.length} asset with its receipt —{" "}
          {verdict.ok ? "verifies" : "FAILS"}
        </span>,
      );
      mutate((j) =>
        j.receipts.unshift({
          receiptId: opened.result.receipt.receiptId,
          grantId: grant as Bytes32,
          passportId: target.passportId,
          txHash: opened.result.receipt.txHash,
          paidUnits: PRICE_UNITS.toString(),
          at: Date.now(),
        }),
      );
    });
    if (!ok3) return setRunning(false);

    const ok4 = await step("rescind", async () => {
      if (!grant) throw new Error("no grant");
      const sent = await session.sendRescind(session.planRescind(grant));
      await waitForTx?.(sent.txHash, "Consent withdrawn");
      mutate((j) => {
        const g = j.grants.find((x) => x.grantId === grant);
        if (g) g.rescindTx = sent.txHash;
      });
      say(
        "rescind",
        <>
          withdrawn — {tx(sent.txHash)} · {sent.encryptedMempool ? "encrypted" : "public"} mempool (
          {sent.plan.path})
        </>,
      );
    });
    if (!ok4) return setRunning(false);

    await step("refused", async () => {
      if (!grant || !query) throw new Error("no grant");
      try {
        await agent.session.query({ gatewayUrl, grantId: grant, passportId: target.passportId });
        throw new Error("the gateway served data after consent was withdrawn");
      } catch (e) {
        const err = e as Error & { context?: { code?: string; status?: number } };
        const code = err.context?.code;
        if (!code) throw err;
        say(
          "refused",
          <span data-testid="refused">
            {code} (HTTP {err.context?.status}) — no data, no charge
          </span>,
        );
      }
    });
    setRunning(false);
    toasts.push({
      tone: "success",
      title: "First recall complete",
      detail: "granted · paid · withdrawn · refused — every step on chain",
      action: { label: "View", onClick: () => nav.go("locker", "locker-ledger") },
    });
  }

  const STATUS_PILL: Record<
    StepState["status"],
    { tone: "neutral" | "pending" | "ok" | "bad"; text: string }
  > = {
    idle: { tone: "neutral", text: "waiting" },
    running: { tone: "pending", text: "running" },
    done: { tone: "ok", text: "done" },
    failed: { tone: "bad", text: "failed" },
  };
  const items: TimelineItem[] = STEPS.map((s) => {
    const st = steps[s.id];
    return {
      id: s.id,
      status: st.status,
      testId: `step-${s.id}`,
      title: (
        <>
          <strong>{s.title}</strong>
          <Pill tone={STATUS_PILL[st.status].tone} dot={st.status === "running"}>
            {STATUS_PILL[st.status].text}
          </Pill>
        </>
      ),
      meta: <span>{s.what}</span>,
      body:
        st.lines.length > 0
          ? st.lines.map((line, i) => (
              <p key={`${s.id}-${i}-${st.lines.length}`} className="line">
                {line}
              </p>
            ))
          : undefined,
    };
  });
  const done = STEPS.filter((s) => steps[s.id].status === "done").length;

  return (
    <section>
      <div className="screen-head">
        <span className="eyebrow">Query · Rescind</span>
        <h1>Recall</h1>
        <p className="lede">
          The other two verbs, against your own passport: an agent pays to query it, you withdraw
          consent, the same query is refused. Real transactions on chain {config.chainId.toString()}
          .
        </p>
      </div>
      {!config.live && (
        <Notice tone="warn">
          Offline ({config.reason}) — the recall needs a gateway with a relay. Point the app at one
          from Settings.
        </Notice>
      )}
      <ActivationCard
        id="recall-activation"
        session={session}
        config={config}
        client={client}
        liveness={liveness}
        onActivated={onActivated}
        what="The recall"
      />
      {config.live && !config.faucet && (
        <Notice tone="info">
          This gateway does not relay the faucet mint, so the demo buyer can only run if it already
          holds USDC.
        </Notice>
      )}

      <Card
        id="recall-run"
        icon="replay"
        tone="accent"
        title="Run the first recall"
        subtitle="A demo buyer in this browser stands in for an AI agent: it funds itself, accepts your terms, pays per query. You grant and withdraw with your passkey."
        actions={
          done > 0 && (
            <Pill tone={done === STEPS.length ? "ok" : "pending"} dot={running}>
              {done}/{STEPS.length} steps
            </Pill>
          )
        }
      >
        {config.live && published.length === 0 ? (
          <Notice tone="info">
            Stamp and anchor something on the Capture tab first — the buyer needs a passport to pay
            for.
          </Notice>
        ) : (
          <div className="recall-controls">
            {published.length > 0 && (
              <Field label="Passport to sell">
                {(id) => (
                  <select
                    id={id}
                    value={passportId}
                    onChange={(e) => setPassportId(e.target.value as Bytes32)}
                  >
                    {published.map((d) => (
                      <option key={d.passportId} value={d.passportId}>
                        {d.label} — {d.passportId.slice(0, 12)}…
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <Button
              variant="primary"
              icon="replay"
              onClick={runAll}
              disabled={!ready || running}
              pending={running}
              pendingLabel="Running…"
              data-testid="run-recall"
            >
              Run the first recall
            </Button>
          </div>
        )}
        {blocked && config.live && <Notice tone="warn">{blocked}.</Notice>}
        {grantId && (
          <p className="row-meta">
            <span>
              grant <Hash value={grantId} n={6} copy />
            </span>
            <span>also listed under the Locker's grants</span>
          </p>
        )}
      </Card>

      <Timeline items={items} className="steps-timeline" />

      {buyerFile && (
        <Card
          id="recall-buyer-file"
          icon="shield"
          tone={buyerFile.ok ? "ok" : "bad"}
          title="The buyer's compliance file"
          subtitle="Sidecar + receipt per served query, verified against the chain before it is handed over — no locker, no gateway call."
        >
          <div className="btn-row">
            <Button
              icon="download"
              onClick={() =>
                downloadJson(`buyer-lineage-${(grantId ?? "").slice(2, 10)}.json`, buyerFile.text)
              }
            >
              download the buyer's compliance file
            </Button>
            <Pill tone={buyerFile.ok ? "ok" : "bad"} dot>
              {pluralise(buyerFile.assets, "asset")} · {buyerFile.ok ? "verified" : "unverified"}
            </Pill>
            <span className="hint">paste it into Verify to check it yourself.</span>
          </div>
        </Card>
      )}
    </section>
  );
}
