import { HardwareDeviceRegistryAbi } from "@firsthand/contracts/abi";
import { type Address, type Bytes32, bytesToHex, u256be } from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";
import type { DevicePolicy, DeviceRegistryReader, DeviceView } from "../ports/DeviceRegistry.js";

export interface OnchainDeviceRegistryReaderOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly hardwareDeviceRegistry: Address;
}

/** A viem read over `HardwareDeviceRegistry.device` (ADR-0015). */
export class OnchainDeviceRegistryReader implements DeviceRegistryReader {
  readonly #c: PublicClient<Transport, Chain>;
  readonly #o: OnchainDeviceRegistryReaderOptions;
  /** Immutable on chain — constructor arguments with no setter — so one read lasts the session. */
  #policy: DevicePolicy | null = null;

  constructor(options: OnchainDeviceRegistryReaderOptions) {
    this.#c = options.publicClient;
    this.#o = options;
  }

  async device(keyCommitment: Bytes32): Promise<DeviceView | null> {
    const d = await this.#c.readContract({
      address: this.#o.hardwareDeviceRegistry,
      abi: HardwareDeviceRegistryAbi,
      functionName: "device",
      args: [keyCommitment],
    });
    // The contract returns a zeroed record for a commitment it has never seen; `registeredAt`
    // is the sentinel, as it is everywhere else in this codebase.
    if (d.registeredAt === 0n) return null;
    return {
      principalId: d.principalId,
      // Stored as two words on chain, carried as two 32-byte hexes everywhere else.
      publicKey: { x: bytesToHex(u256be(d.x)), y: bytesToHex(u256be(d.y)) },
      securityLevel: d.securityLevel,
      verifiedBootState: d.verifiedBootState,
      hasRootOfTrust: d.hasRootOfTrust,
      registeredAt: d.registeredAt,
      revokedAt: d.revokedAt,
    };
  }

  async policy(): Promise<DevicePolicy> {
    if (this.#policy !== null) return this.#policy;
    const [anchors, minimumSecurityLevel] = await Promise.all([
      this.#c.readContract({
        address: this.#o.hardwareDeviceRegistry,
        abi: HardwareDeviceRegistryAbi,
        functionName: "anchors",
      }),
      this.#c.readContract({
        address: this.#o.hardwareDeviceRegistry,
        abi: HardwareDeviceRegistryAbi,
        functionName: "minimumSecurityLevel",
      }),
    ]);
    this.#policy = { anchors: [...anchors], minimumSecurityLevel };
    return this.#policy;
  }
}
