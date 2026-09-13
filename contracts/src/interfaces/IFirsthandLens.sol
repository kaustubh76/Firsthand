// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PassportLib} from "../libraries/PassportLib.sol";
import {BatchProof, GrantStatus, VerifyFailure} from "../types/Structs.sol";

/// @title IFirsthandLens
/// @notice Read-only aggregation: the on-chain `verify()` (README §7.3) and dashboard/Envio views.
interface IFirsthandLens {
    /// @notice verify(P, G, e_now) = SigOK ∧ MerkleOK ∧ GrantLive ∧ liveness ∧ terms/epoch binding.
    function verify(
        PassportLib.Passport calldata passport,
        bytes calldata signature,
        bytes32 batchRoot,
        BatchProof calldata proof,
        bytes32 grantId
    ) external view returns (bool ok, VerifyFailure reason);

    function grantStatus(
        bytes32 grantId
    ) external view returns (GrantStatus);
    function principalIsLive(
        bytes32 principalId
    ) external view returns (bool);
    function domainSeparator() external view returns (bytes32);
    function currentEpoch() external view returns (uint64);
}
