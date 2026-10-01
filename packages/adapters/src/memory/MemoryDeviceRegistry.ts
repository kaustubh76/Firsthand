import {
  type Bytes32,
  deviceKeyCommitment,
  type P256PublicKey,
  SecurityLevel,
} from "@firsthand/core";
import type { DeviceRegistryReader, DeviceView } from "../ports/DeviceRegistry.js";
import { Recorder } from "./Recorder.js";

export interface MemoryDeviceInput {
  readonly principalId: Bytes32;
  readonly publicKey: P256PublicKey;
  /** Defaults to StrongBox; set `TRUSTED_ENVIRONMENT` to exercise the level floor. */
  readonly securityLevel?: number;
  readonly registeredAt?: bigint;
}

/**
 * In-memory twin of `HardwareDeviceRegistry`, following the contract's rules: a device is keyed by
 * its key commitment, revocation is recorded rather than deleted (a buyer auditing an old manifest
 * still needs to see that the device once existed), and the security level is whatever was stored
 * at registration.
 */
export class MemoryDeviceRegistry extends Recorder implements DeviceRegistryReader {
  readonly #devices = new Map<Bytes32, DeviceView>();
  #now: bigint;

  constructor(options: { now?: bigint } = {}) {
    super();
    this.#now = options.now ?? 0n;
  }

  setNow(now: bigint): void {
    this.#now = now;
  }

  /** Mirrors `registerDevice` once the chain has been verified. Returns the key commitment. */
  register(input: MemoryDeviceInput): Bytes32 {
    const keyCommitment = deviceKeyCommitment(input.publicKey);
    this.#devices.set(keyCommitment, {
      principalId: input.principalId,
      publicKey: input.publicKey,
      securityLevel: input.securityLevel ?? SecurityLevel.STRONG_BOX,
      registeredAt: input.registeredAt ?? this.#now,
      revokedAt: 0n,
    });
    return keyCommitment;
  }

  /** Mirrors `revokeDevice`: the record stays, with the block it stopped being live. */
  revoke(keyCommitment: Bytes32, at: bigint = this.#now): void {
    const device = this.#devices.get(keyCommitment);
    if (!device) throw new Error("MemoryDeviceRegistry.revoke: unknown device");
    this.#devices.set(keyCommitment, { ...device, revokedAt: at === 0n ? 1n : at });
  }

  async device(keyCommitment: Bytes32): Promise<DeviceView | null> {
    this.record("device", keyCommitment);
    return this.#devices.get(keyCommitment) ?? null;
  }
}
