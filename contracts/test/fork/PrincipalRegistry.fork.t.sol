// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";
import {Test} from "forge-std/Test.sol";
import {IPrincipalRegistry} from "../../src/interfaces/IPrincipalRegistry.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {P256} from "../../src/libraries/P256.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {P256Signer} from "../P256Signer.sol";

/// @title PrincipalRegistryForkTest
/// @notice `test:testnet` only: exercises the **deployed** registry's bytecode against forked Monad
///         testnet state, with a real P-256 signature rather than the etched double.
/// @dev    Reads deployments/<chainId>.json; skips when MONAD_RPC_URL is unset. The enrolment is a
///         fresh, throw-away key: nothing here is a real principal.
///
///         What a fork does and does not prove. `vm.createSelectFork` takes *state* from the remote
///         chain but executes in Foundry's own EVM, so the RIP-7212 precompile at 0x100 is Foundry's,
///         not Monad's — and it is present only when the toolchain supplies it (`--odyssey` on the
///         v1.1.0 this repo pins; `foundry.toml` sets `evm_version = "cancun"`, which predates the
///         RIP). Without it every signature reads as invalid, so this probes for the precompile and
///         skips with a reason rather than failing as `InvalidAuthoritySignature` — which is how this
///         test spent its whole life red once anyone set MONAD_RPC_URL, unnoticed because
///         `contracts test:testnet` died on a dangling `--rpc-url` before reaching it.
///
///         The *native* precompile is proved where it can only be proved: by real transactions on
///         Monad testnet — `pnpm demo -- --testnet` and the browser tier against the live links.
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

    /// @dev A signature we know is good: if it does not verify, the EVM has no P-256 precompile.
    function hasP256Precompile() internal view returns (bool) {
        uint256 probeKey = uint256(keccak256("rip-7212 probe"));
        (uint256 px, uint256 py) = P256Signer.publicKey(vm, probeKey);
        bytes32 probe = keccak256("rip-7212 probe digest");
        return P256.verifySignature(probe, P256Signer.sign(vm, probeKey, probe), px, py);
    }

    function test_enrollAndAttestOnRealPrecompile() public {
        if (address(registry) == address(0)) {
            vm.skip(true);
            return;
        }
        if (!hasP256Precompile()) {
            console.log("fork: this EVM has no RIP-7212 precompile - run with --odyssey (Foundry 1.1)");
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
