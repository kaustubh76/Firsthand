import { type Bytes32, bytesToHex, CryptoError } from "@firsthand/core";
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { SecretBytes } from "../zeroize.js";

/** A grantee's X25519 key pair. The public key is published in its ERC-8004 card (decision #12). */
export interface GranteeKeyPair {
  readonly secretKey: SecretBytes;
  readonly publicKey: Bytes32;
}

export function generateGranteeKeypair(): GranteeKeyPair {
  return granteeKeyFromSeed(randomBytes(32));
}

/** Deterministic key pair from a 32-byte seed (fixtures, agent cards derived from a card secret). */
export function granteeKeyFromSeed(seed: Uint8Array): GranteeKeyPair {
  if (seed.length !== 32) {
    throw new CryptoError("granteeKeyFromSeed: seed must be 32 bytes", {
      context: { length: seed.length },
    });
  }
  const secret = new Uint8Array(seed);
  return {
    secretKey: new SecretBytes(secret, "grantee-x25519"),
    publicKey: bytesToHex(x25519.getPublicKey(secret)),
  };
}
