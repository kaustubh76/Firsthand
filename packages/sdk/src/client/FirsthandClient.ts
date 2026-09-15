import type { AnchorWriter, BlobStore, TxTransport, X402Facilitator } from "@firsthand/adapters";
import type { Bytes32, Eip712Domain, EpochParams, Terms } from "@firsthand/core";
import type { PrfSource } from "@firsthand/crypto";
import { type Logger, noopLogger } from "@firsthand/runtime";
import { Batcher } from "../batch/Batcher.js";
import { Locker, type NamespaceInfo } from "../locker/Locker.js";
import { type AttestPlan, planAttest, sendAttest } from "../verbs/attest.js";
import { acceptSigned, type DepositInput, type DepositResult, deposit } from "../verbs/deposit.js";
import { type EnrollPlan, planEnroll, type SentTx, sendEnroll } from "../verbs/enroll.js";
import { type GrantInput, type GrantPlan, planGrant, sendGrant } from "../verbs/grant.js";
import { type PublishTarget, publishDeposit, publishWrap } from "../verbs/publish.js";
import { type QueryDeps, type QueryRequest, query } from "../verbs/query.js";
import {
  defaultRescindPath,
  planCommit,
  planDirectRescind,
  planRevealRescind,
  type RescindPath,
  type RescindPlan,
  sendRescind,
  type VerbAddresses,
} from "../verbs/rescind.js";

/**
 * Entry point that assembles adapters into the three verbs. Everything is injected — the same
 * client runs against memory doubles in tests, anvil in CI and Monad testnet in the demo.
 */
export interface FirsthandClientOptions {
  readonly domain: Eip712Domain;
  readonly epochs: EpochParams;
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly transport: TxTransport;
  readonly facilitator: X402Facilitator;
  readonly addresses: VerbAddresses;
  readonly namespaces?: readonly NamespaceInfo[];
  readonly logger?: Logger;
  readonly clock?: () => bigint;
}

export class FirsthandClient {
  readonly options: FirsthandClientOptions;
  readonly logger: Logger;

  constructor(options: FirsthandClientOptions) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }

  /** Opens the user's locker from a PRF source; returns a session bound to it. */
  async open(source: PrfSource): Promise<LockerSession> {
    const locker = await Locker.open(source, {
      domain: this.options.domain,
      epochs: this.options.epochs,
      anchors: this.options.anchors,
      blobs: this.options.blobs,
      logger: this.logger,
      ...(this.options.namespaces ? { namespaces: this.options.namespaces } : {}),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    });
    return new LockerSession(this, locker);
  }

  /** Buyer-side query — no locker needed; see BuyerSession for the full buyer flow. */
  query(request: QueryRequest, deps: QueryDeps) {
    return query(request, deps);
  }
}

export class LockerSession {
  readonly locker: Locker;
  readonly batcher: Batcher;
  readonly #client: FirsthandClient;

  constructor(client: FirsthandClient, locker: Locker) {
    this.#client = client;
    this.locker = locker;
    this.batcher = new Batcher(locker);
  }

  /** Registers the locker's authority key on-chain (Phase 1). Relayable: the transport pays gas. */
  planEnroll(epoch?: bigint): EnrollPlan {
    return planEnroll(this.locker, this.#client.options.addresses.principalRegistry, epoch);
  }

  enroll(epoch?: bigint): Promise<SentTx> {
    return sendEnroll(this.locker, this.#client.options.transport, this.planEnroll(epoch));
  }

  planAttest(epoch?: bigint): AttestPlan {
    return planAttest(this.locker, this.#client.options.addresses.principalRegistry, epoch);
  }

  attest(epoch?: bigint): Promise<SentTx> {
    return sendAttest(this.locker, this.#client.options.transport, this.planAttest(epoch));
  }

  deposit(input: DepositInput): Promise<DepositResult> {
    return deposit(this.locker, this.batcher, input);
  }

  acceptSigned(
    signed: Parameters<typeof acceptSigned>[2],
    ns: number,
    plaintext: Uint8Array,
  ): Promise<DepositResult> {
    return acceptSigned(this.locker, this.batcher, signed, ns, plaintext);
  }

  flush() {
    return this.batcher.flush();
  }

  /** Publishes ciphertext + verified sidecar for a deposit to a gateway. */
  publish(target: PublishTarget, result: DepositResult, terms: Terms) {
    return publishDeposit(target, this.locker, this.batcher, result, terms);
  }

  planGrant(input: GrantInput): GrantPlan {
    return planGrant(this.locker, this.#client.options.addresses.grantManager, input);
  }

  /** Grant on-chain and publish the wrap bytes to the gateway that serves the buyer. */
  async grant(
    input: GrantInput,
    target?: PublishTarget,
  ): Promise<{ plan: GrantPlan; sent: SentTx }> {
    const plan = this.planGrant(input);
    const sent = await sendGrant(this.locker, this.#client.options.transport, plan);
    if (target) await publishWrap(target, plan.grantId, plan.wrap);
    return { plan, sent };
  }

  /** Direct rescission; the path defaults to what the configured transport can honour. */
  planRescind(
    grantId: Bytes32,
    path: Exclude<RescindPath, "commit-reveal"> = defaultRescindPath(
      this.#client.options.transport.kind,
    ),
    epoch?: bigint,
  ): RescindPlan {
    return planDirectRescind(this.locker, path, this.#client.options.addresses, grantId, epoch);
  }

  planCommit(grantId: Bytes32): RescindPlan {
    return planCommit(this.#client.options.addresses, grantId);
  }

  planReveal(grantId: Bytes32, salt: Bytes32): RescindPlan {
    return planRevealRescind(this.locker, this.#client.options.addresses, grantId, salt);
  }

  sendRescind(plan: RescindPlan) {
    return sendRescind(this.locker, this.#client.options.transport, plan);
  }

  close(): void {
    this.locker.dispose();
  }
}
