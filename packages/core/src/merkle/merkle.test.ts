import { loadVectors } from "@firsthand/test-vectors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Bytes32, ZERO_HASH } from "../bytes.js";
import { ValidationError } from "../errors.js";
import {
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

const B32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .transform((v) => v as Bytes32);
const Input = z.object({
  passportIds: z.array(B32),
  index: z.number(),
  passportId: B32,
  siblings: z.array(B32),
});
const Expected = z.object({ root: B32, leaf: B32, valid: z.boolean() });
const Extra = z.object({ zeroHashes: z.array(B32), leafOfZeroId: B32 });

const vectors = loadVectors("merkle", { input: Input, expected: Expected, extra: Extra });

describe("merkle vectors", () => {
  it("zero hashes match the committed (cast-derived) values", () => {
    expect([...ZERO_HASHES]).toEqual(vectors.extra.zeroHashes);
    expect(ZERO_HASHES).toHaveLength(MERKLE_DEPTH + 1);
    expect(hashLeaf(ZERO_HASH)).toBe(vectors.extra.leafOfZeroId);
    expect(hashLeaf(ZERO_HASH)).not.toBe(ZERO_HASHES[0]);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const root = computeRootFromIds(c.input.passportIds);
      expect(root).toBe(c.expected.root);
      expect(hashLeaf(c.input.passportId)).toBe(c.expected.leaf);
      const proof = { index: c.input.index, siblings: c.input.siblings };
      expect(verifyPassportInBatch(root, c.input.passportId, proof)).toBe(c.expected.valid);
    });
  }
});

const idArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b): Bytes32 => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`);

describe("merkle properties", () => {
  it("every real leaf proves under its own index, and under no other index", () => {
    fc.assert(
      fc.property(fc.array(idArb, { minLength: 1, maxLength: 40 }), fc.nat(), (ids, seed) => {
        const tree = buildTree(ids.map(hashLeaf));
        const index = seed % ids.length;
        const proof = proveIndex(tree, index);
        expect(proof.siblings).toHaveLength(MERKLE_DEPTH);
        expect(verifyPassportInBatch(tree.root, ids[index] as Bytes32, proof)).toBe(true);
        const other = (index + 1) % BATCH_SIZE;
        expect(
          verifyPassportInBatch(tree.root, ids[index] as Bytes32, { ...proof, index: other }),
        ).toBe(false);
      }),
      { numRuns: 60 },
    );
  }, 30_000);

  it("root changes when any leaf changes", () => {
    fc.assert(
      fc.property(
        fc.array(idArb, { minLength: 2, maxLength: 20 }),
        idArb,
        fc.nat(),
        (ids, replacement, seed) => {
          const i = seed % ids.length;
          fc.pre(ids[i] !== replacement);
          const a = computeRootFromIds(ids);
          const swapped = [...ids];
          swapped[i] = replacement;
          expect(computeRootFromIds(swapped)).not.toBe(a);
        },
      ),
      { numRuns: 60 },
    );
    // The budget is for a loaded machine, not for the algorithm: `pnpm coverage` runs every
    // package's instrumented suite at once, and sixty Merkle properties are the slowest thing
    // in the repo when they lose the CPU race. The run count is what the test claims; the
    // timeout is only how long it may wait to be scheduled.
  }, 60_000);

  it("padding slots can never be proved as passports", () => {
    const tree = buildTree([hashLeaf(`0x${"aa".repeat(32)}`)]);
    for (const index of [1, 2, 7, 255]) {
      const proof = proveIndex(tree, index);
      // The slot holds Z0 raw; a verifier always hashes the claimed id first, so nothing matches.
      expect(verifyPassportInBatch(tree.root, ZERO_HASH, proof)).toBe(false);
      expect(verifyProof(tree.root, ZERO_HASHES[0] as Bytes32, proof)).toBe(true);
    }
  });
});

describe("merkle validation", () => {
  it("rejects empty and oversized batches", () => {
    expect(() => computeRoot([])).toThrow(ValidationError);
    expect(() => buildTree(new Array<Bytes32>(BATCH_SIZE + 1).fill(ZERO_HASH))).toThrow(
      ValidationError,
    );
  });
  it("rejects malformed leaves and indices", () => {
    expect(() => buildTree(["0x12" as Bytes32])).toThrow(TypeError);
    const tree = buildTree([hashLeaf(ZERO_HASH)]);
    expect(() => proveIndex(tree, -1)).toThrow(ValidationError);
    expect(() => proveIndex(tree, 256)).toThrow(ValidationError);
    expect(() => hashNode("0x" as Bytes32, ZERO_HASH)).toThrow(TypeError);
  });
  it("verifyProof returns false (not throws) for structurally bad proofs", () => {
    const tree = buildTree([hashLeaf(ZERO_HASH)]);
    const good = proveIndex(tree, 0);
    expect(
      verifyProof(tree.root, hashLeaf(ZERO_HASH), { index: 0, siblings: good.siblings.slice(1) }),
    ).toBe(false);
    expect(
      verifyProof(tree.root, hashLeaf(ZERO_HASH), { index: 300, siblings: good.siblings }),
    ).toBe(false);
    expect(
      verifyProof(tree.root, hashLeaf(ZERO_HASH), { index: 0.5, siblings: good.siblings }),
    ).toBe(false);
  });
  it("buildTree reports size and layer shape", () => {
    const tree = buildTree([hashLeaf(ZERO_HASH), hashLeaf(`0x${"01".repeat(32)}`)]);
    expect(tree.size).toBe(2);
    expect(tree.layers).toHaveLength(MERKLE_DEPTH + 1);
    expect(tree.layers[0]).toHaveLength(BATCH_SIZE);
    expect(tree.layers[MERKLE_DEPTH]).toEqual([tree.root]);
  });
});
