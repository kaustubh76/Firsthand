/**
 * What a judge reads when something on the chain path says no. The gateway and the SDK now name
 * failures — a decoded custom error, a rate limit with its retry-after, an empty relayer float —
 * and this turns each name into one sentence a person can act on, keeping the raw detail after it.
 * It also fans failures out to the app shell, which reacts to the two that concern every screen:
 * the relayer being out of gas, and the epoch having rolled over.
 */
export interface Failure {
  readonly code: string | null;
  /** The contract's custom error name, when the failure was a decoded revert. */
  readonly reason: string | null;
  readonly message: string;
}

const REVERTS: Record<string, string> = {
  EpochNotAttested: "this epoch is not attested yet — use *Attest this epoch* first",
  EpochNotCurrent:
    "the epoch rolled over while this was being prepared — attest this epoch and try again",
  EpochInFuture: "the app's clock is ahead of the chain — check the device time",
  AlreadyAttested: "already attested for this epoch",
  AlreadyEnrolled: "this passkey is already enrolled on chain",
  EpochNotMonotone: "attestations must move forward in epochs",
  UnknownPrincipal: "this passkey is not enrolled on chain yet — Activate first",
  GrantExists:
    "this buyer already holds a grant for that namespace this epoch — it can be withdrawn, not re-issued until the next epoch",
  GrantAlreadyRescinded: "consent for this grant was already withdrawn",
  GrantNotLive: "this grant is not live",
  TermsNotAccepted: "the buyer has not accepted these exact terms on chain yet",
  UnknownCard: "the buyer's card is not registered on chain",
  DuplicateRoot: "this batch is already anchored",
  InvalidDepositSignature:
    "the deposit key does not match the attested set — attest this epoch first",
  DepositKeysMismatch: "the deposit keys do not match what was attested — attest this epoch first",
  InvalidAuthoritySignature: "the passkey signature did not verify on chain",
  RateLimitExceeded: "this grant's query allowance for the epoch is spent",
  PriceBelowFloor: "the price must be at least one unit",
  TermTooLong: "a grant may run for at most eight epochs",
};

const REVERT_RE = /would revert: ([A-Z][A-Za-z0-9]*)|refused: ([A-Z][A-Za-z0-9]*)/;

export function failureOf(error: unknown): Failure {
  const e = error as { code?: unknown; message?: unknown; context?: { reason?: unknown } };
  const message = typeof e?.message === "string" ? e.message : String(error);
  const code = typeof e?.code === "string" ? e.code : null;
  const fromContext = typeof e?.context?.reason === "string" ? e.context.reason : null;
  const m = REVERT_RE.exec(message);
  const reason = fromContext ?? m?.[1] ?? m?.[2] ?? null;
  return { code, reason, message };
}

/** One sentence for the screen, with the raw detail kept after it. */
export function explainFailure(error: unknown): string {
  const f = failureOf(error);
  if (f.code === "FH_INSUFFICIENT_FUNDS") {
    return `The venue's relayer is out of gas, so nothing can be written on chain until its operator tops it up. (${f.message})`;
  }
  if (f.code === "FH_RATE_LIMITED") return `${f.message}.`;
  if (f.reason && REVERTS[f.reason]) return `${REVERTS[f.reason]}. (${f.message})`;
  if (f.code === "FH_TRANSPORT")
    return `The gateway could not be reached — retry in a moment. (${f.message})`;
  return f.message;
}

type Listener = (failure: Failure) => void;
const listeners = new Set<Listener>();

/** The app shell listens; screens report. Returns the sentence so a screen can show it too. */
export function reportFailure(error: unknown): string {
  const f = failureOf(error);
  for (const l of listeners) l(f);
  return explainFailure(error);
}

export function onFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Failures that mean "this epoch's attestation is stale" — the shell re-reads liveness on them. */
export const EPOCH_REASONS = new Set([
  "EpochNotAttested",
  "EpochNotCurrent",
  "DepositKeysMismatch",
]);
