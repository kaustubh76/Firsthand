import { readFile } from "node:fs/promises";
import type { AnchorWriter } from "@firsthand/adapters";
import {
  type Address,
  AttestationClass,
  type Bytes32,
  type Eip712Domain,
  isFirsthandError,
  LICENSE_FH_1_0,
  parseSidecar,
  passportId,
  Scope,
  type Terms,
  tag,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { parseExport } from "@firsthand/importers";
import type { Logger } from "@firsthand/runtime";
import {
  type BuyerSession,
  type LockerSession,
  manifestFromQueries,
  type QueryResult,
  serialiseManifest,
  verifyManifest,
} from "@firsthand/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PublicClient } from "viem";
import {
  AcceptTermsInputSchema,
  AttestInputSchema,
  DepositInputSchema,
  EnrollInputSchema,
  ExportManifestInputSchema,
  GrantInputSchema,
  ImportInputSchema,
  QueryInputSchema,
  RegisterCardInputSchema,
  RequestAccessInputSchema,
  RescindInputSchema,
  StatusInputSchema,
} from "./tools/schemas.js";

export interface McpDeps {
  /** Opened lazily on first tool call so a stdio client can list tools without a PRF. */
  readonly session: () => Promise<LockerSession>;
  readonly logger: Logger;
  /** Whether the configured transport actually reaches a chain (relayer key present). */
  readonly canBroadcast: boolean;
  /** Buyer-side session, when BUYER_PRIVATE_KEY / GRANTEE_SEED_HEX are configured. */
  readonly buyer?: () => Promise<BuyerSession>;
  readonly passportDomain: Eip712Domain;
  /** Gateway that hosts ciphertext + sidecars; without it a deposit cannot be recalled by a buyer. */
  readonly gatewayUrl?: string;
  /** True when the anchors adapter reaches a chain — i.e. a deposit can actually be anchored. */
  readonly canAnchor: boolean;
  /** Chain reader for the buyer's own verification (manifest anchors, head block). */
  readonly publicClient?: PublicClient;
  /** Read-only anchors view for manifest verification; defaults to the session's writer. */
  readonly anchors?: Pick<AnchorWriter, "isAnchored" | "anchorBlock">;
  /** Waits for a relayed transaction to land, so dependent calls do not simulate against thin air. */
  readonly waitForTx?: (hash: Bytes32) => Promise<void>;
}

const CLASS = {
  unattested: AttestationClass.UNATTESTED,
  import: AttestationClass.IMPORT,
  device_capture: AttestationClass.DEVICE_CAPTURE,
} as const;

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

function failure(error: unknown) {
  const body = isFirsthandError(error)
    ? { error: error.code, message: error.message, context: error.context }
    : { error: "FH_INTERNAL", message: (error as Error).message };
  return { ...text(body), isError: true };
}

/** Builds the MCP server with the three verbs plus `firsthand_status`. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "firsthand-mcp", version: "0.1.0" });

  server.registerTool(
    "firsthand_deposit",
    {
      title: "Deposit into the locker",
      description:
        "Mint a passkey-rooted Data Passport for a piece of text, seal it client-side, and batch it for anchoring on Monad. Refuses anything it cannot prove.",
      inputSchema: DepositInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const terms: Terms = {
          price: BigInt(input.priceUnits),
          licenseId: LICENSE_FH_1_0,
          scope: Scope.TRAIN | Scope.INFER | Scope.EVAL,
          ns: input.ns,
          rateLimit: 100,
          payees: [input.payee as Address],
          weights: [WAD],
        };
        const result = await session.deposit({
          ns: input.ns,
          datum: { kind: "bytes", bytes: new TextEncoder().encode(input.text) },
          terms,
          attestation: {
            class: CLASS[input.attestationClass],
            capturedAt: BigInt(Math.floor(Date.now() / 1000)),
            sourceTag: input.sourceTag ? tag(input.sourceTag) : ZERO_HASH,
            deviceClass: ZERO_HASH,
            metaHash: ZERO_HASH,
          },
        });
        // A deposit nobody can fetch is not a deposit: anchor the batch and hand the gateway the
        // ciphertext + sidecar, so `firsthand_query` against that gateway can actually serve it.
        let published: string | null = null;
        let anchored = result.anchored?.root ?? null;
        const wantsPublish = input.publish && deps.canAnchor && deps.gatewayUrl !== undefined;
        if (wantsPublish) {
          const flushed = await session.flush();
          anchored =
            flushed.find((b) =>
              b.passports.some((p) => passportId(p.passport) === result.passportId),
            )?.root ?? anchored;
          await session.publish({ gatewayUrl: deps.gatewayUrl as string }, result, terms);
          published = deps.gatewayUrl as string;
        }
        return text({
          passportId: result.passportId,
          passport: result.signed.passport,
          blob: result.blob.id,
          anchored,
          published,
          ...(input.publish && !wantsPublish
            ? {
                warning: deps.canAnchor
                  ? "GATEWAY_URL is not configured — the deposit is anchored but no buyer can fetch it"
                  : "DEPLOYMENTS_FILE / relayer not configured — the deposit is local only and cannot be recalled",
              }
            : {}),
        });
      } catch (error) {
        deps.logger.warn("deposit failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_query",
    {
      title: "Query a passport under a grant",
      description:
        "Buyer side: pay per query over x402 and receive data with its passport, Merkle proof and receipt; the plaintext is opened with the grantee's key. Needs BUYER_PRIVATE_KEY and GRANTEE_SEED_HEX.",
      inputSchema: QueryInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.buyer)
          return failure(
            new Error("no buyer keys configured (BUYER_PRIVATE_KEY, GRANTEE_SEED_HEX)"),
          );
        const buyer = await deps.buyer();
        const { result, plaintext } = await buyer.queryAndOpen(
          {
            gatewayUrl: input.gatewayUrl,
            grantId: input.grantId as Bytes32,
            passportId: input.passportId as Bytes32,
          },
          deps.passportDomain,
        );
        return text({
          passportId: result.passportId,
          receipt: result.receipt,
          paid: {
            value: result.paid.requirements.maxAmountRequired,
            payTo: result.paid.requirements.payTo,
          },
          passport: result.signed.passport,
          plaintextUtf8: new TextDecoder().decode(plaintext),
        });
      } catch (error) {
        deps.logger.warn("query failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_rescind",
    {
      title: "Rescind consent for a grant",
      description:
        "Withdraw consent. `btx` uses Monad's encrypted mempool so no grantee can race the revocation (refused with FH_BTX_UNAVAILABLE where BTX is not live); `public` is the measurable baseline; `commit-reveal` posts a commitment now and works everywhere (pass the returned salt back with the same path to reveal).",
      inputSchema: RescindInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const grantId = input.grantId as Bytes32;
        const plan =
          input.path === "commit-reveal"
            ? input.salt
              ? session.planReveal(grantId, input.salt as Bytes32)
              : session.planCommit(grantId)
            : session.planRescind(grantId, input.path);
        if (!deps.canBroadcast)
          return text({
            broadcast: false,
            path: plan.path,
            salt: plan.salt,
            commitment: plan.commitment,
            tx: { to: plan.to, data: plan.data },
          });
        const sent = await session.sendRescind(plan);
        return text({
          broadcast: true,
          path: plan.path,
          salt: plan.salt,
          commitment: plan.commitment,
          txHash: sent.txHash,
          submittedAt: sent.submittedAt,
          encryptedMempool: sent.encryptedMempool,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_grant",
    {
      title: "Grant a buyer access to a namespace",
      description:
        "Wraps the namespace-epoch vault key to the buyer's card key, signs the grant with the passkey-derived authority key, and (optionally) publishes the wrap to a gateway. The chain stores only the wrap hash.",
      inputSchema: GrantInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const grantInput = {
          granteeCard: input.granteeCard as Bytes32,
          granteeEncryptionPubKey: input.granteeEncryptionPubKey as Bytes32,
          ns: input.ns,
          termsHash: input.termsHash as Bytes32,
          term: BigInt(input.term),
        };
        if (!deps.canBroadcast) {
          const plan = session.planGrant(grantInput);
          return text({
            broadcast: false,
            grantId: plan.grantId,
            wrapRef: plan.wrapRef,
            wrapHex: `0x${Buffer.from(plan.wrap).toString("hex")}`,
            tx: plan.tx,
          });
        }
        const { plan, sent } = await session.grant(
          grantInput,
          input.gatewayUrl ? { gatewayUrl: input.gatewayUrl } : undefined,
        );
        return text({
          broadcast: true,
          grantId: plan.grantId,
          wrapRef: plan.wrapRef,
          txHash: sent.txHash,
          wrapPublishedTo: input.gatewayUrl ?? null,
        });
      } catch (error) {
        deps.logger.warn("grant failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_enroll",
    {
      title: "Enrol the locker's authority key on-chain",
      description:
        "Registers the passkey-derived P-256 authority key in PrincipalRegistry (Phase 1). Relayable: with a relayer key configured the tool broadcasts; otherwise it returns the signed calldata for out-of-band submission.",
      inputSchema: EnrollInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const epoch = input.epoch === undefined ? undefined : BigInt(input.epoch);
        const plan = session.planEnroll(epoch);
        if (!deps.canBroadcast) {
          return text({
            broadcast: false,
            principalId: plan.principalId,
            epoch: plan.epoch,
            tx: plan.tx,
          });
        }
        const sent = await session.enroll(epoch);
        return text({
          broadcast: true,
          principalId: plan.principalId,
          epoch: plan.epoch,
          txHash: sent.txHash,
        });
      } catch (error) {
        deps.logger.warn("enroll failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_attest",
    {
      title: "Attest this epoch's deposit keys",
      description:
        "Publishes the 16 epoch deposit addresses as one commitment and refreshes liveness — the weekly passkey ritual (README §7.4).",
      inputSchema: AttestInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const epoch = input.epoch === undefined ? undefined : BigInt(input.epoch);
        const plan = session.planAttest(epoch);
        if (!deps.canBroadcast) {
          return text({
            broadcast: false,
            principalId: plan.principalId,
            epoch: plan.epoch,
            depositKeysRoot: plan.depositKeysRoot,
            tx: plan.tx,
          });
        }
        const sent = await session.attest(epoch);
        return text({
          broadcast: true,
          principalId: plan.principalId,
          epoch: plan.epoch,
          depositKeysRoot: plan.depositKeysRoot,
          txHash: sent.txHash,
        });
      } catch (error) {
        deps.logger.warn("attest failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_status",
    {
      title: "Locker status",
      description: "Principal id, namespaces, pending and anchored batches.",
      inputSchema: StatusInputSchema.shape,
    },
    async () => {
      try {
        const session = await deps.session();
        return text({
          locker: session.locker.toJSON(),
          epoch: session.locker.currentEpoch(),
          pending: session.batcher.pendingCount(),
          anchored: session.batcher
            .flushed()
            .map((b) => ({ ns: b.ns, epoch: b.epoch, root: b.root, size: b.passports.length })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_register_card",
    {
      title: "Register the buyer's grantee card",
      description:
        "Buyer side: publish this agent's card (owner address + X25519 encryption key) so a principal can grant to it. Permissionless and idempotent; the grant's wrapped vault key is sealed to this card.",
      inputSchema: RegisterCardInputSchema.shape,
    },
    async () => {
      try {
        if (!deps.buyer)
          throw new Error("no buyer keys configured (BUYER_PRIVATE_KEY, GRANTEE_SEED_HEX)");
        const buyer = await deps.buyer();
        const sent = await buyer.registerCard();
        return text({
          cardId: buyer.cardId,
          owner: buyer.owner,
          encryptionPubKey: buyer.encryptionPubKey,
          txHash: sent.txHash,
        });
      } catch (error) {
        deps.logger.warn("registerCard failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_accept_terms",
    {
      title: "Accept a principal's terms",
      description:
        "Buyer side: sign and register acceptance of the price and licence for a namespace. Relayable — the signature authorises it, not the sender. Returns the termsHash the principal needs to grant.",
      inputSchema: AcceptTermsInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.buyer)
          throw new Error("no buyer keys configured (BUYER_PRIVATE_KEY, GRANTEE_SEED_HEX)");
        const buyer = await deps.buyer();
        const terms: Terms = {
          price: BigInt(input.priceUnits),
          licenseId: LICENSE_FH_1_0,
          scope: Scope.TRAIN | Scope.INFER | Scope.EVAL,
          ns: input.ns,
          rateLimit: input.rateLimit,
          payees: [input.payee as Address],
          weights: [WAD],
        };
        const accept = buyer.acceptTerms(input.principalId as Bytes32, terms);
        const sent = await accept.send();
        return text({
          termsHash: accept.plan.termsHash,
          cardId: buyer.cardId,
          granteeEncryptionPubKey: buyer.encryptionPubKey,
          txHash: sent.txHash,
        });
      } catch (error) {
        deps.logger.warn("acceptTerms failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_request_access",
    {
      title: "Ask a human for access to a passport",
      description:
        "Buyer side, the whole handshake: reads the passport's public sidecar from the gateway (principal, namespace, price), registers this agent's card and accepts those exact terms on chain (relayed — no gas needed), and returns the link the human opens in the capture app to approve with a passkey. The grant id is deterministic, so poll firsthand_query with it once approved.",
      inputSchema: RequestAccessInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.buyer)
          throw new Error("no buyer keys configured (BUYER_PRIVATE_KEY, GRANTEE_SEED_HEX)");
        if (!deps.gatewayUrl) throw new Error("GATEWAY_URL is required to read the sidecar");
        const res = await fetch(`${deps.gatewayUrl}/v1/passports/${input.passportId}`);
        if (res.status === 404) throw new Error(`the gateway does not host ${input.passportId}`);
        if (!res.ok) throw new Error(`gateway answered ${res.status}`);
        const sidecar = parseSidecar(await res.json());
        const buyer = await deps.buyer();
        const card = await buyer.registerCard();
        await deps.waitForTx?.(card.txHash);
        const accept = buyer.acceptTerms(sidecar.principalId, sidecar.terms);
        const accepted = await accept.send();
        await deps.waitForTx?.(accepted.txHash);
        const q = new URLSearchParams({
          grant: buyer.cardId,
          pub: buyer.encryptionPubKey,
          ns: String(sidecar.ns),
          from: input.label,
        });
        return text({
          principalId: sidecar.principalId,
          ns: sidecar.ns,
          terms: {
            priceUnits: sidecar.terms.price.toString(),
            scope: sidecar.terms.scope,
            rateLimit: sidecar.terms.rateLimit,
            payees: sidecar.terms.payees,
          },
          termsHash: accept.plan.termsHash,
          cardId: buyer.cardId,
          approvalLink: `${input.appUrl.replace(/\/+$/, "")}/?${q.toString()}`,
          registerCardTx: card.txHash,
          acceptTermsTx: accepted.txHash,
          next: "Send approvalLink to the human. Once they approve, firsthand_query works with the grantId of the epoch they granted in (the Locker shows it); the wrap is published by the app.",
        });
      } catch (error) {
        deps.logger.warn("requestAccess failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_export_manifest",
    {
      title: "Export the buyer's Lineage Manifest",
      description:
        "Buyer side: query the listed passports under a grant (paying per query) and assemble the compliance file — one asset per passport with its origin signature, Merkle proof, anchor and receipt — verified against the chain before it is returned.",
      inputSchema: ExportManifestInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.buyer)
          throw new Error("no buyer keys configured (BUYER_PRIVATE_KEY, GRANTEE_SEED_HEX)");
        if (!deps.anchors || !deps.publicClient)
          throw new Error(
            "manifest verification needs a chain reader (RPC_URL + DEPLOYMENTS_FILE)",
          );
        const buyer = await deps.buyer();
        const results: QueryResult[] = [];
        for (const id of input.passportIds) {
          const { result } = await buyer.queryAndOpen(
            {
              gatewayUrl: input.gatewayUrl,
              grantId: input.grantId as Bytes32,
              passportId: id as Bytes32,
            },
            deps.passportDomain,
          );
          results.push(result);
        }
        const manifest = await manifestFromQueries({
          domain: deps.passportDomain,
          results,
          anchors: deps.anchors,
          payer: buyer.owner,
          finalityDepth: 0,
        });
        const headBlock = await deps.publicClient.getBlockNumber({ cacheTime: 0 });
        const verdict = await verifyManifest(manifest, { anchors: deps.anchors, headBlock });
        return text({
          verifies: verdict.ok,
          assets: verdict.assets,
          hashesPerAsset: verdict.hashesPerAsset,
          paid: results.map((r) => ({
            passportId: r.passportId,
            receiptId: r.receipt.receiptId,
            txHash: r.receipt.txHash,
          })),
          manifest: JSON.parse(serialiseManifest(manifest)),
        });
      } catch (error) {
        deps.logger.warn("exportManifest failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_import",
    {
      title: "Import a ChatGPT or Claude export",
      description:
        "Mint one passport per conversation from a memory export, sealed client-side and tagged with AttestationClass.IMPORT plus the source, so buyers can filter imported data from device-captured data. Anchors and publishes like any other deposit when a deployment and gateway are configured.",
      inputSchema: ImportInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const contents = await readFile(input.path, "utf8");
        const terms: Terms = {
          price: BigInt(input.priceUnits),
          licenseId: LICENSE_FH_1_0,
          scope: Scope.TRAIN | Scope.INFER | Scope.EVAL,
          ns: input.ns,
          rateLimit: 100,
          payees: [input.payee as Address],
          weights: [WAD],
        };
        const minted: { passportId: string; title: string | null; messages: number }[] = [];
        const refused: { title: string | null; reason: string }[] = [];
        for (const item of parseExport(input.source, contents)) {
          if (minted.length >= input.limit) break;
          try {
            const result = await session.deposit({
              ns: input.ns,
              datum: item.datum,
              terms,
              attestation: item.attestation,
            });
            minted.push({
              passportId: result.passportId,
              title: item.conversation.title ?? null,
              messages: item.conversation.messages.length,
            });
          } catch (error) {
            // One unprovable or duplicate conversation must not abandon the rest of the import.
            refused.push({
              title: item.conversation.title ?? null,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const wantsPublish = input.publish && deps.canAnchor && deps.gatewayUrl !== undefined;
        if (wantsPublish && minted.length > 0) await session.flush();
        return text({
          source: input.source,
          minted: minted.length,
          refused: refused.length,
          passports: minted,
          ...(refused.length > 0 ? { refusals: refused } : {}),
          ...(input.publish && !wantsPublish
            ? { warning: "not anchored: configure DEPLOYMENTS_FILE and GATEWAY_URL" }
            : {}),
        });
      } catch (error) {
        deps.logger.warn("import failed", { error });
        return failure(error);
      }
    },
  );

  return server;
}
