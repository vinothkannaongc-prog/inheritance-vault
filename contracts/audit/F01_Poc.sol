// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F01, carried over from the
// audit PoC sandbox poc/F01/contracts/test/PocF01.sol. Contracts renamed F01_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev F01 PoC. A double-entry-point token modelled on TrueUSD's legacy forwarder (the case that
 * hit Compound's sweepToken in 2022) and Synthetix Proxy/ProxyERC20: ONE ledger, TWO live token
 * addresses. This is the primary entry point (address A). It is a normal OpenZeppelin ERC20 and
 * additionally accepts delegated calls from its registered secondary entry point.
 */
contract F01_DualEntryPrimary is ERC20 {
    address public secondary;

    constructor() ERC20("Dual Entry", "DUAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setSecondary(address s) external {
        require(secondary == address(0), "set");
        secondary = s;
    }

    /// @dev Same shape as TUSD's delegateTransfer(to, value, origSender).
    function delegateTransfer(address to, uint256 value, address origSender) external returns (bool) {
        require(msg.sender == secondary, "only secondary");
        _transfer(origSender, to, value);
        return true;
    }

    function delegateApprove(address spender, uint256 value, address origSender) external returns (bool) {
        require(msg.sender == secondary, "only secondary");
        _approve(origSender, spender, value);
        return true;
    }

    function delegateTransferFrom(address from, address to, uint256 value, address origSender)
        external
        returns (bool)
    {
        require(msg.sender == secondary, "only secondary");
        _spendAllowance(from, origSender, value);
        _transfer(from, to, value);
        return true;
    }
}

/// @dev The secondary entry point (address B). Holds no ledger of its own: every read and write
/// is forwarded to the primary's ledger, exactly like the legacy TUSD contract.
contract F01_DualEntrySecondary {
    F01_DualEntryPrimary public immutable primary;

    constructor(F01_DualEntryPrimary p) {
        primary = p;
    }

    function name() external view returns (string memory) {
        return primary.name();
    }

    function symbol() external view returns (string memory) {
        return primary.symbol();
    }

    function decimals() external view returns (uint8) {
        return primary.decimals();
    }

    function totalSupply() external view returns (uint256) {
        return primary.totalSupply();
    }

    function balanceOf(address a) external view returns (uint256) {
        return primary.balanceOf(a);
    }

    function allowance(address o, address s) external view returns (uint256) {
        return primary.allowance(o, s);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return primary.delegateTransfer(to, value, msg.sender);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        return primary.delegateApprove(spender, value, msg.sender);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        return primary.delegateTransferFrom(from, to, value, msg.sender);
    }
}

/**
 * @dev Native-coin ERC20 facade (Celo GoldToken "token duality", Moonbeam's native-balance ERC20
 * precompile). On those chains balanceOf(a) IS a.balance and transfer() moves native coin out of
 * the caller. Plain EVM code cannot debit another account's native balance, so this mock reports
 * the native balance truthfully and RECORDS the transfer request the vault makes; on the real
 * chains that request moves the native coin.
 */
contract F01_NativeFacadeMock {
    address public lastTo;
    uint256 public lastAmount;
    address public lastCaller;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function balanceOf(address a) external view returns (uint256) {
        return a.balance;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        lastCaller = msg.sender;
        lastTo = to;
        lastAmount = value;
        return true;
    }
}
