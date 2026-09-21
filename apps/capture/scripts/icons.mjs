#!/usr/bin/env node
// Renders public/icon.svg to the PNG sizes an installable PWA needs (Chrome wants PNG, not SVG,
// for the install prompt). Uses the Playwright Chromium the e2e already depends on.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public", "icon.svg"), "utf8");
const browser = await chromium.launch();
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<html><body style="margin:0;background:#0a0b10">${svg.replace(/<svg /, `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    const png = await page.screenshot({ type: "png", omitBackground: false });
    writeFileSync(join(root, "public", `icon-${size}.png`), png);
    console.log(`public/icon-${size}.png (${png.length} B)`);
    await page.close();
  }
} finally {
  await browser.close();
}
