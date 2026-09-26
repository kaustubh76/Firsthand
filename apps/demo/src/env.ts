import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { anvil, monadTestnet } from "@firsthand/adapters";
import type { Chain } from "viem";

/**
 * Two ways to run the demo:
 *
 *  --local    spawn anvil, deploy, use its published keys. No accounts, no faucet, no .env — the
 *             path a stranger takes, and the one the Phase 5 gate is timed against.
 *  --testnet  the deployed contracts on Monad testnet, using .env. Needs a funded relayer.
 */
export interface GatewayHandle {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

export interface DemoEnv {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly relayerKey: `0x${string}`;
  readonly buyerKey: `0x${string}`;
  readonly deploymentsFile: string;
  readonly cleanup?: () => Promise<void>;
}

export const anvilDefaults = {
  // Published anvil keys. Safe precisely because they are public: a local chain with fake money.
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  buyer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  rpcUrl: "http://127.0.0.1:8545",
} as const;

export const repoRoot = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = join(dir, "..");
  }
  return process.cwd();
};

/**
 * Starts the gateway as a real process on a free port and waits for /healthz. The demo talks to it
 * over HTTP like any buyer would — which also proves the service boots, not just that its route
 * handlers work in-process (the phase gates only ever exercised the handlers).
 */
export async function startGateway(
  env: DemoEnv,
  root: string,
  chainId: number,
): Promise<GatewayHandle> {
  const port = 8402 + Math.floor(Math.random() * 400);
  const url = `http://127.0.0.1:${port}`;
  const entry = join(root, "apps", "gateway", "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(`the gateway is not built (${entry}) — run \`pnpm build\` first`);
  }
  const proc = spawn(process.execPath, [entry], {
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      // Must match the deployment file, or the gateway refuses to boot (and should).
      CHAIN_ID: String(chainId),
      LOG_LEVEL: "silent",
      DEPLOYMENTS_FILE: env.deploymentsFile,
      MONAD_RPC_URL: env.rpcUrl,
      SETTLEMENT_MODE: "onchain",
      // Real payment verification, not the double: Monad's facilitator where it knows the chain,
      // FIRSTHAND's own verifier on a local one (ADR-0014).
      X402_MODE: chainId === 10143 ? "monad" : "local",
      X402_NETWORK: `eip155:${chainId}`,
      RELAYER_PRIVATE_KEY: env.relayerKey,
      // Keyless browsers (the capture PWA's e2e rides this helper) write through the relay; both
      // chains the demo knows carry the MockUSDC faucet double, so its mint relays too.
      RELAY_ENABLED: "true",
      RELAY_FAUCET_MINT: "true",
      // Where the chain has ERC-8004 registries (testnet), paid queries by carded buyers feed
      // their reputation — the browser tier asserts it.
      ERC8004_FEEDBACK: "true",
      RATE_LIMIT_CAPACITY: "1000",
      PUBLIC_URL: url,
    },
  });
  const stop = async () => {
    proc.kill();
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return { url, stop };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  await stop();
  throw new Error("the gateway did not become healthy within 20s");
}

export async function resolveEnv(
  argv: readonly string[],
  /** Defaulted so tests can pass a literal instead of mutating the process — as `loadConfig` does. */
  source: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DemoEnv> {
  const root = repoRoot();
  const testnet = argv.includes("--testnet");
  if (!testnet) return localEnv(root);

  const rpcUrl = source["MONAD_RPC_URL"] ?? "https://testnet-rpc.monad.xyz";
  const relayerKey = source["RELAYER_PRIVATE_KEY"] as `0x${string}` | undefined;
  const buyerKey = source["BUYER_PRIVATE_KEY"] as `0x${string}` | undefined;
  if (!relayerKey || !buyerKey) {
    throw new Error(
      "--testnet needs RELAYER_PRIVATE_KEY and BUYER_PRIVATE_KEY in .env (see QUICKSTART.md). " +
        "Run without --testnet to use a local chain instead — no keys required.",
    );
  }
  const deploymentsFile = join(root, "deployments", "10143.json");
  if (!existsSync(deploymentsFile)) throw new Error(`no deployment at ${deploymentsFile}`);
  return { rpcUrl, chain: monadTestnet, relayerKey, buyerKey, deploymentsFile };
}

async function localEnv(root: string): Promise<DemoEnv> {
  const deploymentsFile = join(root, "deployments", "31337.json");
  const running = await isUp(anvilDefaults.rpcUrl);
  const cleanups: (() => Promise<void>)[] = [];

  if (!running) {
    console.log("   starting anvil…");
    // Enrolment verifies a P-256 signature through the RIP-7212 precompile. Older anvil exposes it
    // behind `--odyssey`; newer builds removed the flag and ship it by default. Detect, don't guess.
    const args = (await supportsOdyssey()) ? ["--odyssey", "--silent"] : ["--silent"];
    const proc = spawn("anvil", args, { stdio: "ignore", detached: false });
    cleanups.push(async () => {
      proc.kill();
    });
    const ok = await waitUp(anvilDefaults.rpcUrl, 15_000);
    if (!ok) {
      proc.kill();
      throw new Error("anvil did not start — is Foundry installed? (https://getfoundry.sh)");
    }
  }

  if (!existsSync(deploymentsFile) || !(await codeAt(deploymentsFile))) {
    console.log("   deploying contracts to the local chain…");
    const started = Date.now();
    await run(
      "forge",
      ["script", "script/Deploy.s.sol", "--rpc-url", anvilDefaults.rpcUrl, "--broadcast"],
      {
        cwd: join(root, "contracts"),
        env: {
          ...process.env,
          DEPLOYER_PRIVATE_KEY: anvilDefaults.deployer,
          DEPLOY_MOCK_USDC: "true",
        },
      },
      // forge occasionally finishes the broadcast and never exits (seen 2026-09-18 on 1.1.0-dev);
      // the deployment file it writes is the real signal that the chain is ready.
      async () => {
        try {
          const { statSync } = await import("node:fs");
          return statSync(deploymentsFile).mtimeMs > started && (await codeAt(deploymentsFile));
        } catch {
          return false;
        }
      },
    );
  }

  return {
    rpcUrl: anvilDefaults.rpcUrl,
    chain: anvil,
    relayerKey: anvilDefaults.relayer,
    buyerKey: anvilDefaults.buyer,
    deploymentsFile,
    cleanup: async () => {
      for (const c of cleanups) await c();
    },
  };
}

/** True when the recorded deployment still has code — a restarted anvil forgets everything. */
/** The contracts the demo path touches; the lens is recorded but not deployed on a local chain. */
export const REQUIRED_CONTRACTS = [
  "PrincipalRegistry",
  "PassportAnchors",
  "GrantManager",
  "Rescissions",
  "ReceiptLedger",
  "RoyaltyRouter",
  "USDC",
] as const;

/**
 * True once every contract the demo needs has code. Checking the registry alone is not enough:
 * forge writes the file while the last broadcast (MockUSDC, deployed after the registry) can still
 * be in flight, and a gateway started in that gap publishes an asset the chain does not have yet —
 * the buyer's first balanceOf then fails with "returned no data".
 */
export async function codeAt(
  deploymentsFile: string,
  rpcUrl: string = anvilDefaults.rpcUrl,
): Promise<boolean> {
  try {
    const { readFileSync } = await import("node:fs");
    const d = JSON.parse(readFileSync(deploymentsFile, "utf8")) as Record<string, unknown>;
    const addresses = REQUIRED_CONTRACTS.map((k) => d[k]).filter(
      (v): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v),
    );
    // Every one, not merely one: the filter drops absent keys, so `length === 0` would have let a
    // file naming only PrincipalRegistry through — the exact "registry alone is not enough" case
    // the comment above says this exists to prevent.
    if (addresses.length !== REQUIRED_CONTRACTS.length) return false;
    const codes = await Promise.all(
      addresses.map(async (address) => {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getCode",
            params: [address, "latest"],
          }),
        });
        const body = (await res.json()) as { result?: string };
        return (body.result ?? "0x").length > 4;
      }),
    );
    return codes.every(Boolean);
  } catch {
    return false;
  }
}

async function supportsOdyssey(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("anvil", ["--help"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(out.includes("--odyssey")));
  });
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Runs a command to completion — or, when `doneWhen` is given, until that predicate holds, after
 * which the process is killed and treated as finished (for tools that do their work and then hang).
 */
function run(
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  doneWhen?: () => Promise<boolean>,
) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, [...args], { ...opts, stdio: "ignore" });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      error ? reject(error) : resolve();
    };
    const timer = doneWhen
      ? setInterval(async () => {
          if (await doneWhen()) {
            p.kill();
            finish();
          }
        }, 1000)
      : null;
    p.on("error", (e) =>
      finish(new Error(`${cmd} failed to start (${e.message}) — is Foundry installed?`)),
    );
    p.on("exit", (code) =>
      code === 0 || settled ? finish() : finish(new Error(`${cmd} exited ${code}`)),
    );
  });
}
