import { z } from "zod";
import { GrantStatus } from "../grant/state.js";
import { Bytes32Schema, HexSchema, Uint8Schema, Uint32Schema, Uint64Schema } from "./primitives.js";

export const GrantStatusSchema = Uint8Schema.refine(
  (s): s is GrantStatus => Object.values(GrantStatus).includes(s as GrantStatus),
  "unknown grant status",
);

/** On-chain `GrantState` (README §11) in wire form. */
export const GrantStateSchema = z.object({
  granteeCard: Bytes32Schema,
  ns: Uint32Schema,
  epochStart: Uint64Schema,
  /** 0 while ACTIVE. */
  epochEnd: Uint64Schema,
  termsHash: Bytes32Schema,
  status: GrantStatusSchema,
});

/** ERC-8004 card as the protocol needs it (ADR-0006, decision #12). */
export const GranteeCardSchema = z.object({
  cardId: Bytes32Schema,
  owner: HexSchema,
  /** X25519 public key used to wrap vault keys to this grantee. */
  encryptionPubKey: Bytes32Schema,
  active: z.boolean(),
});

export type GrantStateWire = z.input<typeof GrantStateSchema>;
export type GranteeCard = z.output<typeof GranteeCardSchema>;
