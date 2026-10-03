package xyz.firsthand.capture

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec

/**
 * The three operations this app exists to perform, and nothing else (ADR-0015).
 *
 * The phone is a **sensor, not a locker**. No FIRSTHAND key lives here, no passport is minted
 * here, and nothing here has heard of Monad. What a signature from this object proves is that the
 * signing key was generated inside a certified secure element on a device whose verified-boot
 * state the certificate records — **not** what the camera saw. The element signs bytes handed to
 * it by app code and never sees a sensor. `Readme.md` §14 limitation 3 stands unchanged.
 */
object SecureElement {

    /** `principalId ‖ nonce`, two 32-byte words. */
    const val CHALLENGE_BYTES = 64

    /**
     * What one key generation produced. `strongBoxBacked` records whether the StrongBox request
     * was *granted*, which is useful for a log line and is **not** evidence: the authoritative
     * security level is the one inside the certificate, read by `AndroidKeyAttestation` on the
     * host and stored by the registry. A level this app asserted about itself would be worth
     * nothing, which is the whole reason the chain is verified somewhere else.
     */
    data class Generated(
        val alias: String,
        val strongBoxBacked: Boolean,
        /** DER, leaf first — exactly the `bytes[] chain` that `registerDevice` takes. */
        val chain: List<ByteArray>,
    )

    /** One key per principal, so registering a second principal cannot silently orphan the first. */
    fun aliasFor(principalId: ByteArray): String {
        require(principalId.size == 32) { "principalId must be 32 bytes, was ${principalId.size}" }
        return "firsthand/" + principalId.toHex()
    }

    fun exists(alias: String): Boolean = keyStore().containsAlias(alias)

    /**
     * Generates a non-exportable P-256 key whose attestation certificate names `principalId` and
     * spends `nonce`.
     *
     * The challenge is exactly `principalId ‖ nonce` as 64 raw bytes, because
     * `HardwareDeviceRegistry._requireAttested` demands
     * `keccak256(challenge) == keccak256(abi.encodePacked(principalId, nonce))`. The phone
     * therefore cannot choose its own nonce: the locker picks one, spends it on chain in the same
     * call, and hands it here. That is what stops a chain being lifted out of one registration and
     * replayed into another.
     *
     * StrongBox is requested first and TEE is accepted silently, because a handset without a
     * discrete secure element should still produce a usable class-3 device — it just gets
     * recorded, and rendered, as level 1. Both ship; only the label changes.
     *
     * @param replaceExisting generating over a live alias destroys a key that may already be
     *   registered on chain, which would quietly break every future witness from this device. The
     *   caller has to say so out loud.
     */
    fun generateKey(
        principalId: ByteArray,
        nonce: ByteArray,
        replaceExisting: Boolean = false,
    ): Generated {
        require(principalId.size == 32) { "principalId must be 32 bytes, was ${principalId.size}" }
        require(nonce.size == 32) { "nonce must be 32 bytes, was ${nonce.size}" }

        val alias = aliasFor(principalId)
        val store = keyStore()
        if (store.containsAlias(alias)) {
            check(replaceExisting) { "a key already exists for this principal; pass replaceExisting" }
            store.deleteEntry(alias)
        }

        val challenge = principalId + nonce
        check(challenge.size == CHALLENGE_BYTES) { "challenge must be $CHALLENGE_BYTES bytes" }

        val strongBoxBacked =
            try {
                generate(alias, challenge, strongBox = true)
                true
            } catch (e: StrongBoxUnavailableException) {
                // The documented signal: no discrete secure element on this handset.
                store.deleteEntry(alias)
                generate(alias, challenge, strongBox = false)
                false
            } catch (e: ProviderException) {
                // Some OEMs surface the same condition as a bare ProviderException instead, so the
                // documented exception alone would strand those devices on an unusable error.
                store.deleteEntry(alias)
                generate(alias, challenge, strongBox = false)
                false
            }

        return Generated(alias, strongBoxBacked, chain(alias))
    }

    /**
     * The key's attestation certificate chain, DER, leaf first.
     *
     * Public data: it carries the attested public key, the challenge, the measured security level
     * and the verified-boot state, and — because device-properties attestation is never requested
     * below — no device identifier. The host asserts that rather than trusting this sentence.
     */
    fun chain(alias: String): List<ByteArray> {
        val certificates =
            keyStore().getCertificateChain(alias)
                ?: error("no certificate chain for $alias — key attestation is unsupported here")
        return certificates.map { (it as X509Certificate).encoded }
    }

    /**
     * Signs one capture, returning the DER `SEQUENCE { r, s }` the platform produces.
     *
     * The host passes the **preimage**, not the 32-byte digest, and that is a platform constraint
     * rather than a preference: a Keystore key built with `DIGEST_SHA256` will not sign a value
     * that is already hashed, and `NONEwithECDSA` needs `DIGEST_NONE`, which StrongBox commonly
     * refuses. `SHA256withECDSA` hashes here instead, and `sha256(preimage)` *is*
     * `hardwareCaptureDigest(...)` by construction, so the two implementations cannot drift.
     *
     * The result may carry a high `s`. Normalising to low-s 64-byte `r ‖ s` happens on the host,
     * where both `P256.verify` and `verifyP256` reject anything else.
     */
    fun sign(alias: String, preimage: ByteArray): ByteArray {
        val key =
            keyStore().getKey(alias, null) as? PrivateKey
                ?: error("no private key for $alias")
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(preimage)
            sign()
        }
    }

    private fun generate(alias: String, challenge: ByteArray, strongBox: Boolean) {
        val spec =
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(challenge)
                // setDevicePropertiesAttestationIncluded is deliberately NOT called. It adds the
                // IMEI, MEID, serial and brand to the certificate (KeyDescription tags 710-717),
                // and this chain is committed to a public repository as a test fixture.
                .apply { if (strongBox) setIsStrongBoxBacked(true) }
                .build()

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
            initialize(spec)
            generateKeyPair()
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
}

internal fun ByteArray.toHex(): String {
    val out = StringBuilder(size * 2)
    for (b in this) out.append("0123456789abcdef"[(b.toInt() shr 4) and 0xf]).append("0123456789abcdef"[b.toInt() and 0xf])
    return out.toString()
}
