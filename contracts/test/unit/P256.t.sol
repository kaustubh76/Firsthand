// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VectorTest} from "../Vectors.sol";
import {P256Harness} from "../Harnesses.sol";
import {P256Double} from "../doubles/P256Double.sol";
import {P256} from "../../src/libraries/P256.sol";

contract P256Test is VectorTest {
    P256Harness internal h;

    function setUp() public {
        loadSuite("p256-signatures");
        P256Double.etch(vm);
        h = new P256Harness();
    }

    function test_vectors() public view {
        assertHandCases(3);
        for (uint256 i = 0; i < count; ++i) {
            string memory name = caseName(i);
            bool ok = h.verify(
                b32(i, ".input.digest"),
                u(i, ".input.r"),
                u(i, ".input.s"),
                uint256(b32(i, ".input.x")),
                uint256(b32(i, ".input.y"))
            );
            assertEq(ok, boolean(i, ".expected.valid"), name);
            bytes memory sig = abi.encode(u(i, ".input.r"), u(i, ".input.s"));
            assertEq(
                h.verifySignature(
                    b32(i, ".input.digest"), sig, uint256(b32(i, ".input.x")), uint256(b32(i, ".input.y"))
                ),
                boolean(i, ".expected.valid"),
                name
            );
        }
    }

    function test_wrongSignatureLengthIsFalse() public view {
        assertFalse(h.verifySignature(bytes32(0), new bytes(65), 1, 2));
    }

    function test_commitmentMatchesKeysVector() public view {
        string memory keys = vm.readFile("../packages/test-vectors/vectors/keys.v1.json");
        uint256 x = uint256(vm.parseJsonBytes32(keys, ".cases[0].expected.p256X"));
        uint256 y = uint256(vm.parseJsonBytes32(keys, ".cases[0].expected.p256Y"));
        assertEq(P256.commitment(x, y), vm.parseJsonBytes32(keys, ".cases[0].expected.p256Commit"));
    }

    function test_withoutPrecompileEverythingIsFalse() public {
        vm.etch(P256.PRECOMPILE, "");
        assertFalse(
            h.verify(
                b32(0, ".input.digest"),
                u(0, ".input.r"),
                u(0, ".input.s"),
                uint256(b32(0, ".input.x")),
                uint256(b32(0, ".input.y"))
            )
        );
    }
}
