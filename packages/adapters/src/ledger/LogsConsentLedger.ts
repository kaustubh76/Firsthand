import type { Address, Bytes32 } from "@firsthand/core";
import { type Chain, type PublicClient, parseAbiItem, type Transport } from "viem";
import type {
  AnchorView,
  ConsentEvent,
  ConsentLedger,
  ReceiptView,
} from "../ports/ConsentLedger.js";

/** Signatures copied from the interfaces in `contracts/src/interfaces/` — viem types the args from them. */
const EVENTS = {
  enrolled: parseAbiItem(
    "event PrincipalEnrolled(bytes32 indexed principalId, uint256 x, uint256 y, uint64 epoch)",
  ),
  attested: parseAbiItem(
    "event PrincipalAttested(bytes32 indexed principalId, uint64 indexed epoch, bytes32 depositKeysRoot)",
  ),
  anchored: parseAbiItem(
    "event BatchAnchored(bytes32 indexed principalId, uint32 indexed ns, uint64 indexed epoch, bytes32 batchRoot, bytes32 termsHash, uint256 batchIndex)",
  ),
  granted: parseAbiItem(
    "event GrantCreated(bytes32 indexed grantId, bytes32 indexed principalId, bytes32 indexed granteeCard, uint32 ns, uint64 epochStart, uint64 term, bytes32 termsHash, bytes32 wrapRef)",
  ),
  rescinded: parseAbiItem(
    "event GrantRescinded(bytes32 indexed grantId, uint64 epochEnd, uint64 effectiveBlock, bool viaCommitReveal)",
  ),
  receipt: parseAbiItem(
    "event ReceiptRecorded(bytes32 indexed receiptId, bytes32 indexed grantId, address indexed payer, uint32 ns, bytes32 termsHash, uint64 epoch)",
  ),
} as const;

export interface LogsConsentLedgerOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly principalRegistry: Address;
  readonly passportAnchors: Address;
  readonly grantManager: Address;
  readonly receiptLedger: Address;
  /** Deployment block — scanning from 0 on a long-lived chain is pointless and slow. */
  readonly fromBlock?: bigint;
}

/**
 * The Consent Ledger read directly from contract logs. Envio is the indexed path (README §22), but it
 * needs codegen, a database and somewhere to host it; this needs only an RPC, so the audit surface
 * works the moment the contracts are deployed — and it is the fallback ADR-0006 notes Envio lacks.
 *
 * Matches `MemoryConsentLedger` semantics: filtered in block order, `batchIndex` narrowed to a number,
 * everything else left as bigint. FROZEN and EXPIRED are *derived* states, not events — they are
 * computed from liveness and grant terms at query time, exactly as `effectiveStatus` does on chain.
 */
export class LogsConsentLedger implements ConsentLedger {
  readonly #o: LogsConsentLedgerOptions;

  constructor(options: LogsConsentLedgerOptions) {
    this.#o = options;
  }

  get #range() {
    return { fromBlock: this.#o.fromBlock ?? 0n, toBlock: "latest" as const };
  }

  async receiptsForGrant(grantId: Bytes32): Promise<readonly ReceiptView[]> {
    const logs = await this.#o.publicClient.getLogs({
      address: this.#o.receiptLedger,
      event: EVENTS.receipt,
      args: { grantId },
      ...this.#range,
    });
    return logs.map((l) => ({
      receiptId: l.args.receiptId as Bytes32,
      grantId: l.args.grantId as Bytes32,
      payer: (l.args.payer as string).toLowerCase() as Address,
      ns: Number(l.args.ns),
      termsHash: l.args.termsHash as Bytes32,
      epoch: BigInt(l.args.epoch ?? 0n),
      blockNumber: l.blockNumber,
      txHash: l.transactionHash as Bytes32,
    }));
  }

  async anchorsFor(principalId: Bytes32, ns: number): Promise<readonly AnchorView[]> {
    const logs = await this.#o.publicClient.getLogs({
      address: this.#o.passportAnchors,
      event: EVENTS.anchored,
      args: { principalId, ns },
      ...this.#range,
    });
    return logs.map((l) => ({
      batchRoot: l.args.batchRoot as Bytes32,
      ns: Number(l.args.ns),
      epoch: BigInt(l.args.epoch ?? 0n),
      termsHash: l.args.termsHash as Bytes32,
      blockNumber: l.blockNumber,
      batchIndex: Number(l.args.batchIndex ?? 0n),
    }));
  }

  /**
   * enrolled · attested · granted · rescinded from logs, in block order. A rescission is the moment
   * that matters: `GrantRescinded.effectiveBlock` is the *commit* block on the commit-reveal path,
   * so consent ends earlier than the reveal that recorded it — the timeline reports the effective
   * block, not the log's own.
   */
  async consentTimeline(principalId: Bytes32): Promise<readonly ConsentEvent[]> {
    const [enrolled, attested, granted] = await Promise.all([
      this.#o.publicClient.getLogs({
        address: this.#o.principalRegistry,
        event: EVENTS.enrolled,
        args: { principalId },
        ...this.#range,
      }),
      this.#o.publicClient.getLogs({
        address: this.#o.principalRegistry,
        event: EVENTS.attested,
        args: { principalId },
        ...this.#range,
      }),
      this.#o.publicClient.getLogs({
        address: this.#o.grantManager,
        event: EVENTS.granted,
        args: { principalId },
        ...this.#range,
      }),
    ]);
    const grantIds = granted.map((l) => l.args.grantId as Bytes32);
    const rescinded = grantIds.length
      ? await this.#o.publicClient.getLogs({
          address: this.#o.grantManager,
          event: EVENTS.rescinded,
          args: { grantId: grantIds },
          ...this.#range,
        })
      : [];

    const events: ConsentEvent[] = [
      ...enrolled.map((l) =>
        this.#event("enrolled", principalId, null, l.blockNumber, l.transactionHash),
      ),
      ...attested.map((l) =>
        this.#event("attested", principalId, null, l.blockNumber, l.transactionHash),
      ),
      ...granted.map((l) =>
        this.#event(
          "granted",
          principalId,
          (l.args as { grantId: Bytes32 }).grantId,
          l.blockNumber,
          l.transactionHash,
        ),
      ),
      ...rescinded.map((l) => {
        const a = l.args as { grantId: Bytes32; effectiveBlock: bigint };
        return this.#event(
          "rescinded",
          principalId,
          a.grantId,
          BigInt(a.effectiveBlock),
          l.transactionHash,
        );
      }),
    ];
    const blocks = await this.#timestamps(events.map((e) => e.blockNumber));
    return events
      .map((e) => ({ ...e, timestamp: blocks.get(e.blockNumber) ?? 0n }))
      .sort((a, b) => Number(a.blockNumber - b.blockNumber));
  }

  #event(
    kind: ConsentEvent["kind"],
    principalId: Bytes32,
    grantId: Bytes32 | null,
    blockNumber: bigint,
    txHash: string | null,
  ): ConsentEvent {
    return {
      kind,
      principalId,
      grantId,
      blockNumber,
      timestamp: 0n,
      txHash: (txHash as Bytes32 | null) ?? null,
    };
  }

  async #timestamps(blockNumbers: readonly bigint[]): Promise<Map<bigint, bigint>> {
    const unique = [...new Set(blockNumbers)];
    const blocks = await Promise.all(
      unique.map((blockNumber) =>
        this.#o.publicClient
          .getBlock({ blockNumber })
          .then((b) => [blockNumber, b.timestamp] as const)
          .catch(() => [blockNumber, 0n] as const),
      ),
    );
    return new Map(blocks);
  }
}
