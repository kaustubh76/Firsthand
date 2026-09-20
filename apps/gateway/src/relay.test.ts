import { GrantManagerAbi, PassportAnchorsBaselineAbi } from "@firsthand/contracts/abi";
import type { Address } from "@firsthand/core";
import { noopLogger } from "@firsthand/runtime";
import { BaseError, encodeErrorResult, RpcRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { Relay, type RelayOptions } from "./services/Relay.js";

const RELAYER = `0x${"0d".repeat(20)}` as Address;
const ANCHORS = `0x${"a1".repeat(20)}` as Address;
const USDC = `0x${"b0".repeat(20)}` as Address;
const MINT = "0x40c10f19" as const;

function nodeError(message: string, data?: `0x${string}`): BaseError {
  const rpc = new RpcRequestError({
    body: {},
    error: { code: 3, message, ...(data === undefined ? {} : { data }) },
    url: "http://rpc.test",
  });
  return new BaseError("Execution reverted.", { cause: rpc, details: message });
}

/** A relay over fake clients: `call` and `sendTransaction` are scripted per test. */
function relayWith(
  script: { call?: () => Promise<unknown>; send?: () => Promise<`0x${string}`> },
  extra: Partial<RelayOptions> = {},
) {
  const reset = vi.fn();
  const relay = new Relay({
    publicClient: { call: script.call ?? (async () => ({ data: "0x" })) } as never,
    walletClient: {
      account: { address: RELAYER, nonceManager: { reset } },
      chain: { id: 10143 },
      sendTransaction: script.send ?? (async () => `0x${"11".repeat(32)}`),
    } as never,
    allow: [ANCHORS, { address: USDC, selectors: [MINT] }],
    abis: [PassportAnchorsBaselineAbi, GrantManagerAbi],
    logger: noopLogger,
    ...extra,
  });
  return { relay, reset };
}

describe("Relay — what a keyless caller reads when the chain says no", () => {
  it("returns the decoded custom error of a simulated revert, with its arguments", async () => {
    const raw = encodeErrorResult({
      abi: PassportAnchorsBaselineAbi,
      errorName: "EpochNotAttested",
      args: [`0x${"22".repeat(32)}`, 7n],
    });
    const { relay } = relayWith({ call: async () => nodeErrorThrow("execution reverted", raw) });
    await expect(relay.send({ to: ANCHORS, data: "0x12345678" })).rejects.toMatchObject({
      code: "FH_CHAIN",
      retryable: false,
      message: expect.stringMatching(/would revert: EpochNotAttested\(0x2222.*, 7\)/),
      context: expect.objectContaining({ reason: "EpochNotAttested" }),
    });
  });

  it("does not mistake a busy RPC for a revert", async () => {
    const { relay } = relayWith({
      call: async () => {
        throw new Error("HTTP request failed: 429 Too Many Requests");
      },
    });
    await expect(relay.send({ to: ANCHORS, data: "0x12345678" })).rejects.toMatchObject({
      code: "FH_CHAIN",
      retryable: true,
      message: expect.stringMatching(/could not simulate — the RPC is busy/),
    });
  });

  it("names an empty float with its own code and the relayer's address", async () => {
    const { relay } = relayWith({
      send: async () => nodeErrorThrow("Signer had insufficient balance"),
    });
    await expect(relay.send({ to: ANCHORS, data: "0x12345678" })).rejects.toMatchObject({
      code: "FH_INSUFFICIENT_FUNDS",
      retryable: false,
      message: expect.stringContaining(`relayer ${RELAYER} is out of gas`),
    });
  });

  it("retries a nonce collision with a fresh pending nonce and still answers with the hash", async () => {
    let sends = 0;
    const { relay, reset } = relayWith({
      send: async () => {
        sends++;
        if (sends === 1) return nodeErrorThrow("nonce too low");
        return `0x${"33".repeat(32)}`;
      },
    });
    const ref = await relay.send({ to: ANCHORS, data: "0x12345678" });
    expect(ref.hash).toBe(`0x${"33".repeat(32)}`);
    expect(sends).toBe(2);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("applies a per-selector policy to the calldata before simulating", async () => {
    const call = vi.fn(async () => ({ data: "0x" }));
    const { relay } = relayWith(
      { call },
      {
        policies: [
          {
            address: USDC,
            selector: MINT,
            check: (data) => (data.endsWith("ff") ? "faucet mint: amount exceeds the cap" : null),
          },
        ],
      },
    );
    await expect(
      relay.send({ to: USDC, data: `${MINT}${"00".repeat(63)}ff` }),
    ).rejects.toMatchObject({ code: "FH_VALIDATION", message: /exceeds the cap/ });
    expect(call).not.toHaveBeenCalled();
    await expect(
      relay.send({ to: USDC, data: `${MINT}${"00".repeat(64)}` }),
    ).resolves.toMatchObject({ transport: "public" });
  });
});

function nodeErrorThrow(message: string, data?: `0x${string}`): never {
  throw nodeError(message, data);
}
