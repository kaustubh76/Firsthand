# FIRSTHAND capture companion (Android)

The phone is a **sensor, not a locker**. This app holds no FIRSTHAND key, knows nothing about
passports, grants or Monad, and exposes exactly three operations ([`SecureElement.kt`](app/src/main/java/xyz/firsthand/capture/SecureElement.kt)):

1. `generateKey(principalId, nonce)` — a non-exportable P-256 key inside the secure element, whose
   attestation challenge is `principalId ‖ nonce`;
2. `chain(alias)` — the key's attestation certificate chain, DER, leaf first;
3. `sign(alias, preimage)` — an ECDSA signature over the capture preimage.

Everything else — minting, sealing, anchoring, publishing — stays in the PWA, which already does it
and is already tested. See ADR-0015 for why the app was scoped this way.

> **What a signature from here proves.** That the key was generated inside a certified secure
> element on a device whose verified-boot state the certificate records, and that *this* passport's
> content hash was signed by *that* key. **Not** what the camera saw — the secure element signs
> bytes handed to it by app code and never sees a sensor. `Readme.md` §14 limitation 3 stands.

---

## Two interface rules that are not negotiable

**The challenge is exactly 64 raw bytes: `principalId ‖ nonce`.** `HardwareDeviceRegistry`
(`_requireAttested`) checks `keccak256(challenge) == keccak256(abi.encodePacked(principalId,
nonce))`. The phone therefore cannot pick its own nonce — the locker chooses one, spends it on
chain in the same call, and hands it here. That is what stops a chain being lifted out of one
registration and replayed into another.

**The host signs the preimage, not the digest.** A Keystore key created with `DIGEST_SHA256` will
not sign a value that is already hashed, and `NONEwithECDSA` needs `DIGEST_NONE` — a mode StrongBox
commonly refuses. So the bridge passes the **179 bytes** of
`hardwareCapturePreimage()` and the element runs `SHA256withECDSA` over them; its internal hash
*is* `hardwareCaptureDigest()` by construction. `packages/core/src/attestation/hardwareDigest.ts`
derives one from the other so they cannot drift, and `attestation.test.ts` pins the equality.

The signature comes back DER-encoded and may carry a high `s`. Normalising to 64-byte low-s `r ‖ s`
happens on the host, where `P256.verify` and `verifyP256` both reject anything else.

---

## Build it

Nothing here needs a phone — compiling is how the Keystore API usage gets checked before the
handset is ever reachable.

```bash
cd android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
printf 'sdk.dir=%s/Library/Android/sdk\n' "$HOME" > local.properties   # git-ignored
./gradlew :app:assembleDebug
```

`minSdk` is **28**: `setIsStrongBoxBacked` does not exist below it, and a device that cannot answer
the question this app exists to ask is not a device worth supporting. There are no Compose, no
AppCompat and no network dependencies — `KeyStore`, `KeyPairGenerator` and SHA-256 are platform
APIs, and the spike screen is a `TextView`.

## Run the spike

The phone needs **Developer options → USB debugging**, and the *"Allow USB debugging?"* prompt
accepted. Until then `adb devices` lists nothing at all — an unauthorised device would still
appear, as `unauthorized`.

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
adb devices                                    # must read "device"
./gradlew :app:installDebug
adb shell am start -n xyz.firsthand.capture/.MainActivity
adb logcat -d -s firsthand:I firsthand:W firsthand:E
adb pull /sdcard/Android/data/xyz.firsthand.capture/files/attestation-chain.pem .
```

The screen and the log print the same thing: device, Android release, security patch, whether
StrongBox was granted, the chain length, and **every certificate's signature algorithm**. The PEM
carries all of it inline as a header, so the committed fixture can never be separated from the
handset it came from.

### Assertions, not eyeballs

```bash
./gradlew :app:connectedAndroidTest
```

[`SecureElementTest`](app/src/androidTest/java/xyz/firsthand/capture/SecureElementTest.kt) runs on
the handset and checks what the log only shows: every link in the chain verifies, the attested key
is P-256, the KeyDescription is present, the challenge is exactly `principalId ‖ nonce`, a capture
preimage signs and verifies while a tampered one does not, and the chain carries **no device
identifier**. That last one matters because the chain becomes a committed fixture in a **public**
repository — `setDevicePropertiesAttestationIncluded` is never called, and the test proves it
rather than trusting this sentence.

It deliberately does **not** require StrongBox. A TEE-only handset is a supported device at
level 1; a test that failed there would be asserting a purchase decision, not a property of the
code.

### Read the answer

```bash
csplit -sz -f cert- -b '%d.pem' attestation-chain.pem '/-----BEGIN CERTIFICATE-----/' '{*}'
for f in cert-*.pem; do
  echo "== $f"
  openssl x509 -in "$f" -noout -text \
    | grep -E 'Signature Algorithm|Public Key Algorithm|NIST CURVE|Subject:|Issuer:' \
    | sed 's/^ *//' | sort -u
done
```

The **last certificate's `Signature Algorithm`** is the decision:

| It says | Branch | What the README may then claim |
|---|---|---|
| `sha256WithRSAEncryption` | **A** | Every link verified on Monad — P-256 via RIP-7212 (`0x100`), the RSA root via `modexp` (`0x05`) |
| `ecdsa-with-SHA384` | **B** | Every P-256 link verified on Monad, down from a pinned intermediate; the P-384 link checked off-chain once and pinned, because §22 forbids an upgradable anchor |

And the `strongBox` line decides the label: `granted` means security level 2, `UNAVAILABLE — TEE`
means level 1. **Both ship. Only the wording changes.**

---

## Where this goes next

The three operations above plus the transport to the PWA — loopback HTTP on `127.0.0.1:8787`, or an
App Link round trip at one extra tap, decided by whether a Private Network Access preflight blocks
the first.

**Capture order is fixed and not negotiable:** capture → downscale → hash the *final* bytes → sign →
upload. Hashing before downscaling produces a witness for bytes nobody will ever see. The hosted
gateway caps a capture at roughly 4 MiB and phone photos are 3–12 MB, so downscaling is mandatory.
