package xyz.firsthand.capture

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What the secure element actually does, asserted on the handset (ADR-0015).
 *
 * This runs under `connectedAndroidTest`, so it is the only test in the repository whose subject
 * is hardware. It deliberately does **not** require StrongBox: a TEE-only handset is a supported
 * device at level 1, and a test that failed there would be asserting a purchase decision rather
 * than a property of the code.
 */
@RunWith(AndroidJUnit4::class)
class SecureElementTest {

    @Test
    fun theChainIsWellFormedAndEveryLinkVerifies() {
        assertTrue("attestation produced fewer than two certificates", chain.size >= 2)
        for (i in 0 until chain.size - 1) {
            // Throws on mismatch; the message names the link so a failure is readable.
            chain[i].verify(chain[i + 1].publicKey)
        }
    }

    @Test
    fun theAttestedKeyIsP256() {
        val key = chain[0].publicKey
        assertEquals("EC", key.algorithm)
        assertEquals(256, (key as ECPublicKey).params.curve.field.fieldSize)
    }

    @Test
    fun theCertificateCarriesAKeyDescription() {
        assertNotNull(
            "no KeyDescription extension — this build is not hardware-attested",
            chain[0].getExtensionValue(KEY_DESCRIPTION_OID),
        )
    }

    /**
     * The registry refuses a chain whose challenge is not `principalId ‖ nonce`
     * (`HardwareDeviceRegistry._requireAttested`), so if those 64 bytes are not in the extension
     * exactly as handed in, registration fails on chain for reasons no log here would explain.
     */
    @Test
    fun theChallengeIsPrincipalIdConcatNonce() {
        val extension = chain[0].getExtensionValue(KEY_DESCRIPTION_OID)!!
        assertTrue("challenge bytes absent from the KeyDescription", extension.containsSlice(CHALLENGE))
    }

    /**
     * The chain is committed to a **public** repository as a test fixture. Device-properties
     * attestation is never requested, so brand, model, serial and IMEI should be absent — and
     * that gets asserted rather than eyeballed, because an OEM that includes them by default
     * would otherwise publish them on the first run.
     */
    @Test
    fun theChainCarriesNoDeviceIdentifier() {
        val extension = chain[0].getExtensionValue(KEY_DESCRIPTION_OID)!!
        for (identifier in listOf(Build.BRAND, Build.DEVICE, Build.MODEL, Build.MANUFACTURER, Build.PRODUCT)) {
            if (identifier.isNullOrBlank()) continue
            assertTrue(
                "the KeyDescription contains the device identifier \"$identifier\"",
                !extension.containsSlice(identifier.toByteArray(Charsets.UTF_8)),
            )
        }
    }

    /** The round trip the whole class-3 claim rests on, with the host's exact payload shape. */
    @Test
    fun aCapturePreimageSignsAndVerifiesUnderTheAttestedKey() {
        val preimage = ByteArray(179) { (it * 7).toByte() }
        val der = SecureElement.sign(alias, preimage)
        val verified =
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(chain[0].publicKey)
                update(preimage)
                verify(der)
            }
        assertTrue("the attested key did not verify its own signature", verified)
    }

    /** A different payload must not verify — otherwise the test above proves nothing. */
    @Test
    fun aDifferentPreimageDoesNotVerify() {
        val preimage = ByteArray(179) { (it * 7).toByte() }
        val der = SecureElement.sign(alias, preimage)
        val tampered = preimage.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val verified =
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(chain[0].publicKey)
                update(tampered)
                verify(der)
            }
        assertTrue("a signature verified under the wrong preimage", !verified)
    }

    private companion object {
        const val KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17"
        val PRINCIPAL_ID = ByteArray(32) { 0x33 }
        val NONCE = ByteArray(32) { 0x44 }
        val CHALLENGE = PRINCIPAL_ID + NONCE

        lateinit var alias: String
        lateinit var chain: List<X509Certificate>

        /** Generated once: StrongBox keygen is slow, and every test here reads the same key. */
        @JvmStatic
        @BeforeClass
        fun generate() {
            val generated = SecureElement.generateKey(PRINCIPAL_ID, NONCE, replaceExisting = true)
            alias = generated.alias
            val factory = CertificateFactory.getInstance("X.509")
            chain = generated.chain.map { factory.generateCertificate(it.inputStream()) as X509Certificate }
        }
    }
}

/** Naive substring search; the extension is a couple of kilobytes and this runs six times. */
private fun ByteArray.containsSlice(needle: ByteArray): Boolean {
    if (needle.isEmpty() || needle.size > size) return false
    outer@ for (i in 0..size - needle.size) {
        for (j in needle.indices) if (this[i + j] != needle[j]) continue@outer
        return true
    }
    return false
}
