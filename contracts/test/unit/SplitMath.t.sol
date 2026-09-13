// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VectorTest} from "../Vectors.sol";
import {SplitMathHarness} from "../Harnesses.sol";
import {SplitMath} from "../../src/libraries/SplitMath.sol";

contract SplitMathTest is VectorTest {
    SplitMathHarness internal h;

    function setUp() public {
        loadSuite("split-math");
        h = new SplitMathHarness();
    }

    function test_vectors() public {
        assertHandCases(3);
        uint256 checked;
        for (uint256 i = 0; i < count; ++i) {
            string memory name = caseName(i);
            if (startsWith(name, "quote/")) continue; // off-chain banker's rounding, TS-only (ADR-0003)
            uint256 price = u(i, ".input.price");
            uint256[] memory weights = uArr(i, ".input.weights");
            if (has(i, ".expected.error")) {
                vm.expectPartialRevert(selectorFor(str(i, ".expected.error")));
                h.split(price, weights);
            } else {
                (uint256[] memory pays, uint256 residual) = h.split(price, weights);
                uint256[] memory expectedPays = uArr(i, ".expected.pays");
                assertEq(pays.length, expectedPays.length, name);
                for (uint256 k = 0; k < pays.length; ++k) {
                    assertEq(pays[k], expectedPays[k], name);
                }
                assertEq(residual, u(i, ".expected.residual"), name);
            }
            ++checked;
        }
        assertGt(checked, 50, "expected many split cases");
    }

    function test_constants() public pure {
        assertEq(SplitMath.WAD, 1e18);
        assertEq(SplitMath.MAX_RECIPIENTS, 16);
        assertEq(SplitMath.MAX_PRICE, type(uint96).max);
    }

    function test_hugeWeightRevertsWithCustomError() public {
        uint256[] memory w = new uint256[](2);
        w[0] = type(uint256).max;
        w[1] = 1;
        vm.expectRevert(abi.encodeWithSelector(SplitMath.WeightsSumMismatch.selector, type(uint256).max));
        h.validateWeights(w);
    }

    /// @dev Error names in the vectors are shared with the TS error cases; map them to selectors here.
    function selectorFor(
        string memory name
    ) internal pure returns (bytes4) {
        bytes32 k = keccak256(bytes(name));
        if (k == keccak256("NoRecipients")) return SplitMath.NoRecipients.selector;
        if (k == keccak256("TooManyRecipients")) return SplitMath.TooManyRecipients.selector;
        if (k == keccak256("WeightsSumMismatch")) return SplitMath.WeightsSumMismatch.selector;
        if (k == keccak256("PriceTooLarge")) return SplitMath.PriceTooLarge.selector;
        revert("unknown error name in vectors");
    }
}
