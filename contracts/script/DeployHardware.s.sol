// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {HardwareDeviceRegistry} from "../src/HardwareDeviceRegistry.sol";
import {PrincipalRegistry} from "../src/PrincipalRegistry.sol";

/// @title DeployHardware
/// @notice Adds `HardwareDeviceRegistry` to a chain that already has everything else (ADR-0015).
/// @dev    `Deploy.s.sol` deploys a **fresh set of every contract** and rewrites
///         `deployments/<chainId>.json` wholesale, so running it against a live chain would
///         orphan every anchored root, grant, receipt and enrolment that is already out there.
///         This script deploys one contract and merges one key into the existing document.
///
///         Env: `DEPLOYER_PRIVATE_KEY`, `HARDWARE_TRUST_ANCHOR` (the pinned P-256 certificate's
///         key commitment), `HARDWARE_MIN_SECURITY_LEVEL` (1 TrustedEnvironment, 2 StrongBox;
///         defaults to 1).
contract DeployHardware is Script {
    function run() external returns (address registry) {
        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        string memory existing = vm.readFile(path);
        address principals = vm.parseJsonAddress(existing, ".PrincipalRegistry");

        bytes32[] memory anchors = new bytes32[](1);
        anchors[0] = vm.envBytes32("HARDWARE_TRUST_ANCHOR");
        uint8 minimum = uint8(vm.envOr("HARDWARE_MIN_SECURITY_LEVEL", uint256(1)));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        registry = address(new HardwareDeviceRegistry(PrincipalRegistry(principals), minimum, anchors));
        vm.stopBroadcast();

        vm.writeJson(vm.toString(registry), path, ".HardwareDeviceRegistry");
        console.log("merged HardwareDeviceRegistry into", path);
    }
}
