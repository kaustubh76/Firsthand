import type { Address, Bytes32 } from "@firsthand/core";
import { type Chain, type PublicClient, parseAbiItem, type Transport } from "viem";
import type {
  AnchorView,
  ConsentEvent,
  ConsentLedger,
  LedgerScan,
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
  /** Where to start scanning. Defaults to `head - lookbackBlocks`. */
  readonly fromBlock?: bigint;
  /**
   * How far back to look when `fromBlock` is absent. Monad's public RPC caps `eth_getLogs` at a
   * **100-block range** (measured 2026-09-16), so history costs one request per 100 blocks: this is
   * a recent-activity view, not an archive. Full history is what the Envio indexer is for (ADR-0013).
   */
  readonly lookbackBlocks?: bigint;
  /** Max blocks per `eth_getLogs` call. 100 is Monad's public limit; anvil and archives allow more. */
  readonly maxRange?: bigint;
  /**
   * Minimum gap between RPC calls, in ms. Monad's public endpoint caps throughput at 25 requests/s
   * (measured 2026-09-16) across *all* in-flight scans, so this is paced instance-wide, not per call.
   */
  readonly minRequestIntervalMs?: number;
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
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LogsConsentLedgerOptions) {
    this.#o = options;
  }

  /**
   * Splits a scan into windows the RPC will accept. Both limits are real on Monad's public endpoint:
   * 100 blocks per `eth_getLogs` and 25 requests/second (measured 2026-09-16), and the second is
   * global, so requests are paced instance-wide — `consentTimeline` fans out four scans at once.
   */
  async #scan<T>(
    query: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
    scan?: LedgerScan,
  ): Promise<T[]> {
    // cacheTime 0: viem caches block numbers for ~4 s, which would hide a rescission that just landed.
    const head = await this.#paced(() => this.#o.publicClient.getBlockNumber({ cacheTime: 0 }));
    const lookback = this.#o.lookbackBlocks ?? 500n;
    const from = scan?.fromBlock ?? this.#o.fromBlock ?? (head > lookback ? head - lookback : 0n);
    const max = this.#o.maxRange ?? 100n;
    const windows: [bigint, bigint][] = [];
    for (let start = from; start <= head; start += max) {
      const end = start + max - 1n > head ? head : start + max - 1n;
      windows.push([start, end]);
    }
    const chunks = await Promise.all(
      windows.map(([a, b]) => this.#paced(() => this.#withRetry(() => query(a, b)))),
    );
    return chunks.flat();
  }

  /** Throughput caps are transient; a range or argument error is not. */
  async #withRetry<T>(fn: () => Promise<readonly T[]>): Promise<readonly T[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!/limited|rate|429|timeout/i.test((error as Error).message ?? "")) throw error;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  /** One queue for the whole instance: pacing each scan separately still blows a global cap. */
  #paced<T>(fn: () => Promise<T>): Promise<T> {
    const gap = this.#o.minRequestIntervalMs ?? 50;
    const run = this.#queue.then(async () => {
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      return fn();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async receiptsForGrant(grantId: Bytes32, scan?: LedgerScan): Promise<readonly ReceiptView[]> {
    const logs = await this.#scan(
      (fromBlock, toBlock) =>
        this.#o.publicClient.getLogs({
          address: this.#o.receiptLedger,
          event: EVENTS.receipt,
          args: { grantId },
          fromBlock,
          toBlock,
        }),
      scan,
    );
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

  async anchorsFor(
    principalId: Bytes32,
    ns: number,
    scan?: LedgerScan,
  ): Promise<readonly AnchorView[]> {
    const logs = await this.#scan(
      (fromBlock, toBlock) =>
        this.#o.publicClient.getLogs({
          address: this.#o.passportAnchors,
          event: EVENTS.anchored,
          args: { principalId, ns },
          fromBlock,
          toBlock,
        }),
      scan,
    );
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
  async consentTimeline(principalId: Bytes32, scan?: LedgerScan): Promise<readonly ConsentEvent[]> {
    const [enrolled, attested, granted] = await Promise.all([
      this.#scan(
        (fromBlock, toBlock) =>
          this.#o.publicClient.getLogs({
            address: this.#o.principalRegistry,
            event: EVENTS.enrolled,
            args: { principalId },
            fromBlock,
            toBlock,
          }),
        scan,
      ),
      this.#scan(
        (fromBlock, toBlock) =>
          this.#o.publicClient.getLogs({
            address: this.#o.principalRegistry,
            event: EVENTS.attested,
            args: { principalId },
            fromBlock,
            toBlock,
          }),
        scan,
      ),
      this.#scan(
        (fromBlock, toBlock) =>
          this.#o.publicClient.getLogs({
            address: this.#o.grantManager,
            event: EVENTS.granted,
            args: { principalId },
            fromBlock,
            toBlock,
          }),
        scan,
      ),
    ]);
    const grantIds = granted.map((l) => l.args.grantId as Bytes32);
    const rescinded = grantIds.length
      ? await this.#scan(
          (fromBlock, toBlock) =>
            this.#o.publicClient.getLogs({
              address: this.#o.grantManager,
              event: EVENTS.rescinded,
              args: { grantId: grantIds },
              fromBlock,
              toBlock,
            }),
          scan,
        )
      : [];

    const events: ConsentEvent[] = [
      ...enrolled.map((l) =>
        this.#event("enrolled", principalId, null, l.blockNumber, l.transactionHash),
      ),
      ...attested.map((l) =>
        this.#event("attested", principalId, null, l.blockNumber, l.transactionHash),
      ),
      ...granted.map((l) => {
        const a = l.args as {
          grantId: Bytes32;
          granteeCard: Bytes32;
          ns: number;
          termsHash: Bytes32;
        };
        return {
          ...this.#event("granted", principalId, a.grantId, l.blockNumber, l.transactionHash),
          granteeCard: a.granteeCard,
          ns: Number(a.ns),
          termsHash: a.termsHash,
        };
      }),
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
