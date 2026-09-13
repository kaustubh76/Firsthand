import { type Bytes32, bytesToHex, ChainError, keccak256, utf8 } from "@firsthand/core";
import type { AnchorRef, AnchorRequest, AnchorWriter } from "../ports/AnchorWriter.js";
import { Recorder } from "./Recorder.js";

/** Append-only in-memory anchor set with the same duplicate-root rule as the contract. */
export class MemoryAnchorWriter extends Recorder implements AnchorWriter {
  readonly layout = "memory" as const;
  readonly #anchors = new Map<Bytes32, AnchorRef & { request: AnchorRequest }>();
  readonly #counts = new Map<string, number>();
  #block = 1n;

  async anchor(request: AnchorRequest): Promise<AnchorRef> {
    this.record("anchor", request);
    if (this.#anchors.has(request.batchRoot)) {
      throw new ChainError(`DuplicateRoot(${request.batchRoot})`, {
        context: { batchRoot: request.batchRoot },
      });
    }
    const key = `${request.principalId}:${request.ns}:${request.epoch}`;
    const batchIndex = this.#counts.get(key) ?? 0;
    this.#counts.set(key, batchIndex + 1);
    const ref: AnchorRef = {
      batchRoot: request.batchRoot,
      batchIndex,
      blockNumber: this.#block++,
      txHash: bytesToHex(keccak256(utf8(`memory-anchor:${request.batchRoot}`))),
      gasUsed: null,
    };
    this.#anchors.set(request.batchRoot, { ...ref, request });
    return ref;
  }

  async isAnchored(batchRoot: Bytes32): Promise<boolean> {
    this.record("isAnchored", batchRoot);
    return this.#anchors.has(batchRoot);
  }

  async anchorBlock(batchRoot: Bytes32): Promise<bigint | null> {
    this.record("anchorBlock", batchRoot);
    return this.#anchors.get(batchRoot)?.blockNumber ?? null;
  }

  /** Test helper: what was anchored, in order. */
  anchored(): readonly (AnchorRef & { request: AnchorRequest })[] {
    return [...this.#anchors.values()];
  }

  /** Test helper: advance the simulated chain (for finality-depth checks). */
  mineBlocks(n: number): void {
    this.#block += BigInt(n);
  }

  get head(): bigint {
    return this.#block - 1n;
  }
}
