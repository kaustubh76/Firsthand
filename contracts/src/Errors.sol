// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Raised by every stubbed entry point until its phase lands (README §16). Name mirrors `FH_NOT_IMPLEMENTED`.
error NotImplemented(string feature);
