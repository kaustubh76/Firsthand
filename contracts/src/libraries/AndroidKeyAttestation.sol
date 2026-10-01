// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Der} from "./Der.sol";

/// @title AndroidKeyAttestation
/// @notice Reads the slice of X.509 and of Android's `KeyDescription` that a P-256 attestation
///         chain needs (ADR-0015). Twin of `packages/core/src/attestation`; both are checked
///         against `packages/test-vectors/vectors/android-attestation.v1.json`.
/// @dev    Only what a verifier must authenticate is read: the bytes that were signed, the
///         signature, the subject key, the names that link one certificate to the next, and the
///         attestation extension. Validity dates, key usage and revocation are policy, they belong
///         to the caller, and parsing them here would imply a check nobody runs.
///
///         Every field is reached by descending the structure and comparing real object
///         identifiers. Nothing is located by scanning, because `attestationChallenge` is
///         caller-controlled data inside a document Google signs without inspecting — see `Der`.
library AndroidKeyAttestation {
    error AttestationMalformed(uint8 code);

    uint8 internal constant E_TRAILING = 1;
    uint8 internal constant E_NOT_EC = 2;
    uint8 internal constant E_NOT_PRIME256V1 = 3;
    uint8 internal constant E_POINT = 4;
    uint8 internal constant E_SIGNATURE = 5;

    /// @dev `1.2.840.10045.2.1` — id-ecPublicKey.
    bytes internal constant OID_EC_PUBLIC_KEY = hex"2a8648ce3d0201";
    /// @dev `1.2.840.10045.3.1.7` — prime256v1, the only curve RIP-7212 verifies.
    bytes internal constant OID_PRIME256V1 = hex"2a8648ce3d030107";
    /// @dev `1.2.840.10045.4.3.2` — ecdsa-with-SHA256.
    bytes internal constant OID_ECDSA_SHA256 = hex"2a8648ce3d040302";
    /// @dev `1.3.6.1.4.1.11129.2.1.17` — the Android key attestation extension.
    bytes internal constant OID_KEY_DESCRIPTION = hex"2b06010401d679020111";

    /// @dev `AuthorizationList` tags. Both need the high-tag-number form.
    uint32 internal constant TAG_ORIGIN = 702;
    uint32 internal constant TAG_ROOT_OF_TRUST = 704;

    struct Certificate {
        /// @dev `sha256(tbsCertificate)` — what the issuer's signature is over.
        bytes32 tbsHash;
        uint256 r;
        uint256 s;
        uint256 x;
        uint256 y;
        /// @dev `keccak256` of the issuer and subject `Name` DER, for linking one cert to the next.
        bytes32 issuerHash;
        bytes32 subjectHash;
        bool sha256Ecdsa;
    }

    struct KeyDescription {
        bool present;
        uint256 attestationSecurityLevel;
        uint256 keymasterSecurityLevel;
        /// @dev `keccak256(attestationChallenge)` — compared against the principal it must name.
        bytes32 challengeHash;
        uint256 origin;
        bool hasOrigin;
        uint256 verifiedBootState;
        bool hasRootOfTrust;
    }

    // ── certificate ─────────────────────────────────────────────────────────────────────────────

    /// @notice Parses one DER certificate. Reverts on a malformed encoding, on trailing bytes, or
    ///         on a subject key that is not on prime256v1 — refused here rather than later, where
    ///         it would surface as a signature that simply does not verify.
    function parseCertificate(
        bytes calldata cert
    ) internal pure returns (Certificate memory c) {
        Der.Tlv memory outer = Der.readTlv(cert, 0);
        Der.requireTag(outer, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        if (outer.contentEnd != cert.length) revert AttestationMalformed(E_TRAILING);

        Der.Tlv memory tbs = Der.firstChild(cert, outer);
        Der.Tlv memory algorithm = Der.nextSibling(cert, outer, tbs);
        Der.Tlv memory signature = Der.nextSibling(cert, outer, algorithm);

        c.tbsHash = sha256(Der.element(cert, tbs));
        c.sha256Ecdsa = Der.isOid(cert, Der.firstChild(cert, algorithm), OID_ECDSA_SHA256);
        (c.r, c.s) = _signature(Der.bitString(cert, signature));

        // `[0] version` is EXPLICIT and defaults to v1, so everything after it shifts by one.
        Der.Tlv memory field = Der.firstChild(cert, tbs);
        if (field.tagClass == Der.CLASS_CONTEXT && field.tagNumber == 0) {
            field = Der.nextSibling(cert, tbs, field);
        }
        // serialNumber → signature → issuer.
        field = Der.skip(cert, tbs, field, 2);
        c.issuerHash = keccak256(Der.element(cert, field));
        // issuer → validity → subject.
        field = Der.skip(cert, tbs, field, 2);
        c.subjectHash = keccak256(Der.element(cert, field));
        // subject → subjectPublicKeyInfo.
        (c.x, c.y) = _subjectPublicKey(cert, Der.nextSibling(cert, tbs, field));
    }

    /// @dev `ECDSA-Sig-Value ::= SEQUENCE {r INTEGER, s INTEGER}`, inside the BIT STRING. The
    ///      slice restarts at offset zero, which is why `Der` works on calldata rather than offsets
    ///      into one fixed buffer.
    function _signature(
        bytes calldata payload
    ) private pure returns (uint256 r, uint256 s) {
        Der.Tlv memory sequence = Der.readTlv(payload, 0);
        Der.requireTag(sequence, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        if (sequence.contentEnd != payload.length) revert AttestationMalformed(E_SIGNATURE);
        Der.Tlv memory rTlv = Der.firstChild(payload, sequence);
        Der.Tlv memory sTlv = Der.nextSibling(payload, sequence, rTlv);
        r = Der.unsignedInteger(payload, rTlv);
        s = Der.unsignedInteger(payload, sTlv);
    }

    /// @dev `SubjectPublicKeyInfo ::= SEQUENCE {AlgorithmIdentifier, BIT STRING}`, where the bit
    ///      string holds an uncompressed SEC1 point.
    function _subjectPublicKey(bytes calldata cert, Der.Tlv memory spki) private pure returns (uint256 x, uint256 y) {
        Der.Tlv memory algorithm = Der.firstChild(cert, spki);
        Der.Tlv memory algorithmOid = Der.firstChild(cert, algorithm);
        if (!Der.isOid(cert, algorithmOid, OID_EC_PUBLIC_KEY)) revert AttestationMalformed(E_NOT_EC);
        Der.Tlv memory curve = Der.nextSibling(cert, algorithm, algorithmOid);
        if (!Der.isOid(cert, curve, OID_PRIME256V1)) revert AttestationMalformed(E_NOT_PRIME256V1);

        bytes calldata point = Der.bitString(cert, Der.nextSibling(cert, spki, algorithm));
        if (point.length != 65 || uint8(point[0]) != 0x04) revert AttestationMalformed(E_POINT);
        x = Der.word(point, 1);
        y = Der.word(point, 33);
    }

    // ── key description ─────────────────────────────────────────────────────────────────────────

    /// @notice The attestation extension, or `present == false` when the certificate carries none
    ///         (every certificate above the leaf).
    function keyDescriptionOf(
        bytes calldata cert
    ) internal pure returns (KeyDescription memory kd) {
        Der.Tlv memory tbs = Der.firstChild(cert, Der.readTlv(cert, 0));
        Der.Tlv memory field = Der.firstChild(cert, tbs);
        // `[1] issuerUniqueID` and `[2] subjectUniqueID` may sit between the key and `[3]`.
        while (field.tagClass != Der.CLASS_CONTEXT || field.tagNumber != 3) {
            if (!Der.hasNext(tbs, field)) return kd;
            field = Der.nextSibling(cert, tbs, field);
        }

        Der.Tlv memory extensions = Der.firstChild(cert, field);
        Der.requireTag(extensions, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        Der.Tlv memory ext = Der.firstChild(cert, extensions);
        while (true) {
            Der.Tlv memory extnId = Der.firstChild(cert, ext);
            if (Der.isOid(cert, extnId, OID_KEY_DESCRIPTION)) {
                return _parseKeyDescription(Der.content(cert, _extnValue(cert, ext, extnId)));
            }
            if (!Der.hasNext(extensions, ext)) return kd;
            ext = Der.nextSibling(cert, extensions, ext);
        }
    }

    /// @dev `critical` is `DEFAULT FALSE`, so an extension has two elements or three; the value is
    ///      the last either way.
    function _extnValue(
        bytes calldata cert,
        Der.Tlv memory ext,
        Der.Tlv memory extnId
    ) private pure returns (Der.Tlv memory value) {
        value = Der.nextSibling(cert, ext, extnId);
        if (Der.hasNext(ext, value)) value = Der.nextSibling(cert, ext, value);
        Der.requireTag(value, Der.CLASS_UNIVERSAL, Der.TAG_OCTET_STRING);
    }

    function _parseKeyDescription(
        bytes calldata data
    ) private pure returns (KeyDescription memory kd) {
        Der.Tlv memory root = Der.readTlv(data, 0);
        Der.requireTag(root, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        if (root.contentEnd != data.length) revert AttestationMalformed(E_TRAILING);

        // attestationVersion → attestationSecurityLevel.
        Der.Tlv memory field = Der.nextSibling(data, root, Der.firstChild(data, root));
        kd.attestationSecurityLevel = Der.smallUint(data, field);
        // → keymasterVersion → keymasterSecurityLevel.
        field = Der.skip(data, root, field, 2);
        kd.keymasterSecurityLevel = Der.smallUint(data, field);
        // → attestationChallenge.
        field = Der.nextSibling(data, root, field);
        Der.requireTag(field, Der.CLASS_UNIVERSAL, Der.TAG_OCTET_STRING);
        kd.challengeHash = keccak256(Der.content(data, field));
        // → uniqueId → softwareEnforced → teeEnforced.
        field = Der.skip(data, root, field, 3);
        _authorizations(data, field, kd);
        kd.present = true;
    }

    /// @dev `AuthorizationList ::= SEQUENCE {... all [tag] EXPLICIT ... OPTIONAL}`. Only `origin`
    ///      and `rootOfTrust` are read: the first is the non-exportability claim, the second is
    ///      recorded as a measurement. Everything else is deliberately not interpreted.
    function _authorizations(bytes calldata data, Der.Tlv memory list, KeyDescription memory kd) private pure {
        Der.requireTag(list, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        if (list.contentStart == list.contentEnd) return;
        Der.Tlv memory entry = Der.firstChild(data, list);
        while (true) {
            if (entry.tagNumber == TAG_ORIGIN) {
                kd.origin = Der.smallUint(data, Der.firstChild(data, entry));
                kd.hasOrigin = true;
            } else if (entry.tagNumber == TAG_ROOT_OF_TRUST) {
                kd.verifiedBootState = _verifiedBootState(data, Der.firstChild(data, entry));
                kd.hasRootOfTrust = true;
            }
            if (!Der.hasNext(list, entry)) return;
            entry = Der.nextSibling(data, list, entry);
        }
    }

    /// @dev `RootOfTrust ::= SEQUENCE {verifiedBootKey, deviceLocked, verifiedBootState, hash}`.
    function _verifiedBootState(bytes calldata data, Der.Tlv memory rootOfTrust) private pure returns (uint256) {
        Der.requireTag(rootOfTrust, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        Der.Tlv memory field = Der.skip(data, rootOfTrust, Der.firstChild(data, rootOfTrust), 2);
        return Der.smallUint(data, field);
    }
}
