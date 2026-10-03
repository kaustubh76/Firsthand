package xyz.firsthand.capture

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * The spike, as a screen (ADR-0015, plan step 4b).
 *
 * Every line it prints is a measurement read back off the hardware, never a claim this app makes
 * about itself. If the handset has no StrongBox the run says TEE, the fixture says TEE, and the
 * README says TEE — the point of running it on real hardware is to find out, not to confirm.
 *
 * It writes the attestation chain to external files as PEM with its provenance in the header, so
 * the committed fixture carries the device it came from rather than a note someone typed later.
 */
class MainActivity : Activity() {

    private lateinit var view: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        view =
            TextView(this).apply {
                textSize = 11f
                gravity = Gravity.TOP
                setPadding(32, 48, 32, 48)
                typeface = android.graphics.Typeface.MONOSPACE
                text = "running…"
            }
        setContentView(ScrollView(this).apply { addView(view) })
        // StrongBox key generation takes a second or two and must not block the main thread.
        Thread { runSpike() }.start()
    }

    private fun runSpike() {
        val log = StringBuilder()
        fun say(line: String) {
            Log.i(TAG, line)
            log.append(line).append('\n')
            runOnUiThread { view.text = log.toString() }
        }

        try {
            say("device     ${Build.MANUFACTURER} ${Build.MODEL}")
            say("android    ${Build.VERSION.RELEASE} (sdk ${Build.VERSION.SDK_INT})")
            say("patch      ${Build.VERSION.SECURITY_PATCH}")
            say("principal  0x${PRINCIPAL_ID.toHex()}")
            say("nonce      0x${NONCE.toHex()}")
            say("")

            val generated = SecureElement.generateKey(PRINCIPAL_ID, NONCE, replaceExisting = true)
            say("strongBox  ${if (generated.strongBoxBacked) "granted" else "UNAVAILABLE — TEE"}")
            say("chain      ${generated.chain.size} certificates")
            say("")

            val factory = CertificateFactory.getInstance("X.509")
            val parsed =
                generated.chain.map { factory.generateCertificate(it.inputStream()) as X509Certificate }
            parsed.forEachIndexed { i, c ->
                // The LAST certificate's signature algorithm is the D4 decision: an RSA root means
                // every link can be verified on Monad (modexp at 0x05); a P-384 root means the
                // chain is verified on chain only down from a pinned intermediate.
                say("cert[$i]  sigAlg=${c.sigAlgName}  key=${c.publicKey.algorithm}")
                say("         subject=${c.subjectX500Principal}")
                say("         issuer =${c.issuerX500Principal}")
            }
            say("")

            // A round trip on the device itself: if signing or verification is broken here, it is
            // broken before any of the host-side plumbing gets a chance to be blamed for it.
            val preimage = ByteArray(179) { it.toByte() }
            val der = SecureElement.sign(generated.alias, preimage)
            val ok =
                Signature.getInstance("SHA256withECDSA").run {
                    initVerify(parsed[0].publicKey)
                    update(preimage)
                    verify(der)
                }
            say("selfTest   sign+verify ${if (ok) "OK" else "FAILED"} (DER ${der.size} bytes)")

            val out = File(getExternalFilesDir(null), "attestation-chain.pem")
            out.writeText(pem(parsed, generated.strongBoxBacked))
            say("wrote      ${out.absolutePath}")
        } catch (e: Throwable) {
            Log.e(TAG, "spike failed", e)
            say("")
            say("FAILED ${e::class.java.simpleName}: ${e.message}")
        }
    }

    /** Provenance first, so the committed fixture can never be separated from where it came from. */
    private fun pem(chain: List<X509Certificate>, strongBox: Boolean): String {
        val text = StringBuilder()
        text.append("# FIRSTHAND hardware attestation chain (ADR-0015)\n")
            .append("# device       ${Build.MANUFACTURER} ${Build.MODEL}\n")
            .append("# android      ${Build.VERSION.RELEASE} (sdk ${Build.VERSION.SDK_INT})\n")
            .append("# securityPatch ${Build.VERSION.SECURITY_PATCH}\n")
            .append("# strongBox    ${if (strongBox) "granted" else "unavailable (TEE)"}\n")
            .append("# principalId  0x${PRINCIPAL_ID.toHex()}\n")
            .append("# nonce        0x${NONCE.toHex()}\n")
            .append("# challenge    principalId || nonce, 64 raw bytes\n")
            .append("# generatedBy  xyz.firsthand.capture MainActivity (spike)\n")
        chain.forEachIndexed { i, c ->
            text.append("#\n# cert[$i] sigAlg=${c.sigAlgName} subject=${c.subjectX500Principal}\n")
                .append("-----BEGIN CERTIFICATE-----\n")
                .append(Base64.encodeToString(c.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n"))
                .append("\n-----END CERTIFICATE-----\n")
        }
        return text.toString()
    }

    private companion object {
        const val TAG = "firsthand"

        /**
         * Fixed, so the committed fixture is reproducible and the registry's challenge check can
         * be asserted against known words rather than against whatever the run happened to pick.
         * The real flow takes both from the locker, which spends the nonce on chain.
         */
        val PRINCIPAL_ID = ByteArray(32) { 0x11 }
        val NONCE = ByteArray(32) { 0x22 }
    }
}
