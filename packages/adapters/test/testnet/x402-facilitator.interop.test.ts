import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockUSDCAbi } from "@firsthand/contracts/abi";
import { noopLogger } from "@firsthand/runtime";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "../../src/ports/X402Facilitator.js";
import { encodePaymentHeader, PAYMENT_HEADER } from "../../src/ports/X402Facilitator.js";
import {
  MONAD_FACILITATOR_URL,
  MonadFacilitatorClient,
} from "../../src/x402/MonadFacilitatorClient.js";
import { buildPaymentPayload } from "../../src/x402/typedData.js";
import { FACILITATOR_ENVELOPES, facilitatorBody, selectRequirements } from "../../src/x402/wire.js";

/**
 * Interop with Monad's native x402 facilitator — README §8 claim 4, measured rather than asserted.
 *
 * Three questions, and they are different:
 *   1. Does the facilitator exist, speak x402 v2, and offer `exact` on Monad testnet?
 *   2. Which request envelope does it actually accept? (The x402 specification and Monad's own
 *      guide disagree, so this cannot be read — only asked.)
 *   3. Will it verify a payment built by FIRSTHAND, for FIRSTHAND's own USDC?
 *
 * Kept out of `check:all` on purpose: no gate in this repo should depend on someone else's uptime.
 * What it measures is written to `experiments/results/x402-facilitator.json` so the claims in the
 * README and the ADR quote a run, not a hope.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const deployment = JSON.parse(readFileSync(join(root, "deployments", "10143.json"), "utf8")) as {
  chainId: number;
  USDC: string;
  RoyaltyRouter: string;
};

const NETWORK = "eip155:10143";
/** A throwaway payer: it holds nothing but the MockUSDC this test mints to it. */
const TEST_PAYER_KEY = `0x${"0b".repeat(32)}` as const;
const GATEWAY = process.env["E2E_GATEWAY_URL"] ?? "https://firsthand-gateway.vercel.app";
/** A passport the hosted gateway serves (from the 20 Sep live run); override with X402_PASSPORT. */
const HOSTED_PASSPORT = "0xbdb2c60936b197f24dafd1e358e7cea6ceade66a0aaef9fc668a28c38cb08847";
/** Deliberately not a grant: the query must stop at consent, long before anything is settled. */
const UNKNOWN_GRANT = `0x${"11".repeat(32)}`;

const results: Record<string, unknown> = {
  facilitator: MONAD_FACILITATOR_URL,
  gateway: GATEWAY,
  at: new Date().toISOString(),
};

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  maxAmountRequired: "1000",
  resource: "https://firsthand-gateway.vercel.app/v1/query/interop/probe",
  description: "FIRSTHAND per-query access under a live grant",
  mimeType: "application/json",
  payTo: deployment.RoyaltyRouter.toLowerCase(),
  maxTimeoutSeconds: 300,
  asset: deployment.USDC.toLowerCase(),
  extra: { chainId: String(deployment.chainId), name: "USD Coin", version: "2" },
};

const client = new MonadFacilitatorClient({ logger: noopLogger });

async function ask(body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${MONAD_FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 400) };
  }
}

const reasonOf = (answer: unknown): string | undefined =>
  (answer as { body?: { invalidReason?: string } })?.body?.invalidReason;

describe("Monad's x402 facilitator", () => {
  it("offers the exact scheme on Monad testnet, at x402 v2", async () => {
    const kinds = await client.supported();
    results["kinds"] = kinds;
    const exact = kinds.find((k) => k.scheme === "exact" && k.network === NETWORK);
    expect(exact, `no exact scheme for ${NETWORK} in ${JSON.stringify(kinds)}`).toBeTruthy();
    expect(exact?.x402Version).toBe(2);

    const probe = await client.probe("monad-testnet");
    results["probe"] = probe;
    expect(probe).toMatchObject({ reachable: true, supportsExact: true });
    // It publishes the address it settles from; recorded, never assumed.
    expect(probe.signers.length).toBeGreaterThan(0);
  });

  it("understands Monad's own envelope and refuses the specification's", async () => {
    const payer = privateKeyToAccount(TEST_PAYER_KEY);
    const payload = await buildPaymentPayload(payer, requirements, { x402Version: 2 });
    const answers: Record<string, unknown> = {};
    for (const envelope of FACILITATOR_ENVELOPES) {
      answers[envelope] = await ask(facilitatorBody(envelope, payload, requirements));
    }
    results["envelopes"] = answers;
    // The finding this integration turned on: the envelope written in the x402 specification is
    // not the one Monad's facilitator accepts. Both are asked every run, so a change is caught here.
    expect(reasonOf(answers["spec"])).toBe("unsupported_scheme");
    expect(reasonOf(answers["monad-doc"])).not.toBe("unsupported_scheme");
    results["envelope"] = "monad-doc";
  });

  it("verifies a FIRSTHAND payment against FIRSTHAND's own USDC", async () => {
    const payer = privateKeyToAccount(TEST_PAYER_KEY);
    // The gateway relays MockUSDC's `mint` (selector-scoped, capped), so the test payer funds
    // itself exactly as the demo buyer does — no key with value appears anywhere in this test.
    const funded = await fetch(`${GATEWAY}/v1/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: requirements.asset,
        data: encodeFunctionData({
          abi: MockUSDCAbi,
          functionName: "mint",
          args: [payer.address, 1_000_000n],
        }),
      }),
    });
    results["funding"] = { status: funded.status, body: (await funded.text()).slice(0, 200) };

    // Monad executes asynchronously: the mint is accepted before the balance is readable.
    let verdict: { isValid: boolean; invalidReason?: string } | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const payload = await buildPaymentPayload(payer, requirements, { x402Version: 2 });
      const answer = await ask(facilitatorBody("monad-doc", payload, requirements));
      results["verify"] = answer;
      verdict = answer.body as { isValid: boolean; invalidReason?: string };
      if (verdict.isValid || verdict.invalidReason !== "insufficient_funds") break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    // README §8 claim 4, measured: Monad's native facilitator verified a payment built by
    // FIRSTHAND, for FIRSTHAND's asset, under FIRSTHAND's EIP-712 domain.
    expect(verdict?.isValid, `facilitator said: ${JSON.stringify(verdict)}`).toBe(true);
  });

  it("is really verifying — a forged signature is refused", async () => {
    const payer = privateKeyToAccount(TEST_PAYER_KEY);
    const payload = await buildPaymentPayload(payer, requirements, { x402Version: 2 });
    const forged = {
      ...payload,
      payload: { ...payload.payload, signature: `0x${"11".repeat(65)}` as const },
    };
    const answer = await ask(facilitatorBody("monad-doc", forged, requirements));
    results["forged"] = answer;
    const body = answer.body as { isValid: boolean; invalidReason?: string };
    // The property that matters: a forged signature does not verify, on a payer that *does* hold
    // the funds — so this is the signature being checked, not the balance.
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toBeTruthy();
    expect(body.invalidReason).not.toBe("insufficient_funds");
    // Measured: the reason is the generic `unexpected_error`, not a signature-specific code. Worth
    // knowing, because it must never be read as "this facilitator cannot handle this kind of
    // payment" — `CAPABILITY_REASONS` deliberately does not include it, so a forgery can never
    // fall through to the local verifier and get a second opinion.
    expect(reasonOf(answer)).toBe("unexpected_error");
  });

  it("accepts a real payment inside the hosted serving path — without settling anything", async () => {
    // The last unproven half of README §8 claim 4. A *refusal* by the facilitator was already
    // observable; an acceptance inside a served query was not, because completing one costs relayer
    // gas. It does not have to: the gateway verifies the payment before it looks at the grant, and
    // settles only after the grant checks out (`Serving.serve`). So an honest payment against a
    // grant that does not exist proves the facilitator accepted it — the refusal that comes back is
    // about consent, not money — and nothing is ever settled.
    const passportId = process.env["X402_PASSPORT"] ?? HOSTED_PASSPORT;
    const hosted = await fetch(`${GATEWAY}/v1/passports/${passportId}`);
    if (hosted.status !== 200) {
      throw new Error(
        `this test needs a passport the gateway hosts; ${passportId} answered ${hosted.status}. Pass another with X402_PASSPORT=0x…`,
      );
    }
    const url = `${GATEWAY}/v1/query/${UNKNOWN_GRANT}/${passportId}`;

    // Take the gateway's own terms, so the signature covers exactly what it will check.
    const offer = (await (await fetch(url)).json()) as { accepts?: unknown[] };
    const terms = selectRequirements(offer.accepts);
    expect(terms, `no usable requirements in ${JSON.stringify(offer)}`).toBeTruthy();
    const payer = privateKeyToAccount(TEST_PAYER_KEY);
    const payment = await buildPaymentPayload(payer, terms as PaymentRequirements, {
      x402Version: 2,
    });
    const res = await fetch(url, { headers: { [PAYMENT_HEADER]: encodePaymentHeader(payment) } });
    const body = (await res.json()) as { code?: string; detail?: string };
    results["servingPath"] = { status: res.status, body };

    // FH_PAYMENT_INVALID here would mean the facilitator rejected the payment. Any grant-shaped
    // refusal means it accepted it and the gateway moved on to consent.
    expect(body.code, `payment was rejected: ${JSON.stringify(body)}`).not.toBe(
      "FH_PAYMENT_INVALID",
    );
    expect(body.code).toMatch(/^FH_(GRANT_|NOT_FOUND)/);

    // …and the gateway says who did the verifying.
    const health = (await (await fetch(`${GATEWAY}/healthz`)).json()) as {
      x402?: { lastVerifiedBy?: string | null };
    };
    results["lastVerifiedBy"] = health.x402?.lastVerifiedBy ?? null;
    expect(health.x402?.lastVerifiedBy).toBe("monad");
  });

  it("writes what it measured", () => {
    const out = join(root, "experiments", "results", "x402-facilitator.json");
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\n▸ x402 facilitator interop → ${out}`);
    console.log(
      JSON.stringify({ envelope: results["envelope"], verify: results["verify"] }, null, 2),
    );
  });
});
