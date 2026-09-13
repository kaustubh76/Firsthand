import { type Bytes32, bytesToHex, keccak256, utf8 } from "@firsthand/core";
import type {
  PreparedTx,
  TransportCapabilities,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";
import { Recorder } from "./Recorder.js";

export interface MemoryTransportOptions {
  /** Pretend to be an encrypted mempool (for experiment arms that simulate BTX). */
  readonly encryptedMempool?: boolean;
  readonly now?: () => number;
}

export class MemoryTransport extends Recorder implements TxTransport {
  readonly kind = "memory" as const;
  readonly sent: { tx: PreparedTx; ref: TxRef }[] = [];
  readonly #encrypted: boolean;
  readonly #now: () => number;
  #seq = 0;

  constructor(options: MemoryTransportOptions = {}) {
    super();
    this.#encrypted = options.encryptedMempool ?? false;
    this.#now = options.now ?? Date.now;
  }

  async send(tx: PreparedTx): Promise<TxRef> {
    this.record("send", tx);
    const hash: Bytes32 = bytesToHex(
      keccak256(utf8(`memory-tx:${this.#seq++}:${tx.to}:${tx.data}`)),
    );
    const ref: TxRef = { hash, transport: "memory", submittedAt: this.#now() };
    this.sent.push({ tx, ref });
    return ref;
  }

  async capabilities(): Promise<TransportCapabilities> {
    this.record("capabilities");
    return { encryptedMempool: this.#encrypted, detail: "in-memory double" };
  }
}
