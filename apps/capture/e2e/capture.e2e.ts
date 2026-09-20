import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { anvil, createChainClients, monadTestnet } from "@firsthand/adapters/client";
import type { Address, Bytes32 } from "@firsthand/core";
import { chromium } from "playwright";
import { generatePrivateKey } from "viem/accounts";
import {
  approvalLink,
  awaitBalance,
  awaitGrant,
  buy,
  complianceFile,
  discover,
  fetchSidecar,
  listPassports,
  openBuyer,
  prepare,
  registerAgent,
  reputation,
} from "../../../integrations/buyer-agent/src/lib.js";
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
  // .env (git-ignored) supplies the testnet keys: the relayer that also funds the e2e's outside buyer
  // for its one ERC-8004 transaction. Absent locally, nothing depends on it.
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch {
    // no .env
  }
  if (hostedGateway) {
    gatewayUrl = hostedGateway.replace(/\/+$/, "");
    ok(`gateway: ${gatewayUrl} (hosted)`);
  } else {
    const testnet = process.env["E2E_TESTNET"] === "1";
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

    step("activate on chain from where the judge is (the Capture tab's card)");
    const card = page.getByTestId("activation");
    await card.waitFor({ timeout: 60_000 });
    await card.getByRole("button", { name: /Activate on chain/ }).click();
    await card.getByText(/^enrolled/).waitFor({ timeout: 120_000 });
    ok((await card.getByText(/^enrolled/).textContent())?.slice(0, 90) ?? "");
    await page
      .locator(".status")
      .filter({ hasText: /attested for epoch/ })
      .waitFor({ timeout: 60_000 });
    ok("status strip: attested for this epoch; the card is gone");

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
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await page
      .getByTestId("passport-view")
      .getByText(/anchored at block/)
      .waitFor({ timeout: 60_000 });
    ok("passport lookup shows origin, terms and the anchor block");

    step("evidence: H1/H2/H3 on screen, from experiments/results");
    await page.locator("nav").getByRole("button", { name: "evidence" }).click();
    const evidence = page.getByTestId("evidence");
    await evidence.waitFor({ timeout: 10_000 });
    const deltas = await evidence.getByTestId("h1-delta").allTextContents();
    if (!deltas.some((d) => d.startsWith("+")) || !deltas.some((d) => d.startsWith("-"))) {
      throw new Error(`H1 sign flip not shown: ${deltas.join(", ")}`);
    }
    await evidence.getByText("not measurable").waitFor({ timeout: 5_000 });
    await evidence.getByTestId("s4").waitFor({ timeout: 5_000 });
    ok(`H1 paged vs baseline: ${deltas.join(" · ")} · BTX marked not measurable · S4 shown`);

    step("external demand: a buyer outside the browser asks, the human approves, the buyer pays");
    // The same functions the partner template (integrations/buyer-agent) ships — one code path.
    await page.getByRole("button", { name: "locker" }).click();
    await page.getByTestId("locker-link").waitFor({ timeout: 10_000 });
    const lockerLinkText = (await page.getByTestId("locker-link").textContent()) ?? "";
    const sharedPrincipal = /principal=(0x[0-9a-f]{64})/.exec(lockerLinkText)?.[1] as Bytes32;
    if (!sharedPrincipal) throw new Error(`no locker link on the page: ${lockerLinkText}`);
    const fullDisco = await discover(gatewayUrl);
    const catalogue = await listPassports(gatewayUrl, sharedPrincipal);
    if (!catalogue.some((p) => p.passportId === passportId)) {
      throw new Error(
        `the principal's listing does not include the note: ${JSON.stringify(catalogue)}`,
      );
    }
    ok(`locker link lists ${catalogue.length} passports for the principal (note included)`);
    const outsiderKey = generatePrivateKey();
    const outsider = openBuyer(
      gatewayUrl,
      fullDisco,
      outsiderKey,
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const sidecar = await fetchSidecar(gatewayUrl, passportId);
    const prep = await prepare(outsider, fullDisco, sidecar);
    ok(
      `card ${prep.registerCardTx.slice(0, 12)}… · terms accepted${prep.fundedTx ? " · funded from the faucet double" : ""}`,
    );

    // ERC-8004: where the chain has the reference registries, the buyer registers an identity bound
    // to its card. That one transaction is its own (msg.sender), so the test harness gives the
    // throwaway key a little MON from the relayer key in .env — a real agent brings its own.
    let outsiderAgent: bigint | undefined;
    if (fullDisco.erc8004) {
      // Fund from the key the gateway under test is NOT relaying with, or the two race on nonces:
      // the spawned testnet gateway relays with RELAYER_PRIVATE_KEY, the hosted one with the
      // dedicated hosted relayer. Whatever the outsider does not spend is swept back afterwards.
      const funderKey = (
        hostedGateway
          ? process.env["RELAYER_PRIVATE_KEY"]
          : process.env["HOSTED_RELAYER_PRIVATE_KEY"]
      ) as `0x${string}` | undefined;
      if (!funderKey) {
        ok(
          "ERC-8004 registries present but no funding key in the environment for the outsider — skipping registration",
        );
      } else {
        const funder = createChainClients({
          rpcUrl: fullDisco.rpcUrl as string,
          chain: fullDisco.chainId === "31337" ? anvil : monadTestnet,
          privateKey: funderKey,
        });
        if (!funder.walletClient) throw new Error("funder wallet");
        // Registration stores the data: URI on chain: ~680k gas, ≈0.07 MON at 102 gwei (viem's
        // fee cap asks for ~0.13 MON up front).
        const gas = await funder.walletClient.sendTransaction({
          to: outsider.address,
          value: 150_000_000_000_000_000n, // 0.15 MON
        });
        await outsider.wait(gas as Bytes32);
        await awaitBalance(outsider, 150_000_000_000_000_000n);
        const reg = await registerAgent(
          outsider,
          fullDisco,
          gatewayUrl,
          "Outside agent (e2e)",
          "browser-tier buyer",
        );
        outsiderAgent = reg.agentId;
        ok(`ERC-8004 agent #${outsiderAgent} registered, card bound — ${reg.txHash.slice(0, 12)}…`);
        cleanups.push(async () => {
          // Sweep the throwaway key's remainder back to the funder (leave gas for the sweep itself).
          const wallet = outsider.reader.walletClient;
          if (!wallet) return;
          const balance = await outsider.reader.publicClient.getBalance({
            address: outsider.address,
          });
          const gasPrice = await outsider.reader.publicClient.getGasPrice();
          const fee = gasPrice * 21_000n * 2n;
          if (balance > fee) {
            await wallet.sendTransaction({
              to: funder.walletClient?.account.address as Address,
              value: balance - fee,
              gas: 21_000n,
              maxFeePerGas: gasPrice * 2n,
              maxPriorityFeePerGas: gasPrice,
            });
          }
        });
      }
    } else {
      ok("no ERC-8004 registries on this chain (local anvil) — the buyer stays an unverified card");
    }

    const link = `${approvalLink(appUrl, outsider, sidecar.ns, "Outside agent (e2e)", outsiderAgent)}&gateway=${encodeURIComponent(gatewayUrl)}`;
    ok(`approval link built (card ${outsider.cardId.slice(0, 10)}…)`);
    await page.goto(link);
    await page.getByRole("button", { name: "Tap passkey" }).click();
    const requests = page.getByTestId("requests");
    await requests.getByText("Outside agent (e2e)").waitFor({ timeout: 20_000 });
    const identity = requests.getByTestId("agent-identity");
    if (outsiderAgent !== undefined) {
      await identity.filter({ hasText: /binding verified/ }).waitFor({ timeout: 60_000 });
      ok(`the human sees: ${((await identity.textContent()) ?? "").slice(0, 120)}`);
    } else {
      await identity.filter({ hasText: /no ERC-8004 identity/ }).waitFor({ timeout: 10_000 });
      ok("the human sees: no ERC-8004 identity — an unverified card");
    }
    await requests.getByRole("button", { name: "Approve with passkey" }).click();
    const grantsList = page.getByTestId("grants");
    await grantsList
      .locator("li")
      .filter({ hasText: outsider.cardId.slice(2, 8) })
      .waitFor({ timeout: 120_000 });
    // The buyer does not need the page: the grant id is deterministic and the chain says when it is live.
    const outsiderGrant = await awaitGrant(
      outsider,
      fullDisco,
      sidecar.principalId,
      sidecar.ns,
      60_000,
    );
    ok(
      `human approved — grant ${outsiderGrant.slice(0, 12)}… (found on chain by the buyer itself)`,
    );
    const served = await buy(
      outsider,
      gatewayUrl,
      fullDisco,
      outsiderGrant,
      passportId,
      outsiderAgent,
    );
    const opened = new TextDecoder().decode(served.plaintext);
    if (!opened.includes("hallway light")) throw new Error(`outsider opened: ${opened}`);
    ok(`outsider paid and opened: “${opened}”`);
    const { verdict: buyersVerdict } = await complianceFile(outsider, fullDisco, [served.result]);
    if (!buyersVerdict.ok) throw new Error("the outsider's manifest does not verify");
    ok(
      `outsider's compliance file verifies (${buyersVerdict.assets.length} asset, receipt ${served.result.receipt.receiptId.slice(0, 10)}…)`,
    );
    if (outsiderAgent !== undefined) {
      // The venue's feedback lands a block or two after the response.
      let rep = await reputation(gatewayUrl, outsiderAgent);
      const until = Date.now() + 60_000;
      while ((rep?.paidQueriesHere ?? "0") === "0" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3_000));
        rep = await reputation(gatewayUrl, outsiderAgent);
      }
      if ((rep?.paidQueriesHere ?? "0") === "0")
        throw new Error("no paid-query feedback credited to the agent");
      ok(
        `reputation: agent #${outsiderAgent} has ${rep?.paidQueriesHere} paid query credited by this gateway`,
      );
    }

    step("phone-shaped: every screen fits a 390 px viewport (no horizontal overflow)");
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mobile = await phone.newPage();
    const mcdp = await phone.newCDPSession(mobile);
    await mcdp.send("WebAuthn.enable", { enableUI: false });
    await mcdp.send("WebAuthn.addVirtualAuthenticator", {
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
    const overflow = async (label: string) => {
      // A mobile viewport widens itself to the widest element, so compare against the device width,
      // not innerWidth (which would grow with the overflow and hide it).
      const sw = await mobile.evaluate(() => document.documentElement.scrollWidth);
      await mobile.screenshot({ path: join(out, `mobile-${label}.png`), fullPage: true });
      if (sw > 390) throw new Error(`${label}: page is ${sw}px wide on a 390px phone`);
      ok(`${label}: fits (${sw}/390px)`);
    };
    await mobile.goto(`${appUrl}/?gateway=${encodeURIComponent(gatewayUrl)}`);
    await mobile.locator("h1").first().waitFor({ timeout: 10_000 });
    await overflow("enrol");
    await mobile.getByRole("button", { name: "Create passkey" }).click();
    await mobile.locator("nav").waitFor({ timeout: 20_000 });
    await overflow("capture");
    for (const tab of ["locker", "recall", "verify", "evidence"] as const) {
      await mobile.locator("nav").getByRole("button", { name: tab }).click();
      await mobile.locator("h1").first().waitFor({ timeout: 10_000 });
      await overflow(tab);
    }
    await phone.close();

    if (pageErrors.length > 0) throw new Error(`page errors:\n  ${pageErrors.join("\n  ")}`);
    await page.screenshot({ path: join(out, "final.png"), fullPage: true });
    console.log(`\n✔ browser proof passed — screenshot ${join(out, "final.png")}`);
  } catch (error) {
    await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
    const err = error as Error & {
      shortMessage?: string;
      details?: string;
      metaMessages?: string[];
    };
    console.error(`\n✘ ${err.shortMessage ?? err.message}`);
    if (err.details) console.error(`  details: ${err.details}`);
    if (err.metaMessages) console.error(`  ${err.metaMessages.join("\n  ").slice(0, 600)}`);
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
