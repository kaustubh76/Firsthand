// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VectorTest} from "../Vectors.sol";
import {PassportHarness} from "../Harnesses.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";

contract PassportLibTest is VectorTest {
    PassportHarness internal h;

    function setUp() public {
        loadSuite("passport");
        h = new PassportHarness();
    }

    function test_typehashesMatchVectors() public view {
        // Case 0 is "hand/typehashes" — values from `cast keccak`.
        assertEq(caseName(0), "hand/typehashes");
        assertEq(PassportLib.PASSPORT_TYPEHASH, b32(0, ".expected.passportTypehash"));
        assertEq(PassportLib.TERMS_TYPEHASH, b32(0, ".expected.termsTypehash"));
        assertEq(PassportLib.ATTESTATION_TYPEHASH, b32(0, ".expected.attestationTypehash"));
        assertEq(PassportLib.DOMAIN_TYPEHASH, b32(0, ".expected.domainTypehash"));
        assertEq(keccak256("FH-1.0"), b32(0, ".expected.licenseFh10"));
    }

    function test_vectors() public view {
        assertHandCases(3);
        for (uint256 i = 1; i < count; ++i) {
            string memory name = caseName(i);
            bytes32 termsHash = PassportLib.hashTerms(
                uint64(u(i, ".input.terms.price")),
                b32(i, ".input.terms.licenseId"),
                uint32(u(i, ".input.terms.scope")),
                uint32(u(i, ".input.terms.ns")),
                uint32(u(i, ".input.terms.rateLimit")),
                addrArr(i, ".input.terms.payees"),
                uArr(i, ".input.terms.weights")
            );
            assertEq(termsHash, b32(i, ".expected.termsHash"), name);

            bytes32 attest = PassportLib.hashAttestation(
                uint8(u(i, ".input.attestation.class")),
                uint64(u(i, ".input.attestation.capturedAt")),
                b32(i, ".input.attestation.sourceTag"),
                b32(i, ".input.attestation.deviceClass"),
                b32(i, ".input.attestation.metaHash")
            );
            assertEq(attest, b32(i, ".expected.attest"), name);

            PassportLib.Passport memory p = PassportLib.Passport({
                h: b32(i, ".input.passport.h"),
                origin: addr(i, ".input.passport.origin"),
                attest: b32(i, ".input.passport.attest"),
                termsHash: b32(i, ".input.passport.termsHash"),
                epoch: uint64(u(i, ".input.passport.epoch")),
                nonce: b32(i, ".input.passport.nonce")
            });
            assertEq(PassportLib.id(p), b32(i, ".expected.passportId"), name);

            bytes32 ds =
                PassportLib.domainSeparator(u(i, ".input.domain.chainId"), addr(i, ".input.domain.verifyingContract"));
            assertEq(ds, b32(i, ".expected.domainSeparator"), name);
            bytes32 digest = PassportLib.digest(p, ds);
            assertEq(digest, b32(i, ".expected.digest"), name);

            bytes memory sig = bytes_(i, ".input.signature");
            assertEq(h.recoverOrigin(digest, sig), addr(i, ".expected.recovered"), name);
            assertEq(h.verify(p, sig, ds), boolean(i, ".expected.valid"), name);
        }
    }

    function test_signatureLengthIsEnforced() public {
        vm.expectRevert(abi.encodeWithSelector(PassportLib.InvalidSignatureLength.selector, 64));
        h.recoverOrigin(bytes32(0), new bytes(64));
    }

    function test_badVOrZeroSReturnsZeroAddress() public view {
        bytes memory sig = new bytes(65);
        sig[64] = 0x1a; // v = 26
        assertEq(h.recoverOrigin(bytes32(uint256(1)), sig), address(0));
        sig[64] = 0x1b; // v = 27 but s == 0
        assertEq(h.recoverOrigin(bytes32(uint256(1)), sig), address(0));
    }
}
