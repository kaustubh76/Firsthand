// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DerHarness} from "../Harnesses.sol";
import {VectorTest} from "../Vectors.sol";
import {Der} from "../../src/libraries/Der.sol";

/// @dev Malformed encodings are hand-written `hex"..."` beside the assertion that explains them —
///      each is one or two bytes different from a valid one, which is the whole point. The bulk
///      happy path comes from the shared golden suite, so this reader and the TypeScript one are
///      checked against bytes neither of them produced.
contract DerTest is VectorTest {
    DerHarness internal h;
    bytes internal leaf;

    function setUp() public {
        loadSuite("android-attestation");
        h = new DerHarness();
        assertEq(caseName(0), "hand/leaf");
        leaf = bytes_(0, ".input.certificate");
    }

    function malformed(
        uint8 code
    ) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Der.DerMalformed.selector, code);
    }

    // ── the real certificate ────────────────────────────────────────────────────────────────────

    function test_readsTheCertificateTheTypescriptReaderRead() public view {
        Der.Tlv memory outer = h.readTlv(leaf, 0);
        assertEq(outer.tagClass, Der.CLASS_UNIVERSAL);
        assertEq(outer.tagNumber, Der.TAG_SEQUENCE);
        assertTrue(outer.constructed);
        assertEq(outer.contentEnd, leaf.length, "the certificate is one SEQUENCE, exactly");

        // tbsCertificate, signatureAlgorithm, signatureValue.
        assertEq(h.childCount(leaf, 0), 3);

        // The strongest cross-check available: both readers must locate the same signed bytes.
        Der.Tlv memory tbs = h.nthChild(leaf, 0, 0);
        assertEq(sha256(h.element(leaf, tbs.start)), b32(0, ".expected.tbsHash"), "tbs bytes");
    }

    function test_readsTheHighTagNumbersAndroidUses() public view {
        // `origin` is [702] and `rootOfTrust` is [704]; both need the high-tag-number form, and
        // without it an AuthorizationList cannot be walked at all.
        Der.Tlv memory origin = h.readTlv(hex"bf853e03020100", 0);
        assertEq(origin.tagClass, Der.CLASS_CONTEXT);
        assertEq(origin.tagNumber, 702);
        assertTrue(origin.constructed);
        assertEq(h.smallUint(hex"bf853e03020100", origin.contentStart), 0);

        Der.Tlv memory rootOfTrust = h.readTlv(hex"bf85400130", 0);
        assertEq(rootOfTrust.tagNumber, 704);
    }

    function test_readsALongFormLength() public view {
        // 0x82 0x01 0x2c: two length octets, 300 bytes of content.
        bytes memory long = abi.encodePacked(hex"0482012c", new bytes(300));
        Der.Tlv memory t = h.readTlv(long, 0);
        assertEq(t.contentEnd - t.contentStart, 300);
    }

    // ── lengths ─────────────────────────────────────────────────────────────────────────────────

    function test_refusesEveryLengthThatIsNotMinimalDefiniteDer() public {
        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"3080", 0); // indefinite — BER, not DER

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"048101aa", 0); // long form for a value the short form holds

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"04820081", 0); // leading zero in the length

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"04850101010101", 0); // more than four length octets

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"04ff01", 0); // the reserved 0xff form

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"048201", 0); // truncated length octets

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"30", 0); // no length at all

        vm.expectRevert(malformed(Der.E_LENGTH));
        h.readTlv(hex"0484ffffffff", 0); // a length past the ceiling
    }

    function test_refusesReadsPastTheBuffer() public {
        vm.expectRevert(malformed(Der.E_BOUNDS));
        h.readTlv(hex"", 0);

        vm.expectRevert(malformed(Der.E_BOUNDS));
        h.readTlv(hex"040101", 99);

        vm.expectRevert(malformed(Der.E_BOUNDS));
        h.readTlv(hex"04050102", 0); // claims five content bytes, carries two
    }

    // ── tags ────────────────────────────────────────────────────────────────────────────────────

    function test_refusesEveryTagThatIsNotMinimal() public {
        vm.expectRevert(malformed(Der.E_TAG));
        h.readTlv(hex"bf85", 0); // truncated high tag

        vm.expectRevert(malformed(Der.E_TAG));
        h.readTlv(hex"bf80010100", 0); // leading 0x80: a non-minimal encoding of the same number

        vm.expectRevert(malformed(Der.E_TAG));
        h.readTlv(hex"bf010100", 0); // high form carrying a number the short form expresses

        vm.expectRevert(malformed(Der.E_TAG));
        h.readTlv(hex"bfffffffff7f0100", 0); // a tag number past the ceiling
    }

    function test_requireTagRejectsTheWrongOne() public {
        vm.expectRevert(malformed(Der.E_TAG_MISMATCH));
        h.requireTag(hex"040101", 0, Der.CLASS_UNIVERSAL, Der.TAG_SEQUENCE);
        // And accepts the right one.
        h.requireTag(hex"040101", 0, Der.CLASS_UNIVERSAL, Der.TAG_OCTET_STRING);
    }

    // ── navigation ──────────────────────────────────────────────────────────────────────────────

    function test_navigationRefusesWhatIsNotThere() public {
        vm.expectRevert(malformed(Der.E_PRIMITIVE));
        h.firstChild(hex"040101", 0); // an OCTET STRING has no children

        vm.expectRevert(malformed(Der.E_SIBLING));
        h.firstChild(hex"3000", 0); // an empty SEQUENCE has no first child

        vm.expectRevert(malformed(Der.E_SIBLING));
        h.siblingPastEnd(hex"3003020100", 0); // one child, asked for a second

        // A child that reads cleanly against the buffer but runs past its parent: the outer
        // SEQUENCE claims four content bytes and the second child wants seven.
        vm.expectRevert(malformed(Der.E_SIBLING));
        h.childCount(hex"300402010004050102030405", 0);
    }

    function test_walksSiblingsPositionally() public view {
        bytes memory three = hex"3009020101020102020103";
        assertEq(h.childCount(three, 0), 3);
        assertEq(h.smallUint(three, h.nthChild(three, 0, 0).start), 1);
        assertEq(h.smallUint(three, h.nthChild(three, 0, 2).start), 3);
    }

    function test_contentAndElementDifferByTheHeader() public view {
        bytes memory octets = hex"0403aabbcc";
        assertEq(h.content(octets, 0), hex"aabbcc");
        assertEq(h.element(octets, 0), octets);
    }

    // ── values ──────────────────────────────────────────────────────────────────────────────────

    function test_bitStringYieldsItsPayloadAndRefusesAMisalignedOne() public {
        assertEq(h.bitString(hex"030300aabb", 0), hex"aabb");

        vm.expectRevert(malformed(Der.E_TAG_MISMATCH));
        h.bitString(hex"040101", 0);

        vm.expectRevert(malformed(Der.E_BIT_STRING));
        h.bitString(hex"0300", 0); // empty: not even the unused-bit count

        vm.expectRevert(malformed(Der.E_BIT_STRING));
        h.bitString(hex"030301aabb", 0); // one unused trailing bit — nothing here is bit-aligned
    }

    function test_smallUintReadsIntegersAndEnumerationsOnly() public {
        assertEq(h.smallUint(hex"0a0102", 0), 2); // ENUMERATED, as a SecurityLevel is
        assertEq(h.smallUint(hex"0203011170", 0), 70_000);

        vm.expectRevert(malformed(Der.E_INTEGER));
        h.smallUint(hex"040100", 0); // an OCTET STRING is not a number

        vm.expectRevert(malformed(Der.E_INTEGER));
        h.smallUint(hex"0200", 0); // empty

        vm.expectRevert(malformed(Der.E_INTEGER));
        h.smallUint(hex"02050100000000", 0); // wider than a counter has any business being

        vm.expectRevert(malformed(Der.E_INTEGER));
        h.smallUint(hex"020180", 0); // negative
    }

    function test_unsignedIntegerReadsCurveScalars() public {
        // The leading zero DER adds so a high-bit value reads positive is skipped, not counted.
        assertEq(
            h.unsignedInteger(hex"022100ff00000000000000000000000000000000000000000000000000000000000000", 0),
            0xff00000000000000000000000000000000000000000000000000000000000000
        );
        assertEq(h.unsignedInteger(hex"020100", 0), 0);

        vm.expectRevert(malformed(Der.E_TAG_MISMATCH));
        h.unsignedInteger(hex"0a0101", 0); // an ENUMERATED is not an INTEGER here

        vm.expectRevert(malformed(Der.E_INTEGER));
        h.unsignedInteger(hex"0200", 0);

        vm.expectRevert(malformed(Der.E_INTEGER));
        h.unsignedInteger(hex"020180", 0); // negative

        // Thirty-three bytes that are not a padded 32-byte value would overflow.
        vm.expectRevert(malformed(Der.E_INTEGER));
        h.unsignedInteger(hex"022101010101010101010101010101010101010101010101010101010101010101010101", 0);
    }

    function test_wordReadsAFixedWidthCoordinateAndRefusesToReadPastTheEnd() public {
        bytes memory thirtyThree = abi.encodePacked(uint8(0x04), bytes32(uint256(0xabcd)));
        assertEq(h.word(thirtyThree, 1), 0xabcd, "an EC coordinate is fixed width, not a DER integer");

        vm.expectRevert(malformed(Der.E_BOUNDS));
        h.word(thirtyThree, 2);
    }

    function test_isOidComparesContentAndTag() public view {
        bytes memory ecPublicKey = hex"06072a8648ce3d0201";
        assertTrue(h.isOid(ecPublicKey, 0, hex"2a8648ce3d0201"));
        assertFalse(h.isOid(ecPublicKey, 0, hex"2a8648ce3d0301"), "different oid");
        assertFalse(h.isOid(hex"0403aabbcc", 0, hex"aabbcc"), "right bytes, wrong tag");
    }
}
