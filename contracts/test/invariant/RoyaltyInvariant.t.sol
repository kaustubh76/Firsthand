// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TermsInput, TransferAuthorization} from "../../src/types/Structs.sol";
import {SettlementFixture} from "../SettlementFixture.sol";

/// @dev Handler settles a stream of queries with random nonces (and occasionally sweeps); the router's token
///      balance must always equal its dust ledger, and every recorded receipt must correspond to one settlement.
interface ISettleTarget {
    function settleExternal(
        bytes32 nonce
    ) external;
    function sweepExternal() external;
}

contract SettleHandler is Test {
    ISettleTarget internal f;
    uint256 public settled;
    uint256 public swept;

    constructor(
        ISettleTarget fixture
    ) {
        f = fixture;
    }

    function settle(
        bytes32 nonce
    ) external {
        try f.settleExternal(nonce) {
            settled++;
        } catch {}
    }

    function sweep() external {
        try f.sweepExternal() {
            swept++;
        } catch {}
    }
}

contract RoyaltyInvariantTest is SettlementFixture {
    SettleHandler internal handler;

    function setUp() public override {
        super.setUp();
        // Unlimited rate: use terms with rateLimit 0 on a fresh card/grant.
        handler = new SettleHandler(ISettleTarget(address(this)));
        targetContract(address(handler));
    }

    function settleExternal(
        bytes32 nonce
    ) external {
        settle(nonce);
    }

    function sweepExternal() external {
        router.sweepDust();
    }

    function invariant_routerBalanceEqualsDust() public view {
        assertEq(usdc.balanceOf(address(router)), router.dustBalance());
    }

    function invariant_receiptsMatchSettlements() public view {
        // Default grant has rateLimit 3 in epoch 5, so at most 3 receipts land; every success is a receipt.
        assertEq(ledger.queriesThisEpoch(grantId, EPOCH), handler.settled());
        assertLe(handler.settled(), 3);
    }
}
