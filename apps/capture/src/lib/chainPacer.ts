import { createPacer, type Pacer } from "@firsthand/adapters/client";
import type { PublicClient } from "viem";

/**
 * One scheduler per chain client, shared by every reader built over it.
 *
 * Monad answers about fifteen requests a second from one egress and refuses the rest — and viem
 * retries a refusal up to five times, so an unbounded fan-out multiplies rather than merely fails.
 * The browser therefore paces at exactly one level: the *adapters* pace each individual read, and
 * callers fan out freely above them. Pacing both levels against the same pacer would deadlock —
 * outer calls would hold every slot while the inner reads they await queued for one.
 */
const pacers = new WeakMap<PublicClient, Pacer>();

export function pacerForClient(publicClient: PublicClient): Pacer {
  const existing = pacers.get(publicClient);
  if (existing) return existing;
  const pacer = createPacer();
  pacers.set(publicClient, pacer);
  return pacer;
}
