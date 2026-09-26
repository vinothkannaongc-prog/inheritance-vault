// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F04, carried over from the
// audit PoC sandbox poc/F04/contracts/test/PocF04Tokens.sol. Contracts renamed F04_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev F04 PoC only. Anti-whale token (common BNB Chain pattern): any single non-mint transfer
/// above `maxTx` reverts. The cap is immutable, i.e. the "ownership renounced" case where nobody
/// can ever lift it. Nothing else about the token is unusual: no fee, no rebase, no hooks.
contract F04_PocMaxTxToken is ERC20 {
    uint256 public immutable maxTx;

    constructor(uint256 cap) ERC20("Capped", "CAP") {
        maxTx = cap;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) require(value <= maxTx, "maxTx");
        super._update(from, to, value);
    }
}
