import { assertBytes32, type Bytes32, bytesToHex, concat, hexToBytes, u8 } from "../bytes.js";
import { BATCH_SIZE, MERKLE_DEPTH, MERKLE_LEAF_PREFIX, MERKLE_NODE_PREFIX } from "../constants.js";
import { ValidationError } from "../errors.js";
import { keccak256 } from "../hash.js";

export { BATCH_SIZE, MERKLE_DEPTH } from "../constants.js";

/**
 * Fixed-depth, index-addressed Merkle batches (README §7.1/§15 H3, ADR-0004).
 *
 * - Leaves are `hashLeaf(passportId) = keccak256(0x00 ‖ passportId)`.
 * - Nodes are `hashNode(l, r) = keccak256(0x01 ‖ l ‖ r)` — ordered, not sorted, so a proof
 *   also proves the leaf's position `(batch, index)`.
 * - A batch always has exactly `BATCH_SIZE` slots; unused slots hold `Z0 = 0x00…00`, which is not
 *   `keccak256(0x00 ‖ x)` for any known `x`, so padding can never be "proved" as a passport.
 * - Consequently every proof carries exactly `MERKLE_DEPTH` siblings.
 */
export interface BatchProof {
  /** Leaf position in the batch, `0..BATCH_SIZE-1`. */
  readonly index: number;
  /** Exactly `MERKLE_DEPTH` sibling hashes, bottom-up. */
  readonly siblings: readonly Bytes32[];
}

export interface MerkleTree {
  readonly root: Bytes32;
  /** `layers[0]` is the padded leaf layer, `layers[MERKLE_DEPTH]` is `[root]`. */
  readonly layers: readonly (readonly Bytes32[])[];
  /** Number of real (non-padding) leaves. */
  readonly size: number;
}

function leafBytes(id: Uint8Array): Uint8Array {
  return keccak256(concat(u8(MERKLE_LEAF_PREFIX), id));
}

function nodeBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  return keccak256(concat(u8(MERKLE_NODE_PREFIX), left, right));
}

/** Hash of a passport id as a leaf. */
export function hashLeaf(passportId: Bytes32): Bytes32 {
  assertBytes32(passportId, "passportId");
  return bytesToHex(leafBytes(hexToBytes(passportId)));
}

/** Hash of two child nodes, in order. */
export function hashNode(left: Bytes32, right: Bytes32): Bytes32 {
  assertBytes32(left, "left");
  assertBytes32(right, "right");
  return bytesToHex(nodeBytes(hexToBytes(left), hexToBytes(right)));
}

function computeZeroHashes(): readonly Bytes32[] {
  const zeros: Bytes32[] = [bytesToHex(new Uint8Array(32))];
  for (let level = 1; level <= MERKLE_DEPTH; level++) {
    const prev = zeros[level - 1] as Bytes32;
    zeros.push(hashNode(prev, prev));
  }
  return zeros;
}

/**
 * `ZERO_HASHES[k]` is the root of an all-padding subtree of height `k`.
 * Hardcoded in `MerkleLib.sol`; the golden vectors assert both sides agree.
 */
export const ZERO_HASHES: readonly Bytes32[] = computeZeroHashes();

/** Builds a full depth-8 tree over already-hashed leaves (`1..BATCH_SIZE` of them). */
export function buildTree(leaves: readonly Bytes32[]): MerkleTree {
  if (leaves.length === 0) {
    throw new ValidationError("merkle: batch must contain at least one leaf");
  }
  if (leaves.length > BATCH_SIZE) {
    throw new ValidationError(`merkle: batch exceeds ${BATCH_SIZE} leaves`, {
      context: { leaves: leaves.length },
    });
  }

  // Work on bytes internally; hex conversion happens once per node on the way out.
  const zero = new Uint8Array(32);
  const layer0: Uint8Array[] = new Array<Uint8Array>(BATCH_SIZE).fill(zero);
  for (let i = 0; i < leaves.length; i++) {
    assertBytes32(leaves[i], `leaves[${i}]`);
    layer0[i] = hexToBytes(leaves[i] as Bytes32);
  }

  const byteLayers: Uint8Array[][] = [layer0];
  let current = layer0;
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const next = new Array<Uint8Array>(current.length / 2);
    for (let i = 0; i < next.length; i++) {
      next[i] = nodeBytes(current[2 * i] as Uint8Array, current[2 * i + 1] as Uint8Array);
    }
    byteLayers.push(next);
    current = next;
  }
  const layers = byteLayers.map((layer) => layer.map(bytesToHex));
  return { root: bytesToHex(current[0] as Uint8Array), layers, size: leaves.length };
}

/** Root only — the same padding rule as `buildTree`. */
export function computeRoot(leaves: readonly Bytes32[]): Bytes32 {
  return buildTree(leaves).root;
}

/** Convenience: hash each passport id as a leaf, then compute the root. */
export function computeRootFromIds(passportIds: readonly Bytes32[]): Bytes32 {
  return computeRoot(passportIds.map(hashLeaf));
}

/** Produces the 8-sibling proof for `index` (which may point at a padding slot). */
export function proveIndex(tree: MerkleTree, index: number): BatchProof {
  if (!Number.isInteger(index) || index < 0 || index >= BATCH_SIZE) {
    throw new ValidationError(`merkle: index out of range: ${index}`);
  }
  const siblings: Bytes32[] = [];
  let position = index;
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const layer = tree.layers[level] as readonly Bytes32[];
    const siblingIndex = position ^ 1;
    siblings.push(layer[siblingIndex] as Bytes32);
    position >>= 1;
  }
  return { index, siblings };
}

/** Recomputes the root from `leaf` and `proof`; returns whether it equals `root`. */
export function verifyProof(root: Bytes32, leaf: Bytes32, proof: BatchProof): boolean {
  assertBytes32(root, "root");
  assertBytes32(leaf, "leaf");
  if (
    !Number.isInteger(proof.index) ||
    proof.index < 0 ||
    proof.index >= BATCH_SIZE ||
    proof.siblings.length !== MERKLE_DEPTH
  ) {
    return false;
  }
  let node = hexToBytes(leaf);
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const sibling = proof.siblings[level] as Bytes32;
    assertBytes32(sibling, `siblings[${level}]`);
    const siblingBytes = hexToBytes(sibling);
    node =
      ((proof.index >> level) & 1) === 0
        ? nodeBytes(node, siblingBytes)
        : nodeBytes(siblingBytes, node);
  }
  return bytesToHex(node) === root;
}

/** Verifies that `passportId` sits at `proof.index` in the batch with `root`. */
export function verifyPassportInBatch(
  root: Bytes32,
  passportId: Bytes32,
  proof: BatchProof,
): boolean {
  return verifyProof(root, hashLeaf(passportId), proof);
}
