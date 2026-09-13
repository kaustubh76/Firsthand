import type { Address, Bytes32 } from "@firsthand/core";
import type { PaymentPayload, PaymentRequirements } from "../ports/X402Facilitator.js";

/**
 * x402 "exact" scheme typed data: EIP-3009 TransferWithAuthorization under the asset's EIP-712 domain.
 * `PaymentRequirements.extra` carries the domain (`chainId`, `name`, `version`) so buyers need no
 * out-of-band knowledge of the token.
 */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface AssetDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: bigint;
  readonly verifyingContract: Address;
}

export const USDC_DOMAIN_DEFAULTS = { name: "USD Coin", version: "2" } as const;

export function assetDomainFrom(requirements: PaymentRequirements): AssetDomain {
  const extra = (requirements.extra ?? {}) as {
    chainId?: string | number;
    name?: string;
    version?: string;
  };
  if (extra.chainId === undefined) throw new Error("payment requirements lack extra.chainId");
  return {
    name: extra.name ?? USDC_DOMAIN_DEFAULTS.name,
    version: extra.version ?? USDC_DOMAIN_DEFAULTS.version,
    chainId: BigInt(extra.chainId),
    verifyingContract: requirements.asset.toLowerCase() as Address,
  };
}

/** Minimal signer surface (viem accounts and wallet clients both satisfy it). */
export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(args: {
    domain: { name: string; version: string; chainId: bigint; verifyingContract: Address };
    types: typeof transferWithAuthorizationTypes;
    primaryType: "TransferWithAuthorization";
    message: {
      from: Address;
      to: Address;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Bytes32;
    };
  }): Promise<`0x${string}`>;
}

export interface BuildPaymentOptions {
  /** Seconds the authorization stays valid. Default: the requirements' maxTimeoutSeconds. */
  readonly validitySeconds?: number;
  readonly nonce?: Bytes32;
  readonly now?: () => number;
  readonly randomNonce?: () => Bytes32;
}

/** Signs an x402 exact payment for `requirements` from `signer`. */
export async function buildPaymentPayload(
  signer: TypedDataSigner,
  requirements: PaymentRequirements,
  options: BuildPaymentOptions = {},
): Promise<PaymentPayload> {
  const domain = assetDomainFrom(requirements);
  // Validity is judged by the chain's clock: prefer the gateway-advertised chain time over wall-clock.
  const extra = (requirements.extra ?? {}) as { chainTime?: string | number };
  const now =
    options.now !== undefined
      ? Math.floor(options.now() / 1000)
      : extra.chainTime !== undefined
        ? Number(extra.chainTime)
        : Math.floor(Date.now() / 1000);
  const validAfter = 0n;
  const validBefore = BigInt(now + (options.validitySeconds ?? requirements.maxTimeoutSeconds));
  const nonce = options.nonce ?? (options.randomNonce ?? defaultNonce)();
  const message = {
    from: signer.address.toLowerCase() as Address,
    to: requirements.payTo.toLowerCase() as Address,
    value: BigInt(requirements.maxAmountRequired),
    validAfter,
    validBefore,
    nonce,
  };
  const signature = await signer.signTypedData({
    domain,
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
  });
  return {
    x402Version: 1,
    scheme: "exact",
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}

function defaultNonce(): Bytes32 {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
