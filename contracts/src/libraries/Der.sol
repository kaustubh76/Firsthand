// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Der
/// @notice A strict DER reader over calldata — the substrate for hardware capture attestation
///         (README §13, ADR-0015). Twin of the TypeScript reader in
///         `packages/core/src/attestation`; both are checked against the same golden suite,
///         `packages/test-vectors/vectors/android-attestation.v1.json`, so a shared misreading of
///         a certificate has to survive two implementations to get through.
/// @dev    Deliberately not a general ASN.1 library. Fields are located by descending the structure
///         and checking real object identifiers, never by scanning for a byte pattern and never
///         from a caller-supplied offset. The reason is specific: an Android attestation leaf
///         carries `attestationChallenge`, up to 128 bytes of caller-controlled data that Google
///         signs without inspecting, so an attacker can plant a lookalike SubjectPublicKeyInfo
///         inside a legitimately signed certificate and have a scanner read their own key as the
///         attested one.
///
///         Strict in the DER sense rather than the BER sense: indefinite lengths, non-minimal
///         lengths and non-minimal high-tag-number forms are all refused, so one structure has
///         exactly one encoding.
library Der {
    /// @dev One error with a code rather than a dozen error types. Every guard is then a single
    ///      source line — which is what the 100 % line-coverage gate needs — and the code still
    ///      says which guard tripped.
    error DerMalformed(uint8 code);

    uint8 internal constant E_BOUNDS = 1;
    uint8 internal constant E_TAG = 2;
    uint8 internal constant E_LENGTH = 3;
    uint8 internal constant E_PRIMITIVE = 4;
    uint8 internal constant E_SIBLING = 5;
    uint8 internal constant E_TAG_MISMATCH = 6;
    uint8 internal constant E_BIT_STRING = 7;
    uint8 internal constant E_INTEGER = 8;

    uint8 internal constant CLASS_UNIVERSAL = 0;
    uint8 internal constant CLASS_CONTEXT = 2;

    uint32 internal constant TAG_INTEGER = 2;
    uint32 internal constant TAG_BIT_STRING = 3;
    uint32 internal constant TAG_OCTET_STRING = 4;
    uint32 internal constant TAG_OID = 6;
    uint32 internal constant TAG_ENUMERATED = 10;
    uint32 internal constant TAG_SEQUENCE = 16;

    /// @dev Far above any certificate, far below anything that could overflow a uint32 offset.
    uint256 internal constant MAX_LENGTH = 1 << 24;
    /// @dev The identifier value that means "the tag number continues in the following octets".
    uint256 internal constant HIGH_TAG = 0x1f;

    struct Tlv {
        uint8 tagClass;
        bool constructed;
        uint32 tagNumber;
        /// @dev Offset of the identifier octet — where `element` starts.
        uint32 start;
        uint32 contentStart;
        /// @dev One past the last content byte: where the next sibling begins.
        uint32 contentEnd;
    }

    // ── reading ─────────────────────────────────────────────────────────────────────────────────

    /// @notice Reads one tag-length-value at `offset`. Reverts on anything that is not minimal,
    ///         definite DER, or that would read past the end of `data`.
    function readTlv(bytes calldata data, uint256 offset) internal pure returns (Tlv memory t) {
        if (offset >= data.length) revert DerMalformed(E_BOUNDS);
        uint256 identifier = uint8(data[offset]);
        t.tagClass = uint8(identifier >> 6);
        t.constructed = identifier & 0x20 != 0;
        t.start = uint32(offset);

        uint256 cursor = offset + 1;
        uint256 tagNumber = identifier & HIGH_TAG;
        if (tagNumber == HIGH_TAG) (tagNumber, cursor) = _highTagNumber(data, cursor);
        t.tagNumber = uint32(tagNumber);

        if (cursor >= data.length) revert DerMalformed(E_LENGTH);
        uint256 lengthByte = uint8(data[cursor++]);
        uint256 contentLength = lengthByte;
        if (lengthByte >= 0x80) (contentLength, cursor) = _longLength(data, cursor, lengthByte & 0x7f);

        uint256 end = cursor + contentLength;
        if (end > data.length) revert DerMalformed(E_BOUNDS);
        t.contentStart = uint32(cursor);
        t.contentEnd = uint32(end);
    }

    /// @dev Base-128, most significant group first, continuation bit set on all but the last
    ///      octet. Android's AuthorizationList lives up here — `origin` is 702, `rootOfTrust` 704.
    function _highTagNumber(
        bytes calldata data,
        uint256 cursor
    ) private pure returns (uint256 tagNumber, uint256 next) {
        bool first = true;
        while (true) {
            if (cursor >= data.length) revert DerMalformed(E_TAG);
            uint256 part = uint8(data[cursor++]);
            if (first && part == 0x80) revert DerMalformed(E_TAG);
            tagNumber = (tagNumber << 7) | (part & 0x7f);
            if (tagNumber > MAX_LENGTH) revert DerMalformed(E_TAG);
            first = false;
            if (part & 0x80 == 0) break;
        }
        // A number the short form could have expressed is not the minimal encoding of itself.
        if (tagNumber < HIGH_TAG) revert DerMalformed(E_TAG);
        return (tagNumber, cursor);
    }

    /// @dev Long form: one to four octets, no leading zero, never a value the short form holds.
    ///      `count == 0` is the indefinite length, which is BER and not DER.
    function _longLength(
        bytes calldata data,
        uint256 cursor,
        uint256 count
    ) private pure returns (uint256 length, uint256 next) {
        if (count == 0 || count > 4) revert DerMalformed(E_LENGTH);
        if (cursor + count > data.length) revert DerMalformed(E_LENGTH);
        if (uint8(data[cursor]) == 0) revert DerMalformed(E_LENGTH);
        for (uint256 i = 0; i < count; ++i) {
            length = (length << 8) | uint8(data[cursor++]);
        }
        if (length < 0x80) revert DerMalformed(E_LENGTH);
        if (length > MAX_LENGTH) revert DerMalformed(E_LENGTH);
        return (length, cursor);
    }

    // ── navigation ──────────────────────────────────────────────────────────────────────────────

    /// @notice The first element inside a constructed TLV.
    function firstChild(bytes calldata data, Tlv memory parent) internal pure returns (Tlv memory) {
        if (!parent.constructed) revert DerMalformed(E_PRIMITIVE);
        if (parent.contentStart >= parent.contentEnd) revert DerMalformed(E_SIBLING);
        return readTlv(data, parent.contentStart);
    }

    /// @notice Whether `current` has a sibling inside `parent`.
    function hasNext(Tlv memory parent, Tlv memory current) internal pure returns (bool) {
        return current.contentEnd < parent.contentEnd;
    }

    /// @notice The element after `current`, refusing one that would run past `parent`.
    function nextSibling(
        bytes calldata data,
        Tlv memory parent,
        Tlv memory current
    ) internal pure returns (Tlv memory next) {
        if (!hasNext(parent, current)) revert DerMalformed(E_SIBLING);
        next = readTlv(data, current.contentEnd);
        if (next.contentEnd > parent.contentEnd) revert DerMalformed(E_SIBLING);
    }

    /// @notice Skips `count` siblings forward, so a positional field can be addressed by index.
    function skip(
        bytes calldata data,
        Tlv memory parent,
        Tlv memory current,
        uint256 count
    ) internal pure returns (Tlv memory t) {
        t = current;
        for (uint256 i = 0; i < count; ++i) {
            t = nextSibling(data, parent, t);
        }
    }

    // ── values ──────────────────────────────────────────────────────────────────────────────────

    function requireTag(Tlv memory t, uint8 tagClass, uint32 tagNumber) internal pure {
        if (t.tagClass != tagClass || t.tagNumber != tagNumber) revert DerMalformed(E_TAG_MISMATCH);
    }

    /// @notice The content bytes, without the header.
    function content(bytes calldata data, Tlv memory t) internal pure returns (bytes calldata) {
        return data[t.contentStart:t.contentEnd];
    }

    /// @notice The whole element including its header — what a signature is computed over.
    function element(bytes calldata data, Tlv memory t) internal pure returns (bytes calldata) {
        return data[t.start:t.contentEnd];
    }

    /// @notice A BIT STRING's payload. Every bit string read here is byte-aligned, so a non-zero
    ///         count of unused trailing bits is a malformed input rather than something to round.
    function bitString(bytes calldata data, Tlv memory t) internal pure returns (bytes calldata) {
        requireTag(t, CLASS_UNIVERSAL, TAG_BIT_STRING);
        if (t.contentEnd <= t.contentStart) revert DerMalformed(E_BIT_STRING);
        if (uint8(data[t.contentStart]) != 0) revert DerMalformed(E_BIT_STRING);
        return data[t.contentStart + 1:t.contentEnd];
    }

    /// @notice An unsigned INTEGER or ENUMERATED small enough to be a counter or an enum value.
    function smallUint(bytes calldata data, Tlv memory t) internal pure returns (uint256 value) {
        bool isInteger = t.tagNumber == TAG_INTEGER || t.tagNumber == TAG_ENUMERATED;
        if (t.tagClass != CLASS_UNIVERSAL || !isInteger) revert DerMalformed(E_INTEGER);
        uint256 length = t.contentEnd - t.contentStart;
        if (length == 0 || length > 4) revert DerMalformed(E_INTEGER);
        if (uint8(data[t.contentStart]) & 0x80 != 0) revert DerMalformed(E_INTEGER);
        for (uint256 i = t.contentStart; i < t.contentEnd; ++i) {
            value = (value << 8) | uint8(data[i]);
        }
    }

    /// @notice An unsigned INTEGER up to 32 bytes — an ECDSA `r` or `s`.
    /// @dev    DER pads a value whose top bit is set with a leading zero so it reads positive; that
    ///         pad is skipped here, which is also what keeps a 33-byte encoding from overflowing.
    function unsignedInteger(bytes calldata data, Tlv memory t) internal pure returns (uint256 value) {
        requireTag(t, CLASS_UNIVERSAL, TAG_INTEGER);
        uint256 cursor = t.contentStart;
        if (cursor >= t.contentEnd) revert DerMalformed(E_INTEGER);
        if (uint8(data[cursor]) & 0x80 != 0) revert DerMalformed(E_INTEGER);
        if (uint8(data[cursor]) == 0) cursor++;
        if (t.contentEnd - cursor > 32) revert DerMalformed(E_INTEGER);
        for (uint256 i = cursor; i < t.contentEnd; ++i) {
            value = (value << 8) | uint8(data[i]);
        }
    }

    /// @notice The 32 bytes at `offset`, as a word. An EC point's coordinates are fixed-width and
    ///         not DER integers, so they are read directly rather than through `unsignedInteger`.
    /// @dev    `bytes calldata` cannot be converted to `bytes32`; `calldataload` is the way, and
    ///         the bound is checked here rather than trusted from the caller.
    function word(bytes calldata data, uint256 offset) internal pure returns (uint256 value) {
        if (offset + 32 > data.length) revert DerMalformed(E_BOUNDS);
        assembly ("memory-safe") {
            value := calldataload(add(data.offset, offset))
        }
    }

    /// @notice True when `t` is an OBJECT IDENTIFIER whose content equals `oid`.
    function isOid(bytes calldata data, Tlv memory t, bytes memory oid) internal pure returns (bool) {
        if (t.tagClass != CLASS_UNIVERSAL || t.tagNumber != TAG_OID) return false;
        return keccak256(data[t.contentStart:t.contentEnd]) == keccak256(oid);
    }
}
