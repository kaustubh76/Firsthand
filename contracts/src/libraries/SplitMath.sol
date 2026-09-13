// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SplitMath
/// @notice Integer-exact royalty split (README §7.3, ADR-0003). Twin of the core TS `split` module.
/// @dev    pay_i = floor(price * w_i / WAD); residual = price - Σ pay_i → protocol dust pool.
///         Invariants (fuzz + invariant tested): Σ pay + residual == price; residual <= n - 1.
library SplitMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_RECIPIENTS = 16;
    /// @dev Keeps `price * weight < 2^156`; no overflow path exists below this bound.
    uint256 internal constant MAX_PRICE = type(uint96).max;

    error NoRecipients();
    error TooManyRecipients(uint256 count);
    error WeightsSumMismatch(uint256 sum);
    error PriceTooLarge(uint256 price);

    /// @notice Reverts unless `weights` is a valid WAD-scaled distribution of 1..16 entries.
    function validateWeights(
        uint256[] memory weights
    ) internal pure {
        uint256 n = weights.length;
        if (n == 0) revert NoRecipients();
        if (n > MAX_RECIPIENTS) revert TooManyRecipients(n);
        uint256 sum;
        for (uint256 i = 0; i < n; ++i) {
            uint256 w = weights[i];
            // Bound each term first so the running sum can never overflow (both operands <= WAD).
            if (w > WAD) revert WeightsSumMismatch(w);
            sum += w;
            if (sum > WAD) revert WeightsSumMismatch(sum);
        }
        if (sum != WAD) revert WeightsSumMismatch(sum);
    }

    /// @notice Splits `price` by `weights`. Zero weights and a zero price are allowed here;
    ///         the price floor is enforced by GrantManager at terms creation.
    function split(
        uint256 price,
        uint256[] memory weights
    ) internal pure returns (uint256[] memory pays, uint256 residual) {
        if (price > MAX_PRICE) revert PriceTooLarge(price);
        validateWeights(weights);
        uint256 n = weights.length;
        pays = new uint256[](n);
        uint256 paid;
        for (uint256 i = 0; i < n; ++i) {
            uint256 pay = (price * weights[i]) / WAD;
            pays[i] = pay;
            paid += pay;
        }
        residual = price - paid;
    }
}
