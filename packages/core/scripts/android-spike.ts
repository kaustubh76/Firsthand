/**
 * The device spike, end to end (ADR-0015, plan step 4b).
 *
 *   pnpm spike:android
 *
 * Installs the companion app on a connected handset, runs it, pulls the attestation chain it
 * wrote, and reads the answer: which link can be verified on chain, what the secure element
 * actually is, and the commitment to deploy `HardwareDeviceRegistry` with.
 *
 * It exists because the spike is the one step that cannot be done by reading, and the gap between
 * "the phone is plugged in" and "the registry is deployable" should be one command rather than a
 * page of shell someone retypes at 2 a.m.
 *
 * **It refuses to write a recording that carries a device identifier.** This repository is public,
 * and `setDevicePropertiesAttestationIncluded` being absent from the app is an argument, not a
 * guarantee about some OEM's defaults.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deviceIdentifierTags,
  deviceKeyCommitment,
  effectiveSecurityLevel,
  keyDescriptionOf,
  parseCertificate,
  SecurityLevel,
  VerifiedBootState,
} from "../src/attestation/index.js";
import { bytesToHex } from "../src/bytes.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const ANDROID = join(REPO, "android");
const RECORDING = join(
  REPO,
  "packages",
  "test-vectors",
  "recordings",
  "android-attestation-chain.v1.json",
);
const PACKAGE = "xyz.firsthand.capture";
const REMOTE_PEM = `/sdcard/Android/data/${PACKAGE}/files/attestation-chain.pem`;
const JBR = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";

const adbBin = join(process.env["HOME"] ?? "", "Library/Android/sdk/platform-tools/adb");
const adb = (...args: string[]): string =>
  execFileSync(adbBin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function requireDevice(): string {
  if (!existsSync(adbBin)) die(`no adb at ${adbBin} — install Android SDK Platform-Tools`);
  const lines = adb("devices")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  const ready = lines.filter((l) => l.endsWith("\tdevice")).map((l) => l.split("\t")[0] as string);
  if (ready.length === 1) return ready[0] as string;
  if (lines.some((l) => l.endsWith("\tunauthorized"))) {
    die(
      'the handset says "unauthorized" — accept "Allow USB debugging?" on its screen, ticking "Always allow from this computer"',
    );
  }
  if (lines.length === 0) {
    die(
      "adb sees no device.\n" +
        "  On the phone: Settings → About phone → Software information → tap Build number seven times,\n" +
        "  then Settings → Developer options → USB debugging → on. Replug, and accept the prompt.\n" +
        "  A phone that is plugged in but has debugging off enumerates as MTP only and does not appear here at all.",
    );
  }
  die(`expected exactly one ready device, got: ${lines.join(", ")}`);
}

function installAndRun(serial: string): void {
  console.log("· building and installing");
  const gradle = spawnSync("./gradlew", ["--quiet", ":app:installDebug"], {
    cwd: ANDROID,
    stdio: "inherit",
    env: { ...process.env, JAVA_HOME: process.env["JAVA_HOME"] ?? JBR, ANDROID_SERIAL: serial },
  });
  if (gradle.status !== 0) die("gradle install failed");

  console.log("· running the spike");
  adb("-s", serial, "logcat", "-c");
  adb("-s", serial, "shell", "am", "start", "-n", `${PACKAGE}/.MainActivity`);
}

function waitForChain(serial: string): string {
  // StrongBox key generation takes a second or two; give it a generous, bounded wait rather than
  // a sleep that is either flaky or slow.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const log = adb("-s", serial, "logcat", "-d", "-s", "firsthand:I", "firsthand:E");
    if (/FAILED /.test(log)) {
      console.error(log.trim());
      die("the app reported a failure — the lines above are the measurement, not a bug to hide");
    }
    if (/wrote\s+\/sdcard/.test(log)) {
      console.log(log.trim().replace(/^/gm, "  "));
      return log;
    }
    execFileSync("sleep", ["2"]);
  }
  die("the app did not write a chain within 90 s");
}

function pullChain(serial: string): string {
  const dir = mkdtempSync(join(tmpdir(), "firsthand-spike-"));
  const local = join(dir, "attestation-chain.pem");
  adb("-s", serial, "pull", REMOTE_PEM, local);
  return readFileSync(local, "utf8");
}

const derOf = (pem: string): Uint8Array => {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(body, "base64"));
};

function main(): void {
  const serial = requireDevice();
  console.log(`· device ${serial}`);
  installAndRun(serial);
  const log = waitForChain(serial);
  const pem = pullChain(serial);

  const blocks = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ].map((m) => m[0]);
  if (blocks.length < 2)
    die(`the chain has ${blocks.length} certificate(s); it needs at least two`);

  console.log(`\n· ${blocks.length} certificates\n`);
  let anchorIndex = -1;
  let anchor: string | null = null;
  const described: string[] = [];

  blocks.forEach((block, i) => {
    const der = derOf(block);
    try {
      const certificate = parseCertificate(der);
      const commitment = deviceKeyCommitment(certificate.publicKey);
      // The highest P-256 certificate is the pin: everything below it is verifiable by RIP-7212,
      // and nothing above it is. See the recorded Google roots for why that ceiling exists.
      anchorIndex = i;
      anchor = commitment;
      described.push(`  cert[${i}] P-256   commitment ${commitment}`);
    } catch (error) {
      described.push(`  cert[${i}] NOT P-256 — ${(error as Error).message}`);
    }
  });
  console.log(described.join("\n"));

  const leaf = parseCertificate(derOf(blocks[0] as string));
  const description = keyDescriptionOf(leaf);
  if (description === null)
    die("the leaf carries no key attestation — this is not an attested key");

  const identifiers = deviceIdentifierTags(description);
  const level = effectiveSecurityLevel(description);
  const boot = description.teeEnforced.rootOfTrust?.verifiedBootState ?? null;

  console.log(`\n· measured`);
  console.log(
    `  security level     ${level} (${level >= SecurityLevel.STRONG_BOX ? "StrongBox" : level === SecurityLevel.TRUSTED_ENVIRONMENT ? "TEE" : "software"})`,
  );
  console.log(
    `  verified boot      ${boot === null ? "not attested" : `${boot} (${VerifiedBootState.VERIFIED === boot ? "Verified" : "NOT Verified"})`}`,
  );
  console.log(`  challenge          ${bytesToHex(description.attestationChallenge)}`);
  console.log(`  uniqueId           ${description.uniqueId.length} bytes`);
  console.log(`  identifier tags    ${identifiers.length === 0 ? "none" : identifiers.join(", ")}`);

  if (identifiers.length > 0 || description.uniqueId.length > 0) {
    die(
      `this chain carries device identifiers (${identifiers.join(", ") || "uniqueId"}) and will NOT be committed.\n` +
        "  This repository is public. Regenerate the key without device-properties attestation.",
    );
  }
  if (anchor === null) die("no P-256 certificate in the chain — nothing can be pinned");

  const device = /device=(.*)/.exec(log)?.[1]?.trim() ?? "unknown";
  writeFileSync(
    RECORDING,
    `${JSON.stringify(
      {
        kind: "recording",
        name: "android-attestation-chain",
        version: 1,
        recordedAt: new Date().toISOString().slice(0, 10),
        source: `${PACKAGE} MainActivity on ${device}`,
        command: "pnpm spike:android",
        why:
          "The real chain ADR-0015's on-chain verifier is pinned against. Generated certificates " +
          "prove the reader parses DER; only this proves it parses what a phone actually emits.",
        measured: {
          certificates: blocks.length,
          anchorIndex,
          anchorCommitment: anchor,
          securityLevel: level,
          verifiedBootState: boot,
          deviceIdentifierTags: identifiers,
          uniqueIdBytes: description.uniqueId.length,
        },
        provenance: log
          .split("\n")
          .filter((l) => /device=|release=|patch=|strongBox|cert\[/.test(l))
          .map((l) => l.trim()),
        pem,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n· wrote ${RECORDING}`);
  console.log(`\n· the anchor to deploy with — cert[${anchorIndex}], the highest P-256 link:\n`);
  console.log(`    HARDWARE_ANCHORS=${anchor} \\`);
  console.log(
    `    forge script contracts/script/DeployHardware.s.sol --rpc-url "$MONAD_RPC_URL" --broadcast\n`,
  );
}

main();
