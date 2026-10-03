# ADR-0015 — Hardware capture attestation: the secure element co-signs, the chain verifies the certificate

**Status:** accepted · **Date:** 2026-10-03 (freeze week)

## Context

The project names its own hole in four places. `Readme.md:241` and `:312` say a passport proves
*origin key + attestation class + consent* and **not** that the bytes came from a sensor;
`Readme.md:254` and `docs/SECURITY.md:95` both answer the obvious follow-up with *"hardware capture
attestation is the roadmap"*. §20 predicts a judge will ask exactly this, because the honest
summary of `AttestationClass.DEVICE_CAPTURE` is that **nothing checks it** — a real passkey can
sign AI-generated filler and the protocol will anchor it, serve it and settle payment for it.

Two constraints pull the other way. §22 lists *"TEE attestation"* as an explicit non-goal, and §23
puts this after the hackathon. Both are recorded here as deviations rather than quietly ignored.

The §22 non-goal is about **running the protocol inside a TEE** — a trusted enclave that holds keys
or executes the locker. That is not what this is. This consumes a certificate the device's existing
secure element already issues, verifies it against pinned anchors, and stores the result. No part of
FIRSTHAND runs inside anything.

What made it worth doing in freeze week is that Monad supplies the missing piece: **RIP-7212**, the
P-256 precompile at `0x100`. Verifying an X.509 attestation chain on chain is a handful of ECDSA
verifications over `secp256r1` — ruinous on a chain without the precompile, ordinary on one with it.
The feature exists here because of the chain it is deployed on, which is the question a Track-04
entry is supposed to answer.

## Decision

### What class 3 claims, and the sentence that bounds it

`AttestationClass.HARDWARE = 3`: the passport is co-signed by a key that a certificate chain proves
was **generated inside** a certified secure element, and that key is **registered on chain** to this
principal.

> `setAttestationChallenge` attests the **key**, not the bytes. The secure element signs a digest
> handed to it by app code and never sees the camera.

So the claim is **transplantation resistance**, and only that: a class-3 datum passed through one
physically-identified secure element, on a device whose verified-boot state is attested, and the
witness cannot be moved to another device, replayed under another origin, or minted by a desktop
script. It does **not** close the laundering gap — a camera pointed at a screen still produces a
class-3 capture. `Readme.md` §14 limitation 3 stands unchanged, and no copy anywhere may say
otherwise.

### The chain enforces, and separately records

| Fact | On chain |
|---|---|
| Every P-256 link verifies up to a pinned anchor | **Enforced** |
| Each certificate's issuer matches the next subject | **Enforced** |
| Signed with `ecdsa-with-SHA256` | **Enforced** |
| `attestationSecurityLevel ≥ minimum` | **Enforced**, and the measured value stored |
| `origin == GENERATED` (tag 702) | **Enforced** — this is the non-exportability claim |
| `attestationChallenge == keccak(principalId ‖ nonce)` | **Enforced** |
| `rootOfTrust.verifiedBootState` (tag 704) | **Recorded and emitted, not enforced** |

Verified boot is deliberately not a condition. It is read out of a signed certificate, so it is a
measurement rather than an assertion — but a developer handset with an unlocked bootloader reports
`UNVERIFIED`, and making that revert would produce a device nobody can register rather than a
device nobody should trust. **The chain records what the certificate says; policy belongs to the
gateway** (`HARDWARE_REQUIRE_VERIFIED_BOOT`, default false). That split is the point, not a gap.

The effective level is the **weaker** of `attestationSecurityLevel` and `keymasterSecurityLevel`:
reporting the stronger would let a TEE-enforced key claim StrongBox because the attestation above
it happened to be StrongBox-signed.

### Anchors are constructor arguments, with no setter

§22 forbids an upgradable trust anchor and this honours it literally: `HardwareDeviceRegistry` takes
its anchors at deployment and can never be pointed somewhere else. It also sidesteps the question
of the root's curve — no commercial attestation root is P-256 (Google's is RSA or P-384), so what is
pinned is the **highest P-256 certificate** in the chain. The link above it is verified once, off
chain, and the pin records that result. That is a real limitation and `docs/SECURITY.md` prints it
rather than rounding it off.

### What a witness is signed over

`sha256("FIRSTHAND-HW-CAPTURE-v1" ‖ chainId ‖ origin ‖ h ‖ capturedAt ‖ nonce ‖ deviceClass)`.

Every input is a value the passport already commits to, so the witness needs no slot in the frozen
`Attestation` struct, and a signature over it cannot be lifted onto different bytes, a different
locker or a replayed deposit. `origin` and `nonce` are what make it *transplantation*-resistant
rather than merely content-binding: the same photo deposited by a second locker has a different
deposit key and a different deterministic nonce, so the witness stops verifying.

**The device is handed the preimage, not the digest.** A Keystore key built with `DIGEST_SHA256`
refuses an input that is already hashed, and `NONEwithECDSA` needs `DIGEST_NONE`, a mode StrongBox
commonly will not grant. The element runs `SHA256withECDSA` over the 179-byte preimage instead, and
its internal hash *is* the digest above. `hardwareCaptureDigest` is defined as `sha256` of
`hardwareCapturePreimage` so the two cannot drift.

SHA-256 rather than keccak throughout, because that is what Android produces, what `P256.sol` hands
the precompile, and what `verifyP256` checks — one digest, three implementations, no conversion
step to get wrong.

### Where each question is answered

Registration and revocation are authorised like every other authority verb: a P-256 signature over
an EIP-712 digest under **the registry's own domain** (ADR-0009), relayable by anyone, `msg.sender`
meaning nothing. The authority key comes from `PrincipalRegistry.authorityKey`, so the principal
must already be enrolled and no caller-supplied key is trusted. Revocation **records** rather than
deletes: a buyer auditing an older manifest still needs to see that the device existed.

Two questions, kept apart on purpose:

- *Does this witness verify?* Cryptography. Answered locally, by `hardwareProofOk` — the same
  predicate the manifest verifier and the PWA's auditor view both call, so they cannot reach
  different verdicts about what class 3 means.
- *Is the device registered and live?* State. Answered only by `HardwareDeviceRegistry`.

Conflating them would let an unregistered key look admissible. `signCaptureWitness` exists as a
software stand-in for tests and the browser tier, and it cannot fake a hardware claim — not as a
matter of trust but structurally, because what makes a witness count is a registration that
verifies a certificate chain no software key has.

### The phone is a sensor, not a locker

The companion app (`android/`) holds no FIRSTHAND key, mints nothing, and has never heard of Monad.
Three operations and no more: generate an attested key, hand back the chain, sign a preimage. A
standalone app rather than a WebView wrapper, because the PWA already works and the thing that
cannot be done in a browser is precisely the Keystore call.

`setDevicePropertiesAttestationIncluded` is never called — it would put IMEI, serial, brand and
model into a certificate that becomes a fixture in a **public** repository. An instrumented test
asserts their absence rather than trusting the comment.

## Consequences

- **Judges can ask the §20 question and get a demo.** The refusal's twin: one photo deposited
  twice, class 2 and class 3; replay the class-3 witness under a second locker and the gateway
  refuses it (`FH_REFUSED_HARDWARE`) before anything is sealed, while the class-2 copy sails
  through because nothing checks it.
- **A deposit can now be refused for a new reason**, and that is the feature. `FH_REFUSED_HARDWARE`
  and `FH_ATTESTATION_INVALID` both answer HTTP 422.
- **The enum widened without a redeploy.** `hashAttestation` takes a raw `uint8` and nothing in
  `contracts/src/` range-checks `AttestationClass`, so class 3 works against the already-deployed
  immutable contracts. No EIP-712 change, no migration.
- **`HardwareDeviceRegistry` is an optional deployment key.** A gateway or locker pointed at an
  older deployment boots and says class 3 is unavailable here, rather than crashing on a missing
  address.
- **StrongBox is not required.** The enum is `HARDWARE`, not `STRONGBOX`, and the *measured* level
  is stored and rendered. A TEE-only handset ships at level 1 and the UI says TEE.
- **A device still cannot prove what a camera saw.** Anyone who reads this far should leave knowing
  that, which is why the limitation is stated three times above and in the app itself.
