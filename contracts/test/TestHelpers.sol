// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain mintable token for tests.
contract MintableToken is ERC20 {
    constructor() ERC20("Test Token", "TST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% on every real transfer, so the vault's received-amount measurement is exercised.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Refuses native transfers, to prove a hostile payout target cannot corrupt the credit lane.
contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

interface IVaultLike {
    function createVault(
        address token,
        uint256 amount,
        address beneficiary,
        uint32 inactivityPeriod,
        uint32 challengeWindow,
        uint64 absoluteDeadline
    ) external payable returns (uint256);
    function withdraw(uint256 vaultId, uint256 amount, address to) external;
    function initiateClaim(address vaultOwner, uint256 vaultId, address recipient) external;
}

/**
 * @dev A token with an ERC777-style callback on receipt, used to prove the contract is safe
 * against cross-function reentrancy during the deposit measurement in _pull(). The token is
 * itself a vault owner, which is what lets its hook call owner-only functions.
 * mode: 0 none, 1 re-enter withdraw, 2 re-enter initiateClaim.
 */
contract ReentrantToken is ERC20 {
    address public vault;
    uint8 public mode;
    uint256 public reenterAmount;
    address public sink;
    bool public fired;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setVault(address v) external {
        vault = v;
    }

    function arm(uint8 m, uint256 amount, address s) external {
        mode = m;
        reenterAmount = amount;
        sink = s;
        fired = false;
    }

    function openVault(address heir, uint32 period, uint32 window, uint64 horizon, uint256 amount)
        external
        returns (uint256)
    {
        _approve(address(this), vault, type(uint256).max);
        return IVaultLike(vault).createVault(address(this), amount, heir, period, window, horizon);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // Fire only on an inbound transfer that is not our own deposit, so openVault() is clean.
        if (mode != 0 && !fired && to == vault && from != address(this)) {
            fired = true;
            if (mode == 1) IVaultLike(vault).withdraw(0, reenterAmount, sink);
            else if (mode == 2) IVaultLike(vault).initiateClaim(address(this), 0, sink);
        }
    }
}
