import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import {
  anvil,
  createChainClients,
  HttpRelayTransport,
  monadTestnet,
  OnchainAnchorWriter,
} from "@firsthand/adapters/client";
import { type Address, type Bytes32, parseSidecar } from "@firsthand/core";
import {
  BuyerSession,
  createBuyerKeys,
  manifestFromQueries,
  verifyManifest,
} from "@firsthand/sdk/browser";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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
    rpcUrl?: string;
    contracts: Record<string, Address>;
    x402: { asset: Address };
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
    // 402 and 403 are the protocol talking (x402 offer, refusal after rescission), not bugs.
    if (m.type() === "error" && !/Failed to load resource: .* (402|403)/.test(m.text())) {
      pageErrors.push(m.text());
    }
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

    step("capture a note → passport → anchor → publish");
    await page.getByRole("button", { name: "capture" }).click();
    await page
      .getByPlaceholder("What did you observe?")
      .fill("e2e: the hallway light flickers at 3am");
    await page.getByRole("button", { name: "Stamp passport" }).click();
    const landed = page.getByTestId("landed");
    await landed.getByText("published").waitFor({ timeout: 120_000 });
    const passportId = ((await landed.locator("code").first().getAttribute("title")) ??
      "") as Bytes32;
    if (!/^0x[0-9a-f]{64}$/.test(passportId)) throw new Error(`bad passport id ${passportId}`);
    ok(`passport ${passportId}`);
    const hosted = await fetch(`${gatewayUrl}/v1/passports/${passportId}`);
    if (hosted.status !== 200) throw new Error(`gateway serves passport with ${hosted.status}`);
    ok("gateway serves the sidecar (GET /v1/passports/:id → 200)");

    step("capture a photo (bytes datum, mime committed in the attestation)");
    await page.getByRole("tab", { name: "Photo / clip" }).click();
    await page.getByTestId("media-input").setInputFiles({
      name: "icon.png",
      mimeType: "image/png",
      buffer: readFileSync(join(root, "apps", "capture", "public", "icon-192.png")),
    });
    await page.getByRole("button", { name: "Stamp passport" }).click();
    await landed.getByText(/icon\.png · image\/png/).waitFor({ timeout: 120_000 });
    await landed.getByText("published").waitFor({ timeout: 120_000 });
    ok("photo passport anchored and published");

    step("import a ChatGPT export (one passport per conversation)");
    await page.getByRole("tab", { name: "Import export" }).click();
    await page.getByTestId("import-input").setInputFiles({
      name: "conversations.json",
      mimeType: "application/json",
      buffer: readFileSync(
        join(root, "packages", "importers", "test", "fixtures", "chatgpt-two.json"),
      ),
    });
    await page.getByRole("button", { name: /Mint one passport per conversation/ }).click();
    await page.getByText(/conversations? minted/).waitFor({ timeout: 120_000 });
    await landed.getByText("Trip planning").waitFor({ timeout: 120_000 });
    ok((await page.getByText(/conversations? minted/).textContent()) ?? "");

    step("the refusal: a scraped datum is turned away on origin proof");
    await page.getByText("The refusal — try to launder a scraped datum").click();
    await page.getByRole("button", { name: "Inject a scraped datum" }).click();
    const refusal = page.getByTestId("refusal");
    await refusal.waitFor({ timeout: 30_000 });
    const refusalText = (await refusal.textContent()) ?? "";
    if (!refusalText.startsWith("FH_REFUSED_ORIGIN")) throw new Error(`unexpected: ${refusalText}`);
    ok(refusalText);

    step("recall: agent → grant → paid query → withdraw → refused");
    await page.getByRole("button", { name: "recall" }).click();
    await page.getByTestId("run-recall").click();
    for (const id of ["buyer", "grant", "query", "rescind", "refused"] as const) {
      const li = page.getByTestId(`step-${id}`);
      const deadline = Date.now() + 240_000;
      let status = await li.getAttribute("data-status");
      while (status !== "done" && status !== "failed" && Date.now() < deadline) {
        await page.waitForTimeout(500);
        status = await li.getAttribute("data-status");
      }
      if (status !== "done") {
        throw new Error(`recall step ${id} ended ${status}: ${await li.textContent()}`);
      }
      ok(`${id}: ${(await li.locator(".line").allTextContents()).join(" | ").slice(0, 160)}`);
    }
    const refused = (await page.getByTestId("refused").textContent()) ?? "";
    if (!refused.includes("FH_GRANT_RESCINDED"))
      throw new Error(`refusal code missing: ${refused}`);
    const earned = (await page.getByTestId("step-query").textContent()) ?? "";
    if (!/you earned 0\.001 USDC/.test(earned)) throw new Error(`payout not visible: ${earned}`);

    step("locker: grants, consent ledger, lineage manifest");
    await page.getByRole("button", { name: "locker" }).click();
    await page.getByTestId("grants").getByText("withdrawn").waitFor({ timeout: 10_000 });
    const ledger = page.getByTestId("ledger");
    await ledger.waitFor({ timeout: 60_000 });
    for (const kind of ["enrolled", "attested", "granted", "rescinded"]) {
      await ledger.getByText(kind, { exact: true }).first().waitFor({ timeout: 60_000 });
    }
    ok("ledger shows enrolled · attested · granted · rescinded");
    const earnings = page.getByTestId("earnings");
    await earnings.filter({ hasText: /1 receipt/ }).waitFor({ timeout: 60_000 });
    ok(`earnings: ${((await earnings.textContent()) ?? "").slice(0, 60)}`);
    await page.getByRole("button", { name: "Export + verify manifest" }).click();
    const manifest = page.getByTestId("manifest");
    await manifest.waitFor({ timeout: 60_000 });
    const verdict = (await manifest.textContent()) ?? "";
    if (!verdict.startsWith("verifies")) throw new Error(`manifest: ${verdict}`);
    ok(`manifest ${verdict}`);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "download JSON" }).click();
    const sellerFile = readFileSync((await (await downloading).path()) ?? "", "utf8");
    if (!sellerFile.includes('"version": 1'))
      throw new Error("downloaded manifest is not a manifest");
    ok(`downloaded the seller's manifest (${sellerFile.length} bytes)`);

    step("reload: the passkey unlocks the same locker, evidence rebuilt from the gateway");
    await page.reload();
    await page.getByRole("button", { name: "Tap passkey" }).click();
    await page.locator("nav").waitFor({ timeout: 20_000 });
    await page
      .locator(".status")
      .filter({ hasText: /attested for epoch/ })
      .waitFor({ timeout: 60_000 });
    ok(`status: ${await page.locator(".status").textContent()}`);
    await page.getByRole("button", { name: "locker" }).click();
    await page.getByTestId("grants").getByText("withdrawn").waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Export + verify manifest" }).click();
    await page.getByTestId("manifest").waitFor({ timeout: 60_000 });
    const rebuilt = (await page.getByTestId("manifest").textContent()) ?? "";
    if (!rebuilt.startsWith("verifies")) throw new Error(`rebuilt manifest: ${rebuilt}`);
    ok(`manifest after reload ${rebuilt.slice(0, 40)}`);

    step("verify: anyone checks a manifest against the chain — and a tampered one fails");
    await page.locator("nav").getByRole("button", { name: "verify" }).click();
    await page.getByTestId("manifest-text").fill(sellerFile);
    await page.getByRole("button", { name: "Verify against the chain" }).click();
    const verdictBox = page.getByTestId("verdict");
    await verdictBox.waitFor({ timeout: 60_000 });
    if ((await verdictBox.getAttribute("data-ok")) !== "true") {
      throw new Error(`verify: ${await verdictBox.textContent()}`);
    }
    ok("seller's manifest verifies in the Verify tab");
    const tampered = JSON.parse(sellerFile) as { assets: { proof: { index: number } }[] };
    if (tampered.assets[0])
      tampered.assets[0].proof.index = (tampered.assets[0].proof.index + 1) % 8;
    await page.getByTestId("manifest-text").fill(JSON.stringify(tampered));
    await page.getByRole("button", { name: "Verify against the chain" }).click();
    await verdictBox.filter({ hasText: /FAILS|MERKLE_INVALID/ }).waitFor({ timeout: 60_000 });
    ok("a tampered proof FAILS");
    await page.getByTestId("passport-input").fill(passportId);
    await page.getByRole("button", { name: "Look up" }).click();
    await page
      .getByTestId("passport-view")
      .getByText(/anchored at block/)
      .waitFor({ timeout: 60_000 });
    ok("passport lookup shows origin, terms and the anchor block");

    step("external demand: a buyer outside the browser asks, the human approves, the buyer pays");
    const chain = disco.chainId === "31337" ? anvil : monadTestnet;
    const chainId = BigInt(disco.chainId as string);
    const anchorsAddress = disco.contracts["PassportAnchors"] as Address;
    const domain = { chainId, verifyingContract: anchorsAddress };
    const reader = createChainClients({ rpcUrl: disco.rpcUrl as string, chain });
    const relay = new HttpRelayTransport({ baseUrl: gatewayUrl });
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const outsider = new BuyerSession({
      keys: createBuyerKeys(
        Uint8Array.from(key.slice(2).match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
        account,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      grantManager: disco.contracts["GrantManager"] as Address,
      chainId,
      transport: relay,
    });
    const wait = (hash: Bytes32) => reader.publicClient.waitForTransactionReceipt({ hash });
    // The same handshake firsthand_request_access performs: sidecar → card → terms → link.
    const sidecar = parseSidecar(
      await (await fetch(`${gatewayUrl}/v1/passports/${passportId}`)).json(),
    );
    await wait((await outsider.registerCard()).txHash);
    const accept = outsider.acceptTerms(sidecar.principalId, sidecar.terms);
    await wait((await accept.send()).txHash);
    // It has no USDC yet: fund it through the same faucet mint the demo agent used.
    const { encodeFunctionData, parseAbi } = await import("viem");
    const usdc = disco.x402.asset;
    const minted = await relay.send({
      to: usdc,
      data: encodeFunctionData({
        abi: parseAbi(["function mint(address to, uint256 value)"]),
        functionName: "mint",
        args: [account.address, 100_000n],
      }),
    });
    await wait(minted.hash as Bytes32);
    const link = `${appUrl}/?grant=${outsider.cardId}&pub=${outsider.encryptionPubKey}&ns=${sidecar.ns}&from=${encodeURIComponent("Outside agent (e2e)")}&gateway=${encodeURIComponent(gatewayUrl)}`;
    ok(`approval link built (card ${outsider.cardId.slice(0, 10)}…)`);
    await page.goto(link);
    await page.getByRole("button", { name: "Tap passkey" }).click();
    const requests = page.getByTestId("requests");
    await requests.getByText("Outside agent (e2e)").waitFor({ timeout: 20_000 });
    await requests.getByRole("button", { name: "Approve with passkey" }).click();
    const grantsList = page.getByTestId("grants");
    await grantsList
      .locator("li")
      .filter({ hasText: outsider.cardId.slice(2, 8) })
      .waitFor({ timeout: 120_000 });
    const grantRow = grantsList
      .locator("li")
      .filter({ hasText: outsider.cardId.slice(2, 8) })
      .first();
    const outsiderGrant = (await grantRow.locator("code").first().getAttribute("title")) as Bytes32;
    ok(`human approved — grant ${outsiderGrant.slice(0, 12)}…`);
    const served = await outsider.queryAndOpen(
      { gatewayUrl, grantId: outsiderGrant, passportId },
      domain,
    );
    const opened = new TextDecoder().decode(served.plaintext);
    if (!opened.includes("hallway light")) throw new Error(`outsider opened: ${opened}`);
    ok(`outsider paid and opened: “${opened}”`);
    const anchorsReader = new OnchainAnchorWriter({
      address: anchorsAddress,
      layout: "baseline",
      publicClient: reader.publicClient,
    });
    const buyersFile = await manifestFromQueries({
      domain,
      results: [served.result],
      anchors: anchorsReader,
      payer: account.address.toLowerCase() as Address,
      finalityDepth: 0,
    });
    const buyersVerdict = await verifyManifest(buyersFile, {
      anchors: anchorsReader,
      headBlock: await reader.publicClient.getBlockNumber({ cacheTime: 0 }),
    });
    if (!buyersVerdict.ok) throw new Error("the outsider's manifest does not verify");
    ok(
      `outsider's compliance file verifies (${buyersVerdict.assets.length} asset, receipt ${served.result.receipt.receiptId.slice(0, 10)}…)`,
    );

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
