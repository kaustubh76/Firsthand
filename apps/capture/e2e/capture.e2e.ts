import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { repoRoot, resolveEnv, startGateway } from "../../demo/src/env.js";

/**
 * The browser proof. Everything below `pnpm check:all` runs in Node; a blank page — an exception
 * before first paint, a wrong asset path, a config fetch that never returns — passes every one of
 * those gates. This serves the COMMITTED deploy tree (deploy/capture, the bytes Vercel ships),
 * boots the real gateway on a real chain, and drives the app with a virtual passkey that speaks
 * PRF, so `registerPasskey → KeyTree → deposit → relay → anchor` runs inside a page.
 *
 *   pnpm --filter firsthand-capture e2e                      local anvil + gateway (≈40 s)
 *   E2E_TESTNET=1 pnpm --filter firsthand-capture e2e        local gateway on Monad testnet (.env keys)
 *   E2E_GATEWAY_URL=https://… pnpm --filter firsthand-capture e2e   a hosted gateway (Monad testnet)
 *   E2E_APP_URL=https://…      test the hosted PWA itself instead of the local tree
 */
const root = repoRoot();
const tree = join(root, "deploy", "capture");
const out = join(root, "apps", "capture", "e2e-out");
mkdirSync(out, { recursive: true });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

function serveTree(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
    let file = join(dir, path || "index.html");
    if (!existsSync(file) || extname(file) === "") file = join(dir, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    // `localhost` is a secure context, which WebAuthn requires; 127.0.0.1 is not always treated as one.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://localhost:${port}`, server });
    });
  });
}

const step = (name: string) => console.log(`\n▸ ${name}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function main() {
  const hostedGateway = process.env["E2E_GATEWAY_URL"];
  const cleanups: (() => Promise<void>)[] = [];
  let gatewayUrl: string;

  step("environment");
  if (hostedGateway) {
    gatewayUrl = hostedGateway.replace(/\/+$/, "");
    ok(`gateway: ${gatewayUrl} (hosted)`);
  } else {
    const testnet = process.env["E2E_TESTNET"] === "1";
    if (testnet) {
      try {
        process.loadEnvFile(join(root, ".env"));
      } catch {
        // no .env: resolveEnv reports which keys are missing
      }
    }
    const env = await resolveEnv(testnet ? ["--testnet"] : []);
    if (env.cleanup) cleanups.push(env.cleanup);
    const d = JSON.parse(readFileSync(env.deploymentsFile, "utf8")) as { chainId: number };
    const gw = await startGateway(env, root, d.chainId);
    cleanups.push(gw.stop);
    gatewayUrl = gw.url;
    ok(`gateway: ${gatewayUrl} (spawned, chain ${d.chainId})`);
  }
  const disco = (await (await fetch(`${gatewayUrl}/.well-known/firsthand.json`)).json()) as {
    relay?: { enabled?: boolean };
    chainId?: string;
  };
  if (disco.relay?.enabled !== true)
    throw new Error("gateway has no relay — the PWA would be offline");
  ok(`discovery: chain ${disco.chainId}, relay enabled`);

  let appUrl = process.env["E2E_APP_URL"];
  if (!appUrl) {
    if (!existsSync(join(tree, "index.html"))) throw new Error(`${tree} is not built`);
    const served = await serveTree(tree);
    cleanups.push(async () => served.server.close());
    appUrl = served.url;
    ok(`app: ${appUrl} (deploy/capture)`);
  } else {
    ok(`app: ${appUrl} (hosted)`);
  }

  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });

  try {
    step("first paint");
    await page.goto(`${appUrl}/?gateway=${encodeURIComponent(gatewayUrl)}`);
    await page.locator("h1").first().waitFor({ timeout: 10_000 });
    ok(`h1: ${await page.locator("h1").first().textContent()}`);
    const status = page.locator(".status");
    await status.filter({ hasText: /live|offline/ }).waitFor({ timeout: 15_000 });
    const statusText = (await status.textContent()) ?? "";
    if (!statusText.startsWith("live")) throw new Error(`status strip says: ${statusText}`);
    ok(`status: ${statusText}`);

    step("enrol a passkey (virtual authenticator, PRF)");
    await page.getByRole("button", { name: "Create passkey" }).click();
    await page.locator("nav").waitFor({ timeout: 20_000 });
    ok("session unlocked — nav rendered");

    step("activate on chain (enroll + attest over the relay)");
    await page.getByRole("button", { name: "locker" }).click();
    await page.getByRole("button", { name: /Activate on chain/ }).click();
    await page.getByText(/^enrolled/).waitFor({ timeout: 120_000 });
    ok((await page.getByText(/^enrolled/).textContent())?.slice(0, 90) ?? "");

    step("capture → passport → anchor → publish");
    await page.getByRole("button", { name: "capture" }).click();
    await page
      .getByPlaceholder("What did you observe?")
      .fill("e2e: the hallway light flickers at 3am");
    await page.getByRole("button", { name: "Stamp passport" }).click();
    await page.getByText("published").waitFor({ timeout: 120_000 });
    const passportId = (await page.locator("dd code").first().textContent()) ?? "";
    if (!/^0x[0-9a-f]{64}$/.test(passportId)) throw new Error(`bad passport id ${passportId}`);
    ok(`passport ${passportId}`);
    const served = await fetch(`${gatewayUrl}/v1/passports/${passportId}`);
    if (served.status !== 200) throw new Error(`gateway serves passport with ${served.status}`);
    ok("gateway serves the sidecar (GET /v1/passports/:id → 200)");

    step("rescind view renders");
    await page.getByRole("button", { name: "rescind" }).click();
    await page.locator("h1", { hasText: /rescind/i }).waitFor({ timeout: 5_000 });
    ok("rescind screen visible");

    if (pageErrors.length > 0) throw new Error(`page errors:\n  ${pageErrors.join("\n  ")}`);
    await page.screenshot({ path: join(out, "final.png"), fullPage: true });
    console.log(`\n✔ browser proof passed — screenshot ${join(out, "final.png")}`);
  } catch (error) {
    await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
    console.error(`\n✘ ${(error as Error).message}`);
    if (pageErrors.length > 0) console.error(`page errors:\n  ${pageErrors.join("\n  ")}`);
    console.error(`screenshot: ${join(out, "failure.png")}`);
    process.exitCode = 1;
  } finally {
    for (const c of cleanups.reverse()) await c().catch(() => {});
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
