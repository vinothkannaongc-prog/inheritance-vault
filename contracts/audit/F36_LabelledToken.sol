// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F36, carried over from the
// audit PoC sandbox poc/F36/contracts/test/LabelledToken.sol. Contracts renamed F36_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev ERC20 with a caller-chosen name, symbol and decimals. Used twice by the F36 PoC: once as
/// the "canonical" USDC a real parent deposits, and once as a worthless look-alike that anyone
/// can deploy and mint for free. Nothing on-chain distinguishes the two except the address.
contract F36_LabelledToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
