// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title InheritanceVault
 * @notice A self-custody dead man's switch: deposit native coin or an ERC20, name an heir, and
 *         check in on a schedule you chose. Stop checking in for longer than your inactivity
 *         period and the heir may claim; a challenge window then runs during which you can still
 *         veto; after it, anyone can finalize and the heir is paid.
 *
 * Lineage: the state machine (Active -> ClaimPending -> Settled/Closed, inactivity deadline,
 * challenge window, veto, pull-payment credit lane, three-lane accounting) is adapted from
 * PQVault on Ozone Chain. The post-quantum WOTS-K256 signature gating is deliberately NOT
 * carried over: this contract targets mainstream wallets on Base/BNB, where the owner's and
 * beneficiary's ordinary ECDSA keys are the authority.
 *
 * THE TRUST MODEL, stated plainly:
 *
 *   T1. The vault owner's wallet key is the ultimate authority. It can withdraw everything,
 *       change the heir, extend every deadline, and veto any claim. A stolen owner key is a
 *       stolen vault. This contract defends against a LOST key and an ABSENT owner, not a
 *       compromised one.
 *   T2. The beneficiary's wallet key is the claim authority. If the heir loses that key before
 *       claiming, the owner must name a new heir while alive; after the owner is gone, a
 *       lost beneficiary key means the funds are stuck until the horizon -- and if the heir
 *       never claims at all, they are stuck forever. Keeping the heir's address current is
 *       part of owning a vault.
 *   T3. guaranteedInheritanceAt = absoluteDeadline + challengeWindow is a hard date against a
 *       lost owner key and against runaway check-in automation: checkIn and checkInByChain
 *       revert once the horizon is reached, and only the owner's live key can extend it.
 *   T4. The admin can pause new vault creation, lower (never raise above each vault's own
 *       creation-time ceiling) the claim fee, change the fee recipient, and sweep value that
 *       was force-fed outside the accounting lanes. The admin cannot reach a wei of any
 *       vault's balance or any credited payout. That is arithmetic, not a promise -- see
 *       surplus().
 *
 * ACCOUNTING, three lanes per token, verifiable without reading the state machine:
 *   Locked   -- totalLocked[token], the sum of vault balances. Admin cannot reach it.
 *   Credited -- totalCredited[token], settled payouts awaiting pull. Admin cannot reach it.
 *   Surplus  -- balance-of-this minus the first two lanes, force-fed value only.
 * Accounting never reads live balances except in surplus() and the deposit-measurement path,
 * which exists because fee-on-transfer tokens deliver less than they were sent.
 *
 * FEES: a claim fee in basis points, hard-capped at MAX_CLAIM_FEE_BPS, is taken only when an
 * inheritance settles. Owner withdrawals are never fee'd. Each vault snapshots the fee at
 * creation as a ceiling the admin can never raise for that vault; if the global fee is lower
 * at settlement time, the lower rate applies. No fee is taken while no fee recipient is set.
 *
 * NOT SUPPORTED, deliberately: rebasing tokens (balances are recorded, not shares -- a rebase
 * strands or manufactures surplus), and ERC721/1155. One vault holds exactly one asset; owners
 * who want a split estate create several vaults and refresh them with one checkInMany call.
 */
contract InheritanceVault is Ownable2Step, ReentrancyGuard {
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    uint8 public constant STATE_NONE = 0;
    uint8 public constant STATE_ACTIVE = 1;
    uint8 public constant STATE_CLAIM_PENDING = 2;
    uint8 public constant STATE_SETTLED = 3;
    uint8 public constant STATE_CLOSED = 4;

    // Event tags for ClaimSuperseded, so an indexer can tell WHICH owner action displaced a claim.
    uint8 public constant ACT_WITHDRAW = 1;
    uint8 public constant ACT_SET_BENEFICIARY = 2;
    uint8 public constant ACT_EXTEND_HORIZON = 3;
    uint8 public constant ACT_SET_INACTIVITY = 4;
    uint8 public constant ACT_SET_CHECKIN_CHAIN = 5;

    uint32 public constant MIN_INACTIVITY = 7 days;
    uint32 public constant MAX_INACTIVITY = 3650 days;
    /// @dev Seven days, not less. A dead-man switch that fires the instant its timer hits zero
    /// will eventually fire on someone who spent three weeks in hospital, and a shorter veto
    /// window is not enough time to be found, reach a device and send a transaction.
    uint32 public constant MIN_CHALLENGE = 7 days;
    uint32 public constant MAX_CHALLENGE = 365 days;
    uint64 public constant MAX_HORIZON = 36500 days;

    uint256 public constant MAX_OPEN_VAULTS = 32;
    uint256 public constant MAX_BATCH = 32;
    uint32 public constant MAX_HB_COUNT = 100_000;

    /// @dev 1%. A hard ceiling burned into the bytecode: no admin, present or future, can take
    /// more than this from any settlement. The fee is the product's long tail, not its teeth.
    uint16 public constant MAX_CLAIM_FEE_BPS = 100;
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    address internal constant NATIVE = address(0);

    // ------------------------------------------------------------------ types

    struct Vault {
        // ---- slot 0
        address owner;
        uint64 createdAt;
        uint8 state;
        uint8 openIndex;
        uint16 feeBps; // snapshot at creation; a ceiling, never a floor
        // ---- slot 1
        address beneficiary; // the claim authority, unlike PQVault where it was only a topic
        uint64 deadline;
        uint32 inactivityPeriod;
        // ---- slot 2
        address token; // address(0) = native
        uint64 absoluteDeadline;
        uint32 challengeWindow; // immutable after creation, by design
        // ---- slot 3
        uint128 balance;
        uint64 claimInitiatedAt;
        uint32 hbLeft;
        // ---- slot 4
        address claimRecipient;
        // ---- slot 5
        bytes32 hbAnchor;
    }

    struct VaultView {
        address owner;
        uint256 vaultId;
        uint8 state;
        address beneficiary;
        address token;
        uint128 balance;
        uint16 feeBps;
        uint64 createdAt;
        uint64 deadline;
        uint64 absoluteDeadline;
        uint64 guaranteedInheritanceAt;
        uint32 inactivityPeriod;
        uint32 challengeWindow;
        bool expired;
        bool horizonReached;
        address claimRecipient;
        uint64 claimInitiatedAt;
        uint64 finalizableAt;
        bool finalizable;
        bytes32 hbAnchor;
        uint32 hbLeft;
        uint16 warnings;
    }

    // ------------------------------------------------------------------ storage

    mapping(address => mapping(uint256 => Vault)) private _vaults;
    mapping(address => uint64) public vaultCount; // lifetime; ids never reused
    mapping(address => uint64[]) private _openIds; // capped at MAX_OPEN_VAULTS
    mapping(address => mapping(address => uint256)) private _credits; // token => account => amount

    mapping(address => uint256) public totalLocked; // per token
    mapping(address => uint256) public totalCredited; // per token

    uint16 public claimFeeBps;
    address public feeRecipient;
    bool public creationPaused;

    uint64 public vaultsCreated;
    uint64 public vaultsSettled;
    uint64 public vaultsClosed;

    // ------------------------------------------------------------------ events

    event VaultCreated(
        address indexed owner,
        uint256 indexed vaultId,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint64 deadline,
        uint64 absoluteDeadline,
        uint32 challengeWindow,
        uint16 feeBps
    );
    event ToppedUp(address indexed owner, uint256 indexed vaultId, address indexed from, uint256 amount);
    event CheckedIn(address indexed owner, uint256 indexed vaultId, uint64 newDeadline, bool viaHashChain);
    event CheckInChainSet(address indexed owner, uint256 indexed vaultId, bytes32 anchor, uint32 count);
    event Withdrawn(address indexed owner, uint256 indexed vaultId, address indexed to, uint256 amount, bool closed);
    event BeneficiaryChanged(
        address indexed owner, uint256 indexed vaultId, address indexed newBeneficiary, address oldBeneficiary
    );
    event InactivityPeriodSet(address indexed owner, uint256 indexed vaultId, uint32 newPeriod);
    event HorizonExtended(address indexed owner, uint256 indexed vaultId, uint64 newAbsoluteDeadline);
    event ClaimInitiated(address indexed owner, uint256 indexed vaultId, address indexed recipient, uint64 finalizableAt);
    event ClaimAborted(address indexed owner, uint256 indexed vaultId, uint64 newDeadline);
    event ClaimSuperseded(address indexed owner, uint256 indexed vaultId, uint8 byAction);
    event ClaimSettled(
        address indexed owner, uint256 indexed vaultId, address indexed recipient, uint256 amount, uint256 fee
    );
    event CreditPaid(address indexed token, address indexed account, address indexed to, uint256 amount);
    event SurplusSwept(address indexed token, address indexed to, uint256 amount);
    event ClaimFeeChanged(uint16 oldBps, uint16 newBps);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event CreationPauseSet(bool paused);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error CannotPayToSelf();
    error BeneficiaryIsOwner();
    error ZeroAmount();
    error UseTopUp();
    error CreationIsPaused();
    error NativeAmountMismatch(uint256 sent, uint256 declared);
    error UnexpectedNativeValue();
    error NothingReceived();
    error TooManyOpenVaults(uint256 maximum);
    error BatchTooLarge(uint256 given, uint256 maximum);
    error NoSuchVault(address owner, uint256 vaultId);
    error VaultNotActive(uint256 vaultId, uint8 state);
    error VaultTerminal(uint256 vaultId, uint8 state);
    error ClaimPendingUseAbort(uint256 vaultId);
    error NoClaimPending(uint256 vaultId);
    error NotTheBeneficiary(address caller, address beneficiary);
    error NotYetExpired(uint64 deadline);
    error HorizonReached(uint64 absoluteDeadline);
    error ChallengeWindowOpen(uint64 finalizableAt);
    error HorizonNotExtended(uint64 current, uint64 requested);
    error HorizonTooFar(uint64 given, uint64 maximum);
    error InvalidPeriod(uint32 given);
    error InvalidChallengeWindow(uint32 given);
    error InvalidCheckInChain();
    error CheckInChainExhausted(uint256 vaultId);
    error CheckInAlreadyUsed(uint256 vaultId, uint64 currentDeadline);
    error BadCheckIn(uint256 vaultId);
    error InsufficientBalance(uint256 available, uint256 requested);
    error NothingToClaim(uint256 vaultId);
    error NothingCredited(address token, address account);
    error NativeTransferFailed(address to, uint256 amount);
    error NoSurplus();
    error FeeTooHigh(uint16 given, uint16 maximum);
    error RenounceDisabled();

    // ------------------------------------------------------------------ constructor

    constructor(address initialAdmin, uint16 initialClaimFeeBps, address initialFeeRecipient)
        Ownable(initialAdmin)
    {
        if (initialClaimFeeBps > MAX_CLAIM_FEE_BPS) revert FeeTooHigh(initialClaimFeeBps, MAX_CLAIM_FEE_BPS);
        if (initialFeeRecipient == address(this)) revert CannotPayToSelf();
        claimFeeBps = initialClaimFeeBps;
        feeRecipient = initialFeeRecipient; // address(0) is valid and means "charge nothing"
    }

    // ------------------------------------------------------------------ internals

    function _vault(address vaultOwner, uint256 vaultId) private view returns (Vault storage v) {
        if (vaultId >= vaultCount[vaultOwner]) revert NoSuchVault(vaultOwner, vaultId);
        v = _vaults[vaultOwner][vaultId];
    }

    function _requireLive(Vault storage v, uint256 vaultId) private view {
        uint8 s = v.state;
        if (s == STATE_SETTLED || s == STATE_CLOSED || s == STATE_NONE) revert VaultTerminal(vaultId, s);
    }

    function _resetClock(Vault storage v) private {
        uint64 next = uint64(block.timestamp) + v.inactivityPeriod;
        uint64 cap = v.absoluteDeadline;
        v.deadline = next < cap ? next : cap;
    }

    /// @dev Any owner action supersedes a running claim: the owner acting IS the liveness proof
    /// the claim asserted was missing. Unlike PQVault there is no proven recipient to preserve --
    /// no one-time key was burned, so the beneficiary re-initiates for free once the (reset)
    /// deadline expires again.
    function _clearPending(Vault storage v, uint256 vaultId, uint8 action) private {
        if (v.state == STATE_CLAIM_PENDING) {
            v.state = STATE_ACTIVE;
            v.claimInitiatedAt = 0;
            v.claimRecipient = address(0);
            emit ClaimSuperseded(v.owner, vaultId, action);
        }
    }

    function _removeFromOpen(address vaultOwner, Vault storage v) private {
        uint64[] storage ids = _openIds[vaultOwner];
        uint256 lastIdx = ids.length - 1;
        uint8 slot = v.openIndex;
        if (slot != lastIdx) {
            uint64 moved = ids[lastIdx];
            ids[slot] = moved;
            // Rewriting the moved vault's index is load-bearing: omitting it corrupts every
            // later removal.
            _vaults[vaultOwner][moved].openIndex = slot;
        }
        ids.pop();
    }

    function _credit(address token, address to, uint256 amount) private {
        _credits[token][to] += amount;
        totalCredited[token] += amount;
    }

    /// @dev Measures what actually arrived, because fee-on-transfer tokens deliver less than
    /// they were sent and recording the declared amount would slowly hollow out the locked lane.
    function _pull(address token, uint256 amount) private returns (uint256 received) {
        if (token == NATIVE) {
            if (msg.value != amount) revert NativeAmountMismatch(msg.value, amount);
            received = amount;
        } else {
            if (msg.value != 0) revert UnexpectedNativeValue();
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            received = IERC20(token).balanceOf(address(this)) - before;
        }
        if (received == 0) revert NothingReceived();
    }

    function _payout(address token, address to, uint256 amount) private {
        if (to == address(this)) revert CannotPayToSelf();
        if (token == NATIVE) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ------------------------------------------------------------------ lifecycle

    function createVault(
        address token,
        uint256 amount,
        address beneficiary,
        uint32 inactivityPeriod,
        uint32 challengeWindow,
        uint64 absoluteDeadline
    ) external payable nonReentrant returns (uint256 vaultId) {
        if (creationPaused) revert CreationIsPaused();
        if (amount == 0) revert ZeroAmount();
        if (beneficiary == address(0) || beneficiary == address(this)) revert ZeroAddress();
        if (beneficiary == msg.sender) revert BeneficiaryIsOwner();
        if (inactivityPeriod < MIN_INACTIVITY || inactivityPeriod > MAX_INACTIVITY) {
            revert InvalidPeriod(inactivityPeriod);
        }
        if (challengeWindow < MIN_CHALLENGE || challengeWindow > MAX_CHALLENGE) {
            revert InvalidChallengeWindow(challengeWindow);
        }
        if (absoluteDeadline < block.timestamp + inactivityPeriod) {
            revert HorizonNotExtended(uint64(block.timestamp), absoluteDeadline);
        }
        if (absoluteDeadline > block.timestamp + MAX_HORIZON) {
            revert HorizonTooFar(absoluteDeadline, uint64(block.timestamp) + MAX_HORIZON);
        }

        uint64[] storage ids = _openIds[msg.sender];
        if (ids.length >= MAX_OPEN_VAULTS) revert TooManyOpenVaults(MAX_OPEN_VAULTS);

        uint256 received = _pull(token, amount);

        vaultId = vaultCount[msg.sender];
        vaultCount[msg.sender] = uint64(vaultId) + 1;

        Vault storage v = _vaults[msg.sender][vaultId];
        v.owner = msg.sender;
        v.createdAt = uint64(block.timestamp);
        v.state = STATE_ACTIVE;
        v.openIndex = uint8(ids.length);
        v.feeBps = claimFeeBps;
        v.beneficiary = beneficiary;
        v.inactivityPeriod = inactivityPeriod;
        v.token = token;
        v.absoluteDeadline = absoluteDeadline;
        v.challengeWindow = challengeWindow;
        v.balance = received.toUint128();
        _resetClock(v);

        ids.push(uint64(vaultId));
        totalLocked[token] += received;
        vaultsCreated += 1;

        emit VaultCreated(
            msg.sender,
            vaultId,
            beneficiary,
            token,
            received,
            v.deadline,
            absoluteDeadline,
            challengeWindow,
            v.feeBps
        );
    }

    /// @dev Permissionless: a gift cannot harm. Deliberately does NOT reset the deadline -- if it
    /// did, any stranger could manufacture a liveness proof for a dead owner and deny the heir
    /// forever for the price of one wei. Refused mid-claim so the amount an heir is claiming
    /// cannot move underneath them.
    function topUp(address vaultOwner, uint256 vaultId, uint256 amount) external payable nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);

        uint256 received = _pull(v.token, amount);
        v.balance = (uint256(v.balance) + received).toUint128();
        totalLocked[v.token] += received;
        emit ToppedUp(vaultOwner, vaultId, msg.sender, received);
    }

    // ------------------------------------------------------------------ liveness

    function checkIn(uint256 vaultId) public {
        Vault storage v = _vault(msg.sender, vaultId);
        if (v.state == STATE_CLAIM_PENDING) revert ClaimPendingUseAbort(vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);
        // Reverting rather than silently no-op'ing: min(...) past the horizon changes nothing,
        // and a no-op that costs gas and shows a green toast is a lie to the owner.
        if (block.timestamp >= v.absoluteDeadline) revert HorizonReached(v.absoluteDeadline);

        _resetClock(v);
        emit CheckedIn(msg.sender, vaultId, v.deadline, false);
    }

    function checkInMany(uint256[] calldata vaultIds) external {
        uint256 n = vaultIds.length;
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        for (uint256 i = 0; i < n; i++) checkIn(vaultIds[i]);
    }

    /// @dev Owner-gated: installing a check-in chain extends liveness and therefore delays
    /// inheritance, so it carries the same authority as checkIn itself.
    function setCheckInChain(uint256 vaultId, bytes32 anchor, uint32 count) external {
        if (anchor == bytes32(0) || count == 0 || count > MAX_HB_COUNT) revert InvalidCheckInChain();
        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        v.hbAnchor = anchor;
        v.hbLeft = count;
        _resetClock(v);
        _clearPending(v, vaultId, ACT_SET_CHECKIN_CHAIN);
        emit CheckInChainSet(msg.sender, vaultId, anchor, count);
    }

    /**
     * @notice S/KEY hash-chain check-in. Permissionless -- possession of the preimage is the
     * authentication, so msg.sender is irrelevant and the transaction is relayable.
     *
     * Its purpose is a real recovery path: an owner who has lost their wallet key can still keep
     * the vault alive from a 32-byte seed while they coordinate with their heir. The chain runs
     * one way, so a captured check-in can be replayed but never extended.
     *
     * Its limit, stated plainly: it proves liveness, not authority. It cannot veto a claim that
     * is already pending (abortClaim needs the owner key), cannot withdraw, and cannot change
     * the heir. A keyless owner's real endgame is for the NAMED heir to claim and hand back.
     */
    function checkInByChain(address vaultOwner, uint256 vaultId, bytes32 preimage) external {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);
        if (v.hbAnchor == bytes32(0)) revert InvalidCheckInChain();
        if (v.hbLeft == 0) revert CheckInChainExhausted(vaultId);
        if (block.timestamp >= v.absoluteDeadline) revert HorizonReached(v.absoluteDeadline);
        if (preimage == v.hbAnchor) revert CheckInAlreadyUsed(vaultId, v.deadline);
        if (keccak256(abi.encodePacked(preimage)) != v.hbAnchor) revert BadCheckIn(vaultId);

        v.hbAnchor = preimage;
        v.hbLeft -= 1;
        _resetClock(v);
        emit CheckedIn(vaultOwner, vaultId, v.deadline, true);
    }

    // ------------------------------------------------------------------ owner actions

    function withdraw(uint256 vaultId, uint256 amount, address to) external {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert CannotPayToSelf();
        if (amount == 0) revert ZeroAmount();

        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        if (amount > v.balance) revert InsufficientBalance(v.balance, amount);

        v.balance = uint128(v.balance - uint128(amount));
        totalLocked[v.token] -= amount;
        _credit(v.token, to, amount);
        _resetClock(v);
        _clearPending(v, vaultId, ACT_WITHDRAW);

        bool closed = v.balance == 0;
        if (closed) {
            v.state = STATE_CLOSED;
            vaultsClosed += 1;
            _removeFromOpen(msg.sender, v);
        }
        emit Withdrawn(msg.sender, vaultId, to, amount, closed);
    }

    function setBeneficiary(uint256 vaultId, address newBeneficiary) external {
        if (newBeneficiary == address(0) || newBeneficiary == address(this)) revert ZeroAddress();
        if (newBeneficiary == msg.sender) revert BeneficiaryIsOwner();

        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);

        address old = v.beneficiary;
        v.beneficiary = newBeneficiary;
        _resetClock(v);
        _clearPending(v, vaultId, ACT_SET_BENEFICIARY);
        emit BeneficiaryChanged(msg.sender, vaultId, newBeneficiary, old);
    }

    function setInactivityPeriod(uint256 vaultId, uint32 newPeriod) external {
        if (newPeriod < MIN_INACTIVITY || newPeriod > MAX_INACTIVITY) revert InvalidPeriod(newPeriod);
        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        v.inactivityPeriod = newPeriod;
        _resetClock(v);
        _clearPending(v, vaultId, ACT_SET_INACTIVITY);
        emit InactivityPeriodSet(msg.sender, vaultId, newPeriod);
    }

    /// @notice Reachable even after the horizon has passed, while the vault is live. The horizon
    /// exists to beat a LOST key and zombie automation (T3), not a living owner: a human holding
    /// the owner key deliberately extending their own horizon is the person the vault serves.
    /// `challengeWindow` has no setter at all -- its immutability is the heir's guarantee that a
    /// claim, once initiated, has a settlement date no one can stretch.
    function extendHorizon(uint256 vaultId, uint64 newAbsoluteDeadline) external {
        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        if (newAbsoluteDeadline <= v.absoluteDeadline) {
            revert HorizonNotExtended(v.absoluteDeadline, newAbsoluteDeadline);
        }
        uint64 max = uint64(block.timestamp) + MAX_HORIZON;
        if (newAbsoluteDeadline > max) revert HorizonTooFar(newAbsoluteDeadline, max);

        v.absoluteDeadline = newAbsoluteDeadline;
        _resetClock(v);
        _clearPending(v, vaultId, ACT_EXTEND_HORIZON);
        emit HorizonExtended(msg.sender, vaultId, newAbsoluteDeadline);
    }

    // ------------------------------------------------------------------ claiming

    /// @dev Only the named beneficiary may initiate, and the recipient is their choice -- an heir
    /// should route the payout to a fresh address if they want one, without moving their identity
    /// key. There is no relayer path here: on the target chains gas is cents, and gating on
    /// msg.sender is what makes the beneficiary address the authority.
    function initiateClaim(address vaultOwner, uint256 vaultId, address recipient) external {
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);
        if (msg.sender != v.beneficiary) revert NotTheBeneficiary(msg.sender, v.beneficiary);
        if (block.timestamp < v.deadline) revert NotYetExpired(v.deadline);
        if (v.balance == 0) revert NothingToClaim(vaultId);

        v.claimRecipient = recipient;
        v.claimInitiatedAt = uint64(block.timestamp);
        v.state = STATE_CLAIM_PENDING;

        emit ClaimInitiated(vaultOwner, vaultId, recipient, uint64(block.timestamp) + v.challengeWindow);
    }

    /// @dev The veto. Resets the clock, so the abort/re-claim loop is naturally rate-limited to
    /// once per inactivity period -- and unlike PQVault it costs the heir nothing but gas.
    function abortClaim(uint256 vaultId) external {
        Vault storage v = _vault(msg.sender, vaultId);
        if (v.state != STATE_CLAIM_PENDING) revert NoClaimPending(vaultId);

        v.claimInitiatedAt = 0;
        v.claimRecipient = address(0);
        v.state = STATE_ACTIVE;
        _resetClock(v);
        emit ClaimAborted(msg.sender, vaultId, v.deadline);
    }

    /// @dev Permissionless and free of external calls. Splitting settlement from payment keeps a
    /// hostile or non-payable recipient from jamming the vault: value lands in the credit lane
    /// and is pulled from there.
    function finalizeClaim(address vaultOwner, uint256 vaultId) external {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_CLAIM_PENDING) revert NoClaimPending(vaultId);
        uint64 finalizableAt = v.claimInitiatedAt + v.challengeWindow;
        if (block.timestamp < finalizableAt) revert ChallengeWindowOpen(finalizableAt);

        uint256 amt = v.balance;
        address to = v.claimRecipient;
        address token = v.token;

        // The vault's creation-time fee is a ceiling; a lower current global rate applies.
        // No recipient configured means no fee, so an abandoned admin can never strand a claim.
        uint16 bps = v.feeBps;
        uint16 current = claimFeeBps;
        if (current < bps) bps = current;
        address feeTo = feeRecipient;
        uint256 fee = feeTo == address(0) ? 0 : (amt * bps) / BPS_DENOMINATOR;

        v.balance = 0;
        totalLocked[token] -= amt;
        _credit(token, to, amt - fee);
        if (fee != 0) _credit(token, feeTo, fee);
        v.state = STATE_SETTLED;
        vaultsSettled += 1;
        _removeFromOpen(vaultOwner, v);

        emit ClaimSettled(vaultOwner, vaultId, to, amt - fee, fee);
    }

    // ------------------------------------------------------------ the credit lane

    function withdrawCredit(address token, address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = _credits[token][msg.sender];
        if (amount == 0) revert NothingCredited(token, msg.sender);
        _credits[token][msg.sender] = 0;
        totalCredited[token] -= amount;
        emit CreditPaid(token, msg.sender, to, amount);
        _payout(token, to, amount);
    }

    /// @dev Permissionless push, so a contract recipient with a payable receive() but no ability
    /// to originate a transaction can still be paid.
    function pushCredit(address token, address account) external nonReentrant returns (uint256 amount) {
        amount = _credits[token][account];
        if (amount == 0) revert NothingCredited(token, account);
        _credits[token][account] = 0;
        totalCredited[token] -= amount;
        emit CreditPaid(token, account, account, amount);
        _payout(token, account, amount);
    }

    function creditOf(address token, address account) external view returns (uint256) {
        return _credits[token][account];
    }

    // ------------------------------------------------------------------ admin

    /// @dev Bounded twice: by the bytecode constant here, and per-vault by each vault's snapshot.
    function setClaimFee(uint16 newBps) external onlyOwner {
        if (newBps > MAX_CLAIM_FEE_BPS) revert FeeTooHigh(newBps, MAX_CLAIM_FEE_BPS);
        emit ClaimFeeChanged(claimFeeBps, newBps);
        claimFeeBps = newBps;
    }

    /// @dev The contract itself is refused: credits to self can never be paid out, so allowing
    /// it would let a careless admin strand fee revenue inside the credited lane forever.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(this)) revert CannotPayToSelf();
        emit FeeRecipientChanged(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseSet(paused);
    }

    /// @dev Disabled. Renouncing would strand every future force-fed coin permanently, because
    /// sweepSurplus is the only route out and it is onlyOwner. Use transferOwnership.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @dev The only value an admin can ever reach, and the subtraction is the proof.
    function surplus(address token) public view returns (uint256) {
        uint256 accounted = totalLocked[token] + totalCredited[token];
        uint256 bal = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        return bal > accounted ? bal - accounted : 0;
    }

    function sweepSurplus(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = surplus(token);
        if (amount == 0) revert NoSurplus();
        emit SurplusSwept(token, to, amount);
        _payout(token, to, amount);
    }

    /// @dev Plain transfers are refused so native value can never enter outside the accounting
    /// lanes. (ERC20s can still be force-fed by direct transfer; they land in surplus.)
    receive() external payable {
        revert UseTopUp();
    }

    // ------------------------------------------------------------------ views

    /**
     * @notice Warning bits, computed on chain so the frontend cannot silently drift from them.
     *   bit 0  expired -- the inactivity deadline has passed
     *   bit 1  horizon reached -- no check-in can extend this vault any further
     *   bit 2  a claim is pending
     *   bit 3  a check-in chain is configured but exhausted
     *   bit 7  the vault is terminal
     */
    function warningsOf(address vaultOwner, uint256 vaultId) public view returns (uint16 w) {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state == STATE_SETTLED || v.state == STATE_CLOSED) return 1 << 7;
        if (block.timestamp >= v.deadline) w |= 1 << 0;
        if (block.timestamp >= v.absoluteDeadline) w |= 1 << 1;
        if (v.state == STATE_CLAIM_PENDING) w |= 1 << 2;
        if (v.hbAnchor != bytes32(0) && v.hbLeft == 0) w |= 1 << 3;
    }

    function getVault(address vaultOwner, uint256 vaultId) public view returns (VaultView memory o) {
        Vault storage v = _vault(vaultOwner, vaultId);
        o.owner = v.owner;
        o.vaultId = vaultId;
        o.state = v.state;
        o.beneficiary = v.beneficiary;
        o.token = v.token;
        o.balance = v.balance;
        o.feeBps = v.feeBps;
        o.createdAt = v.createdAt;
        o.deadline = v.deadline;
        o.absoluteDeadline = v.absoluteDeadline;
        o.guaranteedInheritanceAt = v.absoluteDeadline + v.challengeWindow;
        o.inactivityPeriod = v.inactivityPeriod;
        o.challengeWindow = v.challengeWindow;
        o.expired = block.timestamp >= v.deadline;
        o.horizonReached = block.timestamp >= v.absoluteDeadline;
        o.claimRecipient = v.claimRecipient;
        o.claimInitiatedAt = v.claimInitiatedAt;
        o.finalizableAt = v.state == STATE_CLAIM_PENDING ? v.claimInitiatedAt + v.challengeWindow : 0;
        o.finalizable = v.state == STATE_CLAIM_PENDING && block.timestamp >= o.finalizableAt;
        o.hbAnchor = v.hbAnchor;
        o.hbLeft = v.hbLeft;
        o.warnings = warningsOf(vaultOwner, vaultId);
    }

    /// @notice Bounded by MAX_OPEN_VAULTS, never by lifetime history.
    function getOpenVaults(address vaultOwner) external view returns (VaultView[] memory out) {
        uint64[] storage ids = _openIds[vaultOwner];
        uint256 n = ids.length;
        out = new VaultView[](n);
        for (uint256 i = 0; i < n; i++) out[i] = getVault(vaultOwner, ids[i]);
    }

    function openVaultIds(address vaultOwner) external view returns (uint64[] memory) {
        return _openIds[vaultOwner];
    }
}
