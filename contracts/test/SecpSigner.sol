// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {PassportLib} from "../src/libraries/PassportLib.sol";

/// @dev Test-side secp256k1 signer producing the protocol's 65-byte `r ‖ s ‖ v`, low-s form.
library SecpSigner {
    function sign(Vm vm, uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        uint256 sv = uint256(s);
        if (sv > PassportLib.SECP_HALF_N) {
            sv = PassportLib.SECP_N - sv;
            v = v == 27 ? 28 : 27;
        }
        return abi.encodePacked(r, bytes32(sv), v);
    }
}
