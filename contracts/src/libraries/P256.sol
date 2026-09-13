// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title P256
/// @notice secp256r1 verification through the RIP-7212 precompile at 0x100 (README §8 claim 3).
/// @dev    Input layout: hash (32) ‖ r (32) ‖ s (32) ‖ x (32) ‖ y (32) = 160 bytes; output is 32 bytes,
///         `1` on success and empty/`0` on failure. The precompile does NOT enforce low-s, so this library
///         does — matching `verifyP256` in the core TS package and the shared p256-signatures vectors.
///         Tests etch the daimo-eth/p256-verifier runtime at 0x100 (`test/doubles/P256Double.sol`).
library P256 {
    address internal constant PRECOMPILE = address(0x100);
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant HALF_N = N >> 1;

    /// @notice Pure predicate: false on high-s, zero/out-of-range r or s, or precompile rejection.
    function verify(bytes32 hash, uint256 r, uint256 s, uint256 x, uint256 y) internal view returns (bool) {
        if (r == 0 || r >= N || s == 0 || s > HALF_N) return false;
        (bool ok, bytes memory ret) = PRECOMPILE.staticcall(abi.encode(hash, r, s, x, y));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    /// @notice Convenience over a 64-byte `r ‖ s` signature.
    function verifySignature(bytes32 hash, bytes memory signature, uint256 x, uint256 y) internal view returns (bool) {
        if (signature.length != 64) return false;
        (uint256 r, uint256 s) = abi.decode(signature, (uint256, uint256));
        return verify(hash, r, s, x, y);
    }

    /// @notice `keccak256(abi.encode(x, y))` — the enrolled `p256KeyCommit` / principal id.
    function commitment(uint256 x, uint256 y) internal pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }
}
