import type { PreparedTx, TxTransport } from "@firsthand/adapters";
import { GrantManagerAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  acceptTermsStructHash,
  authorityDigest,
  type Bytes32,
  cardIdOf,
  type Eip712Domain,
  type Hex,
  hashTerms,
  type Terms,
} from "@firsthand/core";
import { randomNonce, type SecretBytes, signPassportDigest } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { SentTx } from "./enroll.js";

/**
 * Buyer side of consent (README §7.2): the grantee's card owner accepts the terms a principal
 * published for a namespace. Card owners are secp256k1 keys (ADR-0011).
 */
export interface AcceptTermsPlan {
  readonly cardId: Bytes32;
  readonly principalId: Bytes32;
  readonly termsHash: Bytes32;
  readonly nonce: Bytes32;
  readonly cardSig: Hex;
  readonly tx: PreparedTx;
}

export interface CardKeys {
  /** Card owner's secp256k1 private key (the agent's EVM key). */
  readonly ownerKey: SecretBytes;
  readonly owner: Address;
  /** X25519 public key vault keys are wrapped to. */
  readonly encryptionPubKey: Bytes32;
}

export function planRegisterCard(card: CardKeys, grantManager: Address): PreparedTx {
  return {
    to: grantManager,
    data: encodeFunctionData({
      abi: GrantManagerAbi,
      functionName: "registerCard",
      args: [card.owner, card.encryptionPubKey],
    }),
  };
}

export function planAcceptTerms(
  card: CardKeys,
  grantManager: Address,
  chainId: bigint,
  principalId: Bytes32,
  terms: Terms,
  nonce: Bytes32 = randomNonce(),
): AcceptTermsPlan {
  const cardId = cardIdOf(card.owner, card.encryptionPubKey);
  const termsHash = hashTerms(terms);
  const domain: Eip712Domain = { chainId, verifyingContract: grantManager };
  const digest = authorityDigest(
    acceptTermsStructHash(cardId, principalId, terms.ns, termsHash, nonce),
    domain,
  );
  const cardSig = signPassportDigest(card.ownerKey, digest);
  return {
    cardId,
    principalId,
    termsHash,
    nonce,
    cardSig,
    tx: {
      to: grantManager,
      data: encodeFunctionData({
        abi: GrantManagerAbi,
        functionName: "acceptTerms",
        args: [
          cardId,
          principalId,
          { ...terms, payees: [...terms.payees], weights: [...terms.weights] },
          nonce,
          cardSig,
        ],
      }),
    },
  };
}

export async function sendTx(transport: TxTransport, tx: PreparedTx): Promise<SentTx> {
  const ref = await transport.send(tx);
  return { txHash: ref.hash, submittedAt: ref.submittedAt };
}
