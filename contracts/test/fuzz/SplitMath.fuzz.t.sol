// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SplitMath} from "../../src/libraries/SplitMath.sol";

contract SplitMathFuzzTest is Test {
    /// @dev Turns arbitrary fuzz input into a valid WAD distribution of 1..16 parts.
    function distribution(uint256[16] memory raw, uint8 nRaw) internal pure returns (uint256[] memory weights) {
        uint256 n = 1 + (nRaw % SplitMath.MAX_RECIPIENTS);
        weights = new uint256[](n);
        uint256 remaining = SplitMath.WAD;
        for (uint256 i = 0; i + 1 < n; ++i) {
            uint256 w = raw[i] % (remaining + 1);
            weights[i] = w;
            remaining -= w;
        }
        weights[n - 1] = remaining;
    }

    function testFuzz_conservation(uint96 price, uint256[16] memory raw, uint8 nRaw) public pure {
        uint256[] memory weights = distribution(raw, nRaw);
        (uint256[] memory pays, uint256 residual) = SplitMath.split(price, weights);
        uint256 total;
        for (uint256 i = 0; i < pays.length; ++i) {
            total += pays[i];
        }
        assertEq(total + residual, price, "value minted or lost");
        assertLe(residual, weights.length - 1, "residual exceeds n - 1");
    }

    function testFuzz_monotoneInPrice(uint96 price, uint32 delta, uint256[16] memory raw, uint8 nRaw) public pure {
        vm.assume(uint256(price) + delta <= type(uint96).max);
        uint256[] memory weights = distribution(raw, nRaw);
        (uint256[] memory lo,) = SplitMath.split(price, weights);
        (uint256[] memory hi,) = SplitMath.split(uint256(price) + delta, weights);
        for (uint256 i = 0; i < lo.length; ++i) {
            assertGe(hi[i], lo[i]);
        }
    }

    function testFuzz_singleRecipientIdentity(
        uint96 price
    ) public pure {
        uint256[] memory w = new uint256[](1);
        w[0] = SplitMath.WAD;
        (uint256[] memory pays, uint256 residual) = SplitMath.split(price, w);
        assertEq(pays[0], price);
        assertEq(residual, 0);
    }

    function testFuzz_rejectsBadSums(uint256[16] memory raw, uint8 nRaw, uint256 perturb) public {
        uint256[] memory weights = distribution(raw, nRaw);
        vm.assume(perturb != 0 && perturb < SplitMath.WAD);
        weights[0] = weights[0] >= perturb ? weights[0] - perturb : weights[0] + perturb;
        vm.expectRevert();
        this.callValidate(weights);
    }

    function callValidate(
        uint256[] memory weights
    ) external pure {
        SplitMath.validateWeights(weights);
    }
}
