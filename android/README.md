# FIRSTHAND capture companion (Android)

The phone is a **sensor, not a locker**. This app holds no FIRSTHAND key, knows nothing about
passports, grants or Monad, and exposes exactly three operations:

1. `generateKey(challenge)` — a non-exportable P-256 key inside the secure element, with an
   attestation challenge bound to the principal;
2. `getChain()` — the key's attestation certificate chain;
3. `sign(digest32)` — a 64-byte `r‖s` witness over `hwDigest`.

Everything else — minting, sealing, anchoring, publishing — stays in the PWA, which already does it
and is already tested. See ADR-0015 and `~/.claude/plans` for why the app was scoped this way.

> **What a signature from here proves.** That the key was generated inside a certified secure
> element on a device whose verified-boot state the certificate records, and that *this* passport's
> content hash was signed by *that* key. **Not** what the camera saw — the secure element signs a
> digest handed to it by app code and never sees a sensor. README §14 limitation 3 stands.

---

## Step 0 — the spike (do this first)

Nothing else starts until a real attestation chain exists, because the chain's signature algorithms
decide whether the on-chain verifier can check the whole chain or must stop at a pinned
intermediate.

### Prerequisites

| | |
|---|---|
| Android Studio | Any recent stable release |
| SDK Platform | API 34 or newer (**SDK Manager → SDK Platforms**) |
| Platform-Tools | For `adb` (**SDK Manager → SDK Tools → Android SDK Platform-Tools**) |
| Phone | Developer options on, **USB debugging** on, cable connected, "Allow debugging" accepted |

Put `adb` on your PATH once:

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
adb devices        # your phone must appear as "device", not "unauthorized"
```

### Create the project

**New Project → Empty Views Activity**, then:

| Field | Value |
|---|---|
| Name | `FirsthandCapture` |
| Package name | `xyz.firsthand.capture` |
| Save location | `<repo>/android` |
| Language | Kotlin |
| Minimum SDK | **API 28 (Android 9.0)** — `setIsStrongBoxBacked` does not exist below it |
| Build configuration language | Kotlin DSL |

Nothing else needs changing: no extra Gradle dependencies, no permissions, no network access.
`KeyStore`, `KeyPairGenerator` and SHA-256 are all platform APIs.

### Replace `MainActivity.kt`

Keep the generated `package` line; replace the rest. The generated layout is unused.

```kotlin
package xyz.firsthand.capture

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.ProviderException
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec

/**
 * Spike only: generate an attested key, dump its chain, report what the hardware actually gave us.
 * Whatever this prints is a measurement, never a claim — if the device has no StrongBox, the run
 * says TEE and the demo says TEE.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // StrongBox key generation takes a second or two; keep it off the main thread.
        Thread { runSpike() }.start()
    }

    private fun runSpike() {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(ALIAS)) keyStore.deleteEntry(ALIAS)

        var strongBox = true
        try {
            generate(strongBox = true)
        } catch (e: StrongBoxUnavailableException) {
            strongBox = false
            Log.w(TAG, "no StrongBox on this device, falling back to TEE", e)
            generate(strongBox = false)
        } catch (e: ProviderException) {
            // Some OEMs surface the same condition as a bare ProviderException.
            strongBox = false
            Log.w(TAG, "StrongBox refused, falling back to TEE", e)
            generate(strongBox = false)
        }

        val chain = keyStore.getCertificateChain(ALIAS)
        if (chain == null) {
            Log.e(TAG, "no certificate chain — key attestation is unsupported here")
            return
        }

        Log.i(TAG, "device=${Build.MANUFACTURER} ${Build.MODEL}")
        Log.i(TAG, "release=${Build.VERSION.RELEASE} sdk=${Build.VERSION.SDK_INT} patch=${Build.VERSION.SECURITY_PATCH}")
        Log.i(TAG, "strongBoxRequested=$strongBox chainLength=${chain.size}")

        val pem = StringBuilder()
        chain.forEachIndexed { index, certificate ->
            val x509 = certificate as X509Certificate
            Log.i(TAG, "cert[$index] sigAlg=${x509.sigAlgName} subject=${x509.subjectX500Principal}")
            pem.append("-----BEGIN CERTIFICATE-----\n")
                .append(Base64.encodeToString(x509.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n"))
                .append("\n-----END CERTIFICATE-----\n")
        }

        val out = File(getExternalFilesDir(null), "attestation-chain.pem")
        out.writeText(pem.toString())
        Log.i(TAG, "wrote ${out.absolutePath}")
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            // The real build binds this to `principalId ‖ nonce`, so the certificate itself proves
            // the key was created in response to a request naming that principal.
            .setAttestationChallenge(CHALLENGE)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
            initialize(spec)
            generateKeyPair()
        }
    }

    private companion object {
        const val TAG = "firsthand"
        const val ALIAS = "firsthand-spike"
        val CHALLENGE = "FIRSTHAND-SPIKE-0001".toByteArray()
    }
}
```

### Run it and pull the chain

Press **Run** (or `Shift+F10`), then:

```bash
adb logcat -d -s firsthand:I firsthand:W firsthand:E
adb pull /sdcard/Android/data/xyz.firsthand.capture/files/attestation-chain.pem .
```

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

Also note the **`strongBoxRequested`** line from logcat: `true` means security level 2, `false` means
level 1 (TEE). Both ship. Only the label changes.

### Privacy check before the chain is committed

The chain becomes a committed test fixture in a **public** repository. Default key attestation
carries no device identifiers, but that gets asserted, not eyeballed — `deviceIdentifierTags()` in
`@firsthand/core/attestation` must return `[]` for this chain, and the fixture test pins it.

---

## Where this goes next

Once the branch is known, this activity grows the three operations above plus the transport to the
PWA (loopback HTTP on `127.0.0.1:8787`, or gateway staging — decided by the same day's spike C).

**Capture order is fixed and not negotiable:** capture → downscale → hash the *final* bytes → sign →
upload. Hashing before downscaling produces a witness for bytes nobody will ever see. The hosted
gateway caps a capture at roughly 4 MiB and phone photos are 3–12 MB, so downscaling is mandatory.
