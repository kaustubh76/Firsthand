import type { Journal } from "./journal.js";
import type { Liveness } from "./liveness.js";

/**
 * Readme §19's three-minute script as state: which beats this browser has been through, which
 * one is next, and which cannot happen yet. Derived from real records — the credential, the
 * chain's view of the principal, the journal — never from clicks.
 */
export type JourneyStepId =
  | "enrol"
  | "activate"
  | "deposit"
  | "refusal"
  | "recall"
  | "ledger"
  | "evidence";
export type JourneyStatus = "done" | "current" | "todo" | "blocked";
export type JourneyRoute = "capture" | "locker" | "recall" | "verify" | "evidence";

export interface JourneyStep {
  readonly id: JourneyStepId;
  readonly title: string;
  readonly hint: string;
  readonly route: JourneyRoute | null;
  readonly target: string | null;
  readonly status: JourneyStatus;
}

export interface JourneyInputs {
  readonly unlocked: boolean;
  readonly live: boolean;
  readonly liveness: Liveness;
  readonly journal: Journal | null;
}

const BEATS: readonly Omit<JourneyStep, "status">[] = [
  { id: "enrol", title: "Enrol", hint: "one passkey tap", route: null, target: null },
  {
    id: "activate",
    title: "Activate",
    hint: "enroll + attest on chain",
    route: "capture",
    target: "capture-activation",
  },
  {
    id: "deposit",
    title: "Deposit",
    hint: "stamp a passport",
    route: "capture",
    target: "capture-note",
  },
  {
    id: "refusal",
    title: "Refusal",
    hint: "a scraped datum is turned away",
    route: "capture",
    target: "capture-refusal",
  },
  {
    id: "recall",
    title: "Recall",
    hint: "an agent pays, you withdraw",
    route: "recall",
    target: "recall-run",
  },
  {
    id: "ledger",
    title: "Ledger",
    hint: "consent dated, manifest verified",
    route: "locker",
    target: "locker-ledger",
  },
  {
    id: "evidence",
    title: "Evidence",
    hint: "the measured numbers",
    route: "evidence",
    target: "evidence",
  },
];

function doneBeats(i: JourneyInputs): Set<JourneyStepId> {
  const done = new Set<JourneyStepId>();
  const j = i.journal;
  if (i.unlocked) done.add("enrol");
  if (i.liveness.kind === "live") done.add("activate");
  if (j?.deposits.some((d) => d.published)) done.add("deposit");
  if (j?.refusalAt) done.add("refusal");
  if (j && j.receipts.length > 0 && j.grants.some((g) => g.rescindTx)) done.add("recall");
  if (j?.manifestAt) done.add("ledger");
  if (j?.evidenceSeenAt) done.add("evidence");
  return done;
}

export function deriveJourney(i: JourneyInputs): readonly JourneyStep[] {
  const done = doneBeats(i);
  // Offline, nothing reaches a chain: activation and everything that needs it are blocked. The
  // evidence is read from the build, so it stays reachable.
  const blocked = new Set<JourneyStepId>();
  if (!i.live)
    for (const id of ["activate", "deposit", "refusal", "recall", "ledger"] as const)
      blocked.add(id);
  if (!i.unlocked) for (const b of BEATS) if (b.id !== "enrol") blocked.add(b.id);
  let currentAssigned = false;
  return BEATS.map((b) => {
    let status: JourneyStatus;
    if (done.has(b.id)) status = "done";
    else if (blocked.has(b.id)) status = "blocked";
    else if (!currentAssigned) {
      status = "current";
      currentAssigned = true;
    } else status = "todo";
    return { ...b, status };
  });
}

export function journeyProgress(steps: readonly JourneyStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.status === "done").length, total: steps.length };
}
