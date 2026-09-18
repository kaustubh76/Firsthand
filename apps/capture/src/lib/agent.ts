import type { HttpRelayTransport } from "@firsthand/adapters/client";
import type { Address, Bytes32 } from "@firsthand/core";
import { BuyerSession, createBuyerKeys } from "@firsthand/sdk/browser";
import { encodeFunctionData, type PublicClient, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "./config.js";

/**
 * The demand side, in the same browser: a throwaway AI-buyer agent with an EVM key that pays (x402)
 * and an X25519 key that vault keys are wrapped to. It stands in for the Qwen buyer of the judge
 * script so the whole first recall — grant, paid query, receipt, rescind, refusal — can run from one
 * public link. Its keys are demo material persisted in localStorage; it never holds native gas:
 * registerCard and acceptTerms go through the relay, and settlement gas is paid by the relayer.
 */
const KEY = "firsthand.agent";
const usdcAbi = parseAbi([
  "function mint(address to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);

export interface DemoAgent {
  readonly session: BuyerSession;
  readonly address: Address;
  readonly cardId: Bytes32;
  readonly encryptionPubKey: Bytes32;
  /** Set once registerCard / acceptTerms have landed for the current principal. */
  readonly persisted: AgentRecord;
}

interface AgentRecord {
  ownerKey: `0x${string}`;
  granteeSeed: `0x${string}`;
  cardRegisteredTx?: Bytes32;
  /** principalId → termsHash accepted, so a second run skips the acceptance. */
  accepted: Record<string, Bytes32>;
}

const hex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const bytes = (h: `0x${string}`): Uint8Array =>
  Uint8Array.from(h.slice(2).match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));

export function loadAgentRecord(): AgentRecord {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AgentRecord>;
      if (parsed.ownerKey && parsed.granteeSeed) {
        return {
          ownerKey: parsed.ownerKey,
          granteeSeed: parsed.granteeSeed,
          accepted: parsed.accepted ?? {},
          ...(parsed.cardRegisteredTx ? { cardRegisteredTx: parsed.cardRegisteredTx } : {}),
        };
      }
    }
  } catch {
    // fall through: a fresh agent
  }
  const record: AgentRecord = {
    ownerKey: generatePrivateKey(),
    granteeSeed: hex(crypto.getRandomValues(new Uint8Array(32))),
    accepted: {},
  };
  saveAgentRecord(record);
  return record;
}

export function saveAgentRecord(record: AgentRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // storage unavailable: the agent lives for this page only
  }
}

export function openAgent(config: AppConfig, transport: HttpRelayTransport): DemoAgent {
  const record = loadAgentRecord();
  const account = privateKeyToAccount(record.ownerKey);
  const session = new BuyerSession({
    keys: createBuyerKeys(bytes(record.ownerKey), account, bytes(record.granteeSeed)),
    grantManager: config.grantManager,
    chainId: config.chainId,
    transport,
  });
  return {
    session,
    address: account.address.toLowerCase() as Address,
    cardId: session.cardId,
    encryptionPubKey: session.encryptionPubKey,
    persisted: record,
  };
}

/** Funds the agent from the MockUSDC faucet double, through the relay (selector-scoped to `mint`). */
export function mintUsdc(
  transport: HttpRelayTransport,
  usdc: Address,
  to: Address,
  amount: bigint,
): Promise<{ hash: Bytes32 }> {
  return transport
    .send({
      to: usdc,
      data: encodeFunctionData({ abi: usdcAbi, functionName: "mint", args: [to, amount] }),
    })
    .then((ref) => ({ hash: ref.hash as Bytes32 }));
}

export function usdcBalance(publicClient: PublicClient, usdc: Address, who: Address) {
  return publicClient.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [who],
  });
}

/** Whole USDC with six decimals, for display. */
export const formatUsdc = (units: bigint): string => {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} USDC` : `${whole} USDC`;
};
