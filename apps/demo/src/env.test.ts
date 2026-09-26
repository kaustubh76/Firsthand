import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anvilDefaults,
  codeAt,
  REQUIRED_CONTRACTS,
  repoRoot,
  resolveEnv,
  startGateway,
} from "./env.js";

/**
 * `env.ts` is the bootstrap `pnpm demo` and the browser tier both stand on — it spawns anvil, runs
 * the deploy, detects `--odyssey` and starts the gateway — and it had no executed coverage at all,
 * because `apps/demo` declared no `coverage` script so turbo skipped the package.
 *
 * What is covered here is everything reachable without a chain, Foundry or a spawned process. The
 * spawning half is exercised for real by `pnpm demo` and the browser tier; this pins the decisions
 * those two cannot make visible — the refusals, the defaults, and the readiness rule.
 */
const KEY = `0x${"11".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anvilDefaults", () => {
  it("are three well-formed keys and the local endpoint", () => {
    // Published anvil keys, so a paste error is the only way they can be wrong — which is exactly
    // the kind of thing no other test would notice.
    for (const k of [anvilDefaults.deployer, anvilDefaults.relayer, anvilDefaults.buyer]) {
      expect(k).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(anvilDefaults.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(new Set([anvilDefaults.deployer, anvilDefaults.relayer, anvilDefaults.buyer]).size).toBe(
      3,
    );
  });
});

describe("repoRoot", () => {
  it("finds the workspace root from anywhere under it", () => {
    expect(existsSync(join(repoRoot(), "pnpm-workspace.yaml"))).toBe(true);
  });
});

describe("resolveEnv --testnet", () => {
  it("refuses without keys, and names both of them and the way out", async () => {
    // The first thing a newcomer hits if they type the testnet flag with an empty .env. It must say
    // which variables and that there is a keyless path, not just fail.
    await expect(resolveEnv(["--testnet"], {})).rejects.toThrow(/RELAYER_PRIVATE_KEY/);
    await expect(resolveEnv(["--testnet"], {})).rejects.toThrow(/BUYER_PRIVATE_KEY/);
    await expect(resolveEnv(["--testnet"], {})).rejects.toThrow(/without --testnet/);
  });

  it("defaults the RPC and points at the committed deployment", async () => {
    const env = await resolveEnv(["--testnet"], {
      RELAYER_PRIVATE_KEY: KEY,
      BUYER_PRIVATE_KEY: KEY,
    });
    expect(env.rpcUrl).toBe("https://testnet-rpc.monad.xyz");
    expect(env.chain.id).toBe(10143);
    expect(env.deploymentsFile).toBe(join(repoRoot(), "deployments", "10143.json"));
    expect(existsSync(env.deploymentsFile)).toBe(true);
  });

  it("takes an explicit RPC over the default", async () => {
    const env = await resolveEnv(["--testnet"], {
      MONAD_RPC_URL: "https://rpc.example",
      RELAYER_PRIVATE_KEY: KEY,
      BUYER_PRIVATE_KEY: KEY,
    });
    expect(env.rpcUrl).toBe("https://rpc.example");
  });
});

describe("startGateway", () => {
  it("says the gateway is not built rather than spawning nothing", async () => {
    // The guard runs before spawn, so this creates no process. Without it the failure would be a
    // 20 s wait on /healthz for a gateway that was never going to answer.
    const env = { rpcUrl: "", chain: {}, relayerKey: KEY, buyerKey: KEY, deploymentsFile: "" };
    await expect(
      startGateway(env as unknown as Parameters<typeof startGateway>[0], "/nowhere", 31337),
    ).rejects.toThrow(/not built/);
  });
});

describe("codeAt", () => {
  const file = join(repoRoot(), "deployments", "10143.json");
  const reply = (result: string) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ result })));

  it("is false when the chain has forgotten the deployment", async () => {
    reply("0x"); // a restarted anvil: addresses recorded, no code behind them
    await expect(codeAt(file, "http://rpc.test")).resolves.toBe(false);
  });

  it("is true once every recorded contract has code", async () => {
    reply("0x60806040");
    await expect(codeAt(file, "http://rpc.test")).resolves.toBe(true);
  });

  it("refuses a deployment that names only some of the contracts", async () => {
    // The race its docstring describes: forge writes the file while the last broadcast is still in
    // flight. The filter drops absent keys, so requiring merely one address to survive would let a
    // registry-only file through — "checking the registry alone is not enough", as the comment says.
    reply("0x60806040");
    const partial = join(repoRoot(), "apps", "demo", "src", "__partial.json");
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(partial, JSON.stringify({ PrincipalRegistry: `0x${"ab".repeat(20)}` }));
    try {
      await expect(codeAt(partial, "http://rpc.test")).resolves.toBe(false);
    } finally {
      rmSync(partial, { force: true });
    }
    expect(REQUIRED_CONTRACTS.length).toBeGreaterThan(1);
  });

  it("is false rather than throwing when the file is missing or the RPC is down", async () => {
    reply("0x60806040");
    await expect(codeAt("/nowhere/31337.json", "http://rpc.test")).resolves.toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(codeAt(file, "http://rpc.test")).resolves.toBe(false);
  });
});
