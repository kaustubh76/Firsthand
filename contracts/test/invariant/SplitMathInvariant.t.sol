// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SplitMath} from "../../src/libraries/SplitMath.sol";

/// @dev Handler drives the split with arbitrary inputs and accumulates the ledger totals.
contract SplitHandler {
    uint256 public totalPrice;
    uint256 public totalPaid;
    uint256 public totalResidual;
    uint256 public calls;
    uint256 public maxResidual;

    function split(uint96 price, uint256[16] memory raw, uint8 nRaw) external {
        uint256 n = 1 + (nRaw % SplitMath.MAX_RECIPIENTS);
        uint256[] memory weights = new uint256[](n);
        uint256 remaining = SplitMath.WAD;
        for (uint256 i = 0; i + 1 < n; ++i) {
            uint256 w = raw[i] % (remaining + 1);
            weights[i] = w;
            remaining -= w;
        }
        weights[n - 1] = remaining;

        (uint256[] memory pays, uint256 residual) = SplitMath.split(price, weights);
        for (uint256 i = 0; i < pays.length; ++i) {
            totalPaid += pays[i];
        }
        totalResidual += residual;
        totalPrice += price;
        if (residual > maxResidual) maxResidual = residual;
        ++calls;
    }
}

contract SplitMathInvariantTest is Test {
    SplitHandler internal handler;

    function setUp() public {
        handler = new SplitHandler();
        targetContract(address(handler));
    }

    /// @notice Σ pay + residual == price over the whole run: value is never minted nor lost.
    function invariant_ledgerConservation() public view {
        assertEq(handler.totalPaid() + handler.totalResidual(), handler.totalPrice());
    }

    /// @notice Dust per call is bounded by the recipient cap.
    function invariant_residualBounded() public view {
        assertLe(handler.maxResidual(), SplitMath.MAX_RECIPIENTS - 1);
    }
}
