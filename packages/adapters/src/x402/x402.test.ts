import { MONAD_TESTNET_CAIP2 } from "@firsthand/core";
import { noopLogger } from "@firsthand/runtime";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { MemoryFacilitator } from "../memory/MemoryFacilitator.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  X402Facilitator,
} from "../ports/X402Facilitator.js";
import { FallbackFacilitator } from "./FallbackFacilitator.js";
import { LocalFacilitator } from "./LocalFacilitator.js";
import { MonadFacilitatorClient } from "./MonadFacilitatorClient.js";
import { buildPaymentPayload } from "./typedData.js";
import {
  facilitatorBody,
  fromRequirementsV2,
  selectRequirements,
  toRequirementsV2,
} from "./wire.js";

const payer = privateKeyToAccount(`0x${"0b".repeat(32)}`);
const PAY_TO = `0x${"aa".repeat(20)}` as const;
const ASSET = `0x${"dc".repeat(20)}` as const;
const NOW = 1_800_000_000;

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "monad-testnet",
  maxAmountRequired: "1000",
  resource: "https://gw.test/v1/query/0xabc/0xdef",
  description: "FIRSTHAND per-query access under a live grant",
  mimeType: "application/json",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  asset: ASSET,
  extra: { chainId: "10143", name: "USD Coin", version: "2" },
};

const signed = (over: Partial<PaymentRequirements> = {}) =>
  buildPaymentPayload(payer, { ...requirements, ...over }, { now: () => NOW * 1000 });

describe("x402 v2 wire", () => {
  it("projects requirements onto v2 and back without losing a field", () => {
    const v2 = toRequirementsV2(requirements);
    expect(v2).toEqual({
      scheme: "exact",
      // v2 is CAIP-2 even though FIRSTHAND still configures the legacy name.
      network: MONAD_TESTNET_CAIP2,
      amount: "1000",
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      resource: {
        url: requirements.resource,
        description: requirements.description,
        mimeType: requirements.mimeType,
      },
      extra: requirements.extra,
    });
    expect(fromRequirementsV2(v2)).toEqual(requirements);
  });

  it("builds both published envelopes — the spec's and Monad's guide's", async () => {
    const payload = await signed();
    const spec = facilitatorBody("spec", payload, requirements) as Record<string, never>;
    expect(spec).toMatchObject({
      x402Version: 2,
      paymentPayload: { x402Version: 2, scheme: "exact" },
      paymentRequirements: { amount: "1000", network: MONAD_TESTNET_CAIP2 },
    });
    const monad = facilitatorBody("monad-doc", payload, requirements) as {
      accepted: Record<string, unknown>;
      resource: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    expect(monad).toMatchObject({ x402Version: 2 });
    expect(monad.accepted).not.toHaveProperty("resource");
    expect(monad.accepted).toMatchObject({ amount: "1000", network: MONAD_TESTNET_CAIP2 });
    expect(monad.resource).toMatchObject({ url: requirements.resource });
    expect(monad.payload).toHaveProperty("authorization");
  });

  it("selects the payable entry from a mixed `accepts`, preferring v2", () => {
    const v2 = toRequirementsV2(requirements);
    expect(selectRequirements([requirements, v2])?.network).toBe("monad-testnet");
    expect(selectRequirements([v2])).toEqual(requirements);
    expect(selectRequirements([requirements])).toEqual(requirements);
    expect(selectRequirements([{ nope: 1 }])).toBeNull();
    expect(selectRequirements(undefined)).toBeNull();
  });
});

describe("LocalFacilitator — the verifier FIRSTHAND owns", () => {
  const local = (over: Partial<ConstructorParameters<typeof LocalFacilitator>[0]> = {}) =>
    new LocalFacilitator({ network: "monad-testnet", now: () => BigInt(NOW), ...over });

  it("accepts a well-formed authorization and names itself", async () => {
    const verdict = await local().verify(await signed(), requirements);
    expect(verdict).toEqual({
      isValid: true,
      payer: payer.address.toLowerCase(),
      verifiedBy: "local",
    });
  });

  it("refuses what MemoryFacilitator never could: a forged signature", async () => {
    const payload = await signed();
    const forged: PaymentPayload = {
      ...payload,
      payload: { ...payload.payload, signature: `0x${"11".repeat(65)}` },
    };
    // The double waves it through — that is exactly the gap this class closes.
    expect(
      (await new MemoryFacilitator({ network: "monad-testnet" }).verify(forged, requirements))
        .isValid,
    ).toBe(true);
    expect(await local().verify(forged, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
    });
    // A signature over different terms is a different signature.
    const elsewhere = await signed({ payTo: `0x${"bb".repeat(20)}` });
    expect(
      await local().verify(
        {
          ...elsewhere,
          payload: {
            ...elsewhere.payload,
            authorization: { ...elsewhere.payload.authorization, to: PAY_TO },
          },
        },
        requirements,
      ),
    ).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
  });

  it("refuses the wrong recipient, the wrong amount, the wrong network and an expired window", async () => {
    const payload = await signed();
    const bad = (auth: Record<string, string>): PaymentPayload => ({
      ...payload,
      payload: { ...payload.payload, authorization: { ...payload.payload.authorization, ...auth } },
    });
    expect(await local().verify(bad({ to: `0x${"cc".repeat(20)}` }), requirements)).toMatchObject({
      invalidReason: "invalid_exact_evm_payload_recipient_mismatch",
    });
    expect(await local().verify(bad({ value: "999" }), requirements)).toMatchObject({
      invalidReason: "invalid_exact_evm_payload_value_mismatch",
    });
    expect(await local().verify(bad({ validBefore: String(NOW) }), requirements)).toMatchObject({
      invalidReason: "invalid_exact_evm_payload_authorization_valid_before",
    });
    expect(await local().verify(bad({ validAfter: String(NOW + 10) }), requirements)).toMatchObject(
      {
        invalidReason: "invalid_exact_evm_payload_authorization_valid_after",
      },
    );
    expect(await local().verify({ ...payload, network: "eip155:143" }, requirements)).toMatchObject(
      { invalidReason: "unsupported_network" },
    );
    // …and accepts the CAIP-2 spelling of the same chain.
    expect(
      (await local().verify({ ...payload, network: "eip155:10143" }, requirements)).isValid,
    ).toBe(true);
  });

  it("uses the chain for replay and balance when it is given a reader, and never invents a verdict", async () => {
    const payload = await signed();
    const reader = (used: boolean, balance: bigint) =>
      ({
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === "authorizationState" ? used : balance,
      }) as never;
    expect(
      await local({ publicClient: reader(true, 10_000n) }).verify(payload, requirements),
    ).toMatchObject({
      invalidReason: "invalid_exact_evm_payload_authorization_already_used",
    });
    expect(
      await local({ publicClient: reader(false, 1n) }).verify(payload, requirements),
    ).toMatchObject({
      invalidReason: "insufficient_funds",
    });
    expect(
      (await local({ publicClient: reader(false, 1_000n) }).verify(payload, requirements)).isValid,
    ).toBe(true);
    // An RPC that is down is not a refusal: the signature checks already passed and settlement re-checks.
    const broken = {
      readContract: async () => {
        throw new Error("rpc down");
      },
    } as never;
    expect((await local({ publicClient: broken }).verify(payload, requirements)).isValid).toBe(
      true,
    );
  });

  it("does not settle, and says why", async () => {
    const res = await local().settle();
    expect(res.success).toBe(false);
    expect(res.errorReason).toMatch(/RoyaltyRouter\.settle/);
    expect(await local().supported()).toEqual([
      { scheme: "exact", network: MONAD_TESTNET_CAIP2, x402Version: 2 },
      { scheme: "exact", network: "monad-testnet", x402Version: 1 },
    ]);
  });
});

describe("MonadFacilitatorClient — v2, and only v2", () => {
  const client = (handler: (path: string, body: unknown) => Response) =>
    new MonadFacilitatorClient({
      baseUrl: "https://facilitator.test/",
      logger: noopLogger,
      fetch: (async (url: string | URL | Request, init?: RequestInit) =>
        handler(
          new URL(String(url)).pathname,
          init?.body ? JSON.parse(String(init.body)) : undefined,
        )) as unknown as typeof fetch,
    });

  const SUPPORTED = {
    extensions: [],
    kinds: [
      { extra: {}, network: "eip155:10143", scheme: "exact", x402Version: 2 },
      {
        extra: { facilitatorAddress: "0x7f6a" },
        network: "eip155:10143",
        scheme: "upto",
        x402Version: 2,
      },
    ],
    signers: { "eip155:10143": ["0x7f6a2850669202519f0FE8aa912451238820Db86"] },
  };

  it("parses the live /supported shape and answers the capability question for a chain", async () => {
    const c = client((path) =>
      path === "/supported"
        ? new Response(JSON.stringify(SUPPORTED))
        : new Response("nope", { status: 404 }),
    );
    expect(await c.supported()).toEqual([
      { scheme: "exact", network: "eip155:10143", x402Version: 2, extra: {} },
      expect.objectContaining({ scheme: "upto" }),
    ]);
    // The gateway asks with its own spelling; the facilitator answers in CAIP-2.
    const probe = await c.probe("monad-testnet");
    expect(probe).toMatchObject({
      reachable: true,
      supportsExact: true,
      signers: ["0x7f6a2850669202519f0FE8aa912451238820Db86"],
    });
    expect((await c.probe("eip155:8453")).supportsExact).toBe(false);
  });

  it("reports an unreachable facilitator instead of throwing at boot", async () => {
    const c = client(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await c.probe("monad-testnet")).toMatchObject({
      reachable: false,
      supportsExact: false,
    });
  });

  it("sends x402Version 2 and stamps the verdict with its source", async () => {
    const seen: unknown[] = [];
    const c = client((path, body) => {
      seen.push({ path, body });
      return new Response(JSON.stringify({ isValid: true, payer: payer.address }));
    });
    const verdict = await c.verify(await signed(), requirements);
    expect(verdict).toEqual({
      isValid: true,
      payer: payer.address.toLowerCase(),
      verifiedBy: "monad",
    });
    // The measured default is Monad's own envelope, not the specification's (see
    // `test/testnet/x402-facilitator.interop.test.ts`: the spec envelope answers `unsupported_scheme`).
    expect(seen[0]).toMatchObject({
      path: "/verify",
      body: {
        x402Version: 2,
        accepted: { amount: "1000" },
        resource: { url: requirements.resource },
      },
    });
  });

  it("sends the specification's envelope when a facilitator wants that one", async () => {
    const seen: unknown[] = [];
    const c = new MonadFacilitatorClient({
      baseUrl: "https://other.test",
      envelope: "spec",
      logger: noopLogger,
      fetch: (async (_u: string, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ isValid: true }));
      }) as unknown as typeof fetch,
    });
    await c.verify(await signed(), requirements);
    expect(seen[0]).toMatchObject({ paymentPayload: { x402Version: 2 }, paymentRequirements: {} });
  });

  it("reads a verdict delivered with a 4xx — a refusal about the payment is still an answer", async () => {
    // Measured: Monad answers `insufficient_funds` with HTTP 400. Treating that as a transport
    // failure would have hidden every real verdict behind a retry.
    const c = client(
      () =>
        new Response(
          JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "" }),
          { status: 400 },
        ),
    );
    expect(await c.verify(await signed(), requirements)).toMatchObject({
      isValid: false,
      invalidReason: "insufficient_funds",
      verifiedBy: "monad",
    });
    // Measured: a forged signature comes back 500, because the facilitator verifies by simulating
    // the transfer on chain and the call reverts. That is still a verdict, not an outage.
    const reverted = client(
      () =>
        new Response(
          JSON.stringify({
            isValid: false,
            invalidReason: "unexpected_error",
            invalidReasonDetails: "execution reverted",
          }),
          { status: 500 },
        ),
    );
    expect(await reverted.verify(await signed(), requirements)).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_error",
    });
    // A failure that carries no verdict is still a transport failure.
    const broken = client(() => new Response("<html>gateway error</html>", { status: 400 }));
    await expect(broken.verify(await signed(), requirements)).rejects.toMatchObject({
      code: "FH_TRANSPORT",
    });
  });

  it("can be told to discover the envelope, and remembers the winner", async () => {
    const bodies: string[] = [];
    const c = new MonadFacilitatorClient({
      baseUrl: "https://facilitator.test/",
      envelope: null,
      logger: noopLogger,
      fetch: (async (_u: string, init?: RequestInit) =>
        handler(JSON.parse(String(init?.body)))) as unknown as typeof fetch,
    });
    const handler = (body: unknown) => {
      const shape = Object.keys(body as object).includes("paymentPayload") ? "spec" : "monad-doc";
      bodies.push(shape);
      return shape === "spec"
        ? new Response(JSON.stringify({ error: "unknown field" }), { status: 400 })
        : new Response(JSON.stringify({ isValid: true }));
    };
    const payload = await signed();
    expect((await c.verify(payload, requirements)).isValid).toBe(true);
    expect(bodies).toEqual(["spec", "monad-doc"]);
    // Once pinned, it stops guessing.
    await c.verify(payload, requirements);
    expect(bodies).toEqual(["spec", "monad-doc", "monad-doc"]);
  });
});

describe("FallbackFacilitator — resilience, not a bypass", () => {
  const local = new LocalFacilitator({ network: "monad-testnet", now: () => BigInt(NOW) });
  const chain = (primary: X402Facilitator, onDecision?: (v: string) => void) =>
    new FallbackFacilitator({
      primary,
      fallback: local,
      logger: noopLogger,
      ...(onDecision ? { onDecision } : {}),
    });

  const stub = (verify: X402Facilitator["verify"]): X402Facilitator => ({
    supported: async () => [],
    verify,
    settle: async () => ({ success: false, network: "x" }),
  });

  it("uses the facilitator's verdict when it has one", async () => {
    const decisions: string[] = [];
    const c = chain(
      stub(async () => ({ isValid: true, verifiedBy: "monad" })),
      (v) => decisions.push(v),
    );
    expect(await c.verify(await signed(), requirements)).toMatchObject({ verifiedBy: "monad" });
    expect(decisions).toEqual(["monad"]);
    expect(c.lastVerifiedBy).toBe("monad");
  });

  it("verifies locally when the facilitator is unreachable or declines the asset", async () => {
    const unreachable = chain(
      stub(async () => {
        const { TransportError } = await import("@firsthand/core");
        throw new TransportError("FH_TRANSPORT", "facilitator unreachable");
      }),
    );
    expect(await unreachable.verify(await signed(), requirements)).toMatchObject({
      isValid: true,
      verifiedBy: "local",
    });
    const declines = chain(
      stub(async () => ({ isValid: false, invalidReason: "unsupported_asset" })),
    );
    expect(await declines.verify(await signed(), requirements)).toMatchObject({
      isValid: true,
      verifiedBy: "local",
    });
  });

  it("never second-guesses a verdict about the payment itself", async () => {
    const forgery = vi.fn(async () => ({
      isValid: false as const,
      invalidReason: "invalid_exact_evm_payload_signature",
    }));
    const c = chain(stub(forgery));
    // The authorization here is perfectly good; the point is that a fatal refusal stands.
    expect(await c.verify(await signed(), requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
      verifiedBy: "monad",
    });
    expect(forgery).toHaveBeenCalledOnce();
  });
});
