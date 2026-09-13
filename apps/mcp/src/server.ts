import {
  type Address,
  AttestationClass,
  type Bytes32,
  isFirsthandError,
  LICENSE_FH_1_0,
  Scope,
  tag,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";
import type { LockerSession } from "@firsthand/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttestInputSchema,
  DepositInputSchema,
  EnrollInputSchema,
  QueryInputSchema,
  RescindInputSchema,
  StatusInputSchema,
} from "./tools/schemas.js";

export interface McpDeps {
  /** Opened lazily on first tool call so a stdio client can list tools without a PRF. */
  readonly session: () => Promise<LockerSession>;
  readonly logger: Logger;
  /** Whether the configured transport actually reaches a chain (relayer key present). */
  readonly canBroadcast: boolean;
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
        const result = await session.deposit({
          ns: input.ns,
          datum: { kind: "bytes", bytes: new TextEncoder().encode(input.text) },
          terms: {
            price: BigInt(input.priceUnits),
            licenseId: LICENSE_FH_1_0,
            scope: Scope.TRAIN | Scope.INFER | Scope.EVAL,
            ns: input.ns,
            rateLimit: 100,
            payees: [input.payee as Address],
            weights: [WAD],
          },
          attestation: {
            class: CLASS[input.attestationClass],
            capturedAt: BigInt(Math.floor(Date.now() / 1000)),
            sourceTag: input.sourceTag ? tag(input.sourceTag) : ZERO_HASH,
            deviceClass: ZERO_HASH,
            metaHash: ZERO_HASH,
          },
        });
        return text({
          passportId: result.passportId,
          passport: result.signed.passport,
          blob: result.blob.id,
          anchored: result.anchored?.root ?? null,
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
        "Buyer side: pay per query over x402 and receive data with its passport and Merkle proof. Lands in Phase 3.",
      inputSchema: QueryInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        void session;
        return failure(
          new Error(
            `query not implemented yet (gateway ${input.gatewayUrl}, grant ${input.grantId})`,
          ),
        );
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
        "Withdraw consent. `btx` uses Monad's encrypted mempool so no grantee can race the revocation; `commit-reveal` is the fallback.",
      inputSchema: RescindInputSchema.shape,
    },
    async (input) => {
      try {
        const session = await deps.session();
        const plan =
          input.path === "commit-reveal" ? session.planCommit(input.grantId as Bytes32) : null;
        if (plan === null) {
          return failure(
            new Error(
              "direct rescind needs the P-256 authority signature (Phase 4); use path=commit-reveal to post a commitment now",
            ),
          );
        }
        const sent = await session.sendRescind(plan);
        return text({
          path: plan.path,
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

  return server;
}
