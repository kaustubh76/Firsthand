// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiptLedger} from "../src/ReceiptLedger.sol";
import {RoyaltyRouter} from "../src/RoyaltyRouter.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";
import {TermsInput, TransferAuthorization} from "../src/types/Structs.sol";
import {MockUSDC} from "./doubles/MockUSDC.sol";
import {GrantFixture} from "./GrantFixture.sol";

/// @dev GrantFixture + MockUSDC + ledger + router, with one live grant and a funded buyer.
abstract contract SettlementFixture is GrantFixture {
    uint256 internal constant BUYER_SK = 0xB0B;
    address internal buyer;
    MockUSDC internal usdc;
    ReceiptLedger internal ledger;
    RoyaltyRouter internal router;
    address internal dustPool = address(0xD057);
    bytes32 internal grantId;

    function setUp() public virtual override {
        super.setUp();
        buyer = vm.addr(BUYER_SK);
        usdc = new MockUSDC();
        usdc.mint(buyer, 1_000_000_000);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        ledger = new ReceiptLedger(predicted);
        router = new RoyaltyRouter(IERC3009(address(usdc)), grants, ledger, dustPool);
        assertEq(address(router), predicted);
        grantId = doGrant();
    }

    /// @dev Signs an EIP-3009 TransferWithAuthorization for `value` from `sk` to the router.
    function authorization(
        uint256 sk,
        uint256 value,
        bytes32 nonce
    ) internal view returns (TransferAuthorization memory a) {
        a.from = vm.addr(sk);
        a.value = value;
        a.validAfter = 0;
        a.validBefore = type(uint256).max;
        a.nonce = nonce;
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                a.from,
                address(router),
                value,
                a.validAfter,
                a.validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", usdc.DOMAIN_SEPARATOR(), structHash));
        (a.v, a.r, a.s) = vm.sign(sk, digest);
    }

    function settle(
        bytes32 nonce
    ) internal returns (bytes32) {
        return router.settle(grantId, defaultTerms(), authorization(BUYER_SK, 1000, nonce));
    }
}
