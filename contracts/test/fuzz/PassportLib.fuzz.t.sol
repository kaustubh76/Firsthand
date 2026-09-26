// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PassportHarness} from "../Harnesses.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";

/// @dev A passport is a claim about who produced a datum, and its signature is the only thing making
///      that claim binding. Two properties matter for every possible passport, not just the fixtures:
///      the digest covers every field (so a signature cannot silently authorise a different datum,
///      price or epoch), and it is bound to one chain and one contract (so a signature harvested from
///      a testnet deployment is worthless against mainnet). The third is low-s: `ecrecover` accepts
///      both halves of a malleable pair, which would give one authorisation two distinct signatures.
contract PassportLibFuzzTest is Test {
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    PassportHarness internal h;

    function setUp() public {
        h = new PassportHarness();
    }

    function passport(
        bytes32 hash,
        address origin,
        bytes32 attest,
        bytes32 termsHash,
        uint64 epoch,
        bytes32 nonce
    ) internal pure returns (PassportLib.Passport memory p) {
        p = PassportLib.Passport(hash, origin, attest, termsHash, epoch, nonce);
    }

    /// @dev Every one of the six fields changes the id; none is along for the ride.
    function testFuzz_idCoversEveryField(
        bytes32 hash,
        address origin,
        bytes32 attest,
        bytes32 termsHash,
        uint64 epoch,
        bytes32 nonce
    ) public pure {
        epoch = uint64(bound(epoch, 0, type(uint64).max - 1));
        bytes32 base = PassportLib.id(passport(hash, origin, attest, termsHash, epoch, nonce));
        assertTrue(base != PassportLib.id(passport(~hash, origin, attest, termsHash, epoch, nonce)), "h");
        assertTrue(
            base != PassportLib.id(passport(hash, address(uint160(origin) ^ 1), attest, termsHash, epoch, nonce)),
            "origin"
        );
        assertTrue(base != PassportLib.id(passport(hash, origin, ~attest, termsHash, epoch, nonce)), "attest");
        assertTrue(base != PassportLib.id(passport(hash, origin, attest, ~termsHash, epoch, nonce)), "termsHash");
        assertTrue(base != PassportLib.id(passport(hash, origin, attest, termsHash, epoch + 1, nonce)), "epoch");
        assertTrue(base != PassportLib.id(passport(hash, origin, attest, termsHash, epoch, ~nonce)), "nonce");
    }

    /// @dev The same passport signed for one deployment must not verify against another — a passport
    ///      lifted off testnet is not a mainnet passport.
    function testFuzz_digestIsBoundToItsDeployment(
        bytes32 hash,
        uint256 chainA,
        uint256 chainB,
        address contractA,
        address contractB
    ) public pure {
        vm.assume(chainA != chainB || contractA != contractB);
        bytes32 sepA = PassportLib.domainSeparator(chainA, contractA);
        bytes32 sepB = PassportLib.domainSeparator(chainB, contractB);
        assertTrue(sepA != sepB, "two deployments share a domain separator");
        assertTrue(PassportLib.digestOf(hash, sepA) != PassportLib.digestOf(hash, sepB), "digest is not bound");
    }

    /// @dev Terms are hashed by value: price, licence, scope, namespace and rate limit all bind.
    function testFuzz_termsCoverThePrice(
        uint64 price,
        bytes32 licenseId,
        uint32 scope,
        uint32 ns,
        uint32 rate
    ) public pure {
        price = uint64(bound(price, 0, type(uint64).max - 1));
        address[] memory payees = new address[](1);
        payees[0] = address(0xBEEF);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1e18;
        bytes32 base = PassportLib.hashTerms(price, licenseId, scope, ns, rate, payees, weights);
        assertTrue(base != PassportLib.hashTerms(price + 1, licenseId, scope, ns, rate, payees, weights), "price");
        assertTrue(base != PassportLib.hashTerms(price, ~licenseId, scope, ns, rate, payees, weights), "licence");
        assertTrue(base != PassportLib.hashTerms(price, licenseId, scope ^ 1, ns, rate, payees, weights), "scope");
        assertTrue(base != PassportLib.hashTerms(price, licenseId, scope, ns ^ 1, rate, payees, weights), "ns");
        assertTrue(base != PassportLib.hashTerms(price, licenseId, scope, ns, rate ^ 1, payees, weights), "rateLimit");
    }

    /// @dev A real signature recovers to its signer; its malleable twin (high-s) is refused, so one
    ///      authorisation can never be presented as two.
    function testFuzz_lowSOnly(uint256 pk, bytes32 digest) public view {
        pk = bound(pk, 1, SECP_N - 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(h.recoverOrigin(digest, abi.encodePacked(r, s, v)), vm.addr(pk), "the honest signature recovers");

        // The same point, the other half of the curve: ecrecover would take it, recoverOrigin must not.
        bytes32 flipped = bytes32(SECP_N - uint256(s));
        uint8 otherV = v == 27 ? 28 : 27;
        assertEq(h.recoverOrigin(digest, abi.encodePacked(r, flipped, otherV)), address(0), "high-s is refused");
    }

    /// @dev Anything that is not 65 bytes is not a signature, and says so rather than guessing.
    function testFuzz_refusesMalformedSignatures(bytes32 digest, bytes memory signature) public {
        vm.assume(signature.length != 65);
        vm.expectRevert(abi.encodeWithSelector(PassportLib.InvalidSignatureLength.selector, signature.length));
        h.recoverOrigin(digest, signature);
    }
}
