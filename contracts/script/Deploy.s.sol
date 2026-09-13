// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {PrincipalRegistry} from "../src/PrincipalRegistry.sol";
import {Rescissions} from "../src/Rescissions.sol";
import {PassportAnchorsBaseline} from "../src/PassportAnchorsBaseline.sol";
import {PassportAnchorsPaged} from "../src/PassportAnchorsPaged.sol";
import {GrantManager} from "../src/GrantManager.sol";
import {ReceiptLedger} from "../src/ReceiptLedger.sol";
import {RoyaltyRouter} from "../src/RoyaltyRouter.sol";
import {FirsthandLens} from "../src/FirsthandLens.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";
import {IPassportAnchors} from "../src/interfaces/IPassportAnchors.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {MockUSDC} from "../test/doubles/MockUSDC.sol";

/// @title Deploy
/// @notice Immutable deployment (README §12): no proxies, no admin keys. Writes deployments/<chainId>.json.
/// @dev    Env: DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, DUST_POOL (defaults to deployer), EPOCH_GENESIS (defaults
///         to the previous Monday 00:00 UTC), ANCHORS_LAYOUT=baseline|paged (default baseline).
///         The router↔ledger cycle is broken by precomputing the router's CREATE address.
contract Deploy is Script {
    struct Deployed {
        address principalRegistry;
        address rescissions;
        address passportAnchors; // the primary (per ANCHORS_LAYOUT) — what Lens, gateway and SDK bind to
        address passportAnchorsBaseline; // both layouts are always deployed so S1 can compare arms
        address passportAnchorsPaged;
        address grantManager;
        address receiptLedger;
        address royaltyRouter;
        address firsthandLens;
        address usdc;
        uint64 revealWindowBlocks;
        uint64 genesis;
        uint64 epochLength;
        string anchorsLayout;
    }

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        d.genesis = uint64(vm.envOr("EPOCH_GENESIS", defaultGenesis()));
        d.epochLength = EpochLib.DEFAULT_EPOCH_SECONDS;
        d.anchorsLayout = vm.envOr("ANCHORS_LAYOUT", string("baseline"));

        vm.startBroadcast(pk);
        deployCore(d);
        deploySettlement(d, vm.addr(pk));
        vm.stopBroadcast();

        writeDeployment(d);
    }

    function deployCore(
        Deployed memory d
    ) internal {
        PrincipalRegistry registry = new PrincipalRegistry(d.genesis, d.epochLength, EpochLib.LIVENESS_GRACE_EPOCHS);
        d.principalRegistry = address(registry);
        d.rescissions = address(new Rescissions());
        d.passportAnchorsBaseline = address(new PassportAnchorsBaseline(registry));
        d.passportAnchorsPaged = address(new PassportAnchorsPaged(registry));
        d.passportAnchors =
            keccak256(bytes(d.anchorsLayout)) == keccak256("paged") ? d.passportAnchorsPaged : d.passportAnchorsBaseline;
        d.revealWindowBlocks = uint64(vm.envOr("REVEAL_WINDOW_BLOCKS", uint256(1000)));
        d.grantManager = address(new GrantManager(registry, Rescissions(d.rescissions), 0, 0, d.revealWindowBlocks));
    }

    function deploySettlement(Deployed memory d, address deployer) internal {
        // On a local chain (or when asked) deploy the EIP-3009 MockUSDC so settlement can be exercised end to end.
        d.usdc = vm.envOr("DEPLOY_MOCK_USDC", block.chainid == 31_337)
            ? address(new MockUSDC())
            : vm.envAddress("USDC_ADDRESS");
        // ReceiptLedger needs the router address; the router is the *next* CREATE from the deployer.
        address predictedRouter = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        d.receiptLedger = address(new ReceiptLedger(predictedRouter));
        d.royaltyRouter = address(
            new RoyaltyRouter(
                IERC3009(d.usdc),
                GrantManager(d.grantManager),
                ReceiptLedger(d.receiptLedger),
                vm.envOr("DUST_POOL", deployer)
            )
        );
        require(d.royaltyRouter == predictedRouter, "router address prediction failed");
        d.firsthandLens = address(
            new FirsthandLens(
                PrincipalRegistry(d.principalRegistry),
                IPassportAnchors(d.passportAnchors),
                GrantManager(d.grantManager)
            )
        );
    }

    /// @dev Most recent Monday 00:00 UTC before now — aligns epochs with the weekly attestation ritual.
    function defaultGenesis() internal view returns (uint256) {
        uint256 week = 7 days;
        // 1970-01-01 was a Thursday; shift by 4 days so weeks start on Monday.
        uint256 shifted = block.timestamp + 4 days;
        return (shifted / week) * week - 4 days;
    }

    function writeDeployment(
        Deployed memory d
    ) internal {
        string memory root = "deployment";
        vm.serializeAddress(root, "PrincipalRegistry", d.principalRegistry);
        vm.serializeAddress(root, "Rescissions", d.rescissions);
        vm.serializeAddress(root, "PassportAnchors", d.passportAnchors);
        vm.serializeAddress(root, "PassportAnchorsBaseline", d.passportAnchorsBaseline);
        vm.serializeAddress(root, "PassportAnchorsPaged", d.passportAnchorsPaged);
        vm.serializeAddress(root, "GrantManager", d.grantManager);
        vm.serializeAddress(root, "ReceiptLedger", d.receiptLedger);
        vm.serializeAddress(root, "RoyaltyRouter", d.royaltyRouter);
        vm.serializeAddress(root, "FirsthandLens", d.firsthandLens);
        vm.serializeUint(root, "genesis", d.genesis);
        vm.serializeUint(root, "epochLength", d.epochLength);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "USDC", d.usdc);
        vm.serializeUint(root, "revealWindowBlocks", d.revealWindowBlocks);
        string memory out = vm.serializeString(root, "anchorsLayout", d.anchorsLayout);
        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("wrote", path);
    }
}
