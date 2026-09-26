// SPDX-License-Identifier: MIT
// v1 evidence suite (audit/2026-09-preliminary): mock for finding F12, carried over from the
// audit PoC sandbox poc/F12/contracts/test/PocF12Tokens.sol. Contracts renamed F12_* so no artifact
// name collides with another PoC or the main suite; logic unchanged.
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev PoC F12 only. An issuer-controlled stablecoin modelled on Circle's FiatToken (USDC on
 * Base): the issuer can blocklist any address and pause all transfers. The blocklist checks
 * mirror FiatToken v2.2 exactly:
 *   transfer      whenNotPaused notBlacklisted(msg.sender) notBlacklisted(to)
 *   transferFrom  whenNotPaused notBlacklisted(msg.sender) notBlacklisted(from) notBlacklisted(to)
 *   approve       whenNotPaused notBlacklisted(msg.sender) notBlacklisted(spender)
 * balanceOf is never gated. It also carries a Tether-style wipe (USDT's destroyBlackFunds),
 * the power FiatToken's issuer can add at any time because FiatToken is an upgradeable proxy.
 */
contract F12_IssuerControlledToken is ERC20 {
    address public immutable issuer;
    bool public paused;
    mapping(address => bool) public isBlacklisted;

    constructor() ERC20("Issuer USD", "iUSD") {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        require(msg.sender == issuer, "not issuer");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    modifier notBlacklisted(address a) {
        require(!isBlacklisted[a], "Blacklistable: account is blacklisted");
        _;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyIssuer {
        _mint(to, amount);
    }

    function blacklist(address a) external onlyIssuer {
        isBlacklisted[a] = true;
    }

    function unBlacklist(address a) external onlyIssuer {
        isBlacklisted[a] = false;
    }

    function pause() external onlyIssuer {
        paused = true;
    }

    function unpause() external onlyIssuer {
        paused = false;
    }

    /// @dev USDT-style: only a blocklisted holder can be wiped, and the balance is burned.
    function destroyBlackFunds(address a) external onlyIssuer {
        require(isBlacklisted[a], "not blacklisted");
        _burn(a, balanceOf(a));
    }

    function transfer(address to, uint256 value)
        public
        override
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        return super.transferFrom(from, to, value);
    }

    function approve(address spender, uint256 value)
        public
        override
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(spender)
        returns (bool)
    {
        return super.approve(spender, value);
    }
}
