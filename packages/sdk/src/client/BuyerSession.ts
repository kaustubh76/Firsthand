import type { TxTransport, TypedDataSigner } from "@firsthand/adapters";
import { type Address, type Bytes32, cardIdOf, type Terms } from "@firsthand/core";
import {
  type GranteeKeyPair,
  generateGranteeKeypair,
  granteeKeyFromSeed,
  SecretBytes,
} from "@firsthand/crypto";
import { planAcceptTerms, planRegisterCard, sendTx } from "../verbs/acceptTerms.js";
import type { SentTx } from "../verbs/enroll.js";
import {
  checkServed,
  fetchWrap,
  openQueried,
  type QueryRequest,
  type QueryResult,
  query,
} from "../verbs/query.js";

/**
 * The buyer/grantee side: an EVM key that pays (x402) and signs terms acceptance, plus an X25519
 * key that vault keys are wrapped to. Both are the *agent's* keys — never a principal's.
 */
export interface BuyerKeys {
  /** secp256k1 private key of the agent's EVM account (card owner + payer). */
  readonly ownerKey: Uint8Array;
  readonly signer: TypedDataSigner;
  readonly grantee: GranteeKeyPair;
}

export function createBuyerKeys(
  ownerKey: Uint8Array,
  signer: TypedDataSigner,
  granteeSeed?: Uint8Array,
): BuyerKeys {
  return {
    ownerKey,
    signer,
    grantee: granteeSeed ? granteeKeyFromSeed(granteeSeed) : generateGranteeKeypair(),
  };
}

export interface BuyerSessionOptions {
  readonly keys: BuyerKeys;
  readonly grantManager: Address;
  readonly chainId: bigint;
  readonly transport: TxTransport;
  readonly fetch?: typeof fetch;
}

export class BuyerSession {
  readonly cardId: Bytes32;
  readonly owner: Address;
  readonly #o: BuyerSessionOptions;
  readonly #ownerKey: SecretBytes;

  constructor(options: BuyerSessionOptions) {
    this.#o = options;
    this.owner = options.keys.signer.address.toLowerCase() as Address;
    this.#ownerKey = new SecretBytes(new Uint8Array(options.keys.ownerKey), "card-owner");
    this.cardId = cardIdOf(this.owner, options.keys.grantee.publicKey);
  }

  get encryptionPubKey(): Bytes32 {
    return this.#o.keys.grantee.publicKey;
  }

  registerCard(): Promise<SentTx> {
    return sendTx(
      this.#o.transport,
      planRegisterCard(
        { ownerKey: this.#ownerKey, owner: this.owner, encryptionPubKey: this.encryptionPubKey },
        this.#o.grantManager,
      ),
    );
  }

  acceptTerms(principalId: Bytes32, terms: Terms, nonce?: Bytes32) {
    const plan = planAcceptTerms(
      { ownerKey: this.#ownerKey, owner: this.owner, encryptionPubKey: this.encryptionPubKey },
      this.#o.grantManager,
      this.#o.chainId,
      principalId,
      terms,
      nonce,
    );
    return { plan, send: () => sendTx(this.#o.transport, plan.tx) };
  }

  query(
    request: QueryRequest,
    approve?: (r: QueryResult["paid"]["requirements"]) => boolean | Promise<boolean>,
  ): Promise<QueryResult> {
    return query(request, {
      signer: this.#o.keys.signer,
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      ...(approve ? { approve } : {}),
    });
  }

  /** Query, verify what came back, fetch the grant wrap, and open the plaintext. */
  async queryAndOpen(
    request: QueryRequest,
    domain: { chainId: bigint; verifyingContract: Address },
  ): Promise<{ result: QueryResult; plaintext: Uint8Array }> {
    const result = await this.query(request);
    if (!checkServed(result, domain))
      throw new Error("served passport failed buyer-side verification");
    const wrap = await fetchWrap(request.gatewayUrl, request.grantId, this.#o.fetch);
    return {
      result,
      plaintext: openQueried(result, this.#o.keys.grantee.secretKey, wrap, request.grantId),
    };
  }

  close(): void {
    this.#ownerKey.dispose();
    this.#o.keys.grantee.secretKey.dispose();
  }
}
