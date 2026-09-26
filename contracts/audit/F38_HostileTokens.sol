// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F38, carried over from the
// audit PoC sandbox poc/F38/contracts/test/F38HostileTokens.sol. Contracts renamed F38_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev F38 PoC. Returns false from transfer() instead of reverting once armed, and moves nothing.
/// transferFrom stays honest, so deposits work and only the payout path meets the hostile branch.
contract F38_FalseReturnToken is ERC20 {
    bool public failTransfers;

    constructor() ERC20("False Token", "FALSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, value);
    }
}

/// @dev F38 PoC. USDT (Ethereum) style: transfer / transferFrom / approve return NOTHING.
/// Reverts on real failure, so it is an honest token with a non-standard ABI.
contract F38_NoBoolToken {
    string public constant name = "No Bool";
    string public constant symbol = "NOB";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(balanceOf[from] >= value, "balance");
        require(allowance[from][msg.sender] >= value, "allowance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}
