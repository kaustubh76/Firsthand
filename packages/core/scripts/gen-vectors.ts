/**
 * Generates the golden vectors owned by @firsthand/core:
 *   split-math.v1.json, merkle.v1.json, passport.v1.json
 *
 * Usage:
 *   pnpm --filter @firsthand/core gen          # (re)write files
 *   pnpm --filter @firsthand/core gen:check    # exit 1 if files differ from a fresh generation
 *
 * Every suite contains `hand: true` cases whose expected values were derived OUTSIDE this
 * implementation (Foundry `cast keccak` / `cast abi-encode` / `cast wallet sign`, or arithmetic
 * done by hand) — see the HAND_* constants. Generated cases use a seeded PRNG so output is
 * byte-for-byte reproducible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  SUITES,
  type Suite,
  serialiseVectorFile,
  type VectorCase,
  type VectorFile,
  vectorPath,
} from "@firsthand/test-vectors";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  type Address,
  type Attestation,
  AttestationClass,
  addressOfPublicKey,
  BATCH_SIZE,
  type Bytes32,
  buildTree,
  bytesToHex,
  domainSeparator,
  hashAttestation,
  hashLeaf,
  hashTerms,
  hexToBytes,
  MAX_PRICE,
  MAX_RECIPIENTS,
  MERKLE_DEPTH,
  MONAD_TESTNET_CHAIN_ID,
  type Passport,
  passportDigest,
  passportId,
  proveIndex,
  quoteToUnits,
  recoverSigner,
  Scope,
  split,
  type Terms,
  tag,
  u256be,
  verifyPassportInBatch,
  verifyPassportSignature,
  WAD,
  ZERO_HASH,
  ZERO_HASHES,
} from "../src/index.js";

const GENERATOR = "packages/core/scripts/gen-vectors.ts";

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG (SplitMix64) — never use for anything but test data.
// ---------------------------------------------------------------------------------------------
class Rng {
  private state: bigint;
  constructor(seed: bigint) {
    this.state = seed & ((1n << 64n) - 1n);
  }
  next64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & ((1n << 64n) - 1n);
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & ((1n << 64n) - 1n);
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & ((1n << 64n) - 1n);
    return z ^ (z >> 31n);
  }
  /** Uniform bigint in [0, max]. */
  below(max: bigint): bigint {
    if (max <= 0n) return 0n;
    const bits = max.toString(2).length;
    for (;;) {
      let v = 0n;
      for (let got = 0; got < bits; got += 64) v = (v << 64n) | this.next64();
      v &= (1n << BigInt(bits)) - 1n;
      if (v <= max) return v;
    }
  }
  /** Uniform integer in the half-open range [min, max). */
  int(min: number, max: number): number {
    if (max <= min) throw new Error("int: empty range");
    return min + Number(this.below(BigInt(max - min - 1)));
  }
  bytes32(): Bytes32 {
    return bytesToHex(
      u256be(
        (this.next64() << 192n) | (this.next64() << 128n) | (this.next64() << 64n) | this.next64(),
      ),
    );
  }
  address(): Address {
    return bytesToHex(hexToBytes(this.bytes32()).subarray(12));
  }
}

const dec = (v: bigint): string => v.toString(10);

// ---------------------------------------------------------------------------------------------
// split-math
// ---------------------------------------------------------------------------------------------
function genSplitMath(): VectorFile {
  const cases: VectorCase[] = [];
  const ok = (
    name: string,
    hand: boolean,
    price: bigint,
    weights: bigint[],
    pays: bigint[],
    residual: bigint,
  ) => {
    // Self-check hand cases against the implementation before writing.
    const got = split(price, weights);
    if (got.residual !== residual || got.pays.some((p, i) => p !== pays[i])) {
      throw new Error(`split-math hand case mismatch: ${name}`);
    }
    cases.push({
      name,
      ...(hand ? { hand: true } : {}),
      input: { price: dec(price), weights: weights.map(dec) },
      expected: { pays: pays.map(dec), residual: dec(residual) },
    });
  };
  const err = (name: string, price: bigint, weights: bigint[], error: string) => {
    let threw = false;
    try {
      split(price, weights);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`split-math error case did not throw: ${name}`);
    cases.push({
      name,
      hand: true,
      input: { price: dec(price), weights: weights.map(dec) },
      expected: { error },
    });
  };

  const half = WAD / 2n;
  // 1e6 * 5e17 / 1e18 = 5e5 exactly.
  ok("hand/half-half-even", true, 1_000_000n, [half, half], [500_000n, 500_000n], 0n);
  // floor(1e6 * 333333333333333333 / 1e18) = floor(333333.333…) = 333333 (×2)
  // floor(1e6 * 333333333333333334 / 1e18) = floor(333333.333…334) = 333333 ; Σ = 999999 ; residual = 1
  ok(
    "hand/thirds-residual-one",
    true,
    1_000_000n,
    [333_333_333_333_333_333n, 333_333_333_333_333_333n, 333_333_333_333_333_334n],
    [333_333n, 333_333n, 333_333n],
    1n,
  );
  // Single recipient with full weight: identity.
  ok("hand/single-full-weight", true, 7n, [WAD], [7n], 0n);
  // Price below resolution: everything is residual.
  ok("hand/price-one-two-recipients", true, 1n, [half, half], [0n, 0n], 1n);
  // Max price, no overflow, identity.
  ok("hand/max-price-single", true, MAX_PRICE, [WAD], [MAX_PRICE], 0n);
  // Zero-weight recipient is allowed and receives nothing.
  ok("hand/zero-weight-allowed", true, 100n, [0n, WAD], [0n, 100n], 0n);
  // Zero price is allowed by the library (floor enforced by GrantManager).
  ok("hand/zero-price", true, 0n, [half, half], [0n, 0n], 0n);
  // 16 equal recipients: 1e18/16 = 6.25e16 each ; price 15 → floor(15*0.0625)=0 each ; residual 15 = n-1
  ok(
    "hand/sixteen-equal-max-residual",
    true,
    15n,
    new Array<bigint>(16).fill(WAD / 16n),
    new Array<bigint>(16).fill(0n),
    15n,
  );

  err("hand/error-no-recipients", 1n, [], "NoRecipients");
  err(
    "hand/error-too-many-recipients",
    1n,
    new Array<bigint>(MAX_RECIPIENTS + 1).fill(WAD / 17n),
    "TooManyRecipients",
  );
  err("hand/error-weights-sum-low", 1n, [half, half - 1n], "WeightsSumMismatch");
  err("hand/error-weights-sum-high", 1n, [half, half + 1n], "WeightsSumMismatch");
  err("hand/error-price-too-large", MAX_PRICE + 1n, [WAD], "PriceTooLarge");

  const rng = new Rng(0x5011771n);
  for (let i = 0; i < 48; i++) {
    const n = rng.int(1, MAX_RECIPIENTS + 1);
    // Random composition of WAD into n non-negative parts.
    const cuts: bigint[] = [];
    for (let k = 0; k < n - 1; k++) cuts.push(rng.below(WAD));
    cuts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const weights: bigint[] = [];
    let prev = 0n;
    for (const c of cuts) {
      weights.push(c - prev);
      prev = c;
    }
    weights.push(WAD - prev);
    const price = i % 4 === 0 ? rng.below(MAX_PRICE) : rng.below(10n ** 12n);
    const r = split(price, weights);
    ok(
      `gen/${i.toString().padStart(2, "0")}-n${n}`,
      false,
      price,
      weights,
      [...r.pays],
      r.residual,
    );
  }

  // quoteToUnits (off-chain banker's rounding, ADR-0003) — TS-only cases, ignored by forge.
  const q = (name: string, quote: string, decimals: number, expected: string) => {
    const got = quoteToUnits(quote, decimals);
    if (dec(got) !== expected)
      throw new Error(`quoteToUnits hand case mismatch: ${name} got ${got}`);
    cases.push({ name, hand: true, input: { quote, decimals }, expected: { units: expected } });
  };
  q("quote/exact", "1.234567", 6, "1234567");
  q("quote/round-half-even-down", "0.0000005", 6, "0"); // 0.5 → even (0)
  q("quote/round-half-even-up", "0.0000015", 6, "2"); // 1.5 → even (2)
  q("quote/round-above-half", "0.00000051", 6, "1");
  q("quote/round-below-half", "0.00000049", 6, "0");
  q("quote/integer", "42", 6, "42000000");

  return { suite: "split-math", version: 1, generator: GENERATOR, count: cases.length, cases };
}

// ---------------------------------------------------------------------------------------------
// merkle
// ---------------------------------------------------------------------------------------------
/** `cast keccak 0x01 ‖ 0^32 ‖ 0^32`, then folded upward — independent of this implementation. */
const HAND_ZERO_HASHES: readonly Bytes32[] = [
  ZERO_HASH,
  "0xc07a1e8b7e0057673fdc2affe190d8a960c5fe615663f27b7ce84f3d93ef92a6",
  "0xfd47517474a597637d54038a0663d1d03b931b238de06b73e3c12cf443de6e8d",
  "0x47a8f5e8fa70be2760378067c9c6d410dd96be07820b4230c11254c7ff10c298",
  "0xaed19ca4bfe2365b1b33fa94744cd0c6a2d550506c7e7efc073879cb79459b9a",
  "0x6e6998a7da8b2db5c98eb853099d8caec63797b5283b7dac37b2ffb630a86e24",
  "0x181c19735bff23b55bc295fc0b60c1c5c7288209b261a08e26924598ce72404e",
  "0xecb408b290ab2920e63611ef1e8ca964aebb66ea5739f19d24b92094f28e44f8",
  "0x294bf9785e1391d24d52abf915636a73bdaa12ed29e85e21dae14c09d0f2e34b",
];
const ID_11: Bytes32 = `0x${"11".repeat(32)}`;
const ID_22: Bytes32 = `0x${"22".repeat(32)}`;
/** `cast keccak 0x00 ‖ 0x11…11` */
const HAND_LEAF_11: Bytes32 = "0x5f61df1468962c8107c77ae5f01bbd92c363c87a057eba326bd87ca93188e313";
const HAND_LEAF_22: Bytes32 = "0x9608b11d41faf730ce9e119a06798480433341ea1fa9cf8c0f0edb544d30c0b5";
/** `cast keccak 0x00 ‖ 0^32` — the leaf hash of the zero id, which must differ from Z0. */
const HAND_LEAF_ZERO_ID: Bytes32 =
  "0xf39a869f62e75cf5f0bf914688a6b289caf2049435d8e68c5c5e6d05e44913f3";
/** Root of a batch holding only ID_11 at index 0 (8 cast keccak folds against Z_k). */
const HAND_ROOT_SINGLE_11: Bytes32 =
  "0x2c662d4a96314fe34e8177bed91715ee79a7ad4ceee66ec221d160105cbdb159";
/** Root of a batch holding ID_11 at 0 and ID_22 at 1. */
const HAND_ROOT_PAIR_11_22: Bytes32 =
  "0x66889127924a99bff4f4a0ac0676eed8c6119fde78cc45a35acf5a503f7fc28c";

function genMerkle(): VectorFile {
  for (let i = 0; i <= MERKLE_DEPTH; i++) {
    if (ZERO_HASHES[i] !== HAND_ZERO_HASHES[i])
      throw new Error(`ZERO_HASHES[${i}] disagrees with cast`);
  }
  if (hashLeaf(ID_11) !== HAND_LEAF_11 || hashLeaf(ID_22) !== HAND_LEAF_22)
    throw new Error("hashLeaf disagrees with cast");
  if (hashLeaf(ZERO_HASH) !== HAND_LEAF_ZERO_ID) throw new Error("hashLeaf(0) disagrees with cast");

  const cases: VectorCase[] = [];
  const push = (
    name: string,
    hand: boolean,
    ids: Bytes32[],
    index: number,
    expectRoot?: Bytes32,
    tamper?: (s: Bytes32[]) => void,
  ) => {
    const tree = buildTree(ids.map(hashLeaf));
    if (expectRoot !== undefined && tree.root !== expectRoot)
      throw new Error(`merkle hand root mismatch: ${name}`);
    const proof = proveIndex(tree, index);
    const siblings = [...proof.siblings];
    if (tamper) tamper(siblings);
    const leafId = index < ids.length ? (ids[index] as Bytes32) : ZERO_HASH;
    const valid = verifyPassportInBatch(tree.root, leafId, { index, siblings });
    cases.push({
      name,
      ...(hand ? { hand: true } : {}),
      input: { passportIds: ids, index, passportId: leafId, siblings },
      expected: { root: tree.root, leaf: hashLeaf(leafId), valid },
    });
  };

  push("hand/single-leaf-index0", true, [ID_11], 0, HAND_ROOT_SINGLE_11);
  push("hand/pair-index0", true, [ID_11, ID_22], 0, HAND_ROOT_PAIR_11_22);
  push("hand/pair-index1", true, [ID_11, ID_22], 1, HAND_ROOT_PAIR_11_22);
  // Padding slot: proof for index 5 of a 2-leaf batch proves the *zero id* leaf? No — the padding
  // slot holds Z0 (0x00…00 raw), whereas hashLeaf(ZERO_HASH) ≠ Z0, so this must be INVALID.
  push("hand/padding-slot-not-provable", true, [ID_11, ID_22], 5, HAND_ROOT_PAIR_11_22);
  // Tampered sibling.
  push("hand/tampered-sibling-invalid", true, [ID_11, ID_22], 0, HAND_ROOT_PAIR_11_22, (s) => {
    s[3] = ID_22;
  });
  // Wrong index for a real leaf.
  push("hand/wrong-index-invalid", true, [ID_11, ID_22], 1, HAND_ROOT_PAIR_11_22, (s) => {
    // Use index-0 siblings under index 1: swap first sibling to be the leaf itself.
    s[0] = hashLeaf(ID_22);
  });

  const rng = new Rng(0xf1257a11n);
  const sizes = [1, 2, 3, 4, 7, 8, 9, 100, 255, 256];
  for (const size of sizes) {
    const ids: Bytes32[] = [];
    for (let i = 0; i < size; i++) ids.push(rng.bytes32());
    const idx = size === 256 ? 255 : rng.int(0, size);
    push(`gen/size${size}-index${idx}`, false, ids, idx);
  }
  const full: Bytes32[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) full.push(rng.bytes32());
  push("gen/full-batch-index0", false, full, 0);
  push("gen/full-batch-index128", false, full, 128);

  return {
    suite: "merkle",
    version: 1,
    generator: GENERATOR,
    count: cases.length,
    cases,
    extra: { zeroHashes: [...ZERO_HASHES], leafOfZeroId: HAND_LEAF_ZERO_ID },
  };
}

// ---------------------------------------------------------------------------------------------
// passport
// ---------------------------------------------------------------------------------------------
/** Values from `cast keccak` / `cast abi-encode` / `cast wallet sign --no-hash` (see PR notes). */
const HAND = {
  passportTypehash: "0x160cb7919d7a5d8b60830cb42cb5f8aa076fefaf1444d67f85e048fcbf98cbfe",
  termsTypehash: "0x1ad2297d4b1eacd2deaa9ccd5e9ba8f0182eeee0f5b0e3f097ff26c1d76b5d8c",
  attestationTypehash: "0xe028b8b4a6584a35f086eeadbeb26837d47b9c40ba736610c691fa892bf31015",
  domainTypehash: "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
  license: "0x44d5141b056fd6c86f45efebf9406a27937c3da75621017342d3ce45dde90403",
  sourceTag: "0x085faa73fdf3717e752e87c02e5a6621e3de9b9d4710f70210b50d3289a93333",
  // anvil account #0
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  termsHash: "0xe5a5557916de265d50a3bf1ce999e775161fc6ab34a6876c8180c625c567844b",
  attest: "0xc83634e1a6f48e0cc6d88e37c7846701993b6b165d571217233d028bb29b609f",
  h: "0x74b57094b5c102d689ca02f33d6759c431f51a63a08cf037c29390cec34c9511", // keccak("hello firsthand")
  nonce: "0x9c6230254ac733f54ec47298f0a5ddaf93dc9efe6e05fb726dcb6faf10ddece2", // keccak("nonce-1")
  passportId: "0x96627bdd8211081c14056286aed216283509b2da822217808e7d296289b25af8",
  domainSeparator: "0x6fcefa60deb036e8831a962e6620dadf5e171bbbf68c5b3ee045f242bcabecf5",
  digest: "0x7d60b7121821fff161c8d8b1707d7adedc9180d95cdc1302a88193a0081accf6",
  signature:
    "0x2a01406e4aca380f8e52071fa987e8193c12ca4e4bfe7b77deae819d54e4fcb334671453760c34789d86d4dcc187ce9460afb1534e92787cbe699efb0ebfdb2a1c",
  verifyingContract: "0x000000000000000000000000000000000000dead",
} as const;

interface KeyPair {
  readonly privateKey: Uint8Array;
  readonly address: Address;
}

function keyFromScalar(scalar: bigint): KeyPair {
  const privateKey = u256be(scalar);
  return { privateKey, address: addressOfPublicKey(secp256k1.getPublicKey(privateKey, false)) };
}

/** Ethereum-style `r ‖ s ‖ v` from noble's `recovered` format (`rec ‖ r ‖ s`). */
function signDigest(digest: Bytes32, privateKey: Uint8Array): `0x${string}` {
  const rec = secp256k1.sign(hexToBytes(digest), privateKey, {
    prehash: false,
    lowS: true,
    format: "recovered",
  });
  const out = new Uint8Array(65);
  out.set(rec.subarray(1, 65), 0);
  out[64] = 27 + (rec[0] as number);
  return bytesToHex(out);
}

function termsWire(t: Terms) {
  return {
    price: dec(t.price),
    licenseId: t.licenseId,
    scope: t.scope,
    ns: t.ns,
    rateLimit: t.rateLimit,
    payees: [...t.payees],
    weights: t.weights.map(dec),
  };
}

function genPassport(): VectorFile {
  const cases: VectorCase[] = [];
  const domain = {
    chainId: MONAD_TESTNET_CHAIN_ID,
    verifyingContract: HAND.verifyingContract as Address,
  };

  cases.push({
    name: "hand/typehashes",
    hand: true,
    input: {},
    expected: {
      passportTypehash: HAND.passportTypehash,
      termsTypehash: HAND.termsTypehash,
      attestationTypehash: HAND.attestationTypehash,
      domainTypehash: HAND.domainTypehash,
      licenseFh10: HAND.license,
      sourceTagChatgpt: HAND.sourceTag,
    },
  });
  if (tag("FH-1.0") !== HAND.license || tag("chatgpt-export-v1") !== HAND.sourceTag)
    throw new Error("tag() disagrees with cast");

  const handTerms: Terms = {
    price: 1_000_000n,
    licenseId: HAND.license,
    scope: Scope.TRAIN | Scope.INFER,
    ns: 0,
    rateLimit: 100,
    payees: [HAND.address],
    weights: [WAD],
  };
  const handAttestation: Attestation = {
    class: AttestationClass.IMPORT,
    capturedAt: 1_700_000_000n,
    sourceTag: HAND.sourceTag,
    deviceClass: ZERO_HASH,
    metaHash: ZERO_HASH,
  };
  const handPassport: Passport = {
    h: HAND.h,
    origin: HAND.address,
    attest: HAND.attest,
    termsHash: HAND.termsHash,
    epoch: 5n,
    nonce: HAND.nonce,
  };
  if (hashTerms(handTerms) !== HAND.termsHash) throw new Error("hashTerms disagrees with cast");
  if (hashAttestation(handAttestation) !== HAND.attest)
    throw new Error("hashAttestation disagrees with cast");
  if (passportId(handPassport) !== HAND.passportId)
    throw new Error("passportId disagrees with cast");
  if (domainSeparator(domain) !== HAND.domainSeparator)
    throw new Error("domainSeparator disagrees with cast");
  if (passportDigest(handPassport, domain) !== HAND.digest)
    throw new Error("passportDigest disagrees with cast");
  if (recoverSigner(HAND.digest, HAND.signature) !== HAND.address)
    throw new Error("recoverSigner disagrees with cast wallet sign");

  const fullCase = (
    name: string,
    hand: boolean,
    terms: Terms,
    attestation: Attestation,
    passport: Passport,
    signature: `0x${string}`,
    valid: boolean,
  ) => {
    if (verifyPassportSignature(passport, signature, domain) !== valid)
      throw new Error(`verify mismatch: ${name}`);
    cases.push({
      name,
      ...(hand ? { hand: true } : {}),
      input: {
        domain: { chainId: dec(domain.chainId), verifyingContract: domain.verifyingContract },
        terms: termsWire(terms),
        attestation: { ...attestation, capturedAt: dec(attestation.capturedAt) },
        passport: { ...passport, epoch: dec(passport.epoch) },
        signature,
      },
      expected: {
        termsHash: hashTerms(terms),
        attest: hashAttestation(attestation),
        passportId: passportId(passport),
        domainSeparator: domainSeparator(domain),
        digest: passportDigest(passport, domain),
        recovered:
          recoverSigner(passportDigest(passport, domain), signature) ?? ZERO_HASH.slice(0, 42),
        valid,
      },
    });
  };

  fullCase(
    "hand/anvil0-import-passport",
    true,
    handTerms,
    handAttestation,
    handPassport,
    HAND.signature,
    true,
  );
  // Same passport, origin swapped → invalid.
  fullCase(
    "hand/wrong-origin-invalid",
    true,
    handTerms,
    handAttestation,
    { ...handPassport, origin: `0x${"ab".repeat(20)}` },
    HAND.signature,
    false,
  );
  // High-s malleated signature must be rejected even though ecrecover would succeed.
  {
    const n = secp256k1.Point.CURVE().n;
    const s = BigInt(`0x${HAND.signature.slice(66, 130)}`);
    const highS = n - s;
    const v = Number.parseInt(HAND.signature.slice(130, 132), 16) === 27 ? 28 : 27;
    const malleated =
      `0x${HAND.signature.slice(2, 66)}${highS.toString(16).padStart(64, "0")}${v.toString(16)}` as const;
    fullCase(
      "hand/high-s-rejected",
      true,
      handTerms,
      handAttestation,
      handPassport,
      malleated,
      false,
    );
  }

  const rng = new Rng(0xa55a0177n);
  for (let i = 0; i < 24; i++) {
    const key = keyFromScalar(1n + rng.below(secp256k1.Point.CURVE().n - 2n));
    const n = rng.int(1, 5);
    const payees: Address[] = [];
    const weights: bigint[] = [];
    let remaining = WAD;
    for (let k = 0; k < n; k++) {
      payees.push(rng.address());
      const w = k === n - 1 ? remaining : rng.below(remaining);
      weights.push(w);
      remaining -= w;
    }
    const terms: Terms = {
      price: rng.below((1n << 64n) - 1n),
      licenseId: rng.bytes32(),
      scope: rng.int(0, 16),
      ns: rng.int(0, 16),
      rateLimit: rng.int(1, 10_000),
      payees,
      weights,
    };
    const attestation = {
      class: [
        AttestationClass.UNATTESTED,
        AttestationClass.IMPORT,
        AttestationClass.DEVICE_CAPTURE,
        AttestationClass.HARDWARE,
      ][i % 4] as AttestationClass,
      capturedAt: rng.below((1n << 40n) - 1n),
      sourceTag: rng.bytes32(),
      deviceClass: rng.bytes32(),
      metaHash: rng.bytes32(),
    };
    const passport: Passport = {
      h: rng.bytes32(),
      origin: key.address,
      attest: hashAttestation(attestation),
      termsHash: hashTerms(terms),
      epoch: rng.below((1n << 64n) - 1n),
      nonce: rng.bytes32(),
    };
    const signature = signDigest(passportDigest(passport, domain), key.privateKey);
    fullCase(
      `gen/${i.toString().padStart(2, "0")}`,
      false,
      terms,
      attestation,
      passport,
      signature,
      true,
    );
  }

  return { suite: "passport", version: 1, generator: GENERATOR, count: cases.length, cases };
}

// ---------------------------------------------------------------------------------------------
function main(): void {
  const check = process.argv.includes("--check");
  const suites: ReadonlyArray<[Suite, () => VectorFile]> = [
    ["split-math", genSplitMath],
    ["merkle", genMerkle],
    ["passport", genPassport],
  ];
  let dirty = 0;
  for (const [suite, gen] of suites) {
    if (!SUITES.includes(suite)) throw new Error(`unknown suite ${suite}`);
    const text = serialiseVectorFile(gen());
    const path = vectorPath(suite);
    if (check) {
      const current = readFileSync(path, "utf8");
      if (current !== text) {
        dirty++;
        console.error(`✗ ${suite}: committed vectors differ from a fresh generation`);
      } else {
        console.log(`✓ ${suite}: up to date`);
      }
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${path}`);
    }
  }
  if (dirty > 0) process.exit(1);
}

main();
