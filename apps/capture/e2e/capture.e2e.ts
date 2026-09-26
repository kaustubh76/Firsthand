import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import {
  anvil,
  createChainClients,
  HttpRelayTransport,
  MemoryBlobStore,
  monadTestnet,
} from "@firsthand/adapters/client";
import { buildPaymentPayload } from "@firsthand/adapters/x402";
import {
  type Address,
  AttestationClass,
  type Bytes32,
  LICENSE_FH_1_0,
  Scope,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { FirsthandClient, importLocker, parseBundle } from "@firsthand/sdk";
import { clientOptionsFromDeployment } from "@firsthand/sdk/deployment";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  approvalLink,
  awaitBalance,
  awaitGrant,
  buy,
  complianceFile,
  discover,
  fetchSidecar,
  listing,
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
  /** The spawned gateway's environment, kept so a second gateway can be spawned for the dry-float beat. */
  let spawned: { env: Awaited<ReturnType<typeof resolveEnv>>; chainId: number } | null = null;

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
    spawned = { env, chainId: d.chainId };
    ok(`gateway: ${gatewayUrl} (spawned, chain ${d.chainId})`);
  }
  const disco = (await (await fetch(`${gatewayUrl}/.well-known/firsthand.json`)).json()) as {
    relay?: { enabled?: boolean };
    chainId?: string;
    rpcUrl?: string;
    contracts: Record<string, Address>;
    x402: {
      asset: Address;
      payTo: Address;
      version?: number;
      networkCaip2?: string;
      verification?: { mode: string; facilitator: string | null };
      settlement?: { via: string; byFacilitator: boolean };
    };
  };
  if (disco.relay?.enabled !== true)
    throw new Error("gateway has no relay — the PWA would be offline");
  ok(`discovery: chain ${disco.chainId}, relay enabled`);
  // Who verifies a payment, and who settles it — the two halves of README §8 claim 4 (ADR-0014).
  if (disco.x402.version !== 2)
    throw new Error(`gateway does not advertise x402 v2: ${JSON.stringify(disco.x402)}`);
  if (
    disco.x402.settlement?.byFacilitator !== false ||
    disco.x402.settlement.via !== "RoyaltyRouter.settle"
  ) {
    throw new Error(
      `settlement should stay in the router: ${JSON.stringify(disco.x402.settlement)}`,
    );
  }
  ok(
    `x402 v2 · ${disco.x402.networkCaip2} · verified by ${disco.x402.verification?.mode}${
      disco.x402.verification?.facilitator ? ` (${disco.x402.verification.facilitator})` : ""
    } · settled by ${disco.x402.settlement.via}`,
  );

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
    // The strip has read /healthz: the venue's float is known (and worded only once it is low).
    await page.locator('.status[data-relayer="ok"], .status[data-relayer="low"]').waitFor({
      timeout: 30_000,
    });
    ok(
      `status strip knows the relayer float (${await page
        .locator(".status")
        .getAttribute("data-relayer")})`,
    );

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
    // The two questions, side by side. The manifest proves the sale, and always will — history does
    // not change when consent ends. `FirsthandLens.verify` answers the present tense, on chain, and
    // by now this grant has been withdrawn, so the chain refuses it. A compliance file that only
    // said "verifies" would be telling a buyer half of what they need.
    const consent = page.getByTestId("lens-consent");
    await consent.waitFor({ timeout: 60_000 });
    const consentLine = ((await consent.textContent()) ?? "").replace(/\s+/g, " ").trim();
    if (!/FirsthandLens says 0 of 1 grant\(s\) would still be served/.test(consentLine)) {
      throw new Error(`lens line reads: ${consentLine}`);
    }
    ok(`the chain, asked now: ${consentLine}`);
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
    // A principal's listing, for anyone: attestation classes in the open and the namespace's
    // freshness line — what a buyer decides on before asking.
    await page.locator("nav").getByRole("button", { name: "locker" }).click();
    await page.getByTestId("locker-link").waitFor({ timeout: 10_000 });
    const ownPrincipal = /principal=(0x[0-9a-f]{64})/.exec(
      (await page.getByTestId("locker-link").textContent()) ?? "",
    )?.[1];
    if (!ownPrincipal) throw new Error("no principal in the locker link");
    await page.locator("nav").getByRole("button", { name: "verify" }).click();
    await page.getByPlaceholder("0x… principal id").fill(ownPrincipal);
    await page.getByRole("button", { name: "List passports" }).click();
    await page.getByTestId("principal-listing").waitFor({ timeout: 60_000 });
    await page.getByTestId("freshness").first().waitFor({ timeout: 60_000 });
    const shown = await page.getByTestId("class").allTextContents();
    if (!shown.includes("device capture") || !shown.includes("import"))
      throw new Error(`listing classes: ${shown.join(", ")}`);
    ok(`listing shows classes (${[...new Set(shown)].join(" · ")}) and freshness`);

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
    // The attestation class is in the open (README §13): what the app captured is device capture,
    // the export is an import, and a buyer can ask for one class only. The listing also dates
    // each namespace (README §7.3 freshness) from the newest anchor's block.
    const classes = new Map(catalogue.map((p) => [p.passportId, p.class]));
    if (classes.get(passportId) !== 2)
      throw new Error(
        `the note should be class 2 (device capture), got ${classes.get(passportId)}`,
      );
    if (!catalogue.some((p) => p.class === 1))
      throw new Error("no import passport in the listing (the ChatGPT export)");
    const devices = await listPassports(gatewayUrl, sharedPrincipal, undefined, { class: 2 });
    if (devices.length === 0 || devices.some((p) => p.class !== 2))
      throw new Error(`?class=2 listed ${JSON.stringify(devices)}`);
    const full = await listing(gatewayUrl, sharedPrincipal);
    const fresh0 = full.freshness["0"];
    if (!fresh0 || fresh0.lastAnchoredAt === null || fresh0.staleness >= 0.01) {
      throw new Error(
        `ns 0 freshness should date a just-anchored deposit: ${JSON.stringify(fresh0)}`,
      );
    }
    ok(
      `classes in the open: ${devices.length} device capture · ns 0 last anchored at ${fresh0.lastAnchoredAt} · staleness ${fresh0.staleness}`,
    );
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

    step("x402: this gateway verifies payments for anyone, and really checks the signature");
    {
      const supported = (await (await fetch(`${gatewayUrl}/x402/supported`)).json()) as {
        x402Version: number;
        kinds: { scheme: string; network: string }[];
        settle: boolean;
      };
      if (supported.x402Version !== 2 || !supported.kinds.some((k) => k.scheme === "exact")) {
        throw new Error(`/x402/supported: ${JSON.stringify(supported)}`);
      }
      if (supported.settle !== false)
        throw new Error("the gateway must not offer to settle a stranger's payment");
      const stranger = privateKeyToAccount(generatePrivateKey());
      const requirements = {
        scheme: "exact" as const,
        network: `eip155:${disco.chainId}`,
        maxAmountRequired: "1000",
        resource: `${gatewayUrl}/v1/query/interop/probe`,
        description: "verification only",
        mimeType: "application/json",
        payTo: disco.x402.payTo,
        maxTimeoutSeconds: 300,
        asset: disco.x402.asset,
        extra: { chainId: String(disco.chainId), name: "USD Coin", version: "2" },
      };
      const good = await buildPaymentPayload(stranger, requirements, { x402Version: 2 });
      const askGateway = async (payload: typeof good) =>
        (await (
          await fetch(`${gatewayUrl}/x402/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              x402Version: 2,
              paymentPayload: payload,
              paymentRequirements: {
                ...requirements,
                amount: requirements.maxAmountRequired,
                resource: {
                  url: requirements.resource,
                  description: "",
                  mimeType: "application/json",
                },
              },
            }),
          })
        ).json()) as { isValid: boolean; invalidReason?: string; verifiedBy?: string };
      const forged = {
        ...good,
        payload: { ...good.payload, signature: `0x${"11".repeat(65)}` as const },
      };
      const refusal = await askGateway(forged);
      if (refusal.isValid || !`${refusal.invalidReason}`.includes("signature")) {
        throw new Error(`a forged signature was not refused: ${JSON.stringify(refusal)}`);
      }
      // The same authorization, honestly signed: refused only for the funds this stranger lacks.
      const honest = await askGateway(good);
      if (honest.isValid !== false || honest.invalidReason !== "insufficient_funds") {
        throw new Error(`unexpected verdict for an unfunded payer: ${JSON.stringify(honest)}`);
      }
      ok(
        `/x402/verify refuses a forged signature (${refusal.invalidReason}) and reads the chain for a real one (${honest.invalidReason}) — verified by ${refusal.verifiedBy}`,
      );
    }

    step(
      "exit: the locker walks away — a bundle from this gateway re-hosts on another, and the buyer's grant still opens it",
    );
    // README §4 / §12 / §13. The page downloads everything the gateway holds for the locker —
    // ciphertext, sidecars, grant wraps; no plaintext, no key — and a second, empty gateway on the
    // same chain takes it through verified ingest. The outsider then pays and opens the note there
    // with the grant it already holds: the chain was the source of truth all along.
    await page.locator("nav").getByRole("button", { name: "locker" }).click();
    const bundleDownloading = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByTestId("bundle-download").click();
    const bundleDownload = await bundleDownloading;
    const bundlePath = join(out, "locker-bundle.json");
    await bundleDownload.saveAs(bundlePath);
    await page.getByTestId("bundle-note").waitFor({ timeout: 120_000 });
    const bundleNote = (await page.getByTestId("bundle-note").textContent()) ?? "";
    const bundleFile = readFileSync(bundlePath, "utf8");
    if (bundleFile.includes("hallway light")) throw new Error("the bundle carries plaintext");
    const parsed = parseBundle(bundleFile);
    if (parsed.passports.length < 3 || parsed.wraps.length < 1) {
      throw new Error(
        `bundle too small: ${parsed.passports.length} passports, ${parsed.wraps.length} wraps`,
      );
    }
    ok(`${bundleNote}`);
    const second = spawned
      ? spawned
      : process.env["RELAYER_PRIVATE_KEY"] && process.env["BUYER_PRIVATE_KEY"]
        ? await (async () => {
            const env = await resolveEnv(["--testnet"]);
            const d = JSON.parse(readFileSync(env.deploymentsFile, "utf8")) as { chainId: number };
            return { env, chainId: d.chainId };
          })()
        : null;
    if (!second) {
      ok("no keys for a second gateway in this environment — the re-host half is proven locally");
    } else {
      const gwB = await startGateway(second.env, root, second.chainId);
      cleanups.push(gwB.stop);
      const before = await fetch(`${gwB.url}/v1/passports/${passportId}`);
      if (before.status !== 404)
        throw new Error(`gateway B already hosts the note (${before.status})`);
      const report = await importLocker({ gatewayUrl: gwB.url, bundle: bundleFile });
      if (report.passports !== parsed.passports.length || report.wraps !== parsed.wraps.length) {
        throw new Error(`re-host incomplete: ${JSON.stringify(report)}`);
      }
      ok(
        `re-hosted on ${gwB.url}: ${report.passports} passports, ${report.blobs} blobs, ${report.wraps} wraps — every one verified against the chain by the new gateway`,
      );
      const discoB = await discover(gwB.url);
      const servedB = await buy(outsider, gwB.url, discoB, outsiderGrant, passportId);
      const openedB = new TextDecoder().decode(servedB.plaintext);
      if (!openedB.includes("hallway light")) throw new Error(`gateway B served: ${openedB}`);
      ok(`the outsider paid gateway B with the same grant and opened: “${openedB}”`);
    }

    step(
      "the handoff: the page issues a deposit code; an agent with no passkey deposits into the same locker",
    );
    // README §10 / PROGRESS "MCP↔PWA PRF handoff". The Locker issues a delegation for the imports
    // namespace — three keys of one namespace-epoch, no authority key. The Node side opens it the
    // way firsthand-mcp does (FIRSTHAND_DELEGATION), mints, anchors through the relay and
    // publishes; the gateway then lists the passport under the human's principal.
    await page.locator("nav").getByRole("button", { name: "locker" }).click();
    await page.getByTestId("delegate-ns").selectOption("1");
    await page.getByTestId("delegate-issue").click();
    await page.getByTestId("delegation-code").waitFor({ timeout: 10_000 });
    const delegationCode = (await page.getByTestId("delegation-code").textContent()) ?? "";
    if (!delegationCode.startsWith("fhd1."))
      throw new Error(`no delegation code: ${delegationCode}`);
    ok(`${(await page.getByTestId("delegation-scope").textContent())?.slice(0, 80)}…`);
    {
      const deploymentFile = spawned
        ? spawned.env.deploymentsFile
        : join(root, "deployments", `${disco.chainId ?? "10143"}.json`);
      // The deployment file carries checksummed addresses; the SDK's loader lowercases them.
      const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"), (_k, v) =>
        typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v,
      ) as Parameters<typeof clientOptionsFromDeployment>[0]["deployment"];
      const chainClients = createChainClients({
        rpcUrl: disco.rpcUrl ?? "https://testnet-rpc.monad.xyz",
        chain: Number(disco.chainId) === 31337 ? anvil : monadTestnet,
      });
      const agentClient = new FirsthandClient(
        clientOptionsFromDeployment({
          deployment,
          publicClient: chainClients.publicClient,
          transport: new HttpRelayTransport({ baseUrl: gatewayUrl }),
          blobs: new MemoryBlobStore(),
        }),
      );
      const agent = agentClient.openDelegated(delegationCode);
      if (agent.locker.principalId !== ownPrincipal) {
        throw new Error(`delegation names ${agent.locker.principalId}, page is ${ownPrincipal}`);
      }
      const payee = agent.locker.depositKey(1).address;
      const agentTerms = {
        price: 1_000n,
        licenseId: LICENSE_FH_1_0,
        scope: Scope.TRAIN | Scope.EVAL,
        ns: 1,
        rateLimit: 100,
        payees: [payee],
        weights: [WAD],
      };
      const deposited = await agent.deposit({
        ns: 1,
        datum: { kind: "bytes", bytes: new TextEncoder().encode("e2e: deposited by the agent") },
        terms: agentTerms,
        attestation: {
          class: AttestationClass.IMPORT,
          capturedAt: BigInt(Math.floor(Date.now() / 1000)),
          sourceTag: `0x${"a9".repeat(32)}`,
          deviceClass: ZERO_HASH,
          metaHash: ZERO_HASH,
        },
      });
      await agent.flush();
      await agent.publish({ gatewayUrl }, deposited, agentTerms);
      const mine = await listPassports(gatewayUrl, ownPrincipal as Bytes32, 1);
      const row = mine.find((p) => p.passportId === deposited.passportId);
      if (!row) throw new Error("the agent's passport is not listed under the human's principal");
      if (row.class !== 1)
        throw new Error(`agent's passport class ${row.class}, expected 1 (import)`);
      ok(
        `agent (no passkey) deposited ${deposited.passportId.slice(0, 12)}… into ns 1 of principal ${ownPrincipal.slice(0, 12)}… — anchored through the relay, listed by the gateway`,
      );
      // And the scope holds: the same code cannot grant, rescind or touch another namespace.
      let refused = "";
      try {
        agent.planRescind(`0x${"11".repeat(32)}` as Bytes32);
      } catch (e) {
        refused = (e as { code?: string }).code ?? "";
      }
      if (refused !== "FH_DELEGATION_SCOPE")
        throw new Error(`rescind with a delegation: ${refused}`);
      ok("the delegation cannot rescind (FH_DELEGATION_SCOPE) — the passkey keeps consent");
      agent.close();
    }

    step("withdraw privately: a commit that names nothing, a reveal that back-dates consent");
    // README §8 claim 1's fallback (ADR-0012), and the arm the Evidence tab measures. The direct
    // path announces which grant is ending before it ends — the race §13's observer bot is built to
    // win. `Rescissions.commit` publishes only `keccak256(grantId, salt)`, carries no signature and
    // needs no passkey; `revealRescind` then proves the preimage and ends consent at the *commit's*
    // block. Until now the SDK could do this and the page could not, so nothing exercised it in a
    // browser. The outsider's grant is the one still live at this point.
    {
      await page.locator("nav").getByRole("button", { name: "locker" }).click();
      const row = page
        .getByTestId("grants")
        .locator("li")
        .filter({ hasText: outsider.cardId.slice(2, 8) });
      await row.waitFor({ timeout: 30_000 });
      await row.getByRole("button", { name: "Withdraw privately" }).click();
      const commitRow = row.getByTestId(`commit:${outsiderGrant}`);
      await commitRow.waitFor({ timeout: 120_000 });
      const committed = ((await commitRow.textContent()) ?? "").replace(/\s+/g, " ").trim();
      if (!/commit posted/.test(committed)) throw new Error(`commit row reads: ${committed}`);
      ok(`committed without naming the grant — ${committed.slice(0, 110)}`);

      // Still live on chain: a commitment is not a rescission until it is revealed, and the page
      // must not pretend otherwise — the buyer can still pay right now.
      const stillServed = await buy(outsider, gatewayUrl, fullDisco, outsiderGrant, passportId);
      if (!new TextDecoder().decode(stillServed.plaintext).includes("hallway light")) {
        throw new Error("the gateway refused a grant whose rescission was only committed");
      }
      ok("consent still holds between the two steps — the commit alone ends nothing");

      await row.getByRole("button", { name: "Reveal and end consent" }).click();
      await row.getByText("withdrawn").waitFor({ timeout: 120_000 });
      ok("revealed — the row now reads withdrawn");

      let refused: string | null = null;
      try {
        await buy(outsider, gatewayUrl, fullDisco, outsiderGrant, passportId);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      if (refused === null) throw new Error("the gateway served after a revealed rescission");
      if (!/RESCINDED|403/.test(refused))
        throw new Error(`refused for the wrong reason: ${refused}`);
      ok(`the same buyer is refused: ${refused.slice(0, 100)}`);

      // And the ledger dates it at the commit, not at the reveal — the claim the Consent Ledger
      // exists to make, and the one the timeline used to drop on its way through the gateway.
      const ledgerRow = page
        .getByTestId("ledger")
        .locator("li")
        .filter({ hasText: "commit-reveal" })
        .first();
      await ledgerRow.waitFor({ timeout: 60_000 });
      const dated = ((await ledgerRow.textContent()) ?? "").replace(/\s+/g, " ").trim();
      const ended = /consent ended at block (\d+)/.exec(dated);
      const revealed = /revealed at block (\d+)/.exec(dated);
      if (!ended || !revealed) throw new Error(`ledger row reads: ${dated}`);
      if (Number(ended[1]) >= Number(revealed[1])) {
        throw new Error(`consent should end before the reveal that recorded it: ${dated}`);
      }
      ok(`ledger dates the end of consent at the commit: ${dated.slice(0, 120)}`);
    }

    step("the auditor's view: a link, no passkey, and the dated end of consent");
    // The Consent Ledger lived only inside the passkey-gated Locker, so the one party the diagram
    // writes it for — an auditor, a regulator, a buyer's compliance desk — could not open it. A
    // fresh context holds no credential id, which is what "no passkey" means to this app.
    {
      const auditorContext = await browser.newContext();
      const auditor = await auditorContext.newPage();
      await auditor.goto(
        `${appUrl}/?gateway=${encodeURIComponent(gatewayUrl)}&principal=${sidecar.principalId}`,
      );
      const publicLedger = auditor.getByTestId("public-ledger");
      await publicLedger.waitFor({ timeout: 60_000 });
      const text = ((await publicLedger.textContent()) ?? "").replace(/\s+/g, " ").trim();
      if (!/consent ended at block \d+/.test(text)) {
        throw new Error(`the auditor's ledger does not date the end of consent: ${text}`);
      }
      // And it really is unauthenticated: the app never left the public frame.
      if ((await auditor.locator("nav").count()) > 0) {
        throw new Error("the auditor's view is showing the unlocked navigation");
      }
      ok(`auditor with no passkey reads: ${text.slice(0, 120)}`);
      await auditorContext.close();
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

    if (spawned) {
      step("the venue runs dry: an unfunded relayer is named on screen, not hidden in a 502");
      // A second gateway on the same chain whose relayer key holds nothing. The first relayed
      // transaction cannot be paid for; the app must say exactly that.
      const dry = await startGateway(
        { ...spawned.env, relayerKey: generatePrivateKey() },
        root,
        spawned.chainId,
      );
      cleanups.push(dry.stop);
      const dryContext = await browser.newContext();
      const dryPage = await dryContext.newPage();
      const dryCdp = await dryContext.newCDPSession(dryPage);
      await dryCdp.send("WebAuthn.enable", { enableUI: false });
      await dryCdp.send("WebAuthn.addVirtualAuthenticator", {
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
      await dryPage.goto(`${appUrl}/?gateway=${encodeURIComponent(dry.url)}`);
      await dryPage.locator(".status").filter({ hasText: /^live/ }).waitFor({ timeout: 30_000 });
      await dryPage.getByRole("button", { name: "Create passkey" }).click();
      await dryPage.locator("nav").waitFor({ timeout: 20_000 });
      const dryCard = dryPage.getByTestId("activation");
      await dryCard.waitFor({ timeout: 60_000 });
      await dryCard.getByRole("button", { name: /Activate on chain/ }).click();
      await dryPage.getByTestId("out-of-gas").waitFor({ timeout: 60_000 });
      const cardError = (await dryCard.locator(".error").textContent()) ?? "";
      if (!/out of gas/.test(cardError)) throw new Error(`unexpected wording: ${cardError}`);
      ok(`banner + card: ${cardError.slice(0, 110)}…`);
      await dryPage.getByTestId("relayer-float").waitFor({ timeout: 30_000 });
      ok(`strip: ${await dryPage.getByTestId("relayer-float").textContent()}`);
      await dryContext.close();
    }

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
