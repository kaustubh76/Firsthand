import { readFile, writeFile } from "node:fs/promises";
import {
  type AnchorWriter,
  buildAgentURI,
  cardMetadata,
  type Erc8004Registry,
  type Erc8004Writer,
  type TxTransport,
} from "@firsthand/adapters";
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
  exportLocker,
  importLocker,
  type LockerSession,
  manifestFromQueries,
  type QueryResult,
  serialiseBundle,
  serialiseManifest,
  verifyManifest,
} from "@firsthand/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encodeFunctionData, type PublicClient, parseAbi } from "viem";
import {
  AcceptTermsInputSchema,
  AgentReputationInputSchema,
  AttestInputSchema,
  DepositInputSchema,
  EnrollInputSchema,
  ExportLockerInputSchema,
  ExportManifestInputSchema,
  GrantInputSchema,
  ImportInputSchema,
  ImportLockerInputSchema,
  ListPassportsInputSchema,
  QueryInputSchema,
  RegisterAgentInputSchema,
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
  /** The transport every relayed call rides; the faucet mint goes through it when the gateway allows. */
  readonly transport?: TxTransport;
  /** ERC-8004: the reference registries on this chain (reads; writes when the buyer wallet is set). */
  readonly erc8004?: Erc8004Registry & Erc8004Writer;
  /** A wallet on the buyer key, for the one transaction that cannot be relayed: agent registration. */
  readonly buyerRegistry?: () => Erc8004Registry & Erc8004Writer;
  readonly agentId?: bigint;
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

const usdcAbi = parseAbi([
  "function mint(address to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);

/**
 * A buyer that cannot pay is not a buyer. On chains where the USDC is the MockUSDC faucet double
 * the gateway relays exactly `mint` (selector-scoped, published in discovery), so the agent funds
 * itself with a hundred queries' worth; anywhere else this says why it did not.
 */
async function fundBuyer(
  deps: McpDeps,
  owner: Address,
  price: bigint,
): Promise<{ funded: boolean; txHash?: Bytes32; balanceUnits?: string; reason?: string }> {
  if (!deps.gatewayUrl || !deps.publicClient || !deps.transport) {
    return { funded: false, reason: "no gateway/reader/transport to fund through" };
  }
  try {
    const disco = (await (await fetch(`${deps.gatewayUrl}/.well-known/firsthand.json`)).json()) as {
      x402?: { asset?: string };
      relay?: { allow?: string[] };
    };
    const usdc = disco.x402?.asset?.toLowerCase() as Address | undefined;
    if (!usdc) return { funded: false, reason: "discovery names no payment asset" };
    const balance = (await deps.publicClient.readContract({
      address: usdc,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    if (balance >= price * 10n)
      return { funded: false, balanceUnits: balance.toString(), reason: "already funded" };
    if (!(disco.relay?.allow ?? []).includes(`${usdc}:0x40c10f19`)) {
      return {
        funded: false,
        balanceUnits: balance.toString(),
        reason: "this gateway does not relay the faucet mint (not a MockUSDC deployment)",
      };
    }
    const ref = await deps.transport.send({
      to: usdc,
      data: encodeFunctionData({ abi: usdcAbi, functionName: "mint", args: [owner, price * 100n] }),
    });
    await deps.waitForTx?.(ref.hash as Bytes32);
    return {
      funded: true,
      txHash: ref.hash as Bytes32,
      balanceUnits: (balance + price * 100n).toString(),
    };
  } catch (error) {
    return { funded: false, reason: (error as Error).message };
  }
}

interface ListedPassport {
  passportId: Bytes32;
  ns: number;
  epoch: string;
  batchRoot: Bytes32;
  termsHash: Bytes32;
  price: string;
  /** Attestation class (0 unattested · 1 import · 2 device_capture), null on older sidecars. */
  class: number | null;
  capturedAt: string | null;
  sourceTag: Bytes32 | null;
}

/** README §7.3's staleness signal per namespace — a market input, not a protocol rule. */
interface Freshness {
  lastAnchoredAt: string | null;
  halfLifeSeconds: string;
  staleness: number;
}

const CLASS_NAMES = ["unattested", "import", "device_capture"] as const;

/** Supply, discoverable: what a principal has published on this gateway. */
async function listPassports(
  gatewayUrl: string,
  principalId: string,
  ns: number | undefined,
  limit: number,
  klass?: number,
): Promise<{ passports: ListedPassport[]; freshness: Record<string, Freshness> }> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (ns !== undefined) q.set("ns", String(ns));
  if (klass !== undefined) q.set("class", String(klass));
  const res = await fetch(`${gatewayUrl}/v1/principals/${principalId}/passports?${q.toString()}`);
  if (!res.ok) throw new Error(`gateway answered ${res.status} listing ${principalId}`);
  const body = (await res.json()) as {
    passports: ListedPassport[];
    freshness?: Record<string, Freshness>;
  };
  return { passports: body.passports, freshness: body.freshness ?? {} };
}

const agentOf = (deps: McpDeps, raw: string | undefined): bigint | undefined =>
  raw !== undefined ? BigInt(raw) : deps.agentId;

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
        const agent = agentOf(deps, input.agentId);
        const { result, plaintext } = await buyer.queryAndOpen(
          {
            gatewayUrl: input.gatewayUrl,
            grantId: input.grantId as Bytes32,
            passportId: input.passportId as Bytes32,
            ...(agent === undefined ? {} : { agentId: agent }),
          },
          deps.passportDomain,
        );
        return text({
          passportId: result.passportId,
          ...(agent === undefined ? {} : { agentId: agent.toString() }),
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
    "firsthand_export_locker",
    {
      title: "Take a locker with you (exit)",
      description:
        "README §4 'exit = keys + blobs walk away': reads everything a gateway holds for a principal — ciphertext, sidecars and grant wraps, all public and content-addressed, never plaintext or a key — into one bundle file that firsthand_import_locker (or the capture app) re-publishes on any conformant gateway. The chain is the source of truth; a gateway is a cache you can leave.",
      inputSchema: ExportLockerInputSchema.shape,
    },
    async (input) => {
      try {
        const gatewayUrl = input.gatewayUrl ?? deps.gatewayUrl;
        if (!gatewayUrl) throw new Error("GATEWAY_URL (or gatewayUrl) is required");
        const principalId =
          (input.principalId as Bytes32 | undefined) ?? (await deps.session()).locker.principalId;
        const bundle = await exportLocker({
          gatewayUrl,
          principalId,
          chainId: deps.passportDomain.chainId,
          grantIds: input.grantIds as Bytes32[],
        });
        await writeFile(input.path, serialiseBundle(bundle), "utf8");
        return text({
          path: input.path,
          principalId,
          passports: bundle.passports.length,
          wraps: bundle.wraps.length,
          gateway: bundle.gateway,
          contains: "ciphertext + sidecars + grant wraps — no plaintext, no key",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_import_locker",
    {
      title: "Re-publish a locker bundle on a gateway",
      description:
        "The other half of exit: re-publishes a bundle from firsthand_export_locker through the gateway's verified ingest. Every sidecar is checked against the chain (signature, anchored root, owner, inclusion) and every wrap against its grant's on-chain reference; what the gateway cannot verify is reported as skipped, never forced.",
      inputSchema: ImportLockerInputSchema.shape,
    },
    async (input) => {
      try {
        const gatewayUrl = input.gatewayUrl ?? deps.gatewayUrl;
        if (!gatewayUrl) throw new Error("GATEWAY_URL (or gatewayUrl) is required");
        const report = await importLocker({
          gatewayUrl,
          bundle: await readFile(input.path, "utf8"),
        });
        return text({ gateway: gatewayUrl, ...report });
      } catch (error) {
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
      description:
        "Principal id, namespaces, pending and anchored batches — and, when this server runs on a deposit delegation from the app, its scope (namespace, epoch, expiry).",
      inputSchema: StatusInputSchema.shape,
    },
    async () => {
      try {
        const session = await deps.session();
        const delegated = session.locker.delegated;
        return text({
          locker: session.locker.toJSON(),
          session: delegated
            ? {
                kind: "delegated",
                scope: delegated.describe(),
                ns: delegated.ns,
                epoch: delegated.epoch,
                expiresAt: delegated.expiresAt,
                can: ["deposit", "import", "export_locker"],
                cannot:
                  "enroll · attest · grant · rescind (the passkey keeps those — open the app)",
              }
            : { kind: "full" },
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
    "firsthand_register_agent",
    {
      title: "Register this buyer as an ERC-8004 agent",
      description:
        "One transaction from the buyer's own key (the identity registry is msg.sender-authorised, so it cannot be relayed — the key needs a little MON). Mints the agent NFT with a data: registration file and binds this buyer's FIRSTHAND card in metadata, so a human can verify who is asking and the gateway can credit paid queries to the agent's reputation. Put the returned agentId in BUYER_AGENT_ID.",
      inputSchema: RegisterAgentInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.buyer)
          throw new Error("no buyer keys configured (BUYER_PRIVATE_KEY, GRANTEE_SEED_HEX)");
        if (!deps.buyerRegistry) {
          throw new Error(
            "registration needs RPC_URL and a chain with ERC-8004 registries (Monad testnet/mainnet)",
          );
        }
        if (deps.agentId !== undefined) {
          return text({ agentId: deps.agentId.toString(), note: "BUYER_AGENT_ID is already set" });
        }
        const buyer = await deps.buyer();
        const card = await buyer.registerCard();
        await deps.waitForTx?.(card.txHash);
        const { agentId, txHash } = await deps.buyerRegistry().registerAgent({
          agentURI: buildAgentURI({
            name: input.name,
            description: input.description,
            owner: buyer.owner,
            cardId: buyer.cardId,
            encryptionPubKey: buyer.encryptionPubKey,
            ...(deps.gatewayUrl ? { gatewayUrl: deps.gatewayUrl } : {}),
          }),
          metadata: [cardMetadata(buyer.cardId)],
        });
        return text({
          agentId: agentId.toString(),
          cardId: buyer.cardId,
          owner: buyer.owner,
          txHash,
          next: `Set BUYER_AGENT_ID=${agentId} so request_access links and queries carry it.`,
        });
      } catch (error) {
        deps.logger.warn("registerAgent failed", { error });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_agent_reputation",
    {
      title: "Read an agent's FIRSTHAND reputation",
      description:
        "What the gateway has said about an ERC-8004 agent: paid queries it credited (firsthand/paid-query feedback from the gateway's relayer), all FIRSTHAND feedback, the bound card and owner.",
      inputSchema: AgentReputationInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.gatewayUrl) throw new Error("GATEWAY_URL is required");
        const agent = agentOf(deps, input.agentId);
        if (agent === undefined) throw new Error("give an agentId or set BUYER_AGENT_ID");
        const res = await fetch(`${deps.gatewayUrl}/v1/agents/${agent}`);
        if (!res.ok) throw new Error(`gateway answered ${res.status} for agent ${agent}`);
        return text(await res.json());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "firsthand_list_passports",
    {
      title: "List what a principal has published",
      description:
        "Buyer side: given a principal id (from a shared locker link), list the passports the gateway hosts for it — namespace, epoch, price per query, terms hash, attestation class (unattested / import / device_capture; filter with `class`) — plus each namespace's freshness (staleness since its last anchored deposit, README §7.3) so the agent can choose what to ask access to and price continuing access.",
      inputSchema: ListPassportsInputSchema.shape,
    },
    async (input) => {
      try {
        if (!deps.gatewayUrl) throw new Error("GATEWAY_URL is required");
        const klass = input.class === undefined ? undefined : CLASS_NAMES.indexOf(input.class);
        const { passports, freshness } = await listPassports(
          deps.gatewayUrl,
          input.principalId,
          input.ns,
          input.limit,
          klass,
        );
        return text({
          principalId: input.principalId,
          count: passports.length,
          passports: passports.map((p) => ({
            ...p,
            className: p.class === null ? null : (CLASS_NAMES[p.class] ?? null),
          })),
          freshness,
          note: "staleness = 1 − 2^(−t/τ) since the namespace's newest anchor; an off-chain market signal, not a protocol rule",
        });
      } catch (error) {
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
        let passportId = input.passportId;
        if (!passportId) {
          // A locker link names a principal, not a passport: take the newest one they published.
          if (!input.principalId) throw new Error("give a passportId or a principalId");
          const { passports: listed } = await listPassports(
            deps.gatewayUrl,
            input.principalId,
            input.ns,
            1,
          );
          passportId = listed[0]?.passportId;
          if (!passportId)
            throw new Error(
              `principal ${input.principalId} has published nothing the gateway hosts`,
            );
        }
        const res = await fetch(`${deps.gatewayUrl}/v1/passports/${passportId}`);
        if (res.status === 404) throw new Error(`the gateway does not host ${passportId}`);
        if (!res.ok) throw new Error(`gateway answered ${res.status}`);
        const sidecar = parseSidecar(await res.json());
        const buyer = await deps.buyer();
        const card = await buyer.registerCard();
        await deps.waitForTx?.(card.txHash);
        const accept = buyer.acceptTerms(sidecar.principalId, sidecar.terms);
        const accepted = await accept.send();
        await deps.waitForTx?.(accepted.txHash);
        const funding = await fundBuyer(deps, buyer.owner, sidecar.terms.price);
        const agent = agentOf(deps, input.agentId);
        const q = new URLSearchParams({
          grant: buyer.cardId,
          pub: buyer.encryptionPubKey,
          ns: String(sidecar.ns),
          from: input.label,
        });
        if (agent !== undefined) q.set("agent", agent.toString());
        return text({
          passportId,
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
          funding,
          ...(agent === undefined
            ? {
                erc8004:
                  "not carded — firsthand_register_agent gives this buyer an identity the human can verify",
              }
            : { agentId: agent.toString() }),
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
        const agent = agentOf(deps, input.agentId);
        for (const id of input.passportIds) {
          const { result } = await buyer.queryAndOpen(
            {
              gatewayUrl: input.gatewayUrl,
              grantId: input.grantId as Bytes32,
              passportId: id as Bytes32,
              ...(agent === undefined ? {} : { agentId: agent }),
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
