import { type Address, ChainError } from "@firsthand/core";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * One paying key, several senders (the relay, settlement, ERC-8004 feedback, the SDK's own writes)
 * and — hosted — several processes at once. What goes wrong at `eth_sendRawTransaction` falls into
 * a handful of kinds, and each deserves a different answer: a nonce collision is retried with a
 * fresh pending nonce; an empty float is named so the operator can act; a revert carries its
 * decoded reason; an RPC hiccup is retryable; everything else is opaque and says so.
 */
export type SendFailureKind = "nonce" | "funds" | "revert" | "rpc" | "unknown";

export interface SendFailure {
  readonly kind: SendFailureKind;
  /** The most specific message the node or viem produced, for logs and problem bodies. */
  readonly detail: string;
}

const NONCE =
  /nonce too low|nonce too high|invalid nonce|already known|already imported|already exists|replacement transaction underpriced|nonce provided for the transaction/i;
// "gas required exceeds allowance" is geth/anvil's wording when the sender's balance cannot cover
// the estimate — the allowance is derived from the balance, and ours reads 0.
const FUNDS =
  /insufficient funds|insufficient balance|exceeds transaction sender account balance|signer had insufficient|gas required exceeds allowance/i;
const REVERT = /execution reverted|revert/i;
const RPC =
  /timeout|timed out|rate limit|too many requests|429|502|503|504|fetch failed|econnreset|econnrefused|socket hang up|request limit|limited|network error|http request failed/i;

/** Every message on the cause chain, most specific first. */
export function messagesOf(cause: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      shortMessage?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    for (const m of [e.details, e.shortMessage, e.message]) {
      if (typeof m === "string" && m.length > 0 && !out.includes(m)) out.push(m);
    }
    current = e.cause;
  }
  return out;
}

export function classifySendError(cause: unknown): SendFailure {
  const messages = messagesOf(cause);
  const text = messages.join(" | ");
  const detail = messages[0] ?? (typeof cause === "string" ? cause : "unknown failure");
  if (NONCE.test(text)) return { kind: "nonce", detail };
  if (FUNDS.test(text)) return { kind: "funds", detail };
  if (revertData(cause) !== null || REVERT.test(text)) return { kind: "revert", detail };
  if (RPC.test(text)) return { kind: "rpc", detail };
  return { kind: "unknown", detail };
}

/**
 * The raw revert bytes behind a failed `eth_call` / simulation, wherever viem left them: on a
 * `ContractFunctionRevertedError` (simulateContract) or on the RPC error's `data` (plain `call`).
 */
export function revertData(cause: unknown): Hex | null {
  if (!(cause instanceof BaseError)) return null;
  const reverted = cause.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  const carrier = cause.walk((e) => {
    if (typeof e !== "object" || e === null || !("data" in e)) return false;
    const d = (e as { data?: unknown }).data;
    return (
      isHex(d) || (typeof d === "object" && d !== null && isHex((d as { data?: unknown }).data))
    );
  }) as { data?: unknown } | null;
  if (!carrier) return null;
  const d = carrier.data;
  if (isHex(d)) return d;
  const nested = (d as { data?: unknown }).data;
  return isHex(nested) ? nested : null;
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length > 2;
}

export interface RevertExplanation {
  /** Custom error name (`EpochNotAttested`), `Error` / `Panic` for the Solidity built-ins, or null. */
  readonly reason: string | null;
  readonly args: readonly unknown[];
  readonly raw: Hex | null;
}

/** Decodes revert bytes against the given ABIs — the target's first, then whatever it may call into. */
export function explainRevert(cause: unknown, abis: readonly Abi[]): RevertExplanation {
  const raw = revertData(cause);
  if (raw === null) {
    const reverted =
      cause instanceof BaseError
        ? cause.walk((e) => e instanceof ContractFunctionRevertedError)
        : null;
    if (reverted instanceof ContractFunctionRevertedError) {
      return {
        reason: reverted.data?.errorName ?? reverted.reason ?? null,
        args: (reverted.data?.args ?? []).map(jsonSafe),
        raw: null,
      };
    }
    return { reason: null, args: [], raw: null };
  }
  for (const abi of abis) {
    try {
      const decoded = decodeErrorResult({ abi, data: raw });
      return { reason: decoded.errorName, args: (decoded.args ?? []).map(jsonSafe), raw };
    } catch {
      // not this ABI
    }
  }
  return { reason: null, args: [], raw };
}

function jsonSafe(value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export interface NonceRetryOptions {
  readonly account: PrivateKeyAccount;
  readonly chainId: number;
  /** Total attempts, including the first (default 3). */
  readonly attempts?: number;
  readonly onRetry?: (attempt: number, detail: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs a send; on a nonce collision (another process used our pending nonce first, or the node's
 * pending count lagged) resets the account's nonce manager so the next attempt re-reads the pending
 * nonce, waits a little with jitter, and tries again. Any other failure is thrown unchanged.
 */
export async function sendWithNonceRetry<T>(
  send: () => Promise<T>,
  options: NonceRetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (cause) {
      const failure = classifySendError(cause);
      if (failure.kind !== "nonce" || attempt >= attempts) throw cause;
      options.account.nonceManager?.reset({
        address: options.account.address,
        chainId: options.chainId,
      });
      options.onRetry?.(attempt, failure.detail);
      await sleep(150 * attempt + Math.floor(Math.random() * 250));
    }
  }
}

/** The address a `ChainError` about funds should name — the paying key, never a user's. */
export function insufficientFundsError(
  message: string,
  payer: Address,
  cause: unknown,
): ChainError {
  return new ChainError(message, {
    code: "FH_INSUFFICIENT_FUNDS",
    cause,
    context: { payer, detail: classifySendError(cause).detail },
  });
}
