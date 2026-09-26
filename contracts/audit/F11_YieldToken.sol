// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F11, carried over from the
// audit PoC sandbox poc/F11/contracts/test/PocF11YieldToken.sol. Contracts renamed F11_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

/**
 * @dev PoC for audit finding F11. A share-accounted ERC20 that models the two balance-increasing
 * token families a user can deposit through the app's "any ERC-20 address" field:
 *
 *  - accrue(bps): positive rebase / interest-bearing (Aave aToken such as aBasUSDC, stETH-style).
 *    totalSupply grows, shares do not, so every holder's balanceOf grows pro rata WITHOUT any
 *    transfer to them.
 *  - reflectionFeeBps: RFI-style reflection token (common on BNB Chain). A fee is taken from every
 *    transfer and its shares are destroyed, so every OTHER holder's balanceOf grows by its slice
 *    of the fee -- including a holder (the vault) that took no part in the transfer.
 *
 * balanceOf(a) = sharesOf[a] * totalSupply / totalShares.
 */
contract F11_YieldToken {
    string public constant name = "PoC Yield Token";
    string public constant symbol = "PYLD";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    uint256 public totalShares;
    uint16 public reflectionFeeBps;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function balanceOf(address account) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return (sharesOf[account] * totalSupply) / totalShares;
    }

    function mint(address to, uint256 amount) external {
        uint256 shares = totalShares == 0 ? amount : (amount * totalShares) / totalSupply;
        sharesOf[to] += shares;
        totalShares += shares;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @dev Positive rebase: interest of `bps` on the whole supply, credited to every holder.
    function accrue(uint256 bps) external {
        totalSupply += (totalSupply * bps) / 10_000;
    }

    function setReflectionFee(uint16 bps) external {
        reflectionFeeBps = bps;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        uint256 shares = (value * totalShares) / totalSupply;
        require(sharesOf[from] >= shares, "balance");
        uint256 feeShares = (shares * reflectionFeeBps) / 10_000;
        sharesOf[from] -= shares;
        sharesOf[to] += shares - feeShares;
        // Reflection: the fee's shares are destroyed, so every remaining holder's slice of the
        // unchanged totalSupply grows.
        totalShares -= feeShares;
        emit Transfer(from, to, value);
    }
}
