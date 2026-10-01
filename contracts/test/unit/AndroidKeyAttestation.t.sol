// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AndroidKeyAttestationHarness} from "../Harnesses.sol";
import {VectorTest} from "../Vectors.sol";
import {AndroidKeyAttestation} from "../../src/libraries/AndroidKeyAttestation.sol";

/// @dev Every case in the shared suite, through this reader. The expected values were the
///      encoder's *inputs* — a chosen security level, a chosen challenge, a keypair, a signature
///      from an independent signer — so agreement here means two implementations and a generator
///      all say the same thing about the same bytes.
contract AndroidKeyAttestationTest is VectorTest {
    AndroidKeyAttestationHarness internal h;

    function setUp() public {
        loadSuite("android-attestation");
        h = new AndroidKeyAttestationHarness();
    }

    function malformed(
        uint8 code
    ) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AndroidKeyAttestation.AttestationMalformed.selector, code);
    }

    /// @dev Error names in the vectors are shared with the TypeScript cases; map them to codes here.
    function codeFor(
        string memory name
    ) internal pure returns (uint8) {
        bytes32 k = keccak256(bytes(name));
        if (k == keccak256("NotPrime256v1")) return AndroidKeyAttestation.E_NOT_PRIME256V1;
        if (k == keccak256("NotEc")) return AndroidKeyAttestation.E_NOT_EC;
        if (k == keccak256("Point")) return AndroidKeyAttestation.E_POINT;
        if (k == keccak256("Signature")) return AndroidKeyAttestation.E_SIGNATURE;
        if (k == keccak256("Trailing")) return AndroidKeyAttestation.E_TRAILING;
        revert("unknown error name in vectors");
    }

    function test_vectors() public {
        assertHandCases(3);
        for (uint256 i = 0; i < count; ++i) {
            // A certificate that parses and is refused by the chain walk belongs to the
            // registry's tests; this reader's job ends at "it is well-formed".
            if (has(i, ".expected.parses")) {
                h.parseCertificate(bytes_(i, ".input.certificate"));
                continue;
            }
            if (has(i, ".expected.error")) {
                bytes memory expected = malformed(codeFor(str(i, ".expected.error")));
                // Some shapes are a valid certificate carrying an invalid extension: the refusal
                // belongs to whichever reader is looking at the malformed bytes.
                if (has(i, ".expected.onKeyDescription")) {
                    vm.expectRevert(expected);
                    h.keyDescriptionOf(bytes_(i, ".input.certificate"));
                } else {
                    vm.expectRevert(expected);
                    h.parseCertificate(bytes_(i, ".input.certificate"));
                }
                continue;
            }
            assertCertificate(i);
            assertKeyDescription(i);
        }
    }

    function assertCertificate(
        uint256 i
    ) internal view {
        string memory name = caseName(i);
        AndroidKeyAttestation.Certificate memory c = h.parseCertificate(bytes_(i, ".input.certificate"));
        assertEq(c.tbsHash, b32(i, ".expected.tbsHash"), name);
        assertEq(c.x, uint256(b32(i, ".expected.x")), name);
        assertEq(c.y, uint256(b32(i, ".expected.y")), name);
        assertEq(c.sha256Ecdsa, boolean(i, ".expected.sha256Ecdsa"), name);
        // A chain links by name; a certificate that is its own issuer would link to itself.
        assertTrue(c.issuerHash != c.subjectHash, name);
        assertTrue(c.r != 0 && c.s != 0, name);
    }

    function assertKeyDescription(
        uint256 i
    ) internal view {
        string memory name = caseName(i);
        AndroidKeyAttestation.KeyDescription memory kd = h.keyDescriptionOf(bytes_(i, ".input.certificate"));
        assertEq(kd.present, boolean(i, ".expected.hasKeyDescription"), name);
        if (!kd.present) return;

        assertEq(kd.attestationSecurityLevel, u(i, ".expected.securityLevel"), name);
        assertEq(kd.challengeHash, b32(i, ".expected.challengeHash"), name);
        // Absence is reported as absence; a default here would be a value nobody attested.
        bool expectOrigin = !has(i, ".expected.hasOrigin") || boolean(i, ".expected.hasOrigin");
        assertEq(kd.hasOrigin, expectOrigin, name);
        if (has(i, ".expected.origin")) assertEq(kd.origin, u(i, ".expected.origin"), name);
        if (has(i, ".expected.verifiedBootState")) {
            assertTrue(kd.hasRootOfTrust, name);
            assertEq(kd.verifiedBootState, u(i, ".expected.verifiedBootState"), name);
        }
    }

    // ── what the suite cannot carry ─────────────────────────────────────────────────────────────

    function test_refusesTrailingBytesAfterTheCertificate() public {
        bytes memory stuffed = abi.encodePacked(bytes_(0, ".input.certificate"), hex"00");
        vm.expectRevert(malformed(AndroidKeyAttestation.E_TRAILING));
        h.parseCertificate(stuffed);
    }

    function test_findsTheExtensionWhateverTheExtensionShape() public view {
        // `critical` present (three elements) and absent (two) must reach the same value.
        AndroidKeyAttestation.KeyDescription memory plain =
            h.keyDescriptionOf(bytes_(indexOfCase("hand/leaf"), ".input.certificate"));
        AndroidKeyAttestation.KeyDescription memory critical =
            h.keyDescriptionOf(bytes_(indexOfCase("hand/critical-extension"), ".input.certificate"));
        assertTrue(plain.present && critical.present);
        assertEq(critical.challengeHash, plain.challengeHash);
        assertEq(critical.attestationSecurityLevel, plain.attestationSecurityLevel);
    }

    function test_walksPastAnExtensionToReachOurs() public view {
        // With one extension the loop never advances; the advancing arm needs a second.
        AndroidKeyAttestation.KeyDescription memory kd =
            h.keyDescriptionOf(bytes_(indexOfCase("hand/second-extension"), ".input.certificate"));
        assertTrue(kd.present, "found behind another extension");
        assertEq(kd.attestationSecurityLevel, 2);
    }

    function test_passesOverAnExtensionThatIsNotOurs() public view {
        AndroidKeyAttestation.KeyDescription memory kd =
            h.keyDescriptionOf(bytes_(indexOfCase("hand/foreign-extension"), ".input.certificate"));
        assertFalse(kd.present, "a different OID is not a key description");
    }

    function test_reportsMissingAuthorizationsRatherThanDefaultingThem() public view {
        AndroidKeyAttestation.KeyDescription memory kd =
            h.keyDescriptionOf(bytes_(indexOfCase("hand/no-authorizations"), ".input.certificate"));
        assertTrue(kd.present);
        assertFalse(kd.hasOrigin, "no origin attested");
        assertFalse(kd.hasRootOfTrust, "no root of trust attested");
        assertEq(kd.attestationSecurityLevel, 1, "and the level it does attest is read");
    }

    function test_theHighSLeafParsesToTheSameKeyAndDigest() public view {
        AndroidKeyAttestation.Certificate memory low =
            h.parseCertificate(bytes_(indexOfCase("hand/leaf"), ".input.certificate"));
        AndroidKeyAttestation.Certificate memory high =
            h.parseCertificate(bytes_(indexOfCase("hand/leaf-high-s"), ".input.certificate"));
        assertEq(high.x, low.x);
        assertEq(high.tbsHash, low.tbsHash);
        // The contract reads `s` as encoded. Normalising is the submitter's job, because
        // `P256.verify` refuses a high-s signature and the caller is the one who can re-encode.
        assertTrue(high.s != low.s, "high-s is carried through, not silently rewritten");
    }

    function indexOfCase(
        string memory name
    ) internal view returns (uint256) {
        for (uint256 i = 0; i < count; ++i) {
            if (keccak256(bytes(caseName(i))) == keccak256(bytes(name))) return i;
        }
        revert("no such case");
    }
}
