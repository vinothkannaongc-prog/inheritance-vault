// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F10, carried over from the
// audit PoC sandbox poc/F10/contracts/test/F10Tokens.sol. Contracts renamed F10_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev PoC F10. Fee charged ON TOP of the transfer: the sender is debited value + 1%, the
/// recipient receives exactly value. (Contrast TestHelpers.FeeOnTransferToken, which debits the
/// sender exactly value and delivers 99% -- that shape is harmless to the vault's payouts.)
/// Mint and burn are untouched.
contract F10_FeeOnTopToken is ERC20 {
    constructor() ERC20("Fee On Top", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            if (fee != 0) super._update(from, address(0), fee); // reverts if sender cannot cover it
        }
    }
}

/// @dev PoC F10. A holder's balance can fall without the holder sending anything. As the vault
/// sees it this is identical to a negative rebase (its balance shrinks by x%) and to an
/// issuer/agent burn of the ERC-3643 forced-burn kind that needs no prior freeze.
contract F10_ShrinkingToken is ERC20 {
    constructor() ERC20("Shrinking", "SHR") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function shrink(address holder, uint256 bps) external {
        _burn(holder, (balanceOf(holder) * bps) / 10_000);
    }
}
