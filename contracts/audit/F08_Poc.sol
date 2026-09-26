// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F08, carried over from the
// audit PoC sandbox poc/F08/contracts/test/PocF08.sol. Contracts renamed F08_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Models Tether's TetherToken blocklist semantics: `transfer` checks only msg.sender,
 * `transferFrom` checks only `from`. RECEIVING is never blocked, and the issuer can burn a
 * blocklisted balance (TetherToken.destroyBlackFunds).
 */
contract F08_SenderOnlyBlocklistToken is ERC20 {
    address public immutable issuer;
    mapping(address => bool) public isBlackListed;

    constructor() ERC20("Tether-like", "USDTL") {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        require(msg.sender == issuer, "not issuer");
        _;
    }

    function mint(address to, uint256 amount) external onlyIssuer {
        _mint(to, amount);
    }

    function addBlackList(address a) external onlyIssuer {
        isBlackListed[a] = true;
    }

    function destroyBlackFunds(address a) external onlyIssuer {
        require(isBlackListed[a], "not blacklisted");
        _burn(a, balanceOf(a));
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        require(!isBlackListed[msg.sender], "blacklisted");
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        require(!isBlackListed[from], "blacklisted");
        return super.transferFrom(from, to, value);
    }
}

interface F08_IVault {
    function finalizeClaim(address vaultOwner, uint256 vaultId) external;
    function pushCredit(address token, address account) external returns (uint256);
    function withdrawCredit(address token, address to) external returns (uint256);
}

/// @dev Mallory's helper: settle and push in ONE transaction, so the credited account never has a
/// block in which its credit exists and it could route it elsewhere.
contract F08_FinalizeAndPush {
    function run(address vault, address vaultOwner, uint256 vaultId, address token, address account) external {
        F08_IVault(vault).finalizeClaim(vaultOwner, vaultId);
        F08_IVault(vault).pushCredit(token, account);
    }
}

/// @dev A contract "able to make one call" (NatSpec :69-70): it can call withdrawCredit and route
/// the payout anywhere, but has no function that moves an ERC20 it holds.
contract F08_CreditForwarder {
    address public immutable controller;
    address public immutable vault;

    constructor(address c, address v) {
        controller = c;
        vault = v;
    }

    receive() external payable {}

    function pull(address token, address to) external returns (uint256) {
        require(msg.sender == controller, "not controller");
        return F08_IVault(vault).withdrawCredit(token, to);
    }
}
