import { PrincipalRegistryAbi } from "@firsthand/contracts/abi";
import { BaseError, encodeErrorResult, RpcRequestError } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  classifySendError,
  explainRevert,
  insufficientFundsError,
  messagesOf,
  revertData,
  sendWithNonceRetry,
} from "./send.js";

/** A node error the way viem carries it: BaseError → RpcRequestError with the RPC body's `data`. */
function nodeError(message: string, data?: `0x${string}`): BaseError {
  const rpc = new RpcRequestError({
    body: {},
    error: { code: 3, message, ...(data === undefined ? {} : { data }) },
    url: "http://rpc.test",
  });
  return new BaseError("Execution reverted.", { cause: rpc, details: message });
}

describe("classifySendError", () => {
  it("names the failure kinds a paying key meets, whatever the node's wording", () => {
    expect(classifySendError(nodeError("nonce too low")).kind).toBe("nonce");
    expect(classifySendError(nodeError("replacement transaction underpriced")).kind).toBe("nonce");
    expect(classifySendError(nodeError("Signer had insufficient balance")).kind).toBe("funds");
    expect(classifySendError(nodeError("insufficient funds for gas * price + value")).kind).toBe(
      "funds",
    );
    // anvil / geth, at estimateGas, for a sender whose balance covers no gas at all
    expect(classifySendError(nodeError("Out of gas: gas required exceeds allowance: 0")).kind).toBe(
      "funds",
    );
    expect(classifySendError(new Error("fetch failed: ECONNREFUSED")).kind).toBe("rpc");
    expect(classifySendError(nodeError("execution reverted")).kind).toBe("revert");
    expect(classifySendError(new Error("something else")).kind).toBe("unknown");
    expect(classifySendError("plain string").detail).toBe("plain string");
  });

  it("keeps the most specific message first", () => {
    const messages = messagesOf(nodeError("nonce too low"));
    expect(messages[0]).toBe("nonce too low");
  });
});

describe("revert decoding", () => {
  const raw = encodeErrorResult({
    abi: PrincipalRegistryAbi,
    errorName: "EpochNotMonotone",
    args: [3n, 5n],
  });

  it("finds raw revert bytes on a plain eth_call failure and decodes them against the ABIs", () => {
    const cause = nodeError("execution reverted", raw);
    expect(revertData(cause)).toBe(raw);
    const why = explainRevert(cause, [PrincipalRegistryAbi]);
    expect(why.reason).toBe("EpochNotMonotone");
    expect(why.args).toEqual(["3", "5"]);
    expect(classifySendError(cause).kind).toBe("revert");
  });

  it("reads nested `{ data: { data } }` carriers and gives up honestly on unknown selectors", () => {
    const rpc = new RpcRequestError({
      body: {},
      error: { code: 3, message: "execution reverted", data: { data: raw } as never },
      url: "http://rpc.test",
    });
    expect(revertData(new BaseError("x", { cause: rpc }))).toBe(raw);
    const why = explainRevert(nodeError("execution reverted", "0xdeadbeef"), [
      PrincipalRegistryAbi,
    ]);
    expect(why.reason).toBeNull();
    expect(why.raw).toBe("0xdeadbeef");
    expect(revertData(new Error("no chain"))).toBeNull();
  });
});

describe("sendWithNonceRetry", () => {
  const account = (reset: () => void) =>
    ({
      address: `0x${"aa".repeat(20)}`,
      nonceManager: { reset },
    }) as unknown as PrivateKeyAccount;

  it("retries a nonce collision after resetting the nonce manager, then succeeds", async () => {
    const reset = vi.fn();
    let calls = 0;
    const hash = await sendWithNonceRetry(
      async () => {
        calls++;
        if (calls === 1) throw nodeError("nonce too low");
        return "0xhash";
      },
      { account: account(reset), chainId: 10143, sleep: async () => undefined },
    );
    expect(hash).toBe("0xhash");
    expect(calls).toBe(2);
    expect(reset).toHaveBeenCalledWith({ address: `0x${"aa".repeat(20)}`, chainId: 10143 });
  });

  it("gives up after the configured attempts and never retries other failures", async () => {
    const reset = vi.fn();
    let calls = 0;
    await expect(
      sendWithNonceRetry(
        async () => {
          calls++;
          throw nodeError("nonce too low");
        },
        { account: account(reset), chainId: 1, attempts: 2, sleep: async () => undefined },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      sendWithNonceRetry(
        async () => {
          calls++;
          throw nodeError("Signer had insufficient balance");
        },
        { account: account(reset), chainId: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/insufficient/);
    expect(calls).toBe(1);
  });
});

describe("insufficientFundsError", () => {
  it("is the one chain error with its own code, naming the payer and never a user key", () => {
    const err = insufficientFundsError(
      "relay: out of gas",
      `0x${"cc".repeat(20)}`,
      nodeError("Signer had insufficient balance"),
    );
    expect(err.code).toBe("FH_INSUFFICIENT_FUNDS");
    expect(err.retryable).toBe(false);
    expect(err.context).toEqual({
      payer: `0x${"cc".repeat(20)}`,
      detail: "Signer had insufficient balance",
    });
  });
});
