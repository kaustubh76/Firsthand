// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NotImplemented} from "./Errors.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IGrantManager} from "./interfaces/IGrantManager.sol";
import {IReceiptLedger} from "./interfaces/IReceiptLedger.sol";
import {IRoyaltyRouter} from "./interfaces/IRoyaltyRouter.sol";
import {TermsInput, TransferAuthorization} from "./types/Structs.sol";

/// @title RoyaltyRouter
/// @notice Phase 3 stub. Pure math + transfers; immutable addresses; no admin keys (README §9, §12).
contract RoyaltyRouter is IRoyaltyRouter {
    IERC3009 internal immutable _usdc;
    IGrantManager public immutable grants;
    IReceiptLedger public immutable ledger;
    address internal immutable _dustPool;

    uint256 internal _dust;

    constructor(IERC3009 usdc_, IGrantManager grants_, IReceiptLedger ledger_, address dustPool_) {
        _usdc = usdc_;
        grants = grants_;
        ledger = ledger_;
        _dustPool = dustPool_;
    }

    function settle(bytes32, TermsInput calldata, TransferAuthorization calldata) external pure returns (bytes32) {
        revert NotImplemented("RoyaltyRouter.settle");
    }

    function sweepDust() external pure returns (uint256) {
        revert NotImplemented("RoyaltyRouter.sweepDust");
    }

    function usdc() external view returns (address) {
        return address(_usdc);
    }

    function dustPool() external view returns (address) {
        return _dustPool;
    }

    function dustBalance() external view returns (uint256) {
        return _dust;
    }
}
