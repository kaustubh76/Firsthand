import type { Address, Bytes32, Hex } from "@firsthand/core";

/**
 * How a signed transaction reaches the chain (README §8 claim 1, ADR-0006).
 *
 * - `btx`    — Monad's encrypted mempool: observers cannot read the payload before inclusion, so a
 *              rescission cannot be front-run. Typed shell until the RPC surface is confirmed.
 * - `public` — ordinary `eth_sendRawTransaction`; the B2 baseline arm of the race experiment.
 * - `memory` — records calls; used by every unit test.
 */
export type TransportKind = "btx" | "public" | "memory";

export interface PreparedTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
  readonly gas?: bigint;
}

export interface TxRef {
  readonly hash: Bytes32;
  readonly transport: TransportKind;
  /** Unix ms when the transport accepted the transaction — the `t_rescind_broadcast` of §7.4. */
  readonly submittedAt: number;
}

export interface TransportCapabilities {
  readonly encryptedMempool: boolean;
  readonly detail?: string;
}

export interface TxTransport {
  readonly kind: TransportKind;
  send(tx: PreparedTx): Promise<TxRef>;
  capabilities(): Promise<TransportCapabilities>;
}
