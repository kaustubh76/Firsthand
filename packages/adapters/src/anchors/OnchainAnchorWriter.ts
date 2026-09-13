import { PassportAnchorsBaselineAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  type BatchProof,
  type Bytes32,
  ChainError,
  ConfigError,
  ValidationError,
} from "@firsthand/core";
import {
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type {
  AnchorLayout,
  AnchorRef,
  AnchorRequest,
  AnchorWriter,
} from "../ports/AnchorWriter.js";

export interface OnchainAnchorWriterOptions {
  readonly address: Address;
  readonly layout: Exclude<AnchorLayout, "memory">;
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Omit for a read-only instance (the gateway never signs): `anchor()` then throws ConfigError. */
  readonly walletClient?: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

type DepositKeys16 = readonly [
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
];

/**
 * PassportAnchors client over viem (Baseline and Paged share the ABI). Writes are simulated first so a
 * refusal surfaces as a decoded custom error (`ChainError.context.reason`) instead of a burned tx; the
 * relayer wallet pays gas, authorisation is the deposit-key signature inside the request (decision #11).
 */
export class OnchainAnchorWriter implements AnchorWriter {
  readonly layout: Exclude<AnchorLayout, "memory">;
  readonly address: Address;
  readonly #public: PublicClient<Transport, Chain>;
  readonly #wallet: WalletClient<Transport, Chain, PrivateKeyAccount> | null;

  constructor(options: OnchainAnchorWriterOptions) {
    this.layout = options.layout;
    this.address = options.address;
    this.#public = options.publicClient;
    this.#wallet = options.walletClient ?? null;
  }

  get canWrite(): boolean {
    return this.#wallet !== null;
  }

  async anchor(request: AnchorRequest): Promise<AnchorRef> {
    if (this.#wallet === null) {
      throw new ConfigError("OnchainAnchorWriter is read-only: no relayer wallet configured");
    }
    if (request.depositKeys.length !== 16) {
      throw new ValidationError("anchor: depositKeys must have exactly 16 entries");
    }
    const args = [
      request.principalId,
      request.ns,
      request.epoch,
      request.batchRoot,
      request.termsHash,
      request.nonce,
      request.depositKeys as unknown as DepositKeys16,
      request.depositSig,
    ] as const;

    const wallet = this.#wallet;
    let simulatedRequest: Parameters<typeof wallet.writeContract>[0];
    try {
      const sim = await this.#public.simulateContract({
        account: wallet.account,
        address: this.address,
        abi: PassportAnchorsBaselineAbi,
        functionName: "anchor",
        args,
      });
      simulatedRequest = sim.request;
    } catch (cause) {
      throw decodeRevert(cause, "anchor refused");
    }

    try {
      const hash = await wallet.writeContract(simulatedRequest);
      const receipt = await this.#public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new ChainError("anchor transaction reverted", { context: { hash } });
      }
      const record = await this.anchorOf(request.batchRoot);
      return {
        batchRoot: request.batchRoot,
        batchIndex: record?.batchIndex ?? 0,
        blockNumber: receipt.blockNumber,
        txHash: hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (cause) {
      if (cause instanceof ChainError) throw cause;
      throw new ChainError("anchor failed", { cause, retryable: true });
    }
  }

  isAnchored(batchRoot: Bytes32): Promise<boolean> {
    return this.#public.readContract({
      address: this.address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "isAnchored",
      args: [batchRoot],
    });
  }

  async anchorBlock(batchRoot: Bytes32): Promise<bigint | null> {
    const block = await this.#public.readContract({
      address: this.address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "anchorBlock",
      args: [batchRoot],
    });
    return block === 0n ? null : block;
  }

  async anchorOf(batchRoot: Bytes32): Promise<{
    principalId: Bytes32;
    termsHash: Bytes32;
    epoch: bigint;
    blockNumber: bigint;
    ns: number;
    batchIndex: number;
  } | null> {
    const r = await this.#public.readContract({
      address: this.address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "anchorOf",
      args: [batchRoot],
    });
    if (r.principalId === `0x${"00".repeat(32)}`) return null;
    return {
      principalId: r.principalId,
      termsHash: r.termsHash,
      epoch: r.epoch,
      blockNumber: r.blockNumber,
      ns: r.ns,
      batchIndex: r.batchIndex,
    };
  }

  /** On-chain inclusion check: anchored root AND Merkle membership at `proof.index`. */
  isIncluded(batchRoot: Bytes32, passportId: Bytes32, proof: BatchProof): Promise<boolean> {
    return this.#public.readContract({
      address: this.address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "isIncluded",
      args: [
        batchRoot,
        passportId,
        {
          index: proof.index,
          siblings: proof.siblings as unknown as readonly [
            Bytes32,
            Bytes32,
            Bytes32,
            Bytes32,
            Bytes32,
            Bytes32,
            Bytes32,
            Bytes32,
          ],
        },
      ],
    });
  }

  domainSeparator(): Promise<Bytes32> {
    return this.#public.readContract({
      address: this.address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "domainSeparator",
    });
  }
}

/** Turns a viem simulation failure into a ChainError carrying the decoded custom error, when there is one. */
export function decodeRevert(cause: unknown, message: string): ChainError {
  if (cause instanceof BaseError) {
    const reverted = cause.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const reason = reverted.data?.errorName ?? reverted.reason ?? "unknown";
      const args = (reverted.data?.args ?? []).map((a) =>
        typeof a === "bigint" ? a.toString() : a,
      );
      return new ChainError(`${message}: ${reason}`, { cause, context: { reason, args } });
    }
    return new ChainError(`${message}: ${cause.shortMessage}`, { cause, retryable: true });
  }
  return new ChainError(message, { cause, retryable: true });
}
