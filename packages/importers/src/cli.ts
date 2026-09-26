#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createChainClients, HttpRelayTransport, MemoryBlobStore } from "@firsthand/adapters";
import { type Address, contentHash, LICENSE_FH_1_0, Scope, type Terms, WAD } from "@firsthand/core";
import { FirsthandClient } from "@firsthand/sdk";
import { clientOptionsFromDeployment, loadDeployment } from "@firsthand/sdk/deployment";
import { parseExport } from "./index.js";

/**
 * firsthand-import <chatgpt|claude> <conversations.json> [--deposit] [--ns 0] [--price 1000] [--limit n]
 *
 * Without `--deposit` it is a dry run: one JSON line per conversation — id, title, message count,
 * content hash — and no keys are involved.
 *
 * With `--deposit` it mints one passport per conversation into a real locker and publishes them,
 * which is what README §10 and §22 describe an import as. It does that through a **deposit
 * delegation** (`FIRSTHAND_DELEGATION`, the `fhd1.` code the capture app issues) rather than a
 * passkey or a private key: the delegation is scoped to one namespace and one epoch and cannot
 * grant or rescind, so importing a decade of conversation history never needs the authority that
 * ends consent. Gas is the gateway relay's, so the CLI holds no funds either.
 */
interface Flags {
  readonly deposit: boolean;
  readonly ns: number;
  readonly price: string;
  readonly limit: number;
}

function flags(argv: readonly string[]): Flags {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : (argv[i + 1] ?? fallback);
  };
  return {
    deposit: argv.includes("--deposit"),
    ns: Number(value("ns", "0")),
    price: value("price", "1000"),
    limit: Number(value("limit", "1000")),
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for --deposit`);
  return v;
}

/** The locker this CLI is allowed into: one namespace, one epoch, deposits only. */
async function openDelegated(gatewayUrl: string) {
  const deployment = loadDeployment(env("DEPLOYMENTS_FILE"));
  const clients = createChainClients({
    rpcUrl: env("MONAD_RPC_URL"),
    chain: {
      id: deployment.chainId,
      name: `chain-${deployment.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [env("MONAD_RPC_URL")] } },
    },
  });
  const client = new FirsthandClient(
    clientOptionsFromDeployment({
      deployment,
      publicClient: clients.publicClient,
      blobs: new MemoryBlobStore(),
      // No key: anchors ride the gateway's relay, the same path the capture app uses.
      transport: new HttpRelayTransport({ baseUrl: gatewayUrl }),
    }),
  );
  return client.openDelegated(env("FIRSTHAND_DELEGATION"));
}

async function main(argv: string[]): Promise<number> {
  const [source, file] = argv;
  const f = flags(argv);
  if ((source !== "chatgpt" && source !== "claude") || !file) {
    console.error(
      "usage: firsthand-import <chatgpt|claude> <conversations.json> [--deposit] [--ns 0] [--price 1000] [--limit n]\n" +
        "  --deposit needs FIRSTHAND_DELEGATION, GATEWAY_URL, DEPLOYMENTS_FILE and MONAD_RPC_URL",
    );
    return 2;
  }
  const items = [...parseExport(source, readFileSync(file, "utf8"))].slice(0, f.limit);

  if (!f.deposit) {
    for (const item of items) {
      console.log(
        JSON.stringify({
          id: item.conversation.id,
          title: item.conversation.title,
          messages: item.conversation.messages.length,
          h: contentHash(item.datum),
          attestationClass: item.attestation.class,
        }),
      );
    }
    console.error(`${items.length} conversation(s) — dry run; pass --deposit to mint them`);
    return 0;
  }

  const gatewayUrl = env("GATEWAY_URL");
  const session = await openDelegated(gatewayUrl);
  console.error(
    `locker ${session.locker.principalId} — ${session.locker.delegated?.describe() ?? "delegated"}`,
  );
  const terms: Terms = {
    price: BigInt(f.price),
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN | Scope.INFER | Scope.EVAL,
    ns: f.ns,
    rateLimit: 100,
    payees: [session.locker.principalId.slice(0, 42) as Address],
    weights: [WAD],
  };

  const minted: { passportId: string; title: string | null }[] = [];
  const refused: { title: string | null; reason: string }[] = [];
  const results = [];
  for (const item of items) {
    try {
      const result = await session.deposit({
        ns: f.ns,
        datum: item.datum,
        terms,
        attestation: item.attestation,
      });
      results.push(result);
      minted.push({ passportId: result.passportId, title: item.conversation.title ?? null });
      // One conversation the chain will not vouch for must not abandon the rest of the import.
    } catch (error) {
      refused.push({
        title: item.conversation.title ?? null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Anchor the batch, then hand the gateway the ciphertext and sidecars — an imported passport
  // nobody can fetch is only half an import.
  if (results.length > 0) {
    await session.flush();
    for (const result of results) await session.publish({ gatewayUrl }, result, terms);
  }
  for (const m of minted) console.log(JSON.stringify(m));
  console.error(
    `${minted.length} minted, ${refused.length} refused` +
      (refused.length > 0 ? `: ${refused.map((r) => r.reason).join("; ")}` : ""),
  );
  session.locker.dispose();
  return refused.length > 0 && minted.length === 0 ? 1 : 0;
}

// No top-level await: this bundles to CJS as well as ESM, and rollup will not have it. A missing
// environment variable should also read as one line, not a stack trace.
main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
