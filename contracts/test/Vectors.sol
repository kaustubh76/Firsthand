// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Strings} from "./Strings.sol";

/// @title VectorTest
/// @notice Base for vector-driven tests: loads a golden suite from ../packages/test-vectors/vectors.
abstract contract VectorTest is Test {
    string internal json;
    uint256 internal count;

    function loadSuite(
        string memory suite
    ) internal {
        json = vm.readFile(string.concat("../packages/test-vectors/vectors/", suite, ".v1.json"));
        count = vm.parseJsonUint(json, ".count");
        assertGt(count, 0, "suite is empty - run pnpm vectors:gen");
    }

    function casePath(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".cases[", Strings.toString(i), "]", field);
    }

    function caseName(
        uint256 i
    ) internal view returns (string memory) {
        return vm.parseJsonString(json, casePath(i, ".name"));
    }

    function isHand(
        uint256 i
    ) internal view returns (bool) {
        return vm.keyExistsJson(json, casePath(i, ".hand"));
    }

    function has(uint256 i, string memory field) internal view returns (bool) {
        return vm.keyExistsJson(json, casePath(i, field));
    }

    function u(uint256 i, string memory field) internal view returns (uint256) {
        return vm.parseJsonUint(json, casePath(i, field));
    }

    function uArr(uint256 i, string memory field) internal view returns (uint256[] memory) {
        return vm.parseJsonUintArray(json, casePath(i, field));
    }

    function b32(uint256 i, string memory field) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, casePath(i, field));
    }

    function b32Arr(uint256 i, string memory field) internal view returns (bytes32[] memory) {
        return vm.parseJsonBytes32Array(json, casePath(i, field));
    }

    function addr(uint256 i, string memory field) internal view returns (address) {
        return vm.parseJsonAddress(json, casePath(i, field));
    }

    function addrArr(uint256 i, string memory field) internal view returns (address[] memory) {
        return vm.parseJsonAddressArray(json, casePath(i, field));
    }

    function bytes_(uint256 i, string memory field) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, casePath(i, field));
    }

    function str(uint256 i, string memory field) internal view returns (string memory) {
        return vm.parseJsonString(json, casePath(i, field));
    }

    function boolean(uint256 i, string memory field) internal view returns (bool) {
        return vm.parseJsonBool(json, casePath(i, field));
    }

    function startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (p.length > a.length) return false;
        for (uint256 k = 0; k < p.length; ++k) {
            if (a[k] != p[k]) return false;
        }
        return true;
    }

    /// @dev Every suite must carry hand-derived cases so both implementations cannot be wrong together.
    function assertHandCases(
        uint256 minimum
    ) internal view {
        uint256 hand;
        for (uint256 i = 0; i < count; ++i) {
            if (isHand(i)) ++hand;
        }
        assertGe(hand, minimum, "too few hand-derived cases");
    }
}
