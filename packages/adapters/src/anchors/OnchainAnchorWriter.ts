import { PassportAnchorsBaselineAbi } from "@firsthand/contracts/abi";
import { type Address, type Bytes32, ChainError, ValidationError } from "@firsthand/core";
import type { Chain, PublicClient, Transport, WalletClient } from "viem";
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
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

/**
 * Writes anchors to a deployed PassportAnchors (Baseline or Paged — same ABI). The relayer wallet
 * pays gas; authorization is the deposit-key signature inside the request (decision #11).
 */
export class OnchainAnchorWriter implements AnchorWriter {
  readonly layout: Exclude<AnchorLayout, "memory">;
  readonly #address: Address;
  readonly #public: PublicClient<Transport, Chain>;
  readonly #wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;

  constructor(options: OnchainAnchorWriterOptions) {
    this.layout = options.layout;
    this.#address = options.address;
    this.#public = options.publicClient;
    this.#wallet = options.walletClient;
  }

  async anchor(request: AnchorRequest): Promise<AnchorRef> {
    if (request.depositKeys.length !== 16) {
      throw new ValidationError("anchor: depositKeys must have exactly 16 entries");
    }
    const keys = request.depositKeys as unknown as readonly [
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
    try {
      const hash = await this.#wallet.writeContract({
        address: this.#address,
        abi: PassportAnchorsBaselineAbi,
        functionName: "anchor",
        args: [
          request.principalId,
          request.ns,
          request.epoch,
          request.batchRoot,
          request.termsHash,
          request.nonce,
          keys,
          request.depositSig,
        ],
      });
      const receipt = await this.#public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new ChainError("anchor transaction reverted", { context: { hash } });
      }
      const batchIndex = await this.#public.readContract({
        address: this.#address,
        abi: PassportAnchorsBaselineAbi,
        functionName: "batchCount",
        args: [request.principalId, request.ns, request.epoch],
      });
      return {
        batchRoot: request.batchRoot,
        batchIndex: Number(batchIndex) - 1,
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
      address: this.#address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "isAnchored",
      args: [batchRoot],
    });
  }

  async anchorBlock(batchRoot: Bytes32): Promise<bigint | null> {
    const block = await this.#public.readContract({
      address: this.#address,
      abi: PassportAnchorsBaselineAbi,
      functionName: "anchorBlock",
      args: [batchRoot],
    });
    return block === 0n ? null : block;
  }
}
