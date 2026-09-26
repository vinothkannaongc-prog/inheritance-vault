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
 *       lost owner key and against runaway check-in automation: checkIn, checkInByChain and
 *       setCheckInChain revert once the horizon is reached, abortClaim closes with them, and a
 *       partial withdraw no longer displaces a claim. The ONLY way past the date is
 *       extendHorizon, which needs the live owner key, must name a horizon at least one
 *       inactivity period in the future, and is logged as HorizonExtended. So a living owner
 *       can still override the date deliberately -- at a cost of one full inactivity period per
 *       override -- and nothing can do it silently or without bound.
 *       Check-ins stop extending even earlier: once the deadline has reached the horizon (which
 *       the first check-in within one inactivity period of it brings about), checkIn and
 *       checkInByChain revert DeadlinePinnedAtHorizon and checkInMany skips the vault (warnings
 *       bit 4), because a check-in there would move nothing. The heir may then claim AT the
 *       horizon, however recently the owner checked in; extendHorizon is the remedy.
 *   T4. The admin can pause new vault creation, cut the claim fee at once, raise it only after
 *       FEE_RAISE_DELAY of public notice (and never above each vault's own creation-time
 *       ceiling), change the fee recipient (switching fees back on after a period with no
 *       recipient also waits FEE_RAISE_DELAY), and sweep value that was force-fed outside the
 *       accounting lanes, in the native coin or a supported token only. The admin cannot add a
 *       supported token: the list is fixed in the constructor.
 *       The admin cannot reach a wei of any vault's balance or any credited payout. That is
 *       arithmetic, not a promise -- see surplus() -- and it holds for the native coin and for
 *       the supported tokens, which are the only assets a vault can hold. It rests on the
 *       deployer having listed only single-address, non-rebasing tokens (SUPPORTED TOKENS), and
 *       on every payout that runs the payee's code being measured, so a payee cannot hand a
 *       payout back as surplus while the credit is retired (PAYOUT ADDRESSES).
 *
 * ACCOUNTING, three lanes per token, verifiable without reading the state machine:
 *   Locked   -- totalLocked(token), the sum of vault balances. Admin cannot reach it.
 *   Credited -- totalCredited(token), settled payouts awaiting pull. Admin cannot reach it.
 *   Surplus  -- balance-of-this minus the first two lanes, force-fed value only.
 * Accounting never reads live balances except in surplus() and three measurement paths:
 *   - deposits, the only one that feeds a lane, capped at the amount sent, because
 *     fee-on-transfer tokens deliver less than they were sent;
 *   - ERC20 payouts, which must debit this contract by exactly the amount paid, because a token
 *     that debits more would charge the difference to whoever withdraws last, and one that
 *     reports a transfer it did not fully make would turn the unpaid part of a credit into
 *     sweepable surplus;
 *   - native payouts to an address with code (_holdings), which must lower the native balance
 *     by exactly the amount paid and leave every listed token's balance unchanged, because a
 *     payee that sends value back while being paid would turn the payout into sweepable
 *     surplus (PAYOUT ADDRESSES).
 *
 * SUPPORTED TOKENS. A vault holds the native coin or one of the ERC20s passed to the
 * constructor (supportedTokens()). The list is immutable: no function adds or removes a token,
 * because an admin that could list a second address of an existing ledger could then sweep
 * that ledger as "surplus". The deployer lists only tokens that have ONE address per ledger (no
 * double entry point, no ERC20 facade over the native coin), a balance that changes only by
 * transfers (no rebasing, yield, reflection or holding fee), no fee charged on top of a
 * transfer, and no transfer hooks (no ERC777, no settle-on-touch rewards). The contract does not
 * trust that vetting blindly: an ERC20 payout that does not debit the vault by exactly `amount`
 * reverts, and a deposit never records more than the amount the depositor sent. Keep the list
 * short: every native payout to an address with code reads each listed token's balance twice,
 * with bounded gas (PAYOUT ADDRESSES, _holdings).
 *
 * FEES: a claim fee in basis points, hard-capped at MAX_CLAIM_FEE_BPS, is taken only when an
 * inheritance settles. Owner withdrawals are never fee'd. Three rules, under which no rate a
 * user pays can be raised in the same block as, and just before, that user's transaction:
 *   - Each vault snapshots claimFeeBps() at creation as a ceiling the admin can never raise for
 *     that vault. It is a ceiling, not a rate: a later cut lowers what the vault pays only while
 *     the cut is in force.
 *   - initiateClaim locks min(claimFeeBps(), ceiling) for the claim (lockedFeeBps, shown in
 *     getVault and in ClaimInitiated), or 0 when no fee recipient is in force. finalizeClaim
 *     charges min(locked, claimFeeBps()), and nothing when no recipient is in force at
 *     settlement. So the lock is a maximum, which no rise can take a claim above. A cut (a lower
 *     rate, or the recipient removed) reaches the heir only if it is still in force when
 *     finalizeClaim is mined. The admin may reverse it before then, with FEE_RAISE_DELAY of
 *     public notice (a raise, or a recipient switched back on), and with a challenge window
 *     longer than that delay the reversal can take effect before the heir is able to settle.
 *     An heir keeps a cut for good only by beneficiaryCancelClaim and initiateClaim while it is
 *     in force: that locks the lower fee, at the price of a fresh challenge window and of the
 *     gap that beneficiaryCancelClaim describes.
 *   - A cut applies at once and cancels any pending raise. A raise is only scheduled: it takes
 *     effect FEE_RAISE_DELAY after it was announced (ClaimFeeRaiseScheduled), at that second
 *     whether or not anyone has called applyClaimFee, so nobody can hold a matured raise back
 *     and fire it in front of a user. Switching fees on after a period with no recipient is a
 *     raise from zero and waits the same delay: a recipient is "in force" only from
 *     feeRecipientActiveAt, for initiateClaim and finalizeClaim alike.
 *
 * NOT SUPPORTED, deliberately: ERC721/1155, and every ERC20 not on the list, which createVault
 * and topUp refuse. That is why rebasing tokens cannot enter: on a POSITIVE rebase the yield
 * would accrue as surplus, and on a NEGATIVE rebase the credit lane is first-come-first-served,
 * so the last claimant would recover only what is left (through the partial withdrawCredit)
 * rather than a pro-rata share. Nor should a token that caps a transfer or a wallet's balance
 * be listed: the partial withdrawCredit gets a large credit out, but a cap on this contract's
 * own balance would refuse deposits. An unlisted ERC20 sent here directly is stranded:
 * sweepSurplus refuses it, because a sweep through an unlisted address is exactly how a second
 * entry point reaches a listed ledger.
 * What the list cannot rule out is an issuer action on a listed token (a blocklist, a pause, a
 * wipe of this contract's balance); all vaults of that token share one pooled balance. Such an
 * action reaches the native coin only through the measurement of native payouts to payees
 * with code, and there only as far as _holdings allows; a payout to a wallet reads no token.
 *
 * PAYOUT ADDRESSES. This contract, every supported token (the chain's wrapped-native token,
 * wrappedNative, is always one of them), the OP-stack predeploy range 0x4200...0000 to
 * 0x4200...07FF and the four canonical ERC-4337 EntryPoints (v0.6 to v0.9) are refused as a
 * withdraw or withdrawCredit destination, a claim recipient, the fee recipient and a sweep
 * target. A token contract cannot claim its credit. Native coin paid to a wrap-on-receive
 * contract would come back as wrapped tokens held by THIS contract, outside every lane, where
 * only sweepSurplus could move them. That refusal is by address; the rule behind it is enforced
 * by measurement: a native payout to an address with code must lower this contract's native
 * balance by exactly the amount paid and leave its balance of every supported token unchanged,
 * or it reverts PayoutReturned and the credit stays. So no payee -- a wrap-and-forward helper, a
 * SELFDESTRUCT bounce, any contract that sends value back to its sender -- can turn a payout
 * into surplus the admin could sweep. An address with no code runs nothing when paid, so it
 * cannot send anything back and is not measured. (Value a payee sends back later, in a
 * transaction of its own, was paid. So was value it hands back in an asset that is not listed:
 * that stays here, stranded like any unlisted token sent directly.)
 * The predeploy and EntryPoint refusals are of payees that KEEP the value, so the measurement
 * passes them, but leave it owed to this contract somewhere it can never collect it: the payout
 * is lost, though never sweepable. Native coin paid to Base's L2ToL1MessagePasser (0x4200...0016)
 * is withdrawn to msg.sender on L1: to this contract's address there, where only the deployer
 * key, sending from the nonce that created this contract, could ever put code to collect it.
 * Native coin paid to an EntryPoint is booked there as a deposit owned by msg.sender, this
 * contract, and only the owner of a deposit can withdraw it, with a call this contract has no
 * function to make. Both refusals are by address, and no rule can see either kind in general: a
 * payee that forwards value to this contract's address on ANOTHER chain, or one that books the
 * value to msg.sender in a ledger of its own (an EntryPoint at any other address, a staking or
 * deposit contract that credits its sender). The refused addresses cover the one passer every
 * OP-stack chain has, and the canonical EntryPoints, which Base and BNB both have at these
 * addresses.
 * Still not recoverable, and inherent rather than fixable: value credited to some other address
 * that can neither originate a call nor receive native value is stuck. withdrawCredit lets the
 * credited account route anywhere, which covers blocklisted EOAs and any contract able to make
 * one call, provided it acts within PUSH_GRACE (see THE CREDIT LANE); nothing covers an address
 * that can do neither. No admin rescue exists on purpose -- a hatch that can move a user's credit is a
 * hatch that can move a user's credit.
 *
 * THE CREDIT LANE. withdraw and finalizeClaim move no value: they record a credit (Withdrawn,
 * ClaimSettled). Value leaves this contract only in withdrawCredit, pushCredit and sweepSurplus,
 * whose events (CreditPaid, SurplusSwept) are emitted after the transfer succeeded.
 *   - withdrawCredit(token, to) pays the whole credit; withdrawCredit(token, to, amount) pays
 *     part of it, so a token that caps a single transfer cannot freeze a large credit.
 *   - pushCredit pays the credit to the credited account itself. The account may push its own
 *     credit at any time. Anyone else may push only PUSH_GRACE after creditedSince, so that an
 *     account can route a new balance elsewhere first (a blocklisted address, a contract that
 *     can call but cannot move the asset). creditedSince restarts whenever a new credit is at
 *     least as large as what is already owed: a 1-wei credit planted early cannot make a later
 *     inheritance pushable at once (planting one large enough costs as much as the credit it
 *     would expose), while an account that keeps accruing smaller credits (the fee recipient)
 *     cannot keep a third-party push away for longer than PUSH_GRACE.
 *   - The grace runs per account balance (token, account), not per credit. A credit SMALLER
 *     than what the account already owes gets no grace of its own: it joins the older clock,
 *     and once that clock has run out, anyone may settle it (finalizeClaim is permissionless)
 *     and push the whole balance in one transaction. So an heir whose address still holds an
 *     older credit should withdraw it before settling another claim into that address, or name
 *     a fresh recipient for each claim (beneficiaryCancelClaim can still change it before
 *     settlement). Restarting the clock on smaller credits instead would let anyone postpone
 *     the push to an account that cannot act forever, 1 wei at a time.
 *
 * VIEWS. surplus, totalLocked, totalCredited, getVault, getOpenVaults and creditOf revert
 * (ReentrancyGuardReentrantCall) while a nonReentrant function of this contract is running --
 * every function that moves value or calls out -- so code called back from inside such a call
 * can never read a half-applied state through them (a deposit is measured by calling the token
 * BEFORE the lanes are written, so mid-deposit the balance already holds value the lanes do not
 * yet count). The other views read single fields that the accounting does not compare with a
 * balance. Consequence: a payout recipient whose receive() reads a guarded view cannot be paid
 * by pushCredit.
 *
 * THE CHECK-IN CHAIN (see checkInByChain and docs/CHECKIN-CHAIN.md). Every step is bound to
 * this chain id, this contract, the vault's owner and id, and the vault's installation epoch
 * (hbEpoch, bumped by every setCheckInChain), so a value revealed on one vault, deployment,
 * chain or installation is useless on any other. Generate chains with
 * scripts/checkin-chain.ts, which also derives the chain's tip from the seed so the final
 * check-in never reveals the seed itself.
 *
 * EVENTS. Every write to a vault's deadline, whatever caused it, emits DeadlineReset from the
 * one function that writes it, before the event of the action that caused it. checkInMany
 * emits CheckedIn or CheckInSkipped for every id it was given, or, when it moves no deadline,
 * reverts NothingCheckedIn with a bit for every skip reason it saw.
 *
 * One vault holds exactly one asset; owners who want a split estate create several vaults and
 * refresh them with one checkInMany call.
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
    /// @dev A full withdrawal closed the vault. Unlike every other tag, the vault did not go
    /// back to ACTIVE: it is CLOSED, and the claim ended with it.
    uint8 public constant ACT_CLOSE = 6;

    // Reasons for CheckInSkipped: why checkInMany did not refresh an id, and so what fixes it.
    /// @dev The caller has no vault with this id.
    uint8 public constant SKIP_UNKNOWN_ID = 1;
    /// @dev The vault is settled or closed.
    uint8 public constant SKIP_TERMINAL = 2;
    /// @dev A claim is pending and the horizon is still ahead. A check-in never ends one:
    /// abortClaim (the veto) does. (Past the horizon the reason is
    /// SKIP_CLAIM_PENDING_PAST_HORIZON, because abortClaim reverts there.)
    uint8 public constant SKIP_CLAIM_PENDING = 3;
    /// @dev The horizon has passed. Only extendHorizon reopens check-ins.
    uint8 public constant SKIP_HORIZON_REACHED = 4;
    /// @dev The deadline already sits at the horizon, so a check-in cannot move it
    /// (DeadlinePinnedAtHorizon). extendHorizon first.
    uint8 public constant SKIP_PINNED = 5;
    /// @dev The deadline already moved at this second: a repeated id in the batch, or a vault
    /// whose clock was reset earlier in the same block. Nothing is wrong.
    uint8 public constant SKIP_REPEATED = 6;
    /// @dev A claim is pending and the horizon has passed. abortClaim reverts HorizonReached
    /// there; only extendHorizon to at least now + inactivityPeriod, or withdrawing everything
    /// (withdraw(id, type(uint256).max, to)), ends the claim, before finalizeClaim is mined.
    uint8 public constant SKIP_CLAIM_PENDING_PAST_HORIZON = 7;

    /// @notice The domain tag of every check-in chain step (see hbStep).
    bytes32 public constant HB_DOMAIN = keccak256("WillAndKey.CheckInChain.v2");

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

    /// @notice A fee raise, and switching fees back on after a period with no recipient, take
    /// effect this long after they are announced. Long enough for an owner to see it coming and
    /// create a vault at the old ceiling, and for an heir to see it before starting a claim.
    uint32 public constant FEE_RAISE_DELAY = 30 days;

    /// @notice How long a credit is the credited account's alone to route before a third party
    /// may push it to that account (see THE CREDIT LANE).
    uint32 public constant PUSH_GRACE = 30 days;

    address internal constant NATIVE = address(0);

    /// @dev The OP-stack predeploy namespace, 0x4200...0000 to 0x4200...07FF, refused as a payee
    /// (see PAYOUT ADDRESSES). On Base it holds the L2ToL1MessagePasser, whose receive() starts
    /// a withdrawal to msg.sender on L1. Unused on chains that are not OP-stack.
    address internal constant OP_STACK_PREDEPLOYS = 0x4200000000000000000000000000000000000000;

    /// @dev The canonical ERC-4337 EntryPoints v0.6, v0.7, v0.8 and v0.9, deployed at these same
    /// addresses on Base and BNB, refused as a payee (see PAYOUT ADDRESSES). Each one's receive()
    /// books the value as a deposit owned by msg.sender, which only msg.sender can withdraw.
    address internal constant ENTRYPOINT_V06 = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;
    address internal constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant ENTRYPOINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address internal constant ENTRYPOINT_V09 = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;

    /// @dev The most gas a native payout's measurement gives one listed token's balanceOf (see
    /// _holdings). About ten times what the proposed tokens, proxies included, use cold.
    uint256 internal constant BALANCE_READ_GAS = 100_000;

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
        uint32 hbLeft; // owner-declared uses remaining; the contract cannot verify the count
        /// @dev The check-in chain installation this vault is on: 0 = never installed, and +1 on
        /// every setCheckInChain (disarm included). Part of every chain step (see hbStep).
        uint32 hbEpoch;
        // ---- slot 4
        address claimRecipient;
        /// @dev min(feeBps, claimFeeBps()) captured at initiateClaim, or 0 when no fee recipient
        /// was in force then, so the fee cannot be raised under a claim already in flight.
        /// Kept separate from feeBps so the creation-time ceiling stays immutable and never
        /// disagrees with the VaultCreated event. Meaningful only while a claim is pending.
        uint16 lockedFeeBps;
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
        /// @dev The creation-time CEILING, not the rate the vault will pay (see FEES).
        uint16 feeBps;
        /// @dev While a claim is pending: the most it will pay (see FEES). 0 otherwise.
        uint16 lockedFeeBps;
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
        /// @dev 0 when no chain is armed (never installed, or disarmed).
        bytes32 hbAnchor;
        /// @dev Owner-declared uses remaining, not a verified count.
        uint32 hbLeft;
        /// @dev The installation epoch the chain in force was built for (see hbStep).
        uint32 hbEpoch;
        uint16 warnings;
    }

    // ------------------------------------------------------------------ storage

    mapping(address => mapping(uint256 => Vault)) private _vaults;
    mapping(address => uint64) public vaultCount; // lifetime; ids never reused
    mapping(address => uint64[]) private _openIds; // capped at MAX_OPEN_VAULTS
    mapping(address => mapping(address => uint256)) private _credits; // token => account => amount
    /// @notice token => account => when the credit's third-party push grace started (see THE
    /// CREDIT LANE). A third party may push from creditedSince + PUSH_GRACE. 0 when nothing is
    /// owed.
    mapping(address => mapping(address => uint64)) public creditedSince;

    // The Locked and Credited lanes, per token. Read through the guarded totalLocked and
    // totalCredited views (see VIEWS), not public getters: a public getter cannot take the guard.
    mapping(address => uint256) private _totalLocked;
    mapping(address => uint256) private _totalCredited;

    uint16 private _claimFeeBps; // the rate last recorded; claimFeeBps() folds in a matured raise
    address public feeRecipient;
    bool public creationPaused;
    /// @notice A scheduled fee raise, or 0 when none is pending.
    uint16 public pendingClaimFeeBps;

    uint64 public vaultsCreated;
    uint64 public vaultsSettled;
    uint64 public vaultsClosed;
    /// @notice When pendingClaimFeeBps takes effect, or 0 when no raise is pending.
    uint64 public pendingClaimFeeAt;
    /// @notice The fee recipient is in force only from this time: claims initiated before it lock
    /// a zero fee, and claims finalized before it pay none. It is set FEE_RAISE_DELAY ahead
    /// whenever a fee recipient is set after a period with none. 0 on a deployment that started
    /// with a recipient.
    uint64 public feeRecipientActiveAt;

    /// @notice The chain's wrapped-native token (WETH, WBNB), refused as a payout address.
    /// address(0) when the deployment names none. Fixed at deployment, and always one of the
    /// supported tokens (the constructor refuses it otherwise).
    address public immutable wrappedNative;

    /// @notice The ERC20s a vault may hold, besides the native coin (which is not listed).
    /// Written only in the constructor: no function can add or remove an entry.
    mapping(address => bool) public isSupportedToken;
    address[] private _supportedTokens;

    // ------------------------------------------------------------------ events

    /// @notice A TRANSFER IN: `amount` is what actually arrived and was locked in the vault (a
    /// fee-on-transfer token delivers less than was sent). `feeBps` is the vault's fee ceiling.
    event VaultCreated(
        address indexed owner,
        uint256 indexed vaultId,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint64 deadline,
        uint64 absoluteDeadline,
        uint32 inactivityPeriod,
        uint32 challengeWindow,
        uint16 feeBps
    );
    /// @notice A TRANSFER IN: `amount` is what actually arrived and was added to the vault.
    event ToppedUp(address indexed owner, uint256 indexed vaultId, address indexed from, uint256 amount);
    /// @notice `newDeadline` is the deadline after the check-in. checkInMany and checkInByChain
    /// emit it only for a deadline they moved; checkIn called again in the second its clock was
    /// last reset succeeds with the deadline unchanged (harmless: nothing is spent or counted).
    event CheckedIn(address indexed owner, uint256 indexed vaultId, uint64 newDeadline, bool viaHashChain);
    /// @notice checkInMany did not refresh `vaultId`; `reason` is one of the SKIP_* constants.
    event CheckInSkipped(address indexed owner, uint256 indexed vaultId, uint8 reason);
    /// @notice The vault's deadline was written, by any action. Emitted at the write, so before
    /// the event of the action that caused it. Its `newDeadline` is always what getVault reports
    /// next, and it can be EARLIER than before (a shorter setInactivityPeriod).
    event DeadlineReset(address indexed owner, uint256 indexed vaultId, uint64 newDeadline, uint64 absoluteDeadline);
    /// @notice `anchor` 0 with `count` 0 is a disarm. `epoch` is the vault's new hbEpoch, which
    /// the installed chain must have been built for.
    event CheckInChainSet(address indexed owner, uint256 indexed vaultId, bytes32 anchor, uint32 count, uint32 epoch);
    /// @notice A CREDIT, not a transfer: `amount` left the vault's balance and was credited to
    /// `to`, who must pull it with withdrawCredit (or be paid by pushCredit). Nothing has reached
    /// `to` yet; CreditPaid records that.
    event Withdrawn(address indexed owner, uint256 indexed vaultId, address indexed to, uint256 amount, bool closed);
    /// @notice Both heirs are indexed, so a removed heir can find its removal by filtering on its
    /// own address. vaultId is in the data (three indexed fields at most).
    event BeneficiaryChanged(
        address indexed owner, address indexed oldBeneficiary, address indexed newBeneficiary, uint256 vaultId
    );
    event InactivityPeriodSet(address indexed owner, uint256 indexed vaultId, uint32 newPeriod);
    event HorizonExtended(address indexed owner, uint256 indexed vaultId, uint64 newAbsoluteDeadline);
    /// @notice `lockedFeeBps` is the most this claim will pay (see FEES): 0 if no fee recipient
    /// was in force.
    event ClaimInitiated(
        address indexed owner,
        uint256 indexed vaultId,
        address indexed recipient,
        uint64 finalizableAt,
        uint16 lockedFeeBps
    );
    event ClaimAborted(address indexed owner, uint256 indexed vaultId, uint64 newDeadline);
    /// @notice An owner action ended a pending claim. For every tag but ACT_CLOSE the vault is
    /// ACTIVE again; after ACT_CLOSE it is CLOSED.
    event ClaimSuperseded(address indexed owner, uint256 indexed vaultId, uint8 byAction);
    /// @notice The beneficiary withdrew their own pending claim; the vault is ACTIVE again with
    /// its deadline unchanged.
    event ClaimCancelled(address indexed owner, uint256 indexed vaultId, address indexed beneficiary);
    /// @notice A CREDIT, not a transfer: `amount` was credited to `recipient` and `fee` to the
    /// fee recipient. Both must be pulled with withdrawCredit (or paid by pushCredit).
    event ClaimSettled(
        address indexed owner, uint256 indexed vaultId, address indexed recipient, uint256 amount, uint256 fee
    );
    /// @notice A TRANSFER OUT, emitted after it succeeded: `amount` of `account`'s credit was
    /// paid to `to`. `amount` is what this contract sent (gross); for a fee-on-transfer token the
    /// token's own Transfer log shows what arrived.
    event CreditPaid(address indexed token, address indexed account, address indexed to, uint256 amount);
    /// @notice A TRANSFER OUT, emitted after it succeeded: force-fed surplus paid to `to`.
    event SurplusSwept(address indexed token, address indexed to, uint256 amount);
    /// @notice The rate in force changed: a cut (immediate), or a scheduled raise being recorded
    /// (by applyClaimFee or the next setClaimFee). A raise counts from its effectiveAt, which may
    /// be earlier than this event.
    event ClaimFeeChanged(uint16 oldBps, uint16 newBps);
    /// @notice A raise was announced; it counts from `effectiveAt` and replaces any earlier one.
    event ClaimFeeRaiseScheduled(uint16 currentBps, uint16 newBps, uint64 effectiveAt);
    /// @notice A cut cancelled a pending raise.
    event ClaimFeeRaiseCancelled(uint16 cancelledBps);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event CreationPauseSet(bool paused);
    /// @notice Emitted once per listed token, at deployment only.
    event TokenSupported(address indexed token);

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
    /// @dev checkIn, with a claim pending before the horizon: a check-in never ends a claim, and
    /// abortClaim (the veto) does. Past the horizon, where abortClaim reverts too, checkIn
    /// reverts HorizonReached instead (extendHorizon, or a full withdrawal, ends the claim there).
    error ClaimPendingUseAbort(uint256 vaultId);
    error NoClaimPending(uint256 vaultId);
    error NotTheBeneficiary(address caller, address beneficiary);
    error NotYetExpired(uint64 deadline);
    error HorizonReached(uint64 absoluteDeadline);
    error ChallengeWindowOpen(uint64 finalizableAt);
    error HorizonNotExtended(uint64 current, uint64 requested);
    error HorizonTooFar(uint64 given, uint64 maximum);
    error HorizonTooSoon(uint64 minimum, uint64 given);
    /// @dev checkInMany moved no deadline. Bit r of `skipped` (1 << r) is set when some id was
    /// skipped for SKIP_* reason r, so the revert says what the rolled-back CheckInSkipped logs
    /// would have said: a one-vault batch with a claim pending reverts NothingCheckedIn(8)
    /// before the horizon (abortClaim ends the claim) and NothingCheckedIn(128) past it (only
    /// extendHorizon or a full withdrawal does).
    error NothingCheckedIn(uint8 skipped);
    error InvalidPeriod(uint32 given);
    error InvalidChallengeWindow(uint32 given);
    error InvalidCheckInChain();
    error CheckInChainExhausted(uint256 vaultId);
    /// @dev The preimage was already spent, or the vault was already checked in at this second
    /// (a chain link is spent only when it moves the deadline).
    error CheckInAlreadyUsed(uint256 vaultId, uint64 currentDeadline);
    error BadCheckIn(uint256 vaultId);
    /// @dev The deadline already sits at the horizon, so a check-in would move nothing.
    error DeadlinePinnedAtHorizon(uint64 absoluteDeadline);
    /// @dev The chain was built for installation epoch `expected`, but this installation is `next`.
    error CheckInChainEpochMismatch(uint32 expected, uint32 next);
    error InsufficientBalance(uint256 available, uint256 requested);
    error NothingToClaim(uint256 vaultId);
    error NothingCredited(address token, address account);
    error NativeTransferFailed(address to, uint256 amount);
    error NoSurplus();
    error FeeTooHigh(uint16 given, uint16 maximum);
    error RenounceDisabled();
    error UnsupportedToken(address token);
    error InvalidTokenConfig(address token);
    error ForbiddenPayoutAddress(address to);
    error PayoutOverdebited(address token, uint256 debited, uint256 amount);
    /// @dev The token reported a successful transfer but this contract's balance fell by less
    /// than `amount`; the credit is kept.
    error PayoutShortfall(address token, uint256 debited, uint256 amount);
    /// @dev A native payout to `to` did not leave exactly: `to` sent value back to this contract
    /// while being paid (see PAYOUT ADDRESSES). The credit is kept.
    error PayoutReturned(address to);
    error NoFeeRaisePending();
    error FeeRaiseNotDue(uint64 effectiveAt);
    error PushTooEarly(uint64 pushableAt);

    // ------------------------------------------------------------------ constructor

    /**
     * @param supported the ERC20s vaults may hold, fixed for the life of the contract. Refused:
     *        address(0) (that is the native coin, always accepted), this contract, duplicates.
     *        Vetting each token (see SUPPORTED TOKENS) is the deployer's job and cannot be
     *        corrected later, so the deploy script checks code and metadata before sending.
     * @param wrappedNative_ the chain's wrapped-native token, or address(0) for none. It must be
     *        in `supported`: a native payout is measured across the listed tokens only (PAYOUT
     *        ADDRESSES), so an unlisted wrapped-native token is the one asset a wrap-on-receive
     *        payee could hand a payout back in without being caught.
     */
    constructor(
        address initialAdmin,
        uint16 initialFeeBps,
        address initialFeeRecipient,
        address[] memory supported,
        address wrappedNative_
    ) Ownable(initialAdmin) {
        if (initialFeeBps > MAX_CLAIM_FEE_BPS) revert FeeTooHigh(initialFeeBps, MAX_CLAIM_FEE_BPS);
        for (uint256 i = 0; i < supported.length; i++) {
            address t = supported[i];
            if (t == NATIVE || t == address(this) || isSupportedToken[t]) revert InvalidTokenConfig(t);
            isSupportedToken[t] = true;
            _supportedTokens.push(t);
            emit TokenSupported(t);
        }
        // Also refuses this contract, which can never be listed.
        if (wrappedNative_ != NATIVE && !isSupportedToken[wrappedNative_]) revert InvalidTokenConfig(wrappedNative_);
        wrappedNative = wrappedNative_;
        // The same payout-address rule setFeeRecipient applies. address(0) passes it, and means
        // "charge nothing".
        _checkPayee(initialFeeRecipient);
        _claimFeeBps = initialFeeBps;
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

    /// @dev What _resetClock would write now. Never earlier than the stored deadline: _resetClock
    /// is the only writer of `deadline`, and every function that writes `inactivityPeriod` or
    /// `absoluteDeadline` calls it straight after, so the stored deadline is always
    /// min(t + inactivityPeriod, absoluteDeadline) for the second t of its last write.
    function _nextDeadline(Vault storage v) private view returns (uint64) {
        uint64 next = uint64(block.timestamp) + v.inactivityPeriod;
        uint64 cap = v.absoluteDeadline;
        return next < cap ? next : cap;
    }

    /// @dev The ONLY writer of `deadline`, so DeadlineReset is a complete record of it.
    function _resetClock(Vault storage v, uint256 vaultId) private {
        uint64 next = _nextDeadline(v);
        v.deadline = next;
        emit DeadlineReset(v.owner, vaultId, next, v.absoluteDeadline);
    }

    /**
     * @dev Any owner action supersedes a running claim: the owner acting IS the liveness proof
     * the claim asserted was missing. Unlike PQVault there is no proven recipient to preserve --
     * no one-time key was burned, so the beneficiary re-initiates for free once the (reset)
     * deadline expires again.
     *
     * PAST THE HORIZON this closes. _resetClock can no longer move `deadline` (it clamps to
     * absoluteDeadline, already in the past), so a claim displaced after the horizon could be
     * displaced again in the very next block -- an unbounded, zero-cooldown denial of the
     * inheritance. Exactly ONE action may still displace a claim then: extendHorizon, and only
     * because it is now required to name a genuinely future horizon, which restores a full
     * inactivity period of cooldown and is logged as HorizonExtended.
     *
     * A partial withdraw is deliberately NOT on that list. It was, in the first pass of this
     * audit, on the theory that it "actually moves the money out" -- but a 1 wei withdraw moves
     * nothing out and was a strictly better abortClaim: same effect, same gas, and you keep the
     * wei. Past the horizon a partial withdraw now leaves the claim running and the heir simply
     * inherits less. A full withdraw closes the vault, which ends the claim by ending the vault.
     */
    function _clearPending(Vault storage v, uint256 vaultId, uint8 action) private {
        if (v.state == STATE_CLAIM_PENDING) {
            if (block.timestamp >= v.absoluteDeadline && action != ACT_EXTEND_HORIZON) {
                revert HorizonReached(v.absoluteDeadline);
            }
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

    /// @dev Restarts the push grace when nothing was owed, and also when the new credit is at
    /// least as large as what was owed (see THE CREDIT LANE). Restarting only from zero would let
    /// anyone with a vault in the same token plant a 1-wei credit on an heir's claim recipient,
    /// wait out PUSH_GRACE, and then push the heir's whole inheritance in the settlement block.
    /// A smaller credit joins the running clock, with no grace of its own (THE CREDIT LANE).
    function _credit(address token, address to, uint256 amount) private {
        uint256 owed = _credits[token][to];
        if (amount >= owed) creditedSince[token][to] = uint64(block.timestamp);
        _credits[token][to] = owed + amount;
        _totalCredited[token] += amount;
    }

    /// @dev Debits `amount` of `account`'s credit, pays it to `to`, then logs it. Callers have
    /// refused amount == 0 where the caller chose it.
    function _payCredit(address token, address account, address to, uint256 amount) private {
        uint256 owed = _credits[token][account];
        if (owed == 0) revert NothingCredited(token, account);
        if (amount > owed) revert InsufficientBalance(owed, amount);
        _credits[token][account] = owed - amount;
        // A partial payment leaves the grace clock alone: what remains has been owed since then.
        if (amount == owed) delete creditedSince[token][account];
        _totalCredited[token] -= amount;
        _payout(token, to, amount);
        emit CreditPaid(token, account, to, amount);
    }

    /// @dev A raise whose time has come, recorded. claimFeeBps() already counts it from its
    /// effectiveAt; this only makes storage and the event history agree with that.
    function _recordMaturedRaise() private {
        uint64 at = pendingClaimFeeAt;
        if (at != 0 && block.timestamp >= at) {
            uint16 raised = pendingClaimFeeBps;
            emit ClaimFeeChanged(_claimFeeBps, raised);
            _claimFeeBps = raised;
            pendingClaimFeeBps = 0;
            pendingClaimFeeAt = 0;
        }
    }

    /// @dev Measures what actually arrived, because fee-on-transfer tokens deliver less than
    /// they were sent and recording the declared amount would slowly hollow out the locked lane.
    /// Capped at `amount`: the token controls the window between the two balance reads, and
    /// anything else that lands in it (a pool-wide rebase, a settled reward, a third party's
    /// payment) is not the depositor's and stays in surplus. A window in which the balance did
    /// not rise at all reverts NothingReceived instead of an arithmetic panic.
    /// Callers have already refused amount == 0.
    function _pull(address token, uint256 amount) private returns (uint256 received) {
        if (token == NATIVE) {
            if (msg.value != amount) revert NativeAmountMismatch(msg.value, amount);
            return amount;
        }
        if (!isSupportedToken[token]) revert UnsupportedToken(token);
        if (msg.value != 0) revert UnexpectedNativeValue();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBal = IERC20(token).balanceOf(address(this));
        if (afterBal <= before) revert NothingReceived();
        received = afterBal - before;
        if (received > amount) received = amount;
    }

    /// @dev The payout-address rule (see PAYOUT ADDRESSES). Callers handle address(0), which
    /// each of them treats differently (it passes here). wrappedNative needs no test of its own:
    /// the constructor requires it to be listed.
    function _checkPayee(address to) private view {
        if (to == address(this)) revert CannotPayToSelf();
        if (
            isSupportedToken[to] || uint160(to) >> 11 == uint160(OP_STACK_PREDEPLOYS) >> 11 || to == ENTRYPOINT_V06
                || to == ENTRYPOINT_V07 || to == ENTRYPOINT_V08 || to == ENTRYPOINT_V09
        ) revert ForbiddenPayoutAddress(to);
    }

    /// @dev ERC20 payouts are measured like deposits, and exactly `amount` must leave. A token
    /// that debits this contract by more (a fee charged on top) would otherwise take the
    /// difference out of other users' lanes and leave the last withdrawer short. A token that
    /// debits less while reporting success (a transfer that silently moves part or nothing)
    /// would otherwise retire the credit and leave the unpaid value here as surplus, which the
    /// admin could sweep. Either payout reverts instead, and the credit stays.
    /// A native payout to an address with code (a contract, or an EIP-7702 delegated account)
    /// runs that code, so it is measured across every asset the admin could sweep: afterwards
    /// the native balance must be exactly `amount` lower and every supported token's balance
    /// unchanged. A payee that sends value straight back (wraps the coin and forwards the wrapped
    /// token to msg.sender, or SELFDESTRUCTs to it) would otherwise retire the credit and leave
    /// its value here as surplus. It reverts PayoutReturned instead. An address with no code runs
    /// nothing when paid, so it cannot send anything back, and its payout reads no token at all:
    /// a listed token that misbehaves can never hold up a native payout to a wallet.
    /// (An ERC20 payout runs no payee code: supported tokens have no transfer hooks.)
    function _payout(address token, address to, uint256 amount) private {
        _checkPayee(to);
        if (token == NATIVE) {
            bool measured = to.code.length != 0;
            bytes32 expected;
            if (measured) expected = _holdings(amount);
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
            if (measured && _holdings(0) != expected) revert PayoutReturned(to);
        } else {
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(to, amount);
            uint256 afterBal = IERC20(token).balanceOf(address(this));
            uint256 debited = before > afterBal ? before - afterBal : 0;
            if (debited > amount) revert PayoutOverdebited(token, debited, amount);
            if (debited < amount) revert PayoutShortfall(token, debited, amount);
        }
    }

    /// @dev A digest of what this contract holds: its native balance less `less`, and its balance
    /// of every supported token. Each balance is read with at most BALANCE_READ_GAS and at most
    /// one word of returndata copied, and a read that fails, runs out of that gas or returns
    /// less than a word counts as type(uint256).max. So a listed token whose balanceOf reverts,
    /// burns its gas or returns a returndata bomb costs a payout at most 2 * BALANCE_READ_GAS
    /// and cannot freeze it. (Only payees with code are measured at all; see _payout.) A caller
    /// cannot starve a read to hide a return: a starved read counts as failed, a failed read
    /// hides a change only if the other read failed too, and a first read starved of gas leaves
    /// 1/64 of too little for the payee's call itself.
    /// Residuals, both needing a listed token to malfunction: a token that answers differently
    /// on each read blocks native payouts to payees with code (PayoutReturned; the credited
    /// account can route through a wallet instead); and a value returned INTO a token whose reads
    /// fail both times goes unnoticed, and is sweepable surplus once that token answers again.
    function _holdings(uint256 less) private view returns (bytes32) {
        uint256 n = _supportedTokens.length;
        uint256[] memory held = new uint256[](n + 1);
        held[n] = address(this).balance - less;
        for (uint256 i = 0; i < n; i++) {
            address t = _supportedTokens[i];
            uint256 b = type(uint256).max;
            assembly ("memory-safe") {
                // balanceOf(address(this)), in scratch space above the free memory pointer.
                let p := mload(0x40)
                mstore(p, shl(224, 0x70a08231))
                mstore(add(p, 4), address())
                // The call gets its own statement: Yul evaluates arguments right to left, so in
                // and(staticcall(..), gt(returndatasize(), ..)) the size would be the PREVIOUS
                // call's, and every read would count as failed.
                let ok := staticcall(BALANCE_READ_GAS, t, p, 0x24, p, 0x20)
                if and(ok, gt(returndatasize(), 0x1f)) { b := mload(p) }
            }
            held[i] = b;
        }
        return keccak256(abi.encode(held));
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
            // Reports the minimum that would have been accepted, not `now` -- a frontend showing
            // "current 1800000000, requested 1801000000" describes a valid extension being
            // refused and gives the user no way to learn the real floor.
            revert HorizonTooSoon(uint64(block.timestamp) + inactivityPeriod, absoluteDeadline);
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
        // The rate in force: a raise that is only scheduled does not count yet, so a vault
        // created before it takes effect keeps the old ceiling for good.
        v.feeBps = claimFeeBps();
        v.beneficiary = beneficiary;
        v.inactivityPeriod = inactivityPeriod;
        v.token = token;
        v.absoluteDeadline = absoluteDeadline;
        v.challengeWindow = challengeWindow;
        v.balance = received.toUint128();
        _resetClock(v, vaultId);

        ids.push(uint64(vaultId));
        _totalLocked[token] += received;
        vaultsCreated += 1;

        emit VaultCreated(
            msg.sender,
            vaultId,
            beneficiary,
            token,
            received,
            v.deadline,
            absoluteDeadline,
            inactivityPeriod,
            challengeWindow,
            v.feeBps
        );
    }

    /// @dev Permissionless. Deliberately does NOT reset the deadline -- if it did, any stranger
    /// could manufacture a liveness proof for a dead owner and deny the heir forever for the
    /// price of one wei. Refused mid-claim so the amount an heir is claiming cannot move
    /// underneath them. A gift is not quite harmless: a 1-wei topUp front-run onto an owner's
    /// exact-balance withdraw used to keep the vault open; withdraw(id, type(uint256).max, to)
    /// closes it whatever the balance has become.
    function topUp(address vaultOwner, uint256 vaultId, uint256 amount) external payable nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);

        uint256 received = _pull(v.token, amount);
        // Re-assert AFTER the transfer. A token with a receive hook can call back into the
        // owner's own functions during _pull; without this the deposit could be written onto a
        // vault the callback had already closed, stranding it outside every exit.
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);
        v.balance = (uint256(v.balance) + received).toUint128();
        _totalLocked[v.token] += received;
        emit ToppedUp(vaultOwner, vaultId, msg.sender, received);
    }

    // ------------------------------------------------------------------ liveness

    function checkIn(uint256 vaultId) external nonReentrant {
        Vault storage v = _vault(msg.sender, vaultId);
        uint64 horizon = v.absoluteDeadline;
        uint8 s = v.state;
        // ClaimPendingUseAbort names the veto, so it is only true before the horizon: past it
        // abortClaim reverts too, and a pending claim falls through to HorizonReached, whose
        // remedy (extendHorizon) is one of the two actions, with a full withdrawal, that still
        // end a claim there.
        if (s == STATE_CLAIM_PENDING && block.timestamp < horizon) revert ClaimPendingUseAbort(vaultId);
        if (s != STATE_ACTIVE && s != STATE_CLAIM_PENDING) revert VaultNotActive(vaultId, s);
        // Reverting rather than silently no-op'ing: min(...) past the horizon changes nothing,
        // and a no-op that costs gas and shows a green toast is a lie to the owner.
        if (block.timestamp >= horizon) revert HorizonReached(horizon);
        // The same lie one inactivity period earlier: once the deadline has reached the horizon
        // nothing can move it. A deadline still short of the horizon moves (clamped to it, the
        // last partial extension), so that check-in succeeds.
        if (v.deadline >= horizon) revert DeadlinePinnedAtHorizon(horizon);

        _resetClock(v, vaultId);
        emit CheckedIn(msg.sender, vaultId, v.deadline, false);
    }

    /**
     * @notice Refresh a whole split estate in one transaction.
     * @return refreshed how many vaults' deadlines this call actually moved. Each vault counts
     * at most once, so a repeated id does not inflate it.
     *
     * Vaults that cannot be checked in are SKIPPED, not reverted on: an unknown id; a settled
     * or closed vault; a pending claim (it needs abortClaim before the horizon, and extendHorizon
     * or a full withdrawal past it); a vault past its own horizon; a deadline pinned at the
     * horizon; or a deadline already moved at this second. Each skip is logged as
     * CheckInSkipped(owner, vaultId, reason). Strictness here was a trap: one vault reaching a
     * horizon chosen years earlier would revert the batch, so a keeper following the documented
     * pattern would silently stop refreshing all 32 vaults and hand every heir a premature
     * inheritance. So in a call that moves anything, every id gets exactly one log, CheckedIn
     * or CheckInSkipped, and a keeper must alert on every CheckInSkipped (above all
     * SKIP_CLAIM_PENDING and SKIP_CLAIM_PENDING_PAST_HORIZON: a check-in never ends a claim, and
     * past the horizon neither does abortClaim, so the two reasons name different remedies).
     * When no deadline moved at all the call reverts, so a total no-op still cannot masquerade
     * as success, and the logs roll back with it; the reasons do not: NothingCheckedIn(skipped)
     * carries one bit per SKIP_* reason seen. A keeper must treat that revert as "read getVault
     * now", never as a harmless duplicate: for a one-vault owner it is how a pending claim shows
     * up.
     */
    function checkInMany(uint256[] calldata vaultIds) external nonReentrant returns (uint256 refreshed) {
        uint256 n = vaultIds.length;
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        uint64 owned = vaultCount[msg.sender];
        uint8 skipped;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = vaultIds[i];
            uint8 skip;
            // An id the caller never had is skipped, not reverted on: leaving this one revert
            // path in place would have preserved the whole trap for any keeper whose id list
            // outran a customer's vault count.
            if (id >= owned) {
                skip = SKIP_UNKNOWN_ID;
            } else {
                Vault storage v = _vaults[msg.sender][id];
                uint8 s = v.state;
                // The two claim reasons differ in their remedy: abortClaim before the horizon,
                // extendHorizon or a full withdrawal past it (abortClaim reverts there).
                if (s == STATE_CLAIM_PENDING) {
                    skip = block.timestamp < v.absoluteDeadline ? SKIP_CLAIM_PENDING : SKIP_CLAIM_PENDING_PAST_HORIZON;
                } else if (s != STATE_ACTIVE) skip = SKIP_TERMINAL;
                else if (block.timestamp >= v.absoluteDeadline) skip = SKIP_HORIZON_REACHED;
                else if (v.deadline >= v.absoluteDeadline) skip = SKIP_PINNED;
                // Counting only moves is what makes `refreshed` a count of distinct vaults: the
                // second copy of an id finds its deadline already moved at this second.
                else if (_nextDeadline(v) <= v.deadline) skip = SKIP_REPEATED;
                else {
                    _resetClock(v, id);
                    refreshed += 1;
                    emit CheckedIn(msg.sender, id, v.deadline, false);
                    continue;
                }
            }
            skipped |= uint8(1) << skip;
            emit CheckInSkipped(msg.sender, id, skip);
        }
        if (refreshed == 0) revert NothingCheckedIn(skipped);
    }

    /**
     * @notice Arms, re-arms or disarms the vault's check-in chain. `anchor` and `count` both 0
     * disarm it (a leaked seed stops working at once); otherwise both must be set. Every call
     * moves the vault to a new installation epoch (hbEpoch + 1), and a chain works only on the
     * epoch it was built for (see hbStep), so re-arming never revives an earlier chain, even
     * one built from the same seed. Build the chain for getVault(...).hbEpoch + 1, and prefer
     * the overload that takes that epoch: a chain installed at any other epoch is dead from the
     * start, and nothing would say so until a keyless owner needed it.
     * @dev Owner-gated: installing a check-in chain extends liveness and therefore delays
     * inheritance, so it carries the same authority as checkIn itself. Like any owner action it
     * resets the clock and, before the horizon, ends a pending claim; past the horizon it
     * reverts, disarm included, so it can never serve as a veto there.
     */
    function setCheckInChain(uint256 vaultId, bytes32 anchor, uint32 count) external nonReentrant {
        _setCheckInChain(vaultId, anchor, count);
    }

    /// @notice setCheckInChain, refused (CheckInChainEpochMismatch) unless this installation is
    /// `expectedEpoch`, the epoch printed with the chain. That catches a chain built against a
    /// stale hbEpoch and an old printed chain being re-installed.
    function setCheckInChain(uint256 vaultId, bytes32 anchor, uint32 count, uint32 expectedEpoch)
        external
        nonReentrant
    {
        uint32 epoch = _setCheckInChain(vaultId, anchor, count);
        if (epoch != expectedEpoch) revert CheckInChainEpochMismatch(expectedEpoch, epoch);
    }

    function _setCheckInChain(uint256 vaultId, bytes32 anchor, uint32 count) private returns (uint32 epoch) {
        if ((anchor == bytes32(0)) != (count == 0) || count > MAX_HB_COUNT) revert InvalidCheckInChain();
        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        // checkInByChain reverts past the horizon, so installing a chain there would take a fee,
        // clear the "chain exhausted" warning, and hand the owner a mechanism that can never
        // fire -- exactly the green-toast lie checkIn refuses to tell. A disarm is refused there
        // too: a chain cannot fire past the horizon anyway, and a disarm that ended a claim
        // would reopen the veto loop (see _clearPending).
        if (block.timestamp >= v.absoluteDeadline) revert HorizonReached(v.absoluteDeadline);
        epoch = v.hbEpoch + 1;
        v.hbEpoch = epoch;
        v.hbAnchor = anchor;
        v.hbLeft = count;
        _resetClock(v, vaultId);
        _clearPending(v, vaultId, ACT_SET_CHECKIN_CHAIN);
        emit CheckInChainSet(msg.sender, vaultId, anchor, count, epoch);
    }

    /**
     * @notice One step of a vault's check-in chain: checkInByChain accepts `value` when
     * hbStep(owner, vaultId, hbEpoch, value) equals the vault's hbAnchor. It is
     * keccak256(abi.encode(HB_DOMAIN, block.chainid, address(this), vaultOwner, vaultId, epoch,
     * value)), exposed so a generator can check its own arithmetic against the contract.
     */
    function hbStep(address vaultOwner, uint256 vaultId, uint32 epoch, bytes32 value) public view returns (bytes32) {
        return keccak256(abi.encode(HB_DOMAIN, block.chainid, address(this), vaultOwner, vaultId, epoch, value));
    }

    /**
     * @notice S/KEY hash-chain check-in. Permissionless -- possession of the preimage is the
     * authentication, so msg.sender is irrelevant and the transaction is relayable.
     *
     * Its purpose is a real recovery path: an owner who has lost their wallet key can still keep
     * the vault alive from a 32-byte seed while they coordinate with their heir.
     *
     * Replay, stated precisely. Each value works once: the value just spent is refused
     * (CheckInAlreadyUsed), and the next one needs a hbStep preimage of it, which only the
     * seed's holder can compute. Every step is bound to this chain id, this contract, the
     * owner, the vault id and the installation epoch, so a value revealed on another vault,
     * owner, deployment, chain or earlier installation is useless here. What the contract
     * cannot see is the seed: build chains with scripts/checkin-chain.ts, whose tip is derived
     * from the seed, because the last check-in reveals the tip, and a tip that IS the seed
     * would hand that seed to anyone reading calldata.
     *
     * Its limits, stated plainly: it proves liveness, and nothing else. It cannot veto a claim
     * that is already pending (abortClaim needs the owner key), cannot withdraw, and cannot
     * change the heir. But unspent values are bearer credentials: whoever holds one can postpone
     * the heir by up to one inactivity period per value, as far as the horizon. Size `count` to
     * the keyless coordination window, not to a lifetime. A keyless owner's real endgame is for
     * the NAMED heir to claim and hand back.
     *
     * A value is spent only when it moves the deadline. Once the deadline sits at the horizon
     * (DeadlinePinnedAtHorizon), or a second time in one second (CheckInAlreadyUsed), this
     * reverts and the value stays unspent. The first check-in within one inactivity period of
     * the horizon still moves the deadline, to the horizon itself, and spends a value: keep a
     * relayer running until warnings bit 4 (pinned) is set, not one period less.
     *
     * And the sharp edge that follows from that: because initiateClaim needs no secret, an heir
     * watching the mempool can front-run a chain check-in that arrives after the deadline has
     * lapsed. While the vault is CLAIM_PENDING this function reverts, and a keyless owner cannot
     * end the claim. The chain survives only if every check-in lands STRICTLY BEFORE the
     * deadline -- run the relayer with real margin, never at the wire.
     */
    function checkInByChain(address vaultOwner, uint256 vaultId, bytes32 preimage) external nonReentrant {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);
        bytes32 anchor = v.hbAnchor;
        if (anchor == bytes32(0)) revert InvalidCheckInChain();
        if (v.hbLeft == 0) revert CheckInChainExhausted(vaultId);
        uint64 horizon = v.absoluteDeadline;
        if (block.timestamp >= horizon) revert HorizonReached(horizon);
        uint64 deadline = v.deadline;
        if (deadline >= horizon) revert DeadlinePinnedAtHorizon(horizon);
        if (preimage == anchor || _nextDeadline(v) <= deadline) revert CheckInAlreadyUsed(vaultId, deadline);
        // A zero value is refused, so hbAnchor == 0 always means "no chain armed" and an
        // exhausted chain can never pass for a disarmed one.
        if (preimage == bytes32(0) || hbStep(vaultOwner, vaultId, v.hbEpoch, preimage) != anchor) {
            revert BadCheckIn(vaultId);
        }

        v.hbAnchor = preimage;
        v.hbLeft -= 1;
        _resetClock(v, vaultId);
        emit CheckedIn(vaultOwner, vaultId, v.deadline, true);
    }

    // ------------------------------------------------------------------ owner actions

    /// @notice Credits `amount` of the vault to `to` (see THE CREDIT LANE). `amount` ==
    /// type(uint256).max means "everything, and close", whatever the balance is by the time the
    /// transaction lands.
    function withdraw(uint256 vaultId, uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _checkPayee(to);
        if (amount == 0) revert ZeroAmount();

        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        // A live vault never holds 0, so the sentinel always withdraws something.
        if (amount == type(uint256).max) amount = v.balance;
        else if (amount > v.balance) revert InsufficientBalance(v.balance, amount);

        v.balance = uint128(v.balance - uint128(amount));
        _totalLocked[v.token] -= amount;
        _credit(v.token, to, amount);
        _resetClock(v, vaultId);

        bool closed = v.balance == 0;
        if (closed) {
            // Closing ends any pending claim by ending the vault; there is nothing left to claim.
            // Said in the claim vocabulary too, so a tracker that follows only the Claim* events
            // does not keep a phantom claim open. Not routed through _clearPending: its
            // past-horizon revert would block the full withdrawal that must stay open there.
            if (v.state == STATE_CLAIM_PENDING) emit ClaimSuperseded(msg.sender, vaultId, ACT_CLOSE);
            v.state = STATE_CLOSED;
            v.claimInitiatedAt = 0;
            v.claimRecipient = address(0);
            vaultsClosed += 1;
            _removeFromOpen(msg.sender, v);
        } else if (block.timestamp < v.absoluteDeadline) {
            // Before the horizon a partial withdraw is a liveness proof like any other owner
            // action. Past it, see the note on _clearPending: it must not displace the claim.
            _clearPending(v, vaultId, ACT_WITHDRAW);
        }
        emit Withdrawn(msg.sender, vaultId, to, amount, closed);
    }

    function setBeneficiary(uint256 vaultId, address newBeneficiary) external nonReentrant {
        if (newBeneficiary == address(0) || newBeneficiary == address(this)) revert ZeroAddress();
        if (newBeneficiary == msg.sender) revert BeneficiaryIsOwner();

        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);

        address old = v.beneficiary;
        v.beneficiary = newBeneficiary;
        _resetClock(v, vaultId);
        _clearPending(v, vaultId, ACT_SET_BENEFICIARY);
        emit BeneficiaryChanged(msg.sender, old, newBeneficiary, vaultId);
    }

    function setInactivityPeriod(uint256 vaultId, uint32 newPeriod) external nonReentrant {
        if (newPeriod < MIN_INACTIVITY || newPeriod > MAX_INACTIVITY) revert InvalidPeriod(newPeriod);
        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        v.inactivityPeriod = newPeriod;
        _resetClock(v, vaultId);
        _clearPending(v, vaultId, ACT_SET_INACTIVITY);
        emit InactivityPeriodSet(msg.sender, vaultId, newPeriod);
    }

    /// @notice Reachable even after the horizon has passed, while the vault is live. The horizon
    /// exists to beat a LOST key and zombie automation (T3), not a living owner: a human holding
    /// the owner key deliberately extending their own horizon is the person the vault serves.
    /// `challengeWindow` has no setter at all -- its immutability is the heir's guarantee that a
    /// claim, once initiated, has a settlement date no one can stretch.
    /// Check-ins can only move the deadline up to the horizon: a new horizon within one
    /// inactivity period of now leaves the deadline pinned at it, and checkIn then reverts
    /// DeadlinePinnedAtHorizon. Extend well beyond the minimum to keep checking in.
    function extendHorizon(uint256 vaultId, uint64 newAbsoluteDeadline) external nonReentrant {
        Vault storage v = _vault(msg.sender, vaultId);
        _requireLive(v, vaultId);
        if (newAbsoluteDeadline <= v.absoluteDeadline) {
            revert HorizonNotExtended(v.absoluteDeadline, newAbsoluteDeadline);
        }
        // A horizon must be genuinely in the future by at least one inactivity period. Without
        // this, an owner already past their horizon could satisfy the check above with +1 second
        // -- clearing a pending claim, leaving `deadline` pinned in the past, and repeating every
        // block: the same unbounded veto loop abortClaim was closed to prevent, wearing the one
        // costume _clearPending still admits.
        uint64 floor = uint64(block.timestamp) + v.inactivityPeriod;
        if (newAbsoluteDeadline < floor) revert HorizonTooSoon(floor, newAbsoluteDeadline);
        uint64 max = uint64(block.timestamp) + MAX_HORIZON;
        if (newAbsoluteDeadline > max) revert HorizonTooFar(newAbsoluteDeadline, max);

        v.absoluteDeadline = newAbsoluteDeadline;
        _resetClock(v, vaultId);
        _clearPending(v, vaultId, ACT_EXTEND_HORIZON);
        emit HorizonExtended(msg.sender, vaultId, newAbsoluteDeadline);
    }

    // ------------------------------------------------------------------ claiming

    /// @dev Only the named beneficiary may initiate, and the recipient is their choice -- an heir
    /// should route the payout to a fresh address if they want one, without moving their identity
    /// key. There is no relayer path here: on the target chains gas is cents, and gating on
    /// msg.sender is what makes the beneficiary address the authority.
    function initiateClaim(address vaultOwner, uint256 vaultId, address recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();
        // Checked here, not only at payout: the recipient is recorded for the claim, and a
        // credit recorded for a token contract could never be claimed or pushed.
        _checkPayee(recipient);
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_ACTIVE) revert VaultNotActive(vaultId, v.state);
        if (msg.sender != v.beneficiary) revert NotTheBeneficiary(msg.sender, v.beneficiary);
        if (block.timestamp < v.deadline) revert NotYetExpired(v.deadline);
        if (v.balance == 0) revert NothingToClaim(vaultId);

        // Lock the effective fee for the whole challenge window. Without this the admin could
        // sandwich a settlement -- raise the rate back to the vault's ceiling immediately before
        // finalizeClaim and drop it immediately after -- taking a fee the heir had every public
        // reason to believe was lower. The rate can still only ever move DOWN from here.
        // "No recipient, no fee" is part of the rate being locked: a claim begun while no
        // recipient is in force stays fee-free even if one is set before settlement. A
        // recipient set after a period with none is in force only from feeRecipientActiveAt, so
        // it cannot be slipped in front of this transaction either.
        uint16 locked;
        if (feeRecipient != address(0) && block.timestamp >= feeRecipientActiveAt) {
            uint16 current = claimFeeBps();
            locked = current < v.feeBps ? current : v.feeBps;
        }
        v.lockedFeeBps = locked;

        v.claimRecipient = recipient;
        v.claimInitiatedAt = uint64(block.timestamp);
        v.state = STATE_CLAIM_PENDING;

        emit ClaimInitiated(vaultOwner, vaultId, recipient, uint64(block.timestamp) + v.challengeWindow, locked);
    }

    /**
     * @notice The heir's undo: the current beneficiary withdraws their own pending claim, for
     * instance to correct a mistyped payout address (initiateClaim records the recipient for the
     * claim, and this is the only way to change it). The vault returns to ACTIVE with its
     * deadline and horizon untouched, so the beneficiary can initiate again at once, with a new
     * recipient and a fresh, full challenge window.
     *
     * The cost, stated plainly: the payout address is NOT frozen for the life of a claim. Until
     * finalizeClaim is mined, the beneficiary key alone can cancel and re-initiate to any
     * address, so a beneficiary key stolen during the challenge window can redirect the payout,
     * at the price of one more full window (which the owner, if alive, can veto, and in which the
     * heir, still holding the key, can cancel again). Treat the beneficiary key as hot until
     * settlement, and finalize promptly once the window ends.
     *
     * It takes nothing from the owner. Re-initiating restarts the challenge window, so it only
     * ever postpones the heir's own settlement and never shortens the owner's time to veto. Past
     * the horizon the owner still cannot abort or check in; before it, an heir who cancels in
     * front of the owner's abortClaim and re-initiates behind it makes that one transaction
     * revert, but every other owner action (setInactivityPeriod, extendHorizon, setBeneficiary,
     * setCheckInChain, a withdrawal) works whether or not a claim is pending and still ends the
     * claim.
     *
     * The gap is the heir's cost, also stated plainly. Cancel and re-initiate are two
     * transactions, ClaimCancelled announces the first, and in between the vault is ACTIVE with
     * its deadline lapsed, so whatever a pending claim holds off works again:
     *   - before the horizon, the owner or the owner's automation may check in, and so may
     *     ANYONE holding an unspent check-in chain value (a bearer credential): one check-in
     *     postpones the heir's new claim by a full inactivity period (NotYetExpired);
     *   - past the horizon, where a pending claim makes setBeneficiary revert HorizonReached,
     *     the owner may name a new heir, who can claim at once -- where extendHorizon, the only
     *     way to stop the claim itself, would have cost a full inactivity period;
     *   - the new claim re-locks the fee at the rate then in force, up to the vault's ceiling
     *     (see FEES), which can be more than the cancelled claim had locked.
     * Re-initiate straight after the cancel (a smart-account beneficiary can batch the two).
     */
    function beneficiaryCancelClaim(address vaultOwner, uint256 vaultId) external nonReentrant {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_CLAIM_PENDING) revert NoClaimPending(vaultId);
        if (msg.sender != v.beneficiary) revert NotTheBeneficiary(msg.sender, v.beneficiary);
        v.state = STATE_ACTIVE;
        v.claimInitiatedAt = 0;
        v.claimRecipient = address(0);
        emit ClaimCancelled(vaultOwner, vaultId, msg.sender);
    }

    /// @dev The veto. Resets the clock, so the abort/re-claim loop is naturally rate-limited to
    /// once per inactivity period -- and unlike PQVault it costs the heir nothing but gas.
    function abortClaim(uint256 vaultId) external nonReentrant {
        Vault storage v = _vault(msg.sender, vaultId);
        if (v.state != STATE_CLAIM_PENDING) revert NoClaimPending(vaultId);
        // Past the horizon this ECDSA veto closes for good. _resetClock can no longer move the
        // deadline, so an abort here would be repeatable every block -- an unbounded denial of
        // the inheritance. A living owner who genuinely wants to stop a claim past the horizon
        // must say so explicitly with extendHorizon, which is logged as exactly that.
        if (block.timestamp >= v.absoluteDeadline) revert HorizonReached(v.absoluteDeadline);

        v.claimInitiatedAt = 0;
        v.claimRecipient = address(0);
        v.state = STATE_ACTIVE;
        _resetClock(v, vaultId);
        emit ClaimAborted(msg.sender, vaultId, v.deadline);
    }

    /// @dev Permissionless and free of external calls. Splitting settlement from payment keeps a
    /// hostile or non-payable recipient from jamming the vault: value lands in the credit lane
    /// and is pulled from there.
    function finalizeClaim(address vaultOwner, uint256 vaultId) external nonReentrant {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state != STATE_CLAIM_PENDING) revert NoClaimPending(vaultId);
        uint64 finalizableAt = v.claimInitiatedAt + v.challengeWindow;
        if (block.timestamp < finalizableAt) revert ChallengeWindowOpen(finalizableAt);

        uint256 amt = v.balance;
        address to = v.claimRecipient;
        address token = v.token;

        // lockedFeeBps was fixed at initiateClaim. Re-taking the minimum here lets a fee CUT
        // still in force at settlement reach the heir, while a rise can never take the fee above
        // the lock. A cut reversed before this transaction is mined does not count (see FEES).
        // No recipient in force means no fee, so an abandoned admin can never strand a claim.
        // "In force" is the same test initiateClaim applies: removing the recipient is a cut
        // that reaches this claim, and setting one again is a raise from zero that counts only
        // from feeRecipientActiveAt, so it cannot be slipped in front of this transaction.
        uint16 bps = v.lockedFeeBps;
        uint16 current = claimFeeBps();
        if (current < bps) bps = current;
        address feeTo = feeRecipient;
        uint256 fee =
            feeTo == address(0) || block.timestamp < feeRecipientActiveAt ? 0 : (amt * bps) / BPS_DENOMINATOR;

        v.balance = 0;
        _totalLocked[token] -= amt;
        _credit(token, to, amt - fee);
        if (fee != 0) _credit(token, feeTo, fee);
        v.state = STATE_SETTLED;
        vaultsSettled += 1;
        _removeFromOpen(vaultOwner, v);

        emit ClaimSettled(vaultOwner, vaultId, to, amt - fee, fee);
    }

    // ------------------------------------------------------------ the credit lane

    /// @notice Pays the caller's whole credit in `token` to `to`.
    function withdrawCredit(address token, address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = _credits[token][msg.sender];
        _payCredit(token, msg.sender, to, amount);
    }

    /// @notice Pays `amount` of the caller's credit in `token` to `to`; 0 < amount <= credit.
    /// For a token that caps a single transfer (or a wallet's balance), withdraw in pieces that
    /// fit. The rest stays credited, and its push grace keeps running from where it was.
    function withdrawCredit(address token, address to, uint256 amount) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _payCredit(token, msg.sender, to, amount);
        return amount;
    }

    /// @notice Pays `account`'s whole credit to `account` itself. The account may call this at any
    /// time; anyone else only from creditedSince + PUSH_GRACE (see THE CREDIT LANE).
    /// @dev It exists so a contract that can receive but cannot originate a transaction (a
    /// payable receive(), an exchange deposit address) is still paid -- provided that receive()
    /// does not read one of this contract's guarded views (see VIEWS), which revert while the
    /// push runs. The grace exists so a credited account that CAN act gets to route a new
    /// balance first: a push can deliver it into an address that is blocklisted by the token or
    /// cannot move it on. It runs per account balance, not per credit (see THE CREDIT LANE): a
    /// credit smaller than what is already owed joins the older clock, and once that clock has
    /// run out, it can be settled and pushed in one transaction.
    function pushCredit(address token, address account) external nonReentrant returns (uint256 amount) {
        if (msg.sender != account) {
            uint64 pushableAt = creditedSince[token][account] + PUSH_GRACE;
            if (block.timestamp < pushableAt) revert PushTooEarly(pushableAt);
        }
        amount = _credits[token][account];
        _payCredit(token, account, account, amount);
    }

    function creditOf(address token, address account) external view nonReentrantView returns (uint256) {
        return _credits[token][account];
    }

    // ------------------------------------------------------------------ admin

    /// @notice The claim fee in force now, in basis points: the recorded rate, or a scheduled
    /// raise once its effectiveAt has passed, whether or not anyone has applied it. This is what
    /// createVault snapshots and what initiateClaim and finalizeClaim compare against.
    function claimFeeBps() public view returns (uint16) {
        uint64 at = pendingClaimFeeAt;
        return at != 0 && block.timestamp >= at ? pendingClaimFeeBps : _claimFeeBps;
    }

    /**
     * @notice Bounded twice: by the bytecode constant here, and per vault by each vault's
     * creation-time ceiling. A rate at or below the one in force applies at once and cancels any
     * pending raise (so setClaimFee(claimFeeBps()) is how a raise is called off). A higher rate
     * is only scheduled, FEE_RAISE_DELAY from now, replacing any raise already pending.
     * @dev Without the delay a raise could be mined in the same block as, and just before, a
     * user's createVault or initiateClaim, and cut back just after: the rate that user had every
     * public reason to expect would never have been the rate they got.
     */
    function setClaimFee(uint16 newBps) external onlyOwner {
        if (newBps > MAX_CLAIM_FEE_BPS) revert FeeTooHigh(newBps, MAX_CLAIM_FEE_BPS);
        _recordMaturedRaise();
        uint16 current = _claimFeeBps;
        if (newBps > current) {
            uint64 at = uint64(block.timestamp) + FEE_RAISE_DELAY;
            pendingClaimFeeBps = newBps;
            pendingClaimFeeAt = at;
            emit ClaimFeeRaiseScheduled(current, newBps, at);
        } else {
            // A pending raise is always above the recorded rate, so it is above this one too.
            if (pendingClaimFeeAt != 0) {
                emit ClaimFeeRaiseCancelled(pendingClaimFeeBps);
                pendingClaimFeeBps = 0;
                pendingClaimFeeAt = 0;
            }
            emit ClaimFeeChanged(current, newBps);
            _claimFeeBps = newBps;
        }
    }

    /// @notice Permissionless: records a scheduled raise once its time has come. Housekeeping
    /// only -- the raise already counts from its effectiveAt (claimFeeBps()), so applying it, or
    /// not, can never change the fee any transaction pays.
    function applyClaimFee() external {
        uint64 at = pendingClaimFeeAt;
        if (at == 0) revert NoFeeRaisePending();
        if (block.timestamp < at) revert FeeRaiseNotDue(at);
        _recordMaturedRaise();
    }

    /// @dev The contract itself is refused: credits to self can never be paid out, so allowing
    /// it would let a careless admin strand fee revenue inside the credited lane forever. So are
    /// wrappedNative and the supported tokens (PAYOUT ADDRESSES): with them refused here too, no
    /// credit can ever be recorded for an address the payout rule refuses.
    /// Removing the recipient is a cut to zero and applies at once, to claims already pending
    /// too. Setting one after a period with none is a raise from zero: until
    /// feeRecipientActiveAt (now + FEE_RAISE_DELAY) claims initiated lock a zero fee and claims
    /// finalized pay none, whatever they locked. Replacing one recipient with another is neither.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient != address(0)) {
            _checkPayee(newRecipient);
            if (feeRecipient == address(0)) feeRecipientActiveAt = uint64(block.timestamp) + FEE_RAISE_DELAY;
        }
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

    /// @dev The only value an admin can ever reach, and the subtraction is the proof. Reports
    /// any token, but only the native coin and the supported tokens can be swept.
    function surplus(address token) external view nonReentrantView returns (uint256) {
        return _surplus(token);
    }

    /// @notice The Locked lane: the sum of every vault's balance in `token`. Guarded (see VIEWS).
    function totalLocked(address token) external view nonReentrantView returns (uint256) {
        return _totalLocked[token];
    }

    /// @notice The Credited lane: settled payouts in `token` awaiting pull. Guarded (see VIEWS).
    function totalCredited(address token) external view nonReentrantView returns (uint256) {
        return _totalCredited[token];
    }

    function _surplus(address token) private view returns (uint256) {
        uint256 accounted = _totalLocked[token] + _totalCredited[token];
        uint256 bal = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        return bal > accounted ? bal - accounted : 0;
    }

    /// @dev Native coin and supported tokens only. The lanes are keyed by token ADDRESS while a
    /// balance is read from a LEDGER, so sweeping through any other address -- a second entry
    /// point of a listed token, an ERC20 facade over the native coin -- would price depositors'
    /// funds as surplus. An unlisted ERC20 sent here by mistake therefore stays here.
    function sweepSurplus(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        if (token != NATIVE && !isSupportedToken[token]) revert UnsupportedToken(token);
        amount = _surplus(token);
        if (amount == 0) revert NoSurplus();
        _payout(token, to, amount);
        emit SurplusSwept(token, to, amount);
    }

    /// @dev Plain transfers are refused, so native value cannot enter through an ordinary call.
    /// SELFDESTRUCT and block-reward payments can still force-feed native value without running
    /// any code here; like force-fed supported tokens it lands in surplus and is sweepable. What
    /// no path can do is add value to a vault's balance without going through createVault or
    /// topUp.
    receive() external payable {
        revert UseTopUp();
    }

    // ------------------------------------------------------------------ views

    /**
     * @notice Warning bits, computed on chain so the frontend cannot silently drift from them.
     *   bit 0  expired -- the inactivity deadline has passed
     *   bit 1  horizon reached -- no check-in can extend this vault any further
     *   bit 2  a claim is pending
     *   bit 3  a check-in chain is armed and its declared count is used up (hbLeft is the
     *          owner's count, not a verified one; a disarmed chain sets no bit)
     *   bit 4  pinned -- the deadline has reached the horizon, which is still ahead, so checkIn
     *          reverts DeadlinePinnedAtHorizon; extendHorizon is the remedy
     *   bit 7  the vault is terminal
     */
    function warningsOf(address vaultOwner, uint256 vaultId) public view returns (uint16 w) {
        Vault storage v = _vault(vaultOwner, vaultId);
        if (v.state == STATE_SETTLED || v.state == STATE_CLOSED) return 1 << 7;
        if (block.timestamp >= v.deadline) w |= 1 << 0;
        if (block.timestamp >= v.absoluteDeadline) w |= 1 << 1;
        if (v.state == STATE_CLAIM_PENDING) w |= 1 << 2;
        if (v.hbAnchor != bytes32(0) && v.hbLeft == 0) w |= 1 << 3;
        if (v.deadline >= v.absoluteDeadline && block.timestamp < v.absoluteDeadline) w |= 1 << 4;
    }

    function getVault(address vaultOwner, uint256 vaultId) public view nonReentrantView returns (VaultView memory o) {
        Vault storage v = _vault(vaultOwner, vaultId);
        o.owner = v.owner;
        o.vaultId = vaultId;
        o.state = v.state;
        o.beneficiary = v.beneficiary;
        o.token = v.token;
        o.balance = v.balance;
        o.feeBps = v.feeBps;
        // Only a pending claim has a lock; an aborted or superseded claim leaves a stale value.
        if (v.state == STATE_CLAIM_PENDING) o.lockedFeeBps = v.lockedFeeBps;
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
        o.hbEpoch = v.hbEpoch;
        o.warnings = warningsOf(vaultOwner, vaultId);
    }

    /// @notice Bounded by MAX_OPEN_VAULTS, never by lifetime history.
    function getOpenVaults(address vaultOwner) external view nonReentrantView returns (VaultView[] memory out) {
        uint64[] storage ids = _openIds[vaultOwner];
        uint256 n = ids.length;
        out = new VaultView[](n);
        for (uint256 i = 0; i < n; i++) out[i] = getVault(vaultOwner, ids[i]);
    }

    function openVaultIds(address vaultOwner) external view returns (uint64[] memory) {
        return _openIds[vaultOwner];
    }

    /// @notice The ERC20s a vault may hold, in constructor order. The native coin (address(0))
    /// is always accepted and is not in the list.
    function supportedTokens() external view returns (address[] memory) {
        return _supportedTokens;
    }
}
