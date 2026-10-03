import { z } from "zod";
import type { Address, Bytes32, Hex } from "../bytes.js";

/** Zod schemas for wire formats. Internal APIs take already-typed values; these guard the edges. */

export const HexSchema = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/, "expected lowercase 0x hex")
  .transform((v) => v as Hex);

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "expected 32-byte hex")
  .transform((v) => v as Bytes32);

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "expected lowercase 20-byte hex address")
  .transform((v) => v as Address);

/** P-256 `r ‖ s`, low-s — what `verifyP256` and `P256.sol` both take. */
export const Signature64Schema = z
  .string()
  .regex(/^0x[0-9a-f]{128}$/, "expected 64-byte hex signature")
  .transform((v) => v as Hex);

export const Signature65Schema = z
  .string()
  .regex(/^0x[0-9a-f]{130}$/, "expected 65-byte hex signature")
  .transform((v) => v as Hex);

/** Decimal string → bigint. JSON numbers cannot carry uint64/uint256 safely. */
export const BigIntStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "expected a decimal integer string")
  .transform((v) => BigInt(v));

export const Uint64Schema = BigIntStringSchema.refine((v) => v < 1n << 64n, "exceeds uint64");
export const Uint256Schema = BigIntStringSchema.refine((v) => v < 1n << 256n, "exceeds uint256");

export const Uint8Schema = z.number().int().min(0).max(255);
export const Uint32Schema = z.number().int().min(0).max(0xffff_ffff);
