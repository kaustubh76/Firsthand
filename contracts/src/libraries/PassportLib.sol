// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title PassportLib
/// @notice EIP-712 typed hashing and origin recovery for Data Passports (README §7.1, ADR-0002).
///         Twin of the core TS `passport` module. Type strings and field order are normative.
library PassportLib {
    struct Passport {
        bytes32 h; // keccak256(canonical(d))
        address origin; // secp256k1 address of pk_agent(ns, e)
        bytes32 attest; // hashAttestation(...)
        bytes32 termsHash; // hashTerms(...)
        uint64 epoch;
        bytes32 nonce; // HMAC(k_nonce(ns,e), h)
    }

    bytes32 internal constant PASSPORT_TYPEHASH =
        keccak256("Passport(bytes32 h,address origin,bytes32 attest,bytes32 termsHash,uint64 epoch,bytes32 nonce)");
    bytes32 internal constant TERMS_TYPEHASH = keccak256(
        "Terms(uint64 price,bytes32 licenseId,uint32 scope,uint32 ns,uint32 rateLimit,address[] payees,uint256[] weights)"
    );
    bytes32 internal constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint8 class,uint64 capturedAt,bytes32 sourceTag,bytes32 deviceClass,bytes32 metaHash)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("FIRSTHAND");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant SECP_HALF_N = SECP_N >> 1;

    error InvalidSignatureLength(uint256 length);

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, verifyingContract));
    }

    function hashTerms(
        uint64 price,
        bytes32 licenseId,
        uint32 scope,
        uint32 ns,
        uint32 rateLimit,
        address[] memory payees,
        uint256[] memory weights
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                price,
                licenseId,
                scope,
                ns,
                rateLimit,
                keccak256(abi.encodePacked(payees)),
                keccak256(abi.encodePacked(weights))
            )
        );
    }

    function hashAttestation(
        uint8 class_,
        uint64 capturedAt,
        bytes32 sourceTag,
        bytes32 deviceClass,
        bytes32 metaHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(ATTESTATION_TYPEHASH, class_, capturedAt, sourceTag, deviceClass, metaHash));
    }

    /// @notice EIP-712 struct hash — the `passportId` and Merkle leaf preimage.
    function id(
        Passport memory p
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(PASSPORT_TYPEHASH, p.h, p.origin, p.attest, p.termsHash, p.epoch, p.nonce));
    }

    /// @notice `keccak256(0x1901 ‖ domainSeparator ‖ id(p))` — what the deposit key signs.
    function digest(Passport memory p, bytes32 domainSep) internal pure returns (bytes32) {
        return digestOf(id(p), domainSep);
    }

    function digestOf(bytes32 structHash, bytes32 domainSep) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
    }

    /// @notice `ecrecover` with low-s and `v ∈ {27, 28}` enforced. Returns address(0) on failure.
    function recoverOrigin(bytes32 digest_, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength(signature.length);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) == 0 || uint256(s) > SECP_HALF_N) return address(0);
        return ecrecover(digest_, v, r, s);
    }

    /// @notice The one-call origin check: `recoverOrigin(digest(p)) == p.origin`.
    function verify(Passport memory p, bytes memory signature, bytes32 domainSep) internal pure returns (bool) {
        address signer = recoverOrigin(digest(p, domainSep), signature);
        return signer != address(0) && signer == p.origin;
    }
}
