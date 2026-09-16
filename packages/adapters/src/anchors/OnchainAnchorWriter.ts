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
  type Abi,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
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
import type { PreparedTx, TxTransport } from "../ports/TxTransport.js";

export interface OnchainAnchorWriterOptions {
  readonly address: Address;
  readonly layout: Exclude<AnchorLayout, "memory">;
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Omit for a read-only instance (the gateway never signs): `anchor()` then throws ConfigError. */
  readonly walletClient?: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /**
   * Alternative write path for callers that hold no key — the capture PWA relays through the
   * gateway. Reads still go through `publicClient`, because a `TxRef` carries no receipt and
   * `AnchorRef.blockNumber` is load-bearing for manifests.
   */
  readonly transport?: TxTransport;
}

/**
 * The anchor calldata, with no client involved — so a keyless caller can hand it to a relay and get
 * byte-identical calldata to what this writer would have sent itself.
 */
export function prepareAnchorTx(address: Address, request: AnchorRequest): PreparedTx {
  if (request.depositKeys.length !== 16) {
    throw new ValidationError("anchor: depositKeys must have exactly 16 entries");
  }
  return {
    to: address,
    data: encodeFunctionData({
      abi: PassportAnchorsBaselineAbi,
      functionName: "anchor",
      args: [
        request.principalId,
        request.ns,
        request.epoch,
        request.batchRoot,
        request.termsHash,
        request.nonce,
        request.depositKeys as unknown as DepositKeys16,
        request.depositSig,
      ],
    }),
  };
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
  readonly #transport: TxTransport | null;

  constructor(options: OnchainAnchorWriterOptions) {
    this.layout = options.layout;
    this.address = options.address;
    this.#public = options.publicClient;
    this.#wallet = options.walletClient ?? null;
    this.#transport = options.transport ?? null;
  }

  get canWrite(): boolean {
    return this.#wallet !== null || this.#transport !== null;
  }

  async anchor(request: AnchorRequest): Promise<AnchorRef> {
    if (this.#wallet === null && this.#transport === null) {
      throw new ConfigError(
        "OnchainAnchorWriter is read-only: configure a relayer wallet or a relay transport",
      );
    }
    // Validate once, before either write path: `address[16]` is fixed-size, so a short array
    // fails deep inside viem's encoder with a far worse message.
    if (request.depositKeys.length !== 16) {
      throw new ValidationError("anchor: depositKeys must have exactly 16 entries");
    }
    if (this.#wallet === null) return this.#anchorViaTransport(request);
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

  /**
   * Relayed write: the caller holds no key, so the gateway submits the same calldata and we recover
   * the block and batch index by reading the chain afterwards — `TxRef` carries neither.
   */
  async #anchorViaTransport(request: AnchorRequest): Promise<AnchorRef> {
    const transport = this.#transport as TxTransport;
    const tx = prepareAnchorTx(this.address, request);
    // Simulate first so a refusal is a decoded reason here rather than a relayed transaction that
    // reverts at someone else's expense.
    try {
      await this.#public.call({ to: tx.to, data: tx.data });
    } catch (cause) {
      throw decodeRevert(cause, "anchor refused");
    }
    const ref = await transport.send(tx);
    const receipt = await this.#public.waitForTransactionReceipt({ hash: ref.hash });
    if (receipt.status !== "success") {
      throw new ChainError("anchor transaction reverted", { context: { hash: ref.hash } });
    }
    const record = await this.anchorOf(request.batchRoot);
    return {
      batchRoot: request.batchRoot,
      batchIndex: record?.batchIndex ?? 0,
      blockNumber: receipt.blockNumber,
      txHash: ref.hash,
      gasUsed: receipt.gasUsed,
    };
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
export function decodeRevert(
  cause: unknown,
  message: string,
  abis: readonly Abi[] = [],
): ChainError {
  if (cause instanceof BaseError) {
    const reverted = cause.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      let reason = reverted.data?.errorName ?? reverted.reason;
      let args = (reverted.data?.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : a));
      const raw = reverted.raw;
      // Nested reverts (token, ledger, libraries) are not in the caller's ABI: try the extra ones.
      if (!reason && raw) {
        for (const abi of abis) {
          try {
            const decoded = decodeErrorResult({ abi, data: raw });
            reason = decoded.errorName;
            args = (decoded.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : a));
            break;
          } catch {
            // not this ABI
          }
        }
      }
      return new ChainError(`${message}: ${reason ?? "unknown"}`, {
        cause,
        context: {
          reason: reason ?? "unknown",
          args,
          raw: raw ?? null,
          selector: reverted.signature ?? null,
        },
      });
    }
    return new ChainError(`${message}: ${cause.shortMessage}`, { cause, retryable: true });
  }
  return new ChainError(message, { cause, retryable: true });
}
