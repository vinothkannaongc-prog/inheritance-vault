// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F29, carried over from the
// audit PoC sandbox poc/F29/contracts/test/F29Mocks.sol. Contracts renamed F29_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

/// @dev Minimal positive-rebasing ERC20 (stETH-style): balances are shares * index. A rebase
/// raises every holder's balance without any transfer. Used only to show that the homepage's
/// "any ERC-20" invitation covers a token class the contract itself declares unsupported.
contract F29_RebasingToken {
    string public constant name = "Rebasing";
    string public constant symbol = "RBS";
    uint8 public constant decimals = 18;

    uint256 public index = 1e18;
    uint256 internal _totalShares;
    mapping(address => uint256) internal _shares;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256) {
        return (_totalShares * index) / 1e18;
    }

    function balanceOf(address a) public view returns (uint256) {
        return (_shares[a] * index) / 1e18;
    }

    function mint(address to, uint256 amount) external {
        uint256 s = (amount * 1e18) / index;
        _shares[to] += s;
        _totalShares += s;
        emit Transfer(address(0), to, amount);
    }

    /// @param bps positive rebase in basis points (1000 = +10%)
    function rebase(uint256 bps) external {
        index = (index * (10_000 + bps)) / 10_000;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 s = (amount * 1e18) / index;
        require(_shares[from] >= s, "balance");
        _shares[from] -= s;
        _shares[to] += s;
        emit Transfer(from, to, amount);
    }
}
