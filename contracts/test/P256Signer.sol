// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {P256} from "../src/libraries/P256.sol";

/// @dev Test-side P-256 signer over forge's `signP256` cheatcode, normalised to the low-s form the
///      protocol requires (README §7.3, `P256.sol`). Never used outside tests.
library P256Signer {
    function sign(Vm vm, uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, digest);
        uint256 sv = uint256(s);
        if (sv > P256.HALF_N) sv = P256.N - sv;
        return abi.encode(uint256(r), sv);
    }

    function publicKey(Vm vm, uint256 privateKey) internal pure returns (uint256 x, uint256 y) {
        return vm.publicKeyP256(privateKey);
    }
}
