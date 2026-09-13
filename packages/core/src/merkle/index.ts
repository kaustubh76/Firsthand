export type { BatchProof, MerkleTree } from "./merkle.js";
export {
  BATCH_SIZE,
  buildTree,
  computeRoot,
  computeRootFromIds,
  hashLeaf,
  hashNode,
  MERKLE_DEPTH,
  proveIndex,
  verifyPassportInBatch,
  verifyProof,
  ZERO_HASHES,
} from "./merkle.js";
