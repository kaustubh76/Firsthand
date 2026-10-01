// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {P256Double} from "../doubles/P256Double.sol";
import {P256Signer} from "../P256Signer.sol";
import {VectorTest} from "../Vectors.sol";
import {HardwareDeviceRegistry} from "../../src/HardwareDeviceRegistry.sol";
import {IHardwareDeviceRegistry} from "../../src/interfaces/IHardwareDeviceRegistry.sol";
import {PrincipalRegistry} from "../../src/PrincipalRegistry.sol";
import {AuthorityDigests} from "../../src/libraries/AuthorityDigests.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {P256} from "../../src/libraries/P256.sol";
import {PassportLib} from "../../src/libraries/PassportLib.sol";
import {DeviceRecord} from "../../src/types/Structs.sol";

/// @dev End to end against the shared golden chain: the certificate in the fixture was issued to
///      the very principal this test enrols, because its `attestationChallenge` names that
///      principal's key commitment. Nothing here is a stub — the signatures verify, the chain
///      walks, and the precompile does the work.
contract HardwareDeviceRegistryTest is VectorTest {
    uint64 internal constant GENESIS = 1_700_000_000;
    uint64 internal constant LEN = EpochLib.DEFAULT_EPOCH_SECONDS;
    uint8 internal constant STRONG_BOX = 2;
    uint8 internal constant TRUSTED_ENVIRONMENT = 1;

    PrincipalRegistry internal principals;
    HardwareDeviceRegistry internal registry;

    uint256 internal authorityScalar;
    bytes32 internal principalId;
    bytes32 internal nonce;
    bytes32 internal anchor;
    bytes[] internal chain;

    function setUp() public {
        P256Double.etch(vm);
        vm.warp(GENESIS + 5 * LEN + 17); // epoch 5
        loadSuite("android-attestation");

        authorityScalar = uint256(vm.parseJsonBytes32(json, ".extra.authorityScalar"));
        principalId = vm.parseJsonBytes32(json, ".extra.principalId");
        nonce = vm.parseJsonBytes32(json, ".extra.nonce");
        anchor = vm.parseJsonBytes32(json, ".extra.anchorCommitment");
        string[] memory hexChain = vm.parseJsonStringArray(json, ".extra.chain");
        for (uint256 i = 0; i < hexChain.length; ++i) {
            chain.push(vm.parseBytes(hexChain[i]));
        }

        principals = new PrincipalRegistry(GENESIS, LEN, EpochLib.LIVENESS_GRACE_EPOCHS);
        bytes32[] memory anchors = new bytes32[](1);
        anchors[0] = anchor;
        registry = new HardwareDeviceRegistry(principals, STRONG_BOX, anchors);

        enrol();
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────────

    function enrol() internal {
        (uint256 x, uint256 y) = P256Signer.publicKey(vm, authorityScalar);
        assertEq(P256.commitment(x, y), principalId, "the fixture names the principal we enrol");
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.enroll(principalId, 5, bytes32(uint256(1))), principals.domainSeparator()
        );
        principals.enroll(x, y, 5, bytes32(uint256(1)), P256Signer.sign(vm, authorityScalar, digest));
    }

    function registerSig(bytes32 keyCommitment, bytes32 n) internal view returns (bytes memory) {
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.registerDevice(principalId, keyCommitment, n), registry.domainSeparator()
        );
        return P256Signer.sign(vm, authorityScalar, digest);
    }

    function revokeSig(bytes32 keyCommitment, bytes32 n) internal view returns (bytes memory) {
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.revokeDevice(principalId, keyCommitment, n), registry.domainSeparator()
        );
        return P256Signer.sign(vm, authorityScalar, digest);
    }

    /// @dev The commitment the fixture's leaf key makes — what registration must arrive at.
    function deviceCommitment() internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, ".extra.deviceCommitment");
    }

    function doRegister() internal returns (bytes32 keyCommitment) {
        keyCommitment = deviceCommitment();
        registry.registerDevice(principalId, chain, nonce, registerSig(keyCommitment, nonce));
    }

    // ── registration ────────────────────────────────────────────────────────────────────────────

    function test_registersADeviceItsCertificateChainProves() public {
        bytes32 keyCommitment = deviceCommitment();
        vm.expectEmit(true, true, false, true);
        emit IHardwareDeviceRegistry.DeviceRegistered(principalId, keyCommitment, STRONG_BOX, 0, true);
        // Relayed by a stranger: the signature authorises it, not msg.sender.
        vm.prank(address(0xBEEF));
        assertEq(doRegister(), keyCommitment);

        DeviceRecord memory d = registry.device(keyCommitment);
        assertEq(d.principalId, principalId);
        assertEq(d.securityLevel, STRONG_BOX, "the measured level, not the one we asked for");
        assertEq(d.verifiedBootState, 0);
        assertTrue(d.hasRootOfTrust);
        assertEq(d.registeredAt, block.timestamp);
        assertEq(d.revokedAt, 0);
        assertTrue(registry.nonceUsed(principalId, nonce));
    }

    function test_witnessesAreOnlyVerifiedForALiveRegisteredDevice() public {
        bytes32 keyCommitment = deviceCommitment();
        bytes32 captured = keccak256("a capture digest");

        // Unknown device: false, without needing to know anything about the signature.
        assertFalse(registry.verifyCapture(keyCommitment, captured, hex""));

        doRegister();
        bytes memory witness = P256Signer.sign(vm, deviceScalar(), captured);
        assertTrue(registry.verifyCapture(keyCommitment, captured, witness), "the device signed it");
        assertFalse(
            registry.verifyCapture(keyCommitment, keccak256("something else"), witness), "and only over what it signed"
        );

        bytes32 revokeNonce = bytes32(uint256(9));
        registry.revokeDevice(principalId, keyCommitment, revokeNonce, revokeSig(keyCommitment, revokeNonce));
        assertFalse(registry.verifyCapture(keyCommitment, captured, witness), "revoked stops it");
    }

    /// @dev The leaf's private key, as the fixture generator chose it.
    function deviceScalar() internal pure returns (uint256) {
        return uint256(bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)));
    }

    function test_refusesAnUnenrolledPrincipalAndAReplayedNonce() public {
        bytes32 stranger = keccak256("nobody");
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.UnknownPrincipal.selector, stranger));
        registry.registerDevice(stranger, chain, nonce, hex"");

        doRegister();
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.NonceAlreadyUsed.selector, nonce));
        registry.registerDevice(principalId, chain, nonce, hex"");
    }

    function test_refusesASecondRegistrationOfTheSameDevice() public {
        doRegister();
        bytes32 second = bytes32(uint256(77));
        bytes32 keyCommitment = deviceCommitment();
        // Computed first: `vm.expectRevert` binds to the next *external* call, and building a
        // signature reads `domainSeparator()` off the registry.
        bytes memory sig = registerSig(keyCommitment, second);
        // A different nonce, so this is the AlreadyRegistered arm rather than the replay one —
        // which also proves the duplicate check runs before the challenge is examined.
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.AlreadyRegistered.selector, keyCommitment));
        registry.registerDevice(principalId, chain, second, sig);
    }

    function test_refusesAForgedAuthoritySignature() public {
        bytes32 keyCommitment = deviceCommitment();
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.registerDevice(principalId, keyCommitment, nonce), registry.domainSeparator()
        );
        // Signed by somebody else entirely.
        bytes memory foreign = P256Signer.sign(vm, 0xC0FFEE, digest);
        vm.expectRevert(IHardwareDeviceRegistry.InvalidAuthoritySignature.selector);
        registry.registerDevice(principalId, chain, nonce, foreign);
    }

    // ── the chain ───────────────────────────────────────────────────────────────────────────────

    function test_refusesAChainThatDoesNotReachTheAnchor() public {
        bytes32[] memory elsewhere = new bytes32[](1);
        elsewhere[0] = keccak256("some other certificate authority");
        HardwareDeviceRegistry other = new HardwareDeviceRegistry(principals, STRONG_BOX, elsewhere);
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.ChainRejected.selector, 5, chain.length));
        other.registerDevice(principalId, chain, nonce, hex"");
    }

    function test_refusesAChainTooShortToProveAnything() public {
        bytes[] memory lonely = new bytes[](1);
        lonely[0] = chain[0];
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.ChainRejected.selector, 1, 0));
        registry.registerDevice(principalId, lonely, nonce, hex"");
    }

    function test_refusesALeafTheIssuerDidNotSign() public {
        // Names link, signature does not — the only arm a real verification can tell apart from
        // a valid chain, and the reason the precompile is called at all.
        bytes[] memory forged = new bytes[](2);
        forged[0] = bytes_(indexOfCase("hand/wrong-signer"), ".input.certificate");
        forged[1] = chain[1];
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.ChainRejected.selector, 4, 0));
        registry.registerDevice(principalId, forged, nonce, hex"");
    }

    function test_refusesALeafSignedWithAnAlgorithmItDoesNotVerify() public {
        bytes[] memory wrongAlgorithm = new bytes[](2);
        wrongAlgorithm[0] = bytes_(indexOfCase("hand/not-sha256"), ".input.certificate");
        wrongAlgorithm[1] = chain[1];
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.ChainRejected.selector, 2, 0));
        registry.registerDevice(principalId, wrongAlgorithm, nonce, hex"");
    }

    function test_refusesAnIssuerWhoseNameDoesNotLink() public {
        bytes[] memory mislinked = new bytes[](2);
        mislinked[0] = chain[0];
        mislinked[1] = chain[0]; // the leaf as its own issuer: subject "device", issuer "intermediate"
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.ChainRejected.selector, 3, 0));
        registry.registerDevice(principalId, mislinked, nonce, hex"");
    }

    // ── the key the chain attests ───────────────────────────────────────────────────────────────

    function test_refusesALeafWithNoAttestationExtension() public {
        // A certificate the intermediate really did sign, carrying no key description: the chain
        // is sound and still proves nothing about a secure element.
        bytes[] memory headless = new bytes[](2);
        headless[0] = bytes_(indexOfCase("hand/no-version"), ".input.certificate");
        headless[1] = chain[1];
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.DeviceRejected.selector, 1));
        registry.registerDevice(principalId, headless, nonce, hex"");
    }

    function test_refusesAKeyThatIsNotHardwareGeneratedOrIsTooWeak() public {
        bytes[] memory bare = new bytes[](2);
        bare[0] = bytes_(indexOfCase("hand/no-authorizations"), ".input.certificate");
        bare[1] = chain[1];
        // No origin attested: nothing says the private half never left the element.
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.DeviceRejected.selector, 2));
        registry.registerDevice(principalId, bare, nonce, hex"");
    }

    function test_refusesALevelBelowTheOneItWasDeployedToRequire() public {
        bytes32[] memory anchors = new bytes32[](1);
        anchors[0] = anchor;
        bytes[] memory tee = new bytes[](2);
        tee[0] = bytes_(indexOfCase("hand/trusted-environment"), ".input.certificate");
        tee[1] = chain[1];

        // A hardware-generated key that only reaches TEE: refused where StrongBox was demanded…
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.DeviceRejected.selector, 3));
        registry.registerDevice(principalId, tee, nonce, hex"");

        // …and accepted by a deployment that asks for what this device can actually give, with
        // the measured level recorded rather than the one anybody hoped for.
        HardwareDeviceRegistry lenient = new HardwareDeviceRegistry(principals, TRUSTED_ENVIRONMENT, anchors);
        bytes32 keyCommitment = deviceCommitment();
        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.registerDevice(principalId, keyCommitment, nonce), lenient.domainSeparator()
        );
        lenient.registerDevice(principalId, tee, nonce, P256Signer.sign(vm, authorityScalar, digest));
        assertEq(lenient.device(keyCommitment).securityLevel, TRUSTED_ENVIRONMENT);
    }

    function test_refusesAChallengeThatNamesSomebodyElse() public {
        // The certificate's challenge binds one principal and one nonce. Spend a different nonce
        // and the chain stops being a registration of this device by this human.
        bytes32 other = bytes32(uint256(1234));
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.DeviceRejected.selector, 4));
        registry.registerDevice(principalId, chain, other, hex"");
    }

    // ── revocation ──────────────────────────────────────────────────────────────────────────────

    function test_revokesAndRefusesEveryWayItCanBeAskedWrongly() public {
        bytes32 keyCommitment = doRegister();
        bytes32 n = bytes32(uint256(31));

        bytes32 unknown = keccak256("never seen");
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.UnknownDevice.selector, unknown));
        registry.revokeDevice(principalId, unknown, n, hex"");

        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.NotYourDevice.selector, keyCommitment));
        registry.revokeDevice(keccak256("another principal"), keyCommitment, n, hex"");

        bytes32 digest = PassportLib.digestOf(
            AuthorityDigests.revokeDevice(principalId, keyCommitment, n), registry.domainSeparator()
        );
        vm.expectRevert(IHardwareDeviceRegistry.InvalidAuthoritySignature.selector);
        registry.revokeDevice(principalId, keyCommitment, n, P256Signer.sign(vm, 0xC0FFEE, digest));

        bytes memory good = revokeSig(keyCommitment, n);
        vm.expectEmit(true, true, false, true);
        emit IHardwareDeviceRegistry.DeviceRevoked(principalId, keyCommitment, uint64(block.timestamp));
        registry.revokeDevice(principalId, keyCommitment, n, good);
        assertEq(registry.device(keyCommitment).revokedAt, block.timestamp);

        bytes32 again = bytes32(uint256(32));
        bytes memory twice = revokeSig(keyCommitment, again);
        vm.expectRevert(abi.encodeWithSelector(IHardwareDeviceRegistry.AlreadyRevoked.selector, keyCommitment));
        registry.revokeDevice(principalId, keyCommitment, again, twice);

        // The record survives: a buyer auditing an older manifest still needs to see it existed.
        assertEq(registry.device(keyCommitment).principalId, principalId);
    }

    // ── deployment ──────────────────────────────────────────────────────────────────────────────

    function test_refusesToDeployWithNoTrustAnchor() public {
        vm.expectRevert(IHardwareDeviceRegistry.NoTrustAnchors.selector);
        new HardwareDeviceRegistry(principals, STRONG_BOX, new bytes32[](0));
    }

    function test_publishesWhatItWasDeployedWith() public view {
        bytes32[] memory pinned = registry.anchors();
        assertEq(pinned.length, 1);
        assertEq(pinned[0], anchor);
        assertEq(registry.minimumSecurityLevel(), STRONG_BOX);
        assertEq(address(registry.principals()), address(principals));
        assertEq(
            registry.domainSeparator(),
            PassportLib.domainSeparator(block.chainid, address(registry)),
            "its own domain, not the registry's"
        );
    }

    function indexOfCase(
        string memory name
    ) internal view returns (uint256) {
        for (uint256 i = 0; i < count; ++i) {
            if (keccak256(bytes(caseName(i))) == keccak256(bytes(name))) return i;
        }
        revert("no such case");
    }
}
