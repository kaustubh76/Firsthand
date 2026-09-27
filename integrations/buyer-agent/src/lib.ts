import {
  anvil,
  buildAgentURI,
  cardMetadata,
  createChainClients,
  HttpRelayTransport,
  monadTestnet,
  OnchainAnchorWriter,
  OnchainErc8004Registry,
  OnchainGrantReader,
  OnchainReceiptReader,
} from "@firsthand/adapters/client";
import {
  type Address,
  type Bytes32,
  epochAt,
  GrantStatus,
  grantIdOf,
  type LineageManifest,
  type PassportSidecar,
  parseSidecar,
} from "@firsthand/core";
import {
  BuyerSession,
  createBuyerKeys,
  type ManifestVerdict,
  manifestFromQueries,
  type QueryResult,
  verifyManifest,
} from "@firsthand/sdk/browser";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * What a buyer needs from a FIRSTHAND gateway, in the order a partner integrates it. Every step is
 * an SDK call or one HTTP endpoint from the discovery document; nothing here is specific to the
 * hosted deployment. The browser tier's "outside buyer" runs these same functions.
 */
export interface Discovery {
  readonly chainId: string;
  readonly rpcUrl: string | null;
  readonly contracts: Record<string, Address> | null;
  readonly x402: { asset: Address; payTo: Address };
  readonly relay: { enabled: boolean; allow?: string[] };
  readonly epochs: { genesis: string; length: string } | null;
  readonly anchorsLayout: "baseline" | "paged" | null;
  readonly erc8004: { identityRegistry: Address; reputationRegistry: Address } | null;
  readonly app?: string | null;
}

/**
 * Node's fetch reuses keep-alive sockets a serverless host may have closed; the symptom is a bare
 * "fetch failed" on an otherwise healthy endpoint. Reads are retried on any network error; writes
 * only when the connection could not be made at all (nothing was sent).
 */
const NOT_SENT = new Set(["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);
export const resilientFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (error) {
      const code = ((error as Error & { cause?: { code?: string } }).cause?.code ?? "") as string;
      const retry = attempt < 2 && (idempotent || NOT_SENT.has(code));
      if (!retry) throw error;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    // A gateway whose chain RPC is rate-limiting answers 503 + retry-after; a read is worth waiting.
    if (idempotent && (res.status === 503 || res.status === 429) && attempt < 4) {
      const after = Number(res.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(r, Math.min(5_000, (Number.isFinite(after) && after > 0 ? after : 2) * 1_000)),
      );
      continue;
    }
    return res;
  }
};

export async function discover(gatewayUrl: string): Promise<Discovery> {
  const res = await resilientFetch(`${gatewayUrl.replace(/\/+$/, "")}/.well-known/firsthand.json`);
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  return (await res.json()) as Discovery;
}

export interface ListedPassport {
  readonly passportId: Bytes32;
  readonly ns: number;
  readonly epoch: string;
  readonly price: string;
  /** Attestation class (0 unattested · 1 import · 2 device_capture); null on older sidecars. */
  readonly class: number | null;
  readonly capturedAt: string | null;
  readonly sourceTag: Bytes32 | null;
}

/** README §7.3: staleness since the namespace's newest anchor — price continuing access on it. */
export interface Freshness {
  readonly lastAnchoredAt: string | null;
  readonly halfLifeSeconds: string;
  readonly staleness: number;
}

export interface Listing {
  readonly passports: ListedPassport[];
  readonly freshness: Record<string, Freshness>;
}

export async function listPassports(
  gatewayUrl: string,
  principalId: Bytes32,
  ns?: number,
  options: { readonly class?: 0 | 1 | 2 } = {},
): Promise<ListedPassport[]> {
  return (await listing(gatewayUrl, principalId, ns, options)).passports;
}

/** The listing with its freshness block — what a buyer prices on. */
export async function listing(
  gatewayUrl: string,
  principalId: Bytes32,
  ns?: number,
  options: { readonly class?: 0 | 1 | 2 } = {},
): Promise<Listing> {
  const q = new URLSearchParams();
  if (ns !== undefined) q.set("ns", String(ns));
  if (options.class !== undefined) q.set("class", String(options.class));
  const res = await resilientFetch(
    `${gatewayUrl}/v1/principals/${principalId}/passports?${q.toString()}`,
  );
  if (!res.ok) throw new Error(`listing failed: ${res.status}`);
  const body = (await res.json()) as {
    passports: ListedPassport[];
    freshness?: Record<string, Freshness>;
  };
  return { passports: body.passports, freshness: body.freshness ?? {} };
}

export async function fetchSidecar(
  gatewayUrl: string,
  passportId: Bytes32,
): Promise<PassportSidecar> {
  const res = await resilientFetch(`${gatewayUrl}/v1/passports/${passportId}`);
  if (!res.ok) throw new Error(`the gateway does not host ${passportId} (${res.status})`);
  return parseSidecar(await res.json());
}

export interface Buyer {
  readonly session: BuyerSession;
  readonly address: Address;
  readonly cardId: Bytes32;
  readonly encryptionPubKey: Bytes32;
  readonly relay: HttpRelayTransport;
  readonly reader: ReturnType<typeof createChainClients>;
  readonly wait: (hash: Bytes32) => Promise<void>;
}

const hexBytes = (h: `0x${string}`) =>
  Uint8Array.from(h.slice(2).match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));

/** A buyer identity from a private key: an EVM account that pays, an X25519 key vaults are wrapped to. */
export function openBuyer(
  gatewayUrl: string,
  disco: Discovery,
  privateKey: `0x${string}`,
  granteeSeed: Uint8Array,
): Buyer {
  if (!disco.contracts || !disco.rpcUrl) throw new Error("this gateway runs in memory mode");
  const chain = disco.chainId === "31337" ? anvil : monadTestnet;
  const reader = createChainClients({ rpcUrl: disco.rpcUrl, chain, privateKey });
  const relay = new HttpRelayTransport({ baseUrl: gatewayUrl, fetch: resilientFetch });
  const account = privateKeyToAccount(privateKey);
  const session = new BuyerSession({
    keys: createBuyerKeys(hexBytes(privateKey), account, granteeSeed),
    grantManager: disco.contracts["GrantManager"] as Address,
    chainId: BigInt(disco.chainId),
    transport: relay,
    fetch: resilientFetch,
  });
  return {
    session,
    address: account.address.toLowerCase() as Address,
    cardId: session.cardId,
    encryptionPubKey: session.encryptionPubKey,
    relay,
    reader,
    wait: async (hash) => {
      await reader.publicClient.waitForTransactionReceipt({ hash });
    },
  };
}

const usdcAbi = parseAbi([
  "function mint(address to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);

/** Card + terms (relayed, no gas), then USDC from the faucet double where the gateway relays `mint`. */
export async function prepare(
  buyer: Buyer,
  disco: Discovery,
  sidecar: PassportSidecar,
): Promise<{
  registerCardTx: Bytes32;
  acceptTermsTx: Bytes32;
  termsHash: Bytes32;
  fundedTx: Bytes32 | null;
}> {
  const card = await buyer.session.registerCard();
  await buyer.wait(card.txHash);
  const accept = buyer.session.acceptTerms(sidecar.principalId, sidecar.terms);
  const accepted = await accept.send();
  await buyer.wait(accepted.txHash);
  let fundedTx: Bytes32 | null = null;
  const usdc = disco.x402.asset.toLowerCase() as Address;
  const balance = (await buyer.reader.publicClient.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [buyer.address],
  })) as bigint;
  if (
    balance < sidecar.terms.price * 10n &&
    (disco.relay.allow ?? []).includes(`${usdc}:0x40c10f19`)
  ) {
    const ref = await buyer.relay.send({
      to: usdc,
      data: encodeFunctionData({
        abi: usdcAbi,
        functionName: "mint",
        args: [buyer.address, sidecar.terms.price * 100n],
      }),
    });
    await buyer.wait(ref.hash as Bytes32);
    fundedTx = ref.hash as Bytes32;
  }
  return {
    registerCardTx: card.txHash,
    acceptTermsTx: accepted.txHash,
    termsHash: accept.plan.termsHash,
    fundedTx,
  };
}

/**
 * ERC-8004: an identity the human can check. Needs the buyer's own gas (one transaction) — the
 * registry is msg.sender-authorised, so this cannot ride the relay. Binds the card in metadata.
 */
export async function registerAgent(
  buyer: Buyer,
  disco: Discovery,
  gatewayUrl: string,
  name: string,
  description: string,
): Promise<{ agentId: bigint; txHash: Bytes32 }> {
  if (!disco.erc8004) throw new Error("this chain has no ERC-8004 registries");
  if (!buyer.reader.walletClient) throw new Error("registration needs a wallet");
  const registry = new OnchainErc8004Registry({
    publicClient: buyer.reader.publicClient,
    walletClient: buyer.reader.walletClient,
    addresses: disco.erc8004,
  });
  return registry.registerAgent({
    agentURI: buildAgentURI({
      name,
      description,
      owner: buyer.address,
      cardId: buyer.cardId,
      encryptionPubKey: buyer.encryptionPubKey,
      gatewayUrl,
    }),
    metadata: [cardMetadata(buyer.cardId)],
  });
}

/**
 * Monad executes asynchronously: a receipt can arrive a moment before the node's state shows the
 * balance it produced, and a transaction sent in that window is refused as unfunded. Wait for the
 * balance itself before spending it.
 */
export async function awaitBalance(
  buyer: Buyer,
  minWei: bigint,
  timeoutMs = 30_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const balance = await buyer.reader.publicClient.getBalance({ address: buyer.address });
    if (balance >= minWei) return balance;
    if (Date.now() > deadline)
      throw new Error(`balance ${balance} below ${minWei} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The link the human opens: card, X25519 key, namespace, label — and the agent id when carded. */
export function approvalLink(
  appUrl: string,
  buyer: Buyer,
  ns: number,
  label: string,
  agentId?: bigint,
): string {
  const q = new URLSearchParams({
    grant: buyer.cardId,
    pub: buyer.encryptionPubKey,
    ns: String(ns),
    from: label,
  });
  if (agentId !== undefined) q.set("agent", agentId.toString());
  return `${appUrl.replace(/\/+$/, "")}/?${q.toString()}`;
}

/** Grant ids are deterministic: poll the chain until the human's grant for this epoch is ACTIVE. */
export async function awaitGrant(
  buyer: Buyer,
  disco: Discovery,
  principalId: Bytes32,
  ns: number,
  timeoutMs = 10 * 60_000,
): Promise<Bytes32> {
  if (!disco.contracts || !disco.epochs) throw new Error("memory-mode gateway");
  const grants = new OnchainGrantReader({
    publicClient: buyer.reader.publicClient,
    grantManager: disco.contracts["GrantManager"] as Address,
    principalRegistry: disco.contracts["PrincipalRegistry"] as Address,
    receiptLedger: disco.contracts["ReceiptLedger"] as Address,
  });
  const epochs = { genesis: BigInt(disco.epochs.genesis), length: BigInt(disco.epochs.length) };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const block = await buyer.reader.publicClient.getBlock();
    const epoch = epochAt(block.timestamp, epochs);
    // The human may have granted in this epoch or the previous one while we waited.
    for (const e of [epoch, epoch - 1n]) {
      if (e < 0n) continue;
      const id = grantIdOf(principalId, buyer.cardId, ns, e);
      if ((await grants.effectiveStatus(id)) === GrantStatus.ACTIVE) return id;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("no grant appeared in time");
}

/** Pay per query, open the plaintext, keep the result for the compliance file. */
export async function buy(
  buyer: Buyer,
  gatewayUrl: string,
  disco: Discovery,
  grantId: Bytes32,
  passportId: Bytes32,
  agentId?: bigint,
): Promise<{ result: QueryResult; plaintext: Uint8Array }> {
  const domain = {
    chainId: BigInt(disco.chainId),
    verifyingContract: (disco.contracts as Record<string, Address>)["PassportAnchors"] as Address,
  };
  return buyer.session.queryAndOpen(
    { gatewayUrl, grantId, passportId, ...(agentId === undefined ? {} : { agentId }) },
    domain,
  );
}

/** The buyer's Lineage Manifest from what it paid for, verified against the chain before it is kept. */
export async function complianceFile(
  buyer: Buyer,
  disco: Discovery,
  results: readonly QueryResult[],
): Promise<{ manifest: LineageManifest; verdict: ManifestVerdict }> {
  const anchorsAddress = (disco.contracts as Record<string, Address>)["PassportAnchors"] as Address;
  const anchors = new OnchainAnchorWriter({
    address: anchorsAddress,
    layout: disco.anchorsLayout ?? "baseline",
    publicClient: buyer.reader.publicClient,
  });
  const domain = { chainId: BigInt(disco.chainId), verifyingContract: anchorsAddress };
  const headBlock = await buyer.reader.publicClient.getBlockNumber({ cacheTime: 0 });
  const manifest = await manifestFromQueries({
    domain,
    results,
    anchors,
    payer: buyer.address,
    // Claim the finality the anchors have actually reached rather than nothing at all: a file that
    // says `finalityDepth: 0` is telling its auditor to check nothing about settlement.
    headBlock,
  });
  // The buyer's own file, proving its own payments: the receipts come from ReceiptLedger, not from
  // the gateway that served the queries — which is the point of auditing one.
  const receiptLedger = (disco.contracts as Record<string, Address> | null)?.["ReceiptLedger"];
  const verdict = await verifyManifest(manifest, {
    anchors,
    headBlock,
    ...(receiptLedger
      ? {
          receipts: new OnchainReceiptReader({
            publicClient: buyer.reader.publicClient,
            receiptLedger,
          }),
        }
      : {}),
  });
  return { manifest, verdict };
}

/** What the venue has said about this agent: paid queries credited by the gateway's relayer. */
export async function reputation(
  gatewayUrl: string,
  agentId: bigint,
): Promise<{ paidQueriesHere: string; firsthandFeedbackAll: string; owner: string } | null> {
  const res = await resilientFetch(`${gatewayUrl}/v1/agents/${agentId}`);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    owner: string;
    reputation: { paidQueriesHere: string; firsthandFeedbackAll: string };
  };
  return { owner: body.owner, ...body.reputation };
}
