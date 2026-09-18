import { MemoryBlobStore, MemoryTransport } from "@firsthand/adapters";
import type { Deployment } from "@firsthand/contracts/deployments";
import { describe, expect, it } from "vitest";
import { assertChain, clientOptionsFromDeployment } from "./deployment.js";

/**
 * The point of this module is that no app transcribes addresses into its own env vars any more, so
 * these check the mapping itself: what the deployment file says is what the client signs against.
 */
const addr = (b: string) => `0x${b.repeat(20)}` as const;

const deployment = {
  chainId: 31337,
  PrincipalRegistry: addr("a1"),
  Rescissions: addr("a2"),
  PassportAnchors: addr("a3"),
  PassportAnchorsBaseline: addr("a3"),
  PassportAnchorsPaged: addr("a4"),
  GrantManager: addr("a5"),
  ReceiptLedger: addr("a6"),
  RoyaltyRouter: addr("a7"),
  FirsthandLens: addr("a8"),
  USDC: addr("a9"),
  genesis: 1_700_000_000,
  epochLength: 604_800,
  anchorsLayout: "baseline",
  revealWindowBlocks: 1000,
} as const satisfies Deployment;

const publicClient = { getChainId: async () => 31337 } as never;

describe("clientOptionsFromDeployment", () => {
  it("binds the domain, epochs and addresses from the file", () => {
    const options = clientOptionsFromDeployment({
      deployment,
      publicClient,
      blobs: new MemoryBlobStore(),
      transport: new MemoryTransport(),
    });
    // The anchors contract is the passport EIP-712 verifyingContract (ADR-0002/0009) — not the
    // registry, and not the grant manager. Getting this wrong yields FH_SIG_INVALID at the gateway.
    expect(options.domain).toEqual({ chainId: 31337n, verifyingContract: addr("a3") });
    expect(options.epochs).toEqual({ genesis: 1_700_000_000n, length: 604_800n });
    expect(options.addresses).toEqual({
      grantManager: addr("a5"),
      rescissions: addr("a2"),
      principalRegistry: addr("a1"),
    });
    expect(options.transport.kind).toBe("memory");
  });

  it("anchors through the explicit transport when there is no wallet (a relayed client can anchor)", () => {
    const options = clientOptionsFromDeployment({
      deployment,
      publicClient,
      blobs: new MemoryBlobStore(),
      transport: new MemoryTransport(),
    });
    expect((options.anchors as unknown as { canWrite: boolean }).canWrite).toBe(true);
  });

  it("refuses to guess a transport when there is neither a wallet nor an explicit one", () => {
    expect(() =>
      clientOptionsFromDeployment({ deployment, publicClient, blobs: new MemoryBlobStore() }),
    ).toThrow(/walletClient or an explicit transport/);
  });

  it("passes namespaces and clock through when given", () => {
    const clock = () => 42n;
    const options = clientOptionsFromDeployment({
      deployment,
      publicClient,
      blobs: new MemoryBlobStore(),
      transport: new MemoryTransport(),
      namespaces: [{ ns: 0, label: "notes" }],
      clock,
    });
    expect(options.namespaces).toEqual([{ ns: 0, label: "notes" }]);
    expect(options.clock).toBe(clock);
  });
});

describe("assertChain", () => {
  it("accepts the chain the deployment describes", async () => {
    await expect(assertChain(publicClient, deployment, "test")).resolves.toBeUndefined();
  });

  it("refuses a node on another chain, naming both", async () => {
    const wrong = { getChainId: async () => 10143 } as never;
    await expect(assertChain(wrong, deployment, "DEPLOYMENTS_FILE")).rejects.toThrow(
      /chain 10143.*DEPLOYMENTS_FILE.*chain 31337/,
    );
  });
});
