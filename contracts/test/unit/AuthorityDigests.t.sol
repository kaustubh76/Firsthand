// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";

/// @dev Pins the authority type strings (values from `cast keccak`) and the digest composition.
contract AuthorityDigestsTest is Test {
    function test_typehashesArePinned() public pure {
        assertEq(AuthorityDigests.ENROLL_TYPEHASH, 0xc42c9055b20f7856ed8aba0177e53f63bc9ab5177fab45b5223ebddef474f47c);
        assertEq(AuthorityDigests.ATTEST_TYPEHASH, 0xaf15e6a0fee4534521b87e65fcb3aec148622758c3e46236915e8bb0457d2e07);
        assertEq(AuthorityDigests.GRANT_TYPEHASH, 0xa965437826d5391d5383b20e6585b72c4b911f5602248e98c721dc521805005c);
        assertEq(
            AuthorityDigests.ACCEPT_TERMS_TYPEHASH, 0x996de7acc40660ce8933b391c1914c7780144d23dca730257a8a236cd65f2dc5
        );
        assertEq(AuthorityDigests.RESCIND_TYPEHASH, 0x4c89acadd747eaad0aa61627318b860cba97fbbd256e9b5d8d190aa4e179e4c7);
        assertEq(
            AuthorityDigests.RESCIND_COMMIT_TYPEHASH, 0xcca400fa08f22f853a00f1ea1870d760414d3206d02f9ee120efc6ea63c44a58
        );
        assertEq(AuthorityDigests.ANCHOR_TYPEHASH, 0x06d14469a38beb1fb1e25c0c1e5ad3f5da1946b38e960cc539c1264b6ac9dcd7);
    }

    function test_structHashesAreDistinctAndBoundToFields() public pure {
        bytes32 a = bytes32(uint256(1));
        bytes32 b = bytes32(uint256(2));
        assertTrue(AuthorityDigests.enroll(a, 1, b) != AuthorityDigests.enroll(a, 2, b));
        assertTrue(AuthorityDigests.attest(a, 1, a, b) != AuthorityDigests.attest(a, 1, b, b));
        assertTrue(AuthorityDigests.grant(a, b, 0, 1, 2, a, b, a) != AuthorityDigests.grant(a, b, 1, 1, 2, a, b, a));
        assertTrue(AuthorityDigests.acceptTerms(a, b, 0, a, b) != AuthorityDigests.acceptTerms(b, a, 0, a, b));
        assertTrue(AuthorityDigests.rescind(a, 1, b) != AuthorityDigests.rescindCommit(a, b));
        assertTrue(AuthorityDigests.anchor(a, 0, 1, a, b, a) != AuthorityDigests.anchor(a, 0, 1, b, b, a));
        // Every struct hash is domain-separated by its typehash: same fields, different verbs differ.
        assertTrue(AuthorityDigests.rescind(a, 1, b) != AuthorityDigests.enroll(a, 1, b));
    }

    function test_digestUsesFirsthandDomain() public pure {
        bytes32 sh = AuthorityDigests.rescind(bytes32(uint256(7)), 3, bytes32(uint256(9)));
        bytes32 expected = PassportLib.digestOf(sh, PassportLib.domainSeparator(10_143, address(0xdead)));
        assertEq(AuthorityDigests.digest(sh, 10_143, address(0xdead)), expected);
    }
}
