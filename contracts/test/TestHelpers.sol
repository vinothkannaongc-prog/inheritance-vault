// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

// ============================================================================================
// Hostile-token mocks for the 2026-09 preliminary-audit regressions (test/AuditPrelim2026-09.ts).
// Names are distinct from the v1 evidence suite's F0x_* mocks in contracts/audit/, so no
// artifact name is ambiguous.
// ============================================================================================

/**
 * @dev F01. One ledger, two token addresses: the primary entry (this contract) plus a forwarder
 * that reads and writes the same ledger, the shape of TrueUSD's legacy entry point and of
 * Synthetix Proxy/ProxyERC20.
 */
contract DoubleEntryToken is ERC20 {
    address public forwarder;

    constructor() ERC20("Double Entry", "DBL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setForwarder(address f) external {
        require(forwarder == address(0), "set");
        forwarder = f;
    }

    function forwardTransfer(address from, address to, uint256 value) external returns (bool) {
        require(msg.sender == forwarder, "only forwarder");
        _transfer(from, to, value);
        return true;
    }

    function forwardTransferFrom(address spender, address from, address to, uint256 value)
        external
        returns (bool)
    {
        require(msg.sender == forwarder, "only forwarder");
        _spendAllowance(from, spender, value);
        _transfer(from, to, value);
        return true;
    }

    function forwardApprove(address owner, address spender, uint256 value) external returns (bool) {
        require(msg.sender == forwarder, "only forwarder");
        _approve(owner, spender, value);
        return true;
    }
}

/// @dev F01. The second address of DoubleEntryToken's ledger. Holds no balances of its own.
contract DoubleEntryForwarder {
    DoubleEntryToken public immutable primary;

    constructor(DoubleEntryToken p) {
        primary = p;
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
        return primary.forwardTransfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        return primary.forwardTransferFrom(msg.sender, from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        return primary.forwardApprove(msg.sender, spender, value);
    }
}

/**
 * @dev F01. An ERC20 facade over the native coin (Celo GoldToken, Moonbeam's native ERC20
 * precompile): balanceOf(a) IS a.balance. Plain EVM code cannot debit another account's native
 * balance, so transfer() records what it was asked to move; on those chains the call moves it.
 */
contract NativeFacadeRecorder {
    address public lastTo;
    uint256 public lastAmount;

    function balanceOf(address a) external view returns (uint256) {
        return a.balance;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        lastTo = to;
        lastAmount = value;
        return true;
    }
}

/**
 * @dev F09. WETH9's one relevant behaviour: a plain native transfer runs deposit(), which mints
 * the wrapped token to msg.sender. When the vault pays it, msg.sender is the vault.
 */
contract WrappedNativeMock is ERC20 {
    constructor() ERC20("Wrapped Native", "WNAT") {}

    receive() external payable {
        _mint(msg.sender, msg.value);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @dev F10. Fee charged ON TOP: the sender is debited value + 1%, the recipient gets value.
/// (Contrast FeeOnTransferToken above, which debits the sender exactly value.)
contract FeeOnTopToken is ERC20 {
    constructor() ERC20("Fee On Top", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            if (fee != 0) super._update(from, address(0), fee);
        }
    }
}

/**
 * @dev F42. Something else moves the vault's balance while a deposit is in flight: a pool-wide
 * rebase triggered by the transfer, a settle-on-touch reward, a hook-injected third-party
 * payment. arm(target, delta): on the next transfer INTO target from a real sender, `delta` is
 * minted to (delta > 0) or burned from (delta < 0) target after the transfer has moved.
 */
contract DepositWindowToken is ERC20 {
    address public target;
    int256 public delta;

    constructor() ERC20("Deposit Window", "DWT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, int256 delta_) external {
        target = target_;
        delta = delta_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0) && to == target && delta != 0) {
            int256 d = delta;
            delta = 0;
            if (d > 0) super._update(address(0), to, uint256(d));
            else super._update(to, address(0), uint256(-d));
        }
    }
}

interface IVaultViews {
    function surplus(address token) external view returns (uint256);
    function creditOf(address token, address account) external view returns (uint256);
    function totalLocked(address token) external view returns (uint256);
    function totalCredited(address token) external view returns (uint256);
}

/**
 * @dev F33. A token that, right after a transfer INTO the vault has moved balances (inside the
 * deposit measurement window), lets an integrator read the vault's views. Each read is a
 * low-level staticcall whose success and revert selector are recorded, so a guarded view shows
 * up as "refused" instead of bubbling up through the deposit.
 * Review round 1 added the two lane getters, totalLocked and totalCredited: read next to the
 * vault's balance (seenBalance) they are a proof-of-reserve's surplus, and mid-deposit that is a
 * phantom equal to the in-flight deposit.
 */
contract ViewProbeToken is ERC20 {
    address public vault;
    address public vaultOwner;
    bool public armed;

    bool public surplusOk;
    uint256 public seenSurplus;
    bool public getVaultOk;
    bool public openVaultsOk;
    bool public creditOfOk;
    bytes4 public surplusError;
    bytes4 public getVaultError;
    bytes4 public openVaultsError;
    bytes4 public creditOfError;
    bool public lockedOk;
    bool public creditedOk;
    bytes4 public lockedError;
    bytes4 public creditedError;
    uint256 public seenLocked;
    uint256 public seenCredited;
    uint256 public seenBalance;

    constructor() ERC20("View Probe", "PRB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address vault_, address vaultOwner_) external {
        vault = vault_;
        vaultOwner = vaultOwner_;
        armed = true;
    }

    function _selector(bytes memory ret) private pure returns (bytes4 s) {
        if (ret.length >= 4) s = bytes4(ret);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to == vault) {
            armed = false;
            bytes memory ret;
            (surplusOk, ret) = vault.staticcall(abi.encodeCall(IVaultViews.surplus, (address(this))));
            if (surplusOk) seenSurplus = abi.decode(ret, (uint256));
            else surplusError = _selector(ret);
            (getVaultOk, ret) =
                vault.staticcall(abi.encodeWithSignature("getVault(address,uint256)", vaultOwner, uint256(0)));
            if (!getVaultOk) getVaultError = _selector(ret);
            (openVaultsOk, ret) = vault.staticcall(abi.encodeWithSignature("getOpenVaults(address)", vaultOwner));
            if (!openVaultsOk) openVaultsError = _selector(ret);
            (creditOfOk, ret) = vault.staticcall(abi.encodeCall(IVaultViews.creditOf, (address(this), vaultOwner)));
            if (!creditOfOk) creditOfError = _selector(ret);
            (lockedOk, ret) = vault.staticcall(abi.encodeCall(IVaultViews.totalLocked, (address(this))));
            if (lockedOk) seenLocked = abi.decode(ret, (uint256));
            else lockedError = _selector(ret);
            (creditedOk, ret) = vault.staticcall(abi.encodeCall(IVaultViews.totalCredited, (address(this))));
            if (creditedOk) seenCredited = abi.decode(ret, (uint256));
            else creditedError = _selector(ret);
            seenBalance = balanceOf(vault);
        }
    }
}

/// @dev F33. A payout recipient whose receive() reads the vault's creditOf view.
contract ViewReadingReceiver {
    address public immutable vault;
    uint256 public seenCredit;

    constructor(address vault_) {
        vault = vault_;
    }

    receive() external payable {
        seenCredit = IVaultViews(vault).creditOf(address(0), address(this));
    }
}

// ============================================================================================
// Pass 2 (credits, claims and fees) mocks for test/AuditPrelim2026-09.ts.
// ============================================================================================

/// @dev F04. Anti-whale token, a common BNB Chain pattern: any single non-mint transfer above
/// `maxTx` reverts. The cap is immutable -- the "ownership renounced" case, where nobody can ever
/// lift it. Nothing else is unusual: no fee, no rebase, no hooks.
contract MaxTxToken is ERC20 {
    uint256 public immutable maxTx;

    constructor(uint256 cap) ERC20("Capped", "CAP") {
        maxTx = cap;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) require(value <= maxTx, "maxTx");
        super._update(from, to, value);
    }
}

/**
 * @dev F08. TetherToken's blocklist semantics: `transfer` checks only msg.sender and
 * `transferFrom` only `from`, so RECEIVING is never blocked; the issuer (the deployer) can burn
 * a blocklisted balance (TetherToken.destroyBlackFunds).
 */
contract SenderBlocklistToken is ERC20 {
    address public immutable issuer;
    mapping(address => bool) public isBlackListed;

    constructor() ERC20("Tether-like", "USDTL") {
        issuer = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function addBlackList(address a) external {
        require(msg.sender == issuer, "not issuer");
        isBlackListed[a] = true;
    }

    function destroyBlackFunds(address a) external {
        require(msg.sender == issuer, "not issuer");
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

interface IVaultCreditLane {
    function finalizeClaim(address vaultOwner, uint256 vaultId) external;
    function pushCredit(address token, address account) external returns (uint256);
    function withdrawCredit(address token, address to) external returns (uint256);
}

/// @dev F08. A griefer's helper: settle and push in ONE transaction, so the credited account never
/// has a block in which its credit exists and could be routed elsewhere.
contract SettleAndPush {
    function run(address vault, address vaultOwner, uint256 vaultId, address token, address account) external {
        IVaultCreditLane(vault).finalizeClaim(vaultOwner, vaultId);
        IVaultCreditLane(vault).pushCredit(token, account);
    }
}

/// @dev F08. A contract "able to make one call": it can call withdrawCredit and route the payout
/// anywhere, but has no function that moves an ERC20 it holds.
contract CallOnlyForwarder {
    address public immutable controller;
    address public immutable vault;

    constructor(address c, address v) {
        controller = c;
        vault = v;
    }

    receive() external payable {}

    function pull(address token, address to) external returns (uint256) {
        require(msg.sender == controller, "not controller");
        return IVaultCreditLane(vault).withdrawCredit(token, to);
    }
}

/// @dev F26. Logs when it receives native coin, so a test can see where a payout sits among the
/// vault's own logs.
contract LoggingReceiver {
    event Received(uint256 amount);

    receive() external payable {
        emit Received(msg.value);
    }
}

// ============================================================================================
// Pass 4 (F38) hostile-token matrix for test/AuditPrelim2026-09.ts. Classes already covered by
// the mocks above: fee on transfer (FeeOnTransferToken), fee on top (FeeOnTopToken), double entry
// (DoubleEntryToken/DoubleEntryForwarder), transfer cap (MaxTxToken), sender-only blocklist
// (SenderBlocklistToken).
// ============================================================================================

/**
 * @dev F38. A positive-rebasing token (stETH/AMPL style): the internal ledger holds shares, and
 * a balance is shares times an index the issuer raises, so every holder's balance grows with no
 * transfer. Rounding is irrelevant here: the vault must refuse the token outright.
 */
contract RebasingToken is ERC20 {
    uint256 public index = 1e18;

    constructor() ERC20("Rebasing", "REB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Raises every balance by `bps` basis points.
    function rebase(uint256 bps) external {
        index += (index * bps) / 10_000;
    }

    function balanceOf(address a) public view override returns (uint256) {
        return (super.balanceOf(a) * index) / 1e18;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, (value * 1e18) / index);
    }
}

/// @dev F38. The ERC777 hook interface, reduced to what the mock needs.
interface IHookImplementer {
    function tokensToSend(address from, address to, uint256 amount) external;
    function tokensReceived(address from, address to, uint256 amount) external;
}

/**
 * @dev F38. An ERC777-style token: a holder registers a hook implementer (ERC1820 in the real
 * standard) that runs BEFORE its balance is debited (tokensToSend) and AFTER a credit
 * (tokensReceived), so the sender of a deposit gets control in the middle of transferFrom.
 *
 * Review round 1: setTripwire(true) makes balanceOf and transferFrom revert TokenCalled(), so a
 * test can see whether the vault called the token at all. A revert rolls back every state
 * change made inside it, hookCalls included, so reading state after a refused deposit cannot
 * tell "refused before calling the token" from "refused after it"; which error the call
 * reverted with can.
 */
contract HookToken is ERC20 {
    mapping(address => address) public hookOf;
    uint256 public hookCalls;
    bool public tripwire;

    error TokenCalled();

    constructor() ERC20("Hooked", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address implementer) external {
        hookOf[msg.sender] = implementer;
    }

    function setTripwire(bool on) external {
        tripwire = on;
    }

    function balanceOf(address a) public view override returns (uint256) {
        if (tripwire) revert TokenCalled();
        return super.balanceOf(a);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (tripwire) revert TokenCalled();
        return super.transferFrom(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        address h = from == address(0) ? address(0) : hookOf[from];
        if (h != address(0)) {
            hookCalls += 1;
            IHookImplementer(h).tokensToSend(from, to, value);
        }
        super._update(from, to, value);
        h = to == address(0) ? address(0) : hookOf[to];
        if (h != address(0)) {
            hookCalls += 1;
            IHookImplementer(h).tokensReceived(from, to, value);
        }
    }
}

/**
 * @dev F38. A vault owner that is its own ERC777 hook: when its deposit is debited, tokensToSend
 * tries to re-enter the vault with a second createVault, and records whether that got through.
 */
contract HookDepositor is IHookImplementer {
    address public immutable vault;
    HookToken public immutable token;
    bool public armed;
    bool public reentered;
    bytes4 public reentryError;

    constructor(address vault_, HookToken token_) {
        vault = vault_;
        token = token_;
        token_.setHook(address(this));
        token_.approve(vault_, type(uint256).max);
    }

    function deposit(address heir, uint32 period, uint32 window, uint64 horizon, uint256 amount, bool reenter)
        external
        returns (uint256)
    {
        armed = reenter;
        return IVaultLike(vault).createVault(address(token), amount, heir, period, window, horizon);
    }

    function tokensToSend(address, address, uint256 amount) external {
        if (!armed) return;
        armed = false;
        (bool ok, bytes memory ret) = vault.call(
            abi.encodeCall(
                IVaultLike.createVault,
                (address(token), amount, address(0xBEEF), 7 days, 7 days, uint64(block.timestamp + 3650 days))
            )
        );
        reentered = ok;
        if (!ok && ret.length >= 4) reentryError = bytes4(ret);
    }

    function tokensReceived(address, address, uint256) external {}
}

/**
 * @dev F38. A token whose OUTBOUND `transfer` misbehaves once switched (transferFrom stays honest,
 * so deposits work and only payouts meet it): 0 honest; 1 returns false and moves nothing; 2
 * returns true and moves nothing; 3 returns true and moves only half; 4 (review round 3) returns
 * true, moves nothing and credits the sender one unit, so the sender's balance RISES across the
 * transfer (a reward settled on touch). Review round 4: 5 moves `value` and burns one more unit
 * from the sender, and 6 moves one unit less than `value`; each returns true. So a payout is off
 * by a single unit, over or short, which no tolerance in the exact-debit rule can hide.
 */
contract FalseReturnToken is ERC20 {
    uint8 public mode;

    constructor() ERC20("False Return", "FALSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) return true;
        if (mode == 3) {
            _transfer(msg.sender, to, value / 2);
            return true;
        }
        if (mode == 4) {
            _mint(msg.sender, 1);
            return true;
        }
        if (mode == 5) {
            _transfer(msg.sender, to, value);
            _burn(msg.sender, 1);
            return true;
        }
        if (mode == 6) {
            _transfer(msg.sender, to, value - 1);
            return true;
        }
        return super.transfer(to, value);
    }
}

/**
 * @dev F38. USDC-style blocklist: the issuer can block any address, and a blocked address can
 * neither send, receive nor move tokens as a spender.
 */
contract BlocklistToken is ERC20 {
    address public immutable issuer;
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocklist Coin", "BLK") {
        issuer = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address a, bool b) external {
        require(msg.sender == issuer, "not issuer");
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            require(!blocked[from] && !blocked[to] && !blocked[msg.sender], "blocked");
        }
        super._update(from, to, value);
    }
}

// ============================================================================================
// Review round 1 mocks for test/AuditPrelim2026-09.ts.
// ============================================================================================

interface IWrappedNativeLike {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @dev F09 (review round 1). Not the chain's wrappedNative itself: a helper contract that wraps
 * whatever native coin it is sent and returns the wrapped token to the SENDER (a wrap-and-refund
 * or swap-on-receive pattern). When the vault pays it, the sender is the vault, so an heir's
 * payout would come back as wrapped tokens outside every lane.
 */
contract WrapAndReturnGateway {
    IWrappedNativeLike public immutable wrapped;

    constructor(address wrapped_) {
        wrapped = IWrappedNativeLike(wrapped_);
    }

    receive() external payable {
        wrapped.deposit{value: msg.value}();
        wrapped.transfer(msg.sender, msg.value);
    }
}

/**
 * @dev F09 (review round 1). Bounces native coin back to the sender with SELFDESTRUCT. Under
 * Cancun the balance moves and the code stays, and the vault's receive() never runs, so the
 * coin lands in native surplus.
 */
contract SelfdestructBouncer {
    receive() external payable {
        selfdestruct(payable(msg.sender));
    }
}

/**
 * @dev F38 (review round 1). USDT-on-Ethereum style: transfer, transferFrom and approve return
 * NOTHING, so a caller that decodes a bool reverts on every call. Also pausable by its issuer,
 * which freezes every transfer (the pooled issuer risk).
 */
contract NoBoolPausableToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public immutable issuer;
    bool public paused;

    constructor() {
        issuer = msg.sender;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setPaused(bool p) external {
        require(msg.sender == issuer, "not issuer");
        paused = p;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transfer(address to, uint256 value) external {
        require(!paused, "paused");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(!paused, "paused");
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

// ============================================================================================
// Review round 2.

/**
 * @dev A LISTED token whose issuer changes only how balanceOf answers, standing in for an
 * upgrade of a proxy token (Base USDC, EURC and cbBTC and BNB USDC are upgradeable). Transfers
 * are untouched: the question is what a misbehaving balanceOf does to NATIVE payouts, which
 * measure every listed token when the payee has code.
 *   mode 0  normal
 *   mode 1  balanceOf reverts
 *   mode 2  balanceOf burns all the gas it is given
 *   mode 3  balanceOf returns a returndata bomb, sized to the gas it was given
 *   mode 4  balanceOf answers differently on every read (the true balance plus gas noise)
 */
contract BalanceModeToken is ERC20 {
    uint8 public mode;

    constructor() ERC20("Balance Mode", "BMODE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint8 m = mode;
        if (m == 1) revert("balanceOf offline");
        if (m == 2) {
            uint256 x;
            while (gasleft() > 0) x++;
        }
        if (m == 3) {
            // As many bytes as ~70% of this frame's gas can pay memory for: a caller that
            // copies them all must pay that again, out of less gas than this frame had.
            uint256 words = Math.sqrt((gasleft() * 512 * 7) / 10);
            assembly {
                return(0, mul(words, 32))
            }
        }
        if (m == 4) return super.balanceOf(account) + (gasleft() & 1023) + 1;
        return super.balanceOf(account);
    }
}

/**
 * @dev F09 (review round 2). Mimics the OP-stack L2ToL1MessagePasser predeploy (0x4200...0016 on
 * Base), whose receive() starts a withdrawal of msg.value to msg.sender on L1 and keeps the coin.
 * Tests install its runtime code at that address with hardhat_setCode.
 */
contract WithdrawalPasserMock {
    event MessagePassed(address indexed sender, address indexed target, uint256 value);

    receive() external payable {
        emit MessagePassed(msg.sender, msg.sender, msg.value);
    }
}

/**
 * @dev F09 (review round 4). Mimics an ERC-4337 EntryPoint's deposit ledger (StakeManager): its
 * receive() books msg.value as a deposit owned by msg.sender, and only the owner of a deposit can
 * withdraw it (withdrawTo). Tests install its runtime code at the canonical EntryPoint addresses
 * with hardhat_setCode, or deploy it anywhere as "a ledger that credits its sender".
 */
contract EntryPointDepositMock {
    event Deposited(address indexed account, uint256 totalDeposit);

    mapping(address => uint256) public balanceOf;

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, balanceOf[msg.sender]);
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}
