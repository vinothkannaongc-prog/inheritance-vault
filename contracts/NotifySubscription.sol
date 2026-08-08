// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title NotifySubscription
 * @notice Crypto-native billing for the Will & Key reminder service. Pay in the chain's native
 *         coin; time is credited pro-rata against the current monthly price and recorded as
 *         `paidUntil[account]`. The off-chain watcher reads that value and nothing else.
 *
 * Deliberately boring, and the boredom is the point:
 *   - Paying is permissionless and giftable: anyone can extend anyone's subscription. An heir
 *     topping up a forgetful parent's reminders is a feature, not fraud.
 *   - Time already purchased can never be revoked or repriced. A price change moves the meter
 *     for FUTURE purchases only.
 *   - No refunds, no pause, no per-account state beyond one timestamp. The watcher, not this
 *     contract, decides what a subscription is worth (which alerts, how many vaults).
 *   - Unlike the vault, revenue here is MEANT to be withdrawable by the operator. That is the
 *     entire difference in trust model between this contract and InheritanceVault, and it is
 *     why your inheritance never touches this contract.
 */
contract NotifySubscription is Ownable2Step {
    uint256 public constant MONTH = 30 days;
    /// @dev Prepayment cap. Protects a fat-fingered payer from locking a lifetime of funds
    /// into a service decision they can never revisit; ten years is commitment enough.
    uint256 public constant MAX_PREPAID = 3650 days;

    uint256 public pricePerMonth; // wei per 30 days, for future purchases only
    mapping(address => uint64) public paidUntil;

    event Subscribed(address indexed account, address indexed payer, uint256 amount, uint64 newPaidUntil);
    event PriceChanged(uint256 oldPrice, uint256 newPrice);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error PriceIsZero();
    error TooFarAhead(uint256 maximum);
    error NothingToWithdraw();
    error NativeTransferFailed(address to, uint256 amount);
    error RenounceDisabled();

    constructor(address admin, uint256 initialPricePerMonth) Ownable(admin) {
        if (initialPricePerMonth == 0) revert PriceIsZero();
        pricePerMonth = initialPricePerMonth;
    }

    /// @notice Extend `account`'s subscription by whatever `msg.value` buys at today's price.
    /// Extension is from the later of now and the current expiry, so early renewal loses nothing.
    function subscribe(address account) external payable {
        if (account == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        uint256 added = (msg.value * MONTH) / pricePerMonth;
        if (added == 0) revert ZeroAmount(); // dust that buys less than one second

        uint256 current = paidUntil[account];
        uint256 base = current > block.timestamp ? current : block.timestamp;
        uint256 target = base + added;
        uint256 cap = block.timestamp + MAX_PREPAID;
        if (target > cap) revert TooFarAhead(cap);

        paidUntil[account] = uint64(target);
        emit Subscribed(account, msg.sender, msg.value, uint64(target));
    }

    function isActive(address account) external view returns (bool) {
        return paidUntil[account] >= block.timestamp;
    }

    // ------------------------------------------------------------------ admin

    function setPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert PriceIsZero();
        emit PriceChanged(pricePerMonth, newPrice);
        pricePerMonth = newPrice;
    }

    /// @dev Revenue withdrawal. This is the one contract in the suite where the admin taking
    /// the balance is correct behavior — it holds subscription fees, never custody.
    function withdraw(address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();
        emit Withdrawn(to, amount);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }

    /// @dev Disabled: renouncing would strand all future revenue forever. Use transferOwnership.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
