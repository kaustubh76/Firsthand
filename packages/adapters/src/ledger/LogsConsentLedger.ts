import type { Address, Bytes32 } from "@firsthand/core";
import { createPacer, type Pacer } from "@firsthand/runtime";
import { type Chain, type PublicClient, parseAbiItem, type Transport } from "viem";
import type {
  AnchorView,
  ConsentEvent,
  ConsentLedger,
  ConsentTimeline,
  LedgerScan,
  LedgerScanReport,
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
   * Minimum gap between RPC call *starts*, in ms. Monad's public endpoint caps throughput at 25
   * requests/s (measured 2026-09-16) across *all* in-flight scans, so this is paced instance-wide,
   * not per call.
   */
  readonly minRequestIntervalMs?: number;
  /**
   * Requests in flight at once (default 4). Pacing starts rather than completions keeps a scan at
   * the rate cap whatever the RPC's latency: 480 windows at 50 ms is 24 s, not 480 round trips.
   */
  readonly maxInFlight?: number;
  readonly now?: () => number;
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
/** One scan's yield plus how far back it got. */
interface Scanned<T> {
  readonly items: T[];
  readonly report: LedgerScanReport;
}

export class LogsConsentLedger implements ConsentLedger {
  readonly #o: LogsConsentLedgerOptions;
  /** One scheduler for the whole instance: pacing each scan separately still blows a global cap. */
  readonly #pacer: Pacer;

  constructor(options: LogsConsentLedgerOptions) {
    this.#o = options;
    this.#pacer = createPacer({
      // Kept at the ledger's historical defaults so a scan's shape does not change here; the
      // hosted gateway sets both explicitly (LEDGER_MIN_REQUEST_INTERVAL_MS / LEDGER_MAX_IN_FLIGHT).
      minRequestIntervalMs: options.minRequestIntervalMs ?? 50,
      maxInFlight: options.maxInFlight ?? 4,
    });
  }

  /**
   * Splits a scan into windows the RPC will accept and walks them newest-first. Both limits are
   * real on Monad's public endpoint: 100 blocks per `eth_getLogs` and 25 requests/second (measured
   * 2026-09-16), and the second is global, so requests are paced instance-wide — `timeline` fans out
   * three scans at once. With a `budgetMs` the walk stops issuing windows when the budget is spent:
   * the newest history is what comes back, and the report says how far back it reached.
   */
  async #scan<T>(
    query: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
    scan?: LedgerScan,
  ): Promise<Scanned<T>> {
    const started = (this.#o.now ?? Date.now)();
    const deadline =
      scan?.budgetMs === undefined ? Number.POSITIVE_INFINITY : started + scan.budgetMs;
    // cacheTime 0: viem caches block numbers for ~4 s, which would hide a rescission that just landed.
    const head = await this.#pacer.run(() => this.#o.publicClient.getBlockNumber({ cacheTime: 0 }));
    const lookback = this.#o.lookbackBlocks ?? 500n;
    const from = scan?.fromBlock ?? this.#o.fromBlock ?? (head > lookback ? head - lookback : 0n);
    const max = this.#o.maxRange ?? 100n;
    const windows: [bigint, bigint][] = [];
    for (let end = head; end >= from; end -= max) {
      const start = end - max + 1n < from ? from : end - max + 1n;
      windows.push([start, end]);
      if (start === 0n) break;
    }
    const chunks: (readonly T[])[] = [];
    let coveredFrom = head + 1n;
    let partial = false;
    const pending: Promise<void>[] = [];
    for (const [a, b] of windows) {
      if ((this.#o.now ?? Date.now)() >= deadline) {
        partial = true;
        break;
      }
      pending.push(
        this.#pacer
          .run(() => this.#withRetry(() => query(a, b)))
          .then((rows) => {
            chunks.push(rows);
          }),
      );
      coveredFrom = a;
    }
    await Promise.all(pending);
    return {
      items: chunks.flat(),
      report: { fromBlock: partial ? coveredFrom : from, toBlock: head, partial },
    };
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

  async receiptsForGrant(grantId: Bytes32, scan?: LedgerScan): Promise<readonly ReceiptView[]> {
    const { items: logs } = await this.#scan(
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
    const { items: logs } = await this.#scan(
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
    return (await this.timeline(principalId, scan)).events;
  }

  async timeline(principalId: Bytes32, scan?: LedgerScan): Promise<ConsentTimeline> {
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
    const grantIds = granted.items.map((l) => l.args.grantId as Bytes32);
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
      : null;
    const reports = [enrolled.report, attested.report, granted.report, rescinded?.report].filter(
      (r): r is LedgerScanReport => r !== undefined,
    );
    // The conservative view of four walks: the newest "oldest block reached", partial if any was.
    const report: LedgerScanReport = {
      fromBlock: reports.reduce((max, r) => (r.fromBlock > max ? r.fromBlock : max), 0n),
      toBlock: reports.reduce((max, r) => (r.toBlock > max ? r.toBlock : max), 0n),
      partial: reports.some((r) => r.partial),
    };

    const events: ConsentEvent[] = [
      ...enrolled.items.map((l) =>
        this.#event("enrolled", principalId, null, l.blockNumber, l.transactionHash),
      ),
      ...attested.items.map((l) =>
        this.#event("attested", principalId, null, l.blockNumber, l.transactionHash),
      ),
      ...granted.items.map((l) => {
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
      ...(rescinded?.items ?? []).map((l) => {
        const a = l.args as { grantId: Bytes32; effectiveBlock: bigint; viaCommitReveal: boolean };
        const effective = BigInt(a.effectiveBlock);
        return {
          ...this.#event("rescinded", principalId, a.grantId, effective, l.transactionHash),
          // Equal on the direct path; on commit-reveal the reveal landed later than consent ended.
          ...(l.blockNumber === effective ? {} : { recordedBlock: l.blockNumber }),
          viaCommitReveal: a.viaCommitReveal === true,
        };
      }),
    ];
    const blocks = await this.#timestamps(events.map((e) => e.blockNumber));
    return {
      events: events
        .map((e) => ({ ...e, timestamp: blocks.get(e.blockNumber) ?? 0n }))
        .sort((a, b) => Number(a.blockNumber - b.blockNumber)),
      scan: report,
    };
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

  /** Block timestamps for the events, through the same scheduler — they count against the cap too. */
  async #timestamps(blockNumbers: readonly bigint[]): Promise<Map<bigint, bigint>> {
    const unique = [...new Set(blockNumbers)];
    const blocks = await Promise.all(
      unique.map((blockNumber) =>
        this.#pacer.run(() =>
          this.#o.publicClient
            .getBlock({ blockNumber })
            .then((b) => [blockNumber, b.timestamp] as const)
            .catch(() => [blockNumber, 0n] as const),
        ),
      ),
    );
    return new Map(blocks);
  }
}
