import { FirsthandLensAbi, GrantManagerAbi, PrincipalRegistryAbi } from "@firsthand/contracts/abi";
import type { Address, Bytes32, GrantStatus, PrincipalStatus } from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";

/** Thin typed readers over the deployed contracts. Writes go through the verbs and a TxTransport. */
export interface ContractAddresses {
  readonly principalRegistry: Address;
  readonly grantManager: Address;
  readonly firsthandLens: Address;
  readonly passportAnchors: Address;
  readonly rescissions: Address;
}

export class ContractReaders {
  readonly #client: PublicClient<Transport, Chain>;
  readonly addresses: ContractAddresses;

  constructor(client: PublicClient<Transport, Chain>, addresses: ContractAddresses) {
    this.#client = client;
    this.addresses = addresses;
  }

  async principal(principalId: Bytes32): Promise<{
    p256KeyCommit: Bytes32;
    lastAttestedEpoch: bigint;
    status: PrincipalStatus;
    thawEpoch: bigint;
  }> {
    const p = await this.#client.readContract({
      address: this.addresses.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "principal",
      args: [principalId],
    });
    return {
      p256KeyCommit: p.p256KeyCommit,
      lastAttestedEpoch: p.lastAttestedEpoch,
      status: p.status as PrincipalStatus,
      thawEpoch: p.thawEpoch,
    };
  }

  depositKeysRoot(principalId: Bytes32, epoch: bigint): Promise<Bytes32> {
    return this.#client.readContract({
      address: this.addresses.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "depositKeysRoot",
      args: [principalId, epoch],
    });
  }

  async principalStatus(principalId: Bytes32): Promise<PrincipalStatus> {
    const s = await this.#client.readContract({
      address: this.addresses.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "effectiveStatus",
      args: [principalId],
    });
    return s as PrincipalStatus;
  }

  isLive(principalId: Bytes32): Promise<boolean> {
    return this.#client.readContract({
      address: this.addresses.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "isLive",
      args: [principalId],
    });
  }

  registryDomainSeparator(): Promise<Bytes32> {
    return this.#client.readContract({
      address: this.addresses.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "domainSeparator",
    });
  }

  registryEpoch(): Promise<bigint> {
    return this.#client.readContract({
      address: this.addresses.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "currentEpoch",
    });
  }

  currentEpoch(): Promise<bigint> {
    return this.#client.readContract({
      address: this.addresses.firsthandLens,
      abi: FirsthandLensAbi,
      functionName: "currentEpoch",
    });
  }

  async grantStatus(grantId: Bytes32): Promise<GrantStatus> {
    const s = await this.#client.readContract({
      address: this.addresses.grantManager,
      abi: GrantManagerAbi,
      functionName: "effectiveStatus",
      args: [grantId],
    });
    return s as GrantStatus;
  }

  domainSeparator(): Promise<Bytes32> {
    return this.#client.readContract({
      address: this.addresses.firsthandLens,
      abi: FirsthandLensAbi,
      functionName: "domainSeparator",
    });
  }
}
