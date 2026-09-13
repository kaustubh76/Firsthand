// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPrincipalRegistry} from "../../src/interfaces/IPrincipalRegistry.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {P256} from "../../src/libraries/P256.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {P256Signer} from "../P256Signer.sol";

/// @title PrincipalRegistryForkTest
/// @notice `test:testnet` only: exercises the deployed registry on a fork of Monad testnet, so the P-256
///         signature is verified by the chain's native precompile rather than the etched double.
/// @dev    Reads deployments/<chainId>.json; skips when MONAD_RPC_URL is unset. The enrolment is a fresh,
///         throw-away key: nothing here is a real principal.
contract PrincipalRegistryForkTest is Test {
    IPrincipalRegistry internal registry;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        string memory json = vm.readFile(string.concat("../deployments/", vm.toString(block.chainid), ".json"));
        registry = IPrincipalRegistry(vm.parseJsonAddress(json, ".PrincipalRegistry"));
    }

    uint256 internal sk;
    uint256 internal x;
    uint256 internal y;
    bytes32 internal id;

    function test_enrollAndAttestOnRealPrecompile() public {
        if (address(registry) == address(0)) {
            vm.skip(true);
            return;
        }
        sk = uint256(keccak256(abi.encode("fork-test", block.timestamp, msg.sender)));
        (x, y) = P256Signer.publicKey(vm, sk);
        id = P256.commitment(x, y);
        uint64 epoch = registry.currentEpoch();

        registry.enroll(x, y, epoch, bytes32(uint256(1)), signEnroll(epoch, bytes32(uint256(1))));
        assertTrue(registry.isLive(id));

        bytes32 root = keccak256("fork deposit keys");
        registry.attest(id, epoch, root, bytes32(uint256(2)), signAttest(epoch, root, bytes32(uint256(2))));
        assertEq(registry.depositKeysRoot(id, epoch), root);
    }

    function signEnroll(uint64 epoch, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 digest = PassportLib.digestOf(AuthorityDigests.enroll(id, epoch, nonce), registry.domainSeparator());
        return P256Signer.sign(vm, sk, digest);
    }

    function signAttest(uint64 epoch, bytes32 root, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 digest =
            PassportLib.digestOf(AuthorityDigests.attest(id, epoch, root, nonce), registry.domainSeparator());
        return P256Signer.sign(vm, sk, digest);
    }
}
