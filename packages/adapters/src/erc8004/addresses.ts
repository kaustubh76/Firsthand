import type { Address } from "@firsthand/core";

export interface Erc8004Addresses {
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
}

/**
 * The reference registries are deployed with CREATE2 at the same address on every chain they
 * support (erc-8004/erc-8004-contracts README): one pair for mainnets, one for testnets. Monad
 * testnet (10143) is verified live — `getVersion()` answers "2.0.0". Local chains have none.
 */
const TESTNET: Erc8004Addresses = {
  identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  reputationRegistry: "0x8004b663056a597dffe9eccc1965a193b7388713",
};
const MAINNET: Erc8004Addresses = {
  identityRegistry: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
  reputationRegistry: "0x8004baa17c55a88189ae136b182e5fda19de9b63",
};

export function erc8004Addresses(chainId: bigint | number): Erc8004Addresses | null {
  switch (Number(chainId)) {
    case 10143:
      return TESTNET;
    case 143:
      return MAINNET;
    default:
      return null;
  }
}
