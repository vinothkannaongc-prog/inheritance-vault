// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F33, carried over from the
// audit PoC sandbox poc/F33/contracts/test/F33Helpers.sol. Contracts renamed F33_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface F33_IObserver {
    function observe() external;
}

/**
 * @dev PoC for F33. An ERC20 that calls an external observer while a transfer involving the
 * vault is in flight.
 *   mode 1: AFTER the balances are updated, on a transfer INTO the vault (deposit path).
 *   mode 2: BEFORE the balances are updated, on a transfer OUT of the vault (payout path).
 */
contract F33_HookToken is ERC20 {
    address public vault;
    address public observer;
    uint8 public mode;

    constructor() ERC20("Hook Token", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setup(address v, address o, uint8 m) external {
        vault = v;
        observer = o;
        mode = m;
    }

    function _update(address from, address to, uint256 value) internal override {
        bool live = vault != address(0) && observer != address(0);
        if (live && mode == 2 && from == vault && to != address(0)) F33_IObserver(observer).observe();
        super._update(from, to, value);
        if (live && mode == 1 && to == vault && from != address(0)) F33_IObserver(observer).observe();
    }
}

/**
 * @dev A third-party integrator (dashboard / proof-of-reserve / wrapper) that reads the vault's
 * public views from inside the token callback. Every read is a low-level call whose success is
 * recorded, so a guarded view (nonReentrantView) is observed as "refused" rather than bubbling a
 * revert up through the deposit.
 */
contract F33_ViewObserver {
    address public vault;
    address public token;
    address public vaultOwner;
    uint256 public vaultId;
    bool public watchVault;
    bool public trySweep;
    bool public armed;
    bool public fired;

    bool public surplusOk;
    uint256 public seenSurplus;
    bool public lockedOk;
    uint256 public seenLocked;
    bool public creditedOk;
    uint256 public seenCredited;
    uint256 public seenTokenBalance;
    bool public getVaultOk;
    bytes public getVaultRet;
    bool public sweepAttempted;
    bool public sweepOk;
    bytes public sweepRet;

    function arm(
        address v,
        address t,
        address owner_,
        uint256 id,
        bool watchVault_,
        bool trySweep_
    ) external {
        vault = v;
        token = t;
        vaultOwner = owner_;
        vaultId = id;
        watchVault = watchVault_;
        trySweep = trySweep_;
        armed = true;
        fired = false;
    }

    function disarm() external {
        armed = false;
    }

    function observe() external {
        if (!armed || fired) return;
        fired = true;

        (bool ok, bytes memory r) = vault.staticcall(abi.encodeWithSignature("surplus(address)", token));
        surplusOk = ok;
        if (ok) seenSurplus = abi.decode(r, (uint256));

        (ok, r) = vault.staticcall(abi.encodeWithSignature("totalLocked(address)", token));
        lockedOk = ok;
        if (ok) seenLocked = abi.decode(r, (uint256));

        (ok, r) = vault.staticcall(abi.encodeWithSignature("totalCredited(address)", token));
        creditedOk = ok;
        if (ok) seenCredited = abi.decode(r, (uint256));

        (ok, r) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", vault));
        if (ok) seenTokenBalance = abi.decode(r, (uint256));

        if (watchVault) {
            (ok, r) = vault.staticcall(
                abi.encodeWithSignature("getVault(address,uint256)", vaultOwner, vaultId)
            );
            getVaultOk = ok;
            getVaultRet = r;
        }

        if (trySweep) {
            sweepAttempted = true;
            (ok, r) = vault.call(abi.encodeWithSignature("sweepSurplus(address,address)", token, address(this)));
            sweepOk = ok;
            sweepRet = r;
        }
    }
}
