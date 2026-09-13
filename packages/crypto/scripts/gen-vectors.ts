/**
 * Generates the golden vectors owned by @firsthand/crypto:
 *   keys.v1.json, envelope.v1.json, p256-signatures.v1.json
 *
 * Hand cases were derived with OpenSSL 3 (`openssl kdf … HKDF`, `openssl pkeyutl -sign`) and
 * `cast`, independently of noble — see the HAND constants. All PRF inputs here are fixed test
 * values and therefore public; nothing in these files is a real secret.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Bytes32,
  bytesToHex,
  encodeP256Signature,
  hexToBytes,
  keccak256Utf8,
  P256_N,
  parseP256Signature,
  u256be,
  verifyP256,
} from "@firsthand/core";
import {
  SUITES,
  type Suite,
  serialiseVectorFile,
  type VectorCase,
  type VectorFile,
  vectorPath,
} from "@firsthand/test-vectors";
import { p256 } from "@noble/curves/nist.js";
import {
  generateDek,
  granteeKeyFromSeed,
  KeyTree,
  openBlob,
  SecretBytes,
  sealBlob,
  signAuthorityDigest,
  unwrapDek,
  unwrapVaultKey,
  wrapDek,
  wrapVaultKeyToGrantee,
} from "../src/index.js";

const GENERATOR = "packages/crypto/scripts/gen-vectors.ts";

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
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 8) {
      const chunk = u256be(this.next64()).subarray(24);
      out.set(chunk.subarray(0, Math.min(8, n - i)), i);
    }
    return out;
  }
  below(max: bigint): bigint {
    const bits = max.toString(2).length;
    for (;;) {
      let v = 0n;
      for (let got = 0; got < bits; got += 64) v = (v << 64n) | this.next64();
      v &= (1n << BigInt(bits)) - 1n;
      if (v <= max) return v;
    }
  }
}

const hex = bytesToHex;
const dec = (v: bigint) => v.toString(10);

// ---------------------------------------------------------------------------------------------
// keys — HKDF tree
// ---------------------------------------------------------------------------------------------
/** `openssl kdf … HKDF` with prf = 0x01×32, salt "FIRSTHAND/kdf/v1", then reduced in Python. */
const HAND_KEYS = {
  prf: `0x${"01".repeat(32)}`,
  prk: "0x26a0ff788f176270f43f566e92bb0234eaec718c0c3c96aba630d7d8409e5827",
  kIdScalar: "0x9b937c1d985f4da2384908aad8e7e9fdf14ad5a71e1f5ed3dcfb9131c097fa9c",
  p256X: "0xcdd61de9b78f38ec9fd29181202f4fdd5f1b42f9bacb4d3198f9c4268bbdac39",
  p256Y: "0x0ce7ab1ac7587227ffd5387b1db83aa9a642f55396b872f143e2a5ee46d23cd8",
  p256Commit: "0xf55f44dfb222251dcb5eedd8068d03f83aa4fdcc961206edd346bf43e7fbd034",
  ns: 3,
  epoch: 7n,
  kNs: "0x1ab8cfed78aff008d7431e744c51ae782fdcc36a1dd02c573326425bc3b6b962",
  kDepScalar: "0x341f66342d2e890c6f546596afffd4ba210759e215ebe2ce56aabb079f6ca800",
  origin: "0x2223df8ecb8c866a83a4246207c8df3c3e64b21f",
  kNonce: "0x070df6d1cd817763e8f81e4da1cf0b7c35542f2c8a44c6ad53ceccf9d14cd89e",
} as const;

function keysCase(
  name: string,
  hand: boolean,
  prf: Uint8Array,
  ns: number,
  epoch: bigint,
): VectorCase {
  const tree = KeyTree.fromPrf(new Uint8Array(prf));
  const prk = tree.prk();
  const authority = tree.authorityKey();
  const vault = tree.vaultKey(ns, epoch);
  const deposit = tree.depositKey(ns, epoch);
  const nonceKey = tree.nonceKey(ns, epoch);
  const contentHash = keccak256Utf8(`content:${name}`);
  const c: VectorCase = {
    name,
    ...(hand ? { hand: true } : {}),
    input: { prf: hex(prf), ns, epoch: dec(epoch), contentHash },
    expected: {
      prk: hex(prk.expose()),
      kIdScalar: hex(authority.scalar.expose()),
      p256X: authority.publicKey.x,
      p256Y: authority.publicKey.y,
      p256Commit: authority.commitment,
      kNs: hex(vault.expose()),
      kDepScalar: hex(deposit.privateKey.expose()),
      depositPublicKey: deposit.publicKey,
      origin: deposit.address,
      kNonce: hex(nonceKey.expose()),
      passportNonce: tree.passportNonce(ns, epoch, contentHash),
    },
  };
  for (const s of [prk, authority.scalar, vault, deposit.privateKey, nonceKey]) s.dispose();
  tree.dispose();
  return c;
}

function genKeys(): VectorFile {
  const cases: VectorCase[] = [];
  const hand = keysCase(
    "hand/openssl-prf01-ns3-e7",
    true,
    hexToBytes(HAND_KEYS.prf),
    HAND_KEYS.ns,
    HAND_KEYS.epoch,
  );
  const e = hand.expected as Record<string, string>;
  const checks: [string, string][] = [
    ["prk", HAND_KEYS.prk],
    ["kIdScalar", HAND_KEYS.kIdScalar],
    ["p256X", HAND_KEYS.p256X],
    ["p256Y", HAND_KEYS.p256Y],
    ["p256Commit", HAND_KEYS.p256Commit],
    ["kNs", HAND_KEYS.kNs],
    ["kDepScalar", HAND_KEYS.kDepScalar],
    ["origin", HAND_KEYS.origin],
    ["kNonce", HAND_KEYS.kNonce],
  ];
  for (const [k, v] of checks) {
    if (e[k] !== v)
      throw new Error(`keys hand case: ${k} disagrees with OpenSSL (${e[k]} != ${v})`);
  }
  cases.push(hand);
  // Same PRF, other scopes: proves domain separation between (ns, e) pairs.
  cases.push(keysCase("hand/openssl-prf01-ns0-e0", true, hexToBytes(HAND_KEYS.prf), 0, 0n));
  cases.push(
    keysCase("hand/openssl-prf01-ns15-emax", true, hexToBytes(HAND_KEYS.prf), 15, (1n << 64n) - 1n),
  );

  const rng = new Rng(0x6e75n);
  for (let i = 0; i < 12; i++) {
    cases.push(
      keysCase(
        `gen/${i.toString().padStart(2, "0")}`,
        false,
        rng.bytes(32),
        Number(rng.below(15n)),
        rng.below(1n << 40n),
      ),
    );
  }
  return { suite: "keys", version: 1, generator: GENERATOR, count: cases.length, cases };
}

// ---------------------------------------------------------------------------------------------
// envelope — seal / wrap round-trips with injected nonces
// ---------------------------------------------------------------------------------------------
function genEnvelope(): VectorFile {
  const cases: VectorCase[] = [];
  const rng = new Rng(0xe1e0n);

  const push = (
    name: string,
    hand: boolean,
    plaintext: Uint8Array,
    dekBytes: Uint8Array,
    vaultBytes: Uint8Array,
    granteeSeed: Uint8Array,
  ) => {
    const passportId = keccak256Utf8(`passport:${name}`);
    const grantId = keccak256Utf8(`grant:${name}`);
    const ns = Number(rng.below(15n));
    const epoch = rng.below(1n << 32n);
    const blobNonce = rng.bytes(24);
    const dekNonce = rng.bytes(24);
    const wrapNonce = rng.bytes(24);
    const ephemeral = rng.bytes(32);

    const dek = new SecretBytes(new Uint8Array(dekBytes), "dek");
    const vault = new SecretBytes(new Uint8Array(vaultBytes), "vault");
    const grantee = granteeKeyFromSeed(granteeSeed);

    const blob = sealBlob(dek, plaintext, passportId, { nonce: blobNonce });
    const wrappedDek = wrapDek(vault, dek, passportId, ns, epoch, { nonce: dekNonce });
    const wrap = wrapVaultKeyToGrantee(
      vault,
      grantee.publicKey,
      { grantId, ns, epoch },
      { ephemeralSecret: ephemeral, nonce: wrapNonce },
    );

    // Round-trip self-check before writing.
    const recoveredVault = unwrapVaultKey(grantee.secretKey, wrap.bytes, { grantId, ns, epoch });
    const recoveredDek = unwrapDek(recoveredVault, wrappedDek, passportId, ns, epoch);
    const recovered = openBlob(recoveredDek, blob, passportId);
    if (hex(recovered) !== hex(plaintext)) throw new Error(`envelope round-trip failed: ${name}`);

    cases.push({
      name,
      ...(hand ? { hand: true } : {}),
      input: {
        plaintext: hex(plaintext),
        dek: hex(dekBytes),
        vaultKey: hex(vaultBytes),
        granteeSeed: hex(granteeSeed),
        passportId,
        grantId,
        ns,
        epoch: dec(epoch),
        blobNonce: hex(blobNonce),
        dekNonce: hex(dekNonce),
        wrapNonce: hex(wrapNonce),
        ephemeralSecret: hex(ephemeral),
      },
      expected: {
        blob: hex(blob),
        wrappedDek: hex(wrappedDek),
        granteePublicKey: grantee.publicKey,
        wrap: hex(wrap.bytes),
        wrapRef: wrap.ref,
      },
    });
  };

  // Hand cases: known plaintexts and all-fixed keys, so a third-party XChaCha20-Poly1305 / X25519
  // implementation can reproduce them from the documented layout alone.
  push(
    "hand/empty-plaintext",
    true,
    new Uint8Array(0),
    new Uint8Array(32).fill(0x11),
    new Uint8Array(32).fill(0x22),
    new Uint8Array(32).fill(0x33),
  );
  push(
    "hand/ascii-plaintext",
    true,
    new TextEncoder().encode("firsthand: the data locker that can prove what's inside it"),
    new Uint8Array(32).fill(0x44),
    new Uint8Array(32).fill(0x55),
    new Uint8Array(32).fill(0x66),
  );
  push(
    "hand/1kib-zero-plaintext",
    true,
    new Uint8Array(1024),
    new Uint8Array(32).fill(0x77),
    new Uint8Array(32).fill(0x88),
    new Uint8Array(32).fill(0x99),
  );

  for (let i = 0; i < 8; i++) {
    push(
      `gen/${i}`,
      false,
      rng.bytes(Number(rng.below(200n)) + 1),
      rng.bytes(32),
      rng.bytes(32),
      rng.bytes(32),
    );
  }
  // Silence unused import in case generateDek is only used for type parity.
  generateDek().dispose();
  return { suite: "envelope", version: 1, generator: GENERATOR, count: cases.length, cases };
}

// ---------------------------------------------------------------------------------------------
// p256-signatures — for the Solidity P256 library (precompile double) and core verifyP256
// ---------------------------------------------------------------------------------------------
/** `openssl pkeyutl -sign` over keccak("firsthand authority test") with the hand k_id above. */
const HAND_P256 = {
  digest: "0x0deab5a2880087abad7cbb743483e65a0774a4a78ea6e21104948bdf0d2aff31",
  r: 0x85822163f46fae19abd3662458d9856cfae5d48b2ddc7fe5fd1c95c1938e2086n,
  s: 0x6614e206b13f6ed4a355d7a7387f950cac4e82e632af6b8d4eee719d87acaa8cn,
} as const;

function genP256(): VectorFile {
  const cases: VectorCase[] = [];
  const push = (
    name: string,
    hand: boolean,
    digest: Bytes32,
    r: bigint,
    s: bigint,
    x: Bytes32,
    y: Bytes32,
    valid: boolean,
  ) => {
    const got = verifyP256(digest, encodeP256Signature({ r, s }), { x, y });
    if (got !== valid) throw new Error(`p256 case ${name}: expected valid=${valid}, got ${got}`);
    cases.push({
      name,
      ...(hand ? { hand: true } : {}),
      input: { digest, r: dec(r), s: dec(s), x, y },
      expected: { valid },
    });
  };
  const X = HAND_KEYS.p256X as Bytes32;
  const Y = HAND_KEYS.p256Y as Bytes32;
  push("hand/openssl-signature", true, HAND_P256.digest, HAND_P256.r, HAND_P256.s, X, Y, true);
  push(
    "hand/openssl-high-s-rejected",
    true,
    HAND_P256.digest,
    HAND_P256.r,
    P256_N - HAND_P256.s,
    X,
    Y,
    false,
  );
  push(
    "hand/wrong-digest",
    true,
    keccak256Utf8("not the message"),
    HAND_P256.r,
    HAND_P256.s,
    X,
    Y,
    false,
  );
  push(
    "hand/off-curve-key",
    true,
    HAND_P256.digest,
    HAND_P256.r,
    HAND_P256.s,
    X,
    hex(u256be(1n)),
    false,
  );
  push("hand/zero-r", true, HAND_P256.digest, 0n, HAND_P256.s, X, Y, false);
  push("hand/s-equals-n", true, HAND_P256.digest, HAND_P256.r, P256_N, X, Y, false);

  const rng = new Rng(0x9256n);
  for (let i = 0; i < 16; i++) {
    const scalar = new SecretBytes(u256be(1n + rng.below(P256_N - 2n)), "k");
    const pub = p256.getPublicKey(scalar.expose(), false);
    const x = hex(pub.subarray(1, 33));
    const y = hex(pub.subarray(33, 65));
    const digest = hex(rng.bytes(32));
    const sig = parseP256Signature(signAuthorityDigest(scalar, digest));
    if (sig === null) throw new Error("signAuthorityDigest produced an unparseable signature");
    push(`gen/${i.toString().padStart(2, "0")}`, false, digest, sig.r, sig.s, x, y, true);
    if (i % 4 === 0)
      push(
        `gen/${i.toString().padStart(2, "0")}-tampered-r`,
        false,
        digest,
        (sig.r + 1n) % P256_N || 1n,
        sig.s,
        x,
        y,
        false,
      );
  }
  return { suite: "p256-signatures", version: 1, generator: GENERATOR, count: cases.length, cases };
}

// ---------------------------------------------------------------------------------------------
function main(): void {
  const check = process.argv.includes("--check");
  const suites: ReadonlyArray<[Suite, () => VectorFile]> = [
    ["keys", genKeys],
    ["envelope", genEnvelope],
    ["p256-signatures", genP256],
  ];
  let dirty = 0;
  for (const [suite, gen] of suites) {
    if (!SUITES.includes(suite)) throw new Error(`unknown suite ${suite}`);
    const text = serialiseVectorFile(gen());
    const path = vectorPath(suite);
    if (check) {
      if (readFileSync(path, "utf8") !== text) {
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
