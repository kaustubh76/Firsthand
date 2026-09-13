// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SplitMath} from "../../src/libraries/SplitMath.sol";
import {TermsInput} from "../../src/types/Structs.sol";
import {SettlementFixture} from "../SettlementFixture.sol";

/// @dev Value conservation through the whole settlement path: buyer − price == Σ payees + dust, and the router's
///      token balance is exactly its dust ledger.
contract RoyaltyRouterFuzzTest is SettlementFixture {
    TermsInput internal fuzzTerms;
    bytes32 internal fuzzGrant;

    function testFuzz_settleConservesValue(
        uint64 priceSeed,
        uint256[16] memory raw,
        uint8 nRaw,
        uint32 rateLimit
    ) public {
        uint64 price = uint64(bound(priceSeed, 1, 1_000_000));
        uint256 n = 1 + (nRaw % SplitMath.MAX_RECIPIENTS);
        buildTerms(price, n, raw, rateLimit);
        setUpGrant(n, price);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        router.settle(fuzzGrant, fuzzTerms, authorization(BUYER_SK, price, keccak256(abi.encode("q", price, n))));

        uint256 paid;
        for (uint256 i = 0; i < n; ++i) {
            paid += usdc.balanceOf(fuzzTerms.payees[i]);
        }
        assertEq(buyerBefore - usdc.balanceOf(buyer), price, "buyer charged exactly the price");
        assertEq(paid + router.dustBalance(), price, "value conserved");
        assertEq(usdc.balanceOf(address(router)), router.dustBalance(), "router holds exactly its dust");
        assertLe(router.dustBalance(), n - 1, "dust bounded");
    }

    function buildTerms(uint64 price, uint256 n, uint256[16] memory raw, uint32 rateLimit) internal {
        TermsInput memory t = defaultTerms();
        t.price = price;
        t.rateLimit = rateLimit;
        t.payees = new address[](n);
        t.weights = new uint256[](n);
        uint256 remaining = SplitMath.WAD;
        for (uint256 i = 0; i < n; ++i) {
            t.payees[i] = address(uint160(0x1000 + i));
            uint256 w = i + 1 == n ? remaining : raw[i] % (remaining + 1);
            t.weights[i] = w;
            remaining -= w;
        }
        fuzzTerms = t;
    }

    /// @dev Fresh card so the grant id does not collide with the fixture's default grant.
    function setUpGrant(uint256 n, uint64 price) internal {
        uint256 cardSk = 0xC000 + n;
        bytes32 c = grants.registerCard(vm.addr(cardSk), bytes32(uint256(n)));
        bytes32 nonce = keccak256(abi.encode(price, n));
        bytes32 th =
            grants.acceptTerms(c, principalId, fuzzTerms, nonce, acceptSig(cardSk, c, principalId, fuzzTerms, nonce));
        GrantArgs memory g = defaultGrant();
        g.granteeCard = c;
        g.termsHash = th;
        g.nonce = nonce;
        fuzzGrant = submitGrant(g, grantSig(AUTHORITY_SK, g));
    }
}
