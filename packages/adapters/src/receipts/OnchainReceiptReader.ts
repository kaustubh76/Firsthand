import { ReceiptLedgerAbi } from "@firsthand/contracts/abi";
import type { Address, Bytes32 } from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";

/** What `ReceiptLedger` stored when a query was paid for. No txHash — a contract cannot know its own. */
export interface ChainReceipt {
  readonly grantId: Bytes32;
  readonly payer: Address;
  readonly ns: number;
  readonly termsHash: Bytes32;
  readonly blockNumber: bigint;
  readonly epoch: bigint;
}

export interface OnchainReceiptReaderOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly receiptLedger: Address;
}

/**
 * Proves a receipt is real, in one `eth_call`.
 *
 * This is what lets a Lineage Manifest say "and it was paid for" rather than merely carrying a
 * receipt object. `ReceiptLedger`'s own docstring is the reason it reads the chain and not the
 * gateway: "Every served query leaves a receipt … so the chain — not the gateway — is the source of
 * truth." A manifest is audited precisely because the gateway's word is what is in question.
 *
 * `exists` and `receipt` are separate views on chain, but `receipt` on an unknown id returns a
 * zero-filled struct rather than reverting, so a zero `grantId` is the "never recorded" signal —
 * which is why this returns `null` instead of a struct full of zeros a caller might compare against.
 */
export class OnchainReceiptReader {
  readonly #client: PublicClient<Transport, Chain>;
  readonly #address: Address;

  constructor(options: OnchainReceiptReaderOptions) {
    this.#client = options.publicClient;
    this.#address = options.receiptLedger;
  }

  async receipt(receiptId: Bytes32): Promise<ChainReceipt | null> {
    const r = (await this.#client.readContract({
      address: this.#address,
      abi: ReceiptLedgerAbi,
      functionName: "receipt",
      args: [receiptId],
    })) as {
      grantId: Bytes32;
      payer: Address;
      ns: number;
      termsHash: Bytes32;
      blockNumber: bigint;
      epoch: bigint;
    };
    if (r.grantId === `0x${"00".repeat(32)}`) return null;
    return {
      grantId: r.grantId,
      payer: r.payer.toLowerCase() as Address,
      ns: Number(r.ns),
      termsHash: r.termsHash,
      blockNumber: BigInt(r.blockNumber),
      epoch: BigInt(r.epoch),
    };
  }
}
