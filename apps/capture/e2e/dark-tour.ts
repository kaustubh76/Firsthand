// A visual tour, not a test: drives the built tree against a local chain in DARK mode at phone and
// laptop widths and writes screenshots to e2e-out/tour-*. Run with `pnpm exec tsx e2e/dark-tour.ts`.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium, type Page } from "playwright";
import { repoRoot, resolveEnv, startGateway } from "../../demo/src/env.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
};

async function main() {
  const root = repoRoot();
  const tree = join(root, "deploy", "capture");
  const out = join(root, "apps", "capture", "e2e-out");
  mkdirSync(out, { recursive: true });
  const env = await resolveEnv([]);
  const gateway = await startGateway(env, root, env.chain.id);
  const server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
    let file = join(tree, path || "index.html");
    if (!existsSync(file) || extname(file) === "") file = join(tree, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const appUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    for (const [label, viewport] of [
      ["phone", { width: 390, height: 844 }],
      ["laptop", { width: 1280, height: 900 }],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        colorScheme: "dark",
        deviceScaleFactor: 2,
        isMobile: label === "phone",
        hasTouch: label === "phone",
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error" && !/402|403/.test(m.text())) errors.push(`${label}: ${m.text()}`);
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
      const shot = (name: string) =>
        page.screenshot({ path: join(out, `tour-${label}-${name}.png`), fullPage: true });
      await page.goto(`${appUrl}/?gateway=${encodeURIComponent(gateway.url)}`);
      await page.locator(".status").filter({ hasText: /^live/ }).waitFor({ timeout: 30_000 });
      await shot("enrol");
      await page.getByRole("button", { name: "Create passkey" }).click();
      await page.locator("nav").waitFor({ timeout: 20_000 });
      await shot("capture-before");
      const card = page.getByTestId("activation");
      await card.getByRole("button", { name: /Activate on chain/ }).click();
      await card.getByText(/^enrolled/).waitFor({ timeout: 120_000 });
      await page
        .getByPlaceholder("What did you observe?")
        .fill("the hallway light flickers at 3am");
      await page.getByRole("button", { name: "Stamp passport" }).click();
      await page.getByTestId("landed").getByText("published").waitFor({ timeout: 120_000 });
      await shot("capture-landed");
      await nav(page, "recall");
      await page.getByTestId("run-recall").click();
      await page
        .getByTestId("step-refused")
        .and(page.locator('[data-status="done"]'))
        .waitFor({ timeout: 240_000 });
      await shot("recall-done");
      await nav(page, "locker");
      await page.getByTestId("ledger").waitFor({ timeout: 60_000 });
      await page.getByRole("button", { name: "Export + verify manifest" }).click();
      await page.getByTestId("manifest").waitFor({ timeout: 60_000 });
      await shot("locker");
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Settings" }).waitFor();
      await page.screenshot({ path: join(out, `tour-${label}-settings.png`) });
      await page.keyboard.press("Escape");
      await nav(page, "verify");
      await shot("verify");
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
    await gateway.stop();
    await env.cleanup?.();
  }
  console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "tour: no page errors");
}

async function nav(page: Page, tab: string) {
  await page.locator("nav").getByRole("button", { name: tab }).click();
  await page.locator("h1").first().waitFor();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
