# InheritanceVault v2: changelog

**v2 is the fixed source** in `contracts/InheritanceVault.sol`, written in response to the preliminary
security audit of 2026-09. This file records its changes up to the pre-launch review of 27 September 2026,
when it was still undeployed. Nothing in it describes a deployment.

**v1 is immutable.** The InheritanceVault deployed on Base at
`0xC821849A1D74959753450409b594b23eCE7fEe2f` (Basescan-verified; source kept as
`contracts/v1/InheritanceVaultV1.sol`) cannot be changed. Every defect listed here is still present
there. Through every round below, the website app talked to v1, with the v1 ABI.

Each finding below has a `describe` block in `test/AuditPrelim2026-09.ts`. Every test in it fails on
v1, except those titled "(control)", "(guard)" or "(pin)". A "(pin)" test (review round 3) records a
cost that v2 accepts and documents, so it is not regression evidence: on v1 it asserts what v1 does
instead, where v1 lacks the cost, or it fails only because the v2 function it exercises is absent.
Most of the other tests fail for their finding's reason; tests of API that v2 adds as the fix itself
(for example `beneficiaryCancelClaim`, the three-argument `withdrawCredit`, `feeRecipientActiveAt`)
fail on v1 because the function is absent (see the file header, corrected in review rounds 1 and
3). To see the failures:

```sh
VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts
```

Runtime size is measured from `artifacts/.../InheritanceVault.json` as `deployedBytecode.length / 2 - 1`
(optimizer on, 200 runs, unchanged). The EIP-170 limit is 24,576 bytes. v1: 16,163 bytes.

---

## Pass 1: custody and tokens

Runtime size after pass 1: **17,130 bytes** (+967).

### Constructor (supports F01 and F09)

New signature:

```solidity
constructor(
    address initialAdmin,
    uint16 initialFeeBps,
    address initialFeeRecipient,
    address[] memory supported,
    address wrappedNative_
)
```

- `supported` is the ERC20 allowlist, fixed for the life of the contract. The constructor reverts
  `InvalidTokenConfig(token)` for `address(0)` (that is the native coin, which is always accepted and
  never listed), for the vault's own address, and for a duplicate. Each entry emits
  `TokenSupported(token)` at deployment.
- `wrappedNative_` is the chain's wrapped-native token, or `address(0)` for none. It reverts
  `InvalidTokenConfig` if it is the vault's own address. It is stored as the immutable
  `wrappedNative()`.
- `initialFeeRecipient` follows the F09 payout rule: `CannotPayToSelf` for the vault, and
  `ForbiddenPayoutAddress` for `wrappedNative_` or a listed token. `address(0)` still means "charge no
  fee".
- New views: `supportedTokens()` (the list, in constructor order), `isSupportedToken(address)` and
  `wrappedNative()`.
- The contract does not check that a listed address has code. `scripts/deploy.ts` does this before it
  sends anything (see below), so the check costs no runtime bytes.

### F01: immutable supported-token allowlist (Medium)

- `_pull` reverts `UnsupportedToken(token)` for any ERC20 that is not listed. That covers
  `createVault` and `topUp`. A `topUp` could never reach the check anyway, because its token was
  checked when the vault was created and the list cannot change. The check sits in `_pull` as defence
  in depth.
- `sweepSurplus(token, to)` reverts `UnsupportedToken(token)` unless `token` is the native coin or a
  listed token. The accounting lanes are keyed by token address while `balanceOf` reads a ledger, so a
  sweep through a second entry point, or through an ERC20 facade over the native coin, would price
  depositors' funds as surplus.
- No function adds or removes a listed token. The plan rules out an admin "add" function, because an
  admin able to list a ledger's second address could then sweep that ledger.
- NatSpec: T4 is now scoped to the native coin and the listed tokens. New SUPPORTED TOKENS section
  (the vetting rules the deployer must apply); NOT SUPPORTED rewritten.
- **Disclosed cost:** an unlisted ERC20 sent to the contract by mistake can no longer be swept, so it
  is stranded. Force-fed native coin and force-fed listed tokens are still sweepable.
- **Residual risk, which rests on the deployer:** the protection holds only if every listed token has
  exactly one address per ledger. If a deployer lists BOTH entry points of a double-entry token, v2 is
  still exposed. The same applies if an upgradeable listed token (USDC, cbBTC, USDT, BTCB) later gains
  a second entry point. The list is public and immutable, so a bad listing can be seen before anyone
  deposits.
  - Considered and not adopted: a post-sweep check that no other listed token's balance moved (the
    Compound pattern). It catches a double listing, but not a malicious listed token. The plan does
    not call for it, and it costs roughly 200 to 300 runtime bytes. It remains an option if the lead
    wants it.
- Tests (F01 block): sweep through the second address refused, with the principal intact; a settled
  credit still payable after the attempt; unlisted and second-address deposits refused; the native
  facade is never asked to move value; an unlisted force-fed ERC20 is stranded; (control) native and
  listed-token sweeps still work and take only the surplus; the list is readable and native coin needs
  no listing; (guard) no state-changing function in the ABI names a token or list; constructor
  validation.

### F09: payout addresses (Low)

- New private `_checkPayee(to)`: `CannotPayToSelf` for the vault itself, and
  `ForbiddenPayoutAddress(to)` for `wrappedNative` or any listed token.
- Applied to:
  - `withdraw` `to`, which replaces the old self-check and still reports `CannotPayToSelf` for the
    vault;
  - `initiateClaim` `recipient`, after the existing zero/self check, which still reports
    `ZeroAddress`;
  - `_payout`, which covers `withdrawCredit` `to`, `pushCredit`'s account and the `sweepSurplus` target;
  - `setFeeRecipient` (non-zero values only) and the constructor.
- **Deviation from the plan (a strict superset).** The plan names withdraw `to`, withdrawCredit `to`
  and the initiateClaim `recipient`. I also applied the rule to the fee recipient (setter and
  constructor) and to the sweep target. Reason: `finalizeClaim` credits `feeRecipient`, so it was the
  one remaining way to record a credit for WETH, which a push would then turn into vault-held WETH.
  With it closed, no credit can ever be recorded for an address the rule refuses. The `pushCredit`
  check is therefore defence in depth.
- Beneficiary addresses are unchanged. A token contract named as heir can never claim, which is an
  owner mistake the owner can correct. The plan does not list it.
- Tests (F09 block): the WETH round trip (claim to WETH, push, admin sweep) cannot happen; the
  initiateClaim, withdraw and withdrawCredit refusals, with the credit kept; the fee-recipient and sweep
  target refusals; the constructor fee recipient; (control) ordinary addresses and a zero fee
  recipient.

### F10: measured ERC20 payouts (Low)

- `_payout` reads `balanceOf(this)` before and after `safeTransfer`. It reverts
  `PayoutOverdebited(token, debited, amount)` when the balance fell by more than `amount`, which covers
  fee-on-top tokens and any other over-debit. A fee-on-transfer token debits the sender exactly
  `amount`, so it still pays.
- The same measurement protects `sweepSurplus`: a sweep can no longer overdraw into the locked lane.
- Not changed (the plan does not call for it): an issuer wipe or a negative rebase of the pooled
  balance still leaves the lane short, first come first served. The allowlist is the control for that
  class, and NatSpec names issuer action on a listed token as a pooled risk.
- Tests (F10 block): a fee-on-top payout reverts and the lane stays solvent; the last withdrawer is
  never left short; a fee-on-top sweep reverts; (control) a fee-on-transfer payout still pays.

### F42: deposits capped at the amount sent (Low)

- `_pull` now does `if (after <= before) revert NothingReceived(); received = min(after - before, amount)`.
  A gain that lands inside the deposit window (a pool rebase, a settled reward, a hook-injected payment)
  stays in surplus instead of being written into the depositor's vault. A window in which the balance
  did not rise reverts `NothingReceived` instead of `Panic(0x11)`.
- Not adopted (not in the plan): a caller-supplied `minReceived`. A depositor can still absorb an
  in-window loss smaller than the deposit. The allowlist excludes the token classes that do this.
- Tests (F42 block): createVault and topUp capped (event amounts and balances); a loss larger than the
  deposit reverts `NothingReceived` (on v1 it panics); (control) a loss equal to the deposit.

### F33: view reentrancy guard (Informational)

- OZ 5.6.1 `nonReentrantView` on `surplus`, `getVault`, `getOpenVaults` and `creditOf`, exactly as the
  plan says. `surplus` is now `external` and delegates to a private `_surplus`, which `sweepSurplus`
  calls while it holds the lock. `getOpenVaults` still calls `getVault`; the view guard only reads
  the lock, so this is fine.
- **Known consequence, flagged for the lead.** A native-payout recipient whose `receive()` reads one of
  those four views now reverts, so `pushCredit` cannot pay it (`NativeTransferFailed`; the credit
  stays). The digest's severity reviewer asked for the opposite property, "a recipient whose receive()
  reads creditOf is still paid". I followed the plan, which is binding, documented the cost in NatSpec
  (VIEWS, and on `pushCredit`), and pinned it with a test so any change is deliberate. If the lead
  prefers the reviewer's option, guard only `surplus`, or expose `reentrancyGuardEntered()`.
- Unguarded, per the plan: the `totalLocked` and `totalCredited` public getters, `warningsOf`,
  `openVaultIds` and `isSupportedToken`.
- Note for later passes: never call a guarded view from inside a `nonReentrant` function. Use the
  internal form, as `sweepSurplus` does with `_surplus`.
- Tests (F33 block): a token callback in the deposit window gets `ReentrancyGuardReentrantCall` from
  all four views, and the deposit itself goes through; (control) the views answer outside a
  transaction and `sweepSurplus` works; the pinned consequence above.

### F11: yield on rebasing, reflection and aToken deposits (Low, covered by F01)

No separate code change: unlisted tokens cannot be deposited and cannot be swept. Tests (F11 block):
an unlisted yield token is refused at the door, and the admin can take no yield.

### F39: A-05 regression test pinned (Informational, tests only)

`test/Audit.ts` A-05 now pins each block's timestamp with `time.setNextBlockTimestamp(latest + 60)`.
Each call gets its own pin, because a reverted transaction is still mined in this setup. The test
keeps an exact equality and adds the inclusive-minimum boundary pair (`t + PERIOD - 1` reverts,
`t + PERIOD` succeeds). Before this change it failed intermittently (seen at the start of this pass).

### Tests: one deploy helper

- New `test/helpers/deploy.ts`: `deployVault(opts)` is the only place any test deploys
  InheritanceVault. With `VAULT_IMPL=v1` it deploys `InheritanceVaultV1` and attaches the v2 ABI, for
  the v1-failure check.
- `test/InheritanceVault.ts` and `test/Audit.ts` now use it. Their tokens are deployed first and
  listed. No assertion was removed or weakened.
- New mocks in `contracts/test/TestHelpers.sol`: `DoubleEntryToken`/`DoubleEntryForwarder`,
  `NativeFacadeRecorder`, `WrappedNativeMock`, `FeeOnTopToken`, `DepositWindowToken`, `ViewProbeToken`
  and `ViewReadingReceiver`. Their names are distinct from the v1 evidence suite's `F0x_*` mocks.

### scripts/deploy.ts (the constructor part only)

- Adds per-network token lists and `wrappedNative`: Base WETH/USDC/cbBTC, BNB WBNB/USDT/USDC/BTCB,
  Base Sepolia WETH/USDC, BNB testnet WBNB. Addresses and symbols were checked read-only on 2026-09-26.
- **These lists are proposals.** The user confirms them before any mainnet deploy, because they can
  never change afterwards.
- Overrides: `SUPPORTED_TOKENS=0xA,0xB|none` and `WRAPPED_NATIVE`.
- Before sending anything, the script:
  - refuses duplicates and `address(0)`;
  - requires a wrapped-native token on mainnets;
  - requires contract code at every address;
  - checks each `symbol()` against the table;
  - prints the list with the warning that it is permanent.
- After deploying, it reads back `wrappedNative()` and `supportedTokens()`.
- It writes `deployments/<net>.vault-args.js` for `hardhat verify --constructor-args`, because
  `hardhat verify` cannot take the array argument on the command line.
- Rehearsed on a local node (port 8547): deploy and read-back pass; a no-code address and a duplicate
  are both refused before sending. The rehearsal files were removed afterwards.
- **Not done in this pass:** the rest of F31 (drop NotifySubscription, require explicit
  `ADMIN_ADDRESS`/`FEE_RECIPIENT` on mainnets, `transfer-admin.ts` without a subscription).
  Done in pass 4.

---

## Pass 2: credits, claims and fees

Runtime size after pass 2: **19,005 bytes** (+1,875 over pass 1; optimizer unchanged, 200 runs).
Headroom to EIP-170: 5,571 bytes.

Full suite after pass 2: `npx hardhat test` gives 139 passing, 0 failing (92 before this pass). The
47 new tests are in `test/AuditPrelim2026-09.ts`. With `VAULT_IMPL=v1`, every new test fails except
the 11 titled "(control)" or "(guard)". Each fails on the finding's own defect: the heir recovers 0,
a fee is charged, the rate jumps at once, the credit is pushed, the event is missing or out of order,
or the v2-only function or field does not exist.

### F04: partial credit withdrawal (Medium)

- New overload `withdrawCredit(address token, address to, uint256 amount) returns (uint256)`. It
  requires `0 < amount <= credit` (`ZeroAmount`, `InsufficientBalance(owed, amount)`,
  `NothingCredited` when nothing is owed) and reduces `_credits` and `totalCredited` by exactly
  `amount`. The two-argument form is unchanged and still pays the whole credit.
- Both forms and `pushCredit` now share one private `_payCredit`. It keeps the `ZeroAddress`,
  F09 payee and F10 measurement checks.
- `pushCredit` stays full-amount only, as the plan says. A passive contract recipient of a capped
  token still cannot be paid in pieces. The credited account can always pull in pieces.
- NatSpec: NOT SUPPORTED now says the last claimant after a negative rebase gets what is left, not
  nothing, and that transfer-capped and max-wallet tokens must not be listed. A max-wallet cap on
  the vault's own balance would refuse deposits.
- ethers v6 note for integrators: with two overloads, call the three-argument form by its
  signature, `vault["withdrawCredit(address,address,uint256)"](...)`. The two-argument call
  `vault.withdrawCredit(token, to)` still resolves without overrides.
- Tests (F04 block): a MaxTxToken (cap 100) estate of 199 reaches the heir in cap-sized parts; a
  stranger's topUp over the cap does not freeze it; a stranger's `withdraw(to = heir)` merge does
  not freeze it; exact debit and every refusal; (control) the two-argument form pays in full.

### F05: the fee lock respects the zero fee recipient (Low)

- `initiateClaim` sets `lockedFeeBps = 0` when no fee recipient is in force. Otherwise it sets
  `min(claimFeeBps(), v.feeBps)`. `finalizeClaim` is unchanged: it takes the minimum with the
  current rate and charges nothing without a recipient at settlement. (Review round 1 changed
  this: `finalizeClaim` now also charges nothing before `feeRecipientActiveAt`. See below.)
- **Deviation from the plan (strictly better, for heirs).** The plan's lock stops a recipient set
  during the challenge window. It does not stop a recipient set in the same block as, and just
  before, the heir's `initiateClaim`. That is the same sandwich reached one step earlier. So
  switching fees back on is treated as a raise from zero:
  - `setFeeRecipient(x)` with the old recipient at `address(0)` sets
    `feeRecipientActiveAt = now + FEE_RAISE_DELAY`;
  - `initiateClaim` locks 0 until then.
  - Removing the recipient is a cut and applies at once.
  - Replacing one non-zero recipient with another changes nothing.
  - On a deployment that starts with a recipient, `feeRecipientActiveAt` is 0.
  - Cost: the operator collects no fee on claims begun in the 30 days after re-enabling fees.
    Users lose nothing.
- Not adopted (the severity reviewer advised against it): snapshotting `feeBps = 0` at
  `createVault` when there is no recipient.
- Tests (F05 block): a recipient set mid-window takes nothing; the one-block recipient sandwich
  around `finalizeClaim` takes nothing; a deployment that starts with no recipient charges nothing
  on an in-flight claim; a recipient front-run onto `initiateClaim` takes nothing (the deviation);
  (control) fees resume after the delay; (control) a recipient removed mid-claim means no fee.

### F06: fee raises are timelocked (Low)

- `FEE_RAISE_DELAY = 30 days`.
- `setClaimFee(newBps)`, `onlyOwner`, capped at `MAX_CLAIM_FEE_BPS` as before:
  - **Cut** (`newBps <=` the rate in force): applies at once and emits `ClaimFeeChanged`. It
    cancels any pending raise (`ClaimFeeRaiseCancelled`). `setClaimFee(claimFeeBps())` is how a
    raise is called off.
  - **Raise**: only scheduled. It sets `pendingClaimFeeBps` and
    `pendingClaimFeeAt = now + FEE_RAISE_DELAY`, emits `ClaimFeeRaiseScheduled(current, new,
    effectiveAt)`, and replaces any earlier pending raise, restarting the delay.
- `applyClaimFee()` is permissionless. It reverts `NoFeeRaisePending`, or `FeeRaiseNotDue(at)`
  before the delay. After the delay it records the raise (`ClaimFeeChanged`).
- **The raise counts from its announced second whether or not anyone applies it.** `claimFeeBps`
  is now a view: the recorded rate, or the pending raise once `pendingClaimFeeAt` has passed.
  `createVault`, `initiateClaim` and `finalizeClaim` all read it. The recorded rate moved to the
  private `_claimFeeBps`. The getter name and selector are unchanged.
- Why lazy: if a matured raise took effect only when applied, the admin could hold it back and
  apply it in the block before a victim's `createVault` or `initiateClaim`, then cut back after.
  That is the one-block sandwich again. With a lazy rate, `applyClaimFee` is only housekeeping, so
  the storage and the event history agree with the rate already in force. `setClaimFee` records a
  matured raise first, so a later cut or raise is measured from the rate in force.
- How the snapshot points interact with a pending raise:
  - `createVault` snapshots the rate in force, and a scheduled raise does not count. A vault created
    during the notice period keeps the old ceiling for good.
  - `initiateClaim` locks `min(rate in force, ceiling)`, and `finalizeClaim` can only lower that.
    A raise that matures during a claim never reaches it (the A-04 property; control test).
  - No admin transaction can raise any of these three reads within a block.
- **Residual, documented.** A raise matures at a public, predictable second, 30 days after it was
  announced. An heir whose vault's deadline falls after that second locks the new rate, up to the
  vault's creation ceiling, and cannot initiate earlier. This is announced 30 days ahead, bounded
  by the ceiling the owner accepted, and the same for everyone. It is not a sandwich. The APP
  disposition (show the current and pending rates) is what makes it visible.
- Not adopted: `maxFeeBps` arguments. The plan chose the timelock, which protects plain EOAs with
  no ABI change.
- Tests (F06 block): a raise is only scheduled, keeps the old rate one second before its time, and
  counts at that second unapplied (pinned block timestamps); `createVault` front-run sandwich (one
  block, tip-ordered, order asserted); the two-point claim sandwich; a cut cancels a pending raise,
  and re-affirming the rate calls one off; a new raise replaces and restarts; `applyClaimFee`
  refusals, permissionlessness, no rate change, and a cut measured from a matured-but-unapplied
  raise; (control) A-04 still holds.

### F08: third-party pushes wait PUSH_GRACE (Low)

- `PUSH_GRACE = 30 days`. New public mapping `creditedSince(token, account)`.
- `pushCredit` by anyone other than `account` reverts `PushTooEarly(pushableAt)` before
  `creditedSince + PUSH_GRACE`. The account itself may push at any time.
- A full payout deletes `creditedSince`. A partial payout (F04) leaves it alone, because what
  remains has been owed since then.
- **Deviation from the plan (strictly better).** The plan restarts the clock only when the credit
  goes from zero to non-zero. That lets anyone who has a vault in the same token plant a 1-wei
  credit on an heir's payout address with `withdraw(id, 1, heir)` and wait out `PUSH_GRACE`. When
  the inheritance settles into the same account, it can then be pushed in the settlement
  transaction, which is exactly the F08 attack.
  - v2 restarts the clock whenever a new credit is at least as large as what is already owed
    (`amount >= owed`, which includes `owed == 0`).
  - The fee recipient's stream of smaller fees does not restart it, so its credit stays pushable
    `PUSH_GRACE` after it was first owed. A test checks this.
  - Restarting the clock on someone else's credit now costs a gift at least equal to that credit,
    and the gift goes to the victim.
  - A plant large enough to expose an inheritance must be at least as large as the inheritance.
  - The test "a 1-wei credit planted early..." fails under the plan-literal rule.
- **Known cost.** A payout address that cannot originate a call (an exchange deposit address, a
  receive-only contract) is now paid by a keeper 30 days after settlement, not at once. Neither the
  heir nor the owner can push early for another address. The owner can instead withdraw to
  themselves and route with `withdrawCredit(token, to)`.
- NatSpec: the new THE CREDIT LANE section, `pushCredit`, and PAYOUT ADDRESSES now scope the
  routing escape to "provided it acts within PUSH_GRACE".
- Tests (F08 block): a stranger's atomic settle-and-push onto a Tether-style blocklisted heir is
  refused and the heir routes elsewhere; a stranger's push cannot front-run a call-only forwarder;
  the 1-wei plant (the deviation); the fee recipient's accruing credit is pushable exactly
  `PUSH_GRACE` after the first fee (pinned timestamp); a partial payout keeps the clock and a full
  one clears it; (control) the account pushes its own credit at any time; (control) a stranger may
  push after the grace.
- Existing tests adapted: `test/InheritanceVault.ts` "pushCredit pays an account that cannot
  originate transactions" now first asserts `PushTooEarly` with the exact time, then waits and
  keeps its payout assertion. In the F33 block, "pins the documented cost..." waits out the grace
  before its unchanged `NativeTransferFailed` assertion.

### F14: ClaimSuperseded(ACT_CLOSE) on a closing withdrawal (Low)

- New tag `ACT_CLOSE = 6`. When a withdrawal closes a `CLAIM_PENDING` vault, `withdraw` emits
  `ClaimSuperseded(owner, vaultId, ACT_CLOSE)` before `Withdrawn(..., closed = true)`.
- It is emitted inline, not through `_clearPending`, whose past-horizon revert would block the full
  withdrawal that must stay open there.
- The event NatSpec says every other tag means the vault is ACTIVE again, and `ACT_CLOSE` means it
  is CLOSED.
- Tests (F14 block): before the horizon (exact log order); past the horizon (a partial
  withdrawal still leaves the claim running, the full one ends it with `ACT_CLOSE`); an
  event-sourced tracker agrees with storage; (control) a partial withdrawal still emits
  `ACT_WITHDRAW`, and a close with no claim pending emits no `ClaimSuperseded`.

### F20: beneficiaryCancelClaim (Low)

- New function `beneficiaryCancelClaim(vaultOwner, vaultId)`, `nonReentrant`:
  - callable only while `CLAIM_PENDING` (`NoClaimPending`), and only by the current beneficiary
    (`NotTheBeneficiary`);
  - returns the vault to ACTIVE, clears `claimRecipient` and `claimInitiatedAt`, and leaves
    `deadline` and `absoluteDeadline` untouched;
  - emits the new event `ClaimCancelled(owner, vaultId, beneficiary)`.
- The heir can re-initiate at once with a new recipient and a fresh, full challenge window.
- **Checked against the veto loop and hostile-heir griefing:**
  - Re-initiating restarts the challenge window, so a cancel only postpones the heir's own
    settlement. It never shortens the owner's time to veto (test).
  - Past the horizon the owner gains nothing: `abortClaim` reverts `NoClaimPending` and `checkIn`
    reverts, so no owner-side loop reopens (test).
  - **Known limitation (documented in NatSpec, pinned by a control test).** A hostile heir can
    cancel in front of the owner's `abortClaim` and re-initiate behind it in one block. That one
    `abortClaim` then reverts `NoClaimPending`. Doing this costs the heir two transactions each
    time and restarts the window each time, and it cannot keep a claim alive. Every other owner
    action (`setInactivityPeriod`, `extendHorizon`, `setBeneficiary`, `setCheckInChain`, a
    withdrawal) clears a pending claim and resets the clock whether or not a claim is pending. The
    control test shows `setInactivityPeriod` ending it. APP note: after a failed Veto, retry with
    one of those actions rather than `abortClaim`.
  - Until the heir re-initiates, the vault is ACTIVE, so the owner, a keeper or a check-in chain
    relayer may check in. A new claim re-locks the fee at the rate then in force. Both are in the
    NatSpec.
- Tests (F20 block): a mistyped recipient is corrected and the estate reaches the heir; the state
  after a cancel and the event; the access and state checks; the fresh window, with the owner's
  veto intact; no reopening past the horizon; (control) the front-run grief cannot keep the claim
  alive; (control) the owner's veto works.

### F22: withdraw(id, type(uint256).max, to) closes (Low)

- The sentinel is checked before `InsufficientBalance`. It withdraws the whole balance at mining
  time, closes the vault, and reports the real amount in `Withdrawn`. Any other amount above the
  balance still reverts.
- The `topUp` comment "a gift cannot harm" is corrected.
- Tests (F22 block): a 1-wei front-run topUp (tip-ordered, one block, order asserted) cannot keep
  the vault open, and the griefer's wei is credited to the owner; with a claim pending, the sentinel
  closes and emits `ACT_CLOSE`; (control) exact-balance closes and over-balance reverts.

### F25: the locked fee is visible (Informational)

- `VaultView` gains `lockedFeeBps`, after `feeBps`. It is shown only while a claim is pending, and is
  0 otherwise, so a value left by an aborted claim is never shown. With F05, it is the most the
  claim will pay.
- `ClaimInitiated` gains a fifth, non-indexed field, `lockedFeeBps`. **This changes its topic
  hash** from v1. `notify/watcher.js` hard-codes the v1 four-field signature, which is correct for
  v1 and must change for any v2 deployment.
- Not adopted (not in the plan): an `effectiveFeeBps` field. Also not adopted: zeroing the timing
  fields of terminal vaults. `warnings` bit 7 stays the authoritative terminal flag. `hbEpoch` in
  VaultView belongs to F02, which is a later pass.
- Tests (F25 block): the ceiling and the locked rate are read, and settlement takes the locked
  rate; the event field; a zero lock with no recipient; no stale value after an abort.

### F26: value events (Informational)

- `CreditPaid` is emitted after the transfer succeeds, in `_payCredit`.
- **Also moved, beyond the plan:** `SurplusSwept` is now emitted after its transfer, so every
  transfer-out event follows its transfer.
- The amount stays gross, as sent. The NatSpec says so.
- NatSpec on each value event states whether it records a TRANSFER IN (`VaultCreated`,
  `ToppedUp`), a CREDIT (`Withdrawn`, `ClaimSettled`) or a TRANSFER OUT (`CreditPaid`,
  `SurplusSwept`). The new THE CREDIT LANE header section says the same.
- Tests (F26 block): the log order `Transfer`, then `CreditPaid`, for `withdrawCredit`; a native
  push logs the recipient's `receive()` first; `Transfer`, then `SurplusSwept`, for a sweep;
  (guard) the NatSpec above each value event is checked in the source.

### Tests and test infrastructure

- New mocks in `contracts/test/TestHelpers.sol`:
  - `MaxTxToken` (F04);
  - `SenderBlocklistToken`, `SettleAndPush` and `CallOnlyForwarder` (F08);
  - `LoggingReceiver` (F26);
  - the interface `IVaultCreditLane`.
- None of these names collides with the `F0x_*` names in `contracts/audit/`. `MaxTxToken` and
  `SenderBlocklistToken` are added to the prelim fixture's supported list.
- `test/helpers/deploy.ts`, v1 mode: v1 is now attached with a hybrid ABI. It is the v2 ABI, except
  where v1 has the same function with different outputs (`getVault`'s VaultView) or an event of the
  same name with a different signature (`ClaimInitiated`); there v1's own fragment is used. A v1
  run then sees a v2-only field as missing instead of hitting a decoding error, and pass 1's v1-mode
  controls that read `getVault` still pass. The v1 check gives the same pattern as before for pass
  1 (6 passing, 23 failing) and adds pass 2's 11 controls/guards passing and 36 failing.
- Existing tests adapted to the F06 delay. No assertion was removed or weakened:
  - `test/InheritanceVault.ts` "snapshots the claim fee at creation" now also creates a vault during
    the notice period, which gets the old ceiling, and one after it, which gets the new one;
  - `test/Audit.ts` A-04 "locks the effective rate at initiateClaim" now waits for the raise to be
    in force before settling and asserts `claimFeeBps() == 100`, so the lock rather than the delay
    is what it tests;
  - A-04 "a rate locked during a promotion..." waits `max(PERIOD + 1, FEE_RAISE_DELAY)` and asserts
    the restored rate before re-locking.

### Flagged for the lead (outside this pass's files)

- `scripts/smoke.ts` and `scripts/close-vault.ts` attach the **v2** `InheritanceVault` artifact ABI
  to the address in `deployments/<net>.json`, which on Base is v1. v2's `VaultView` now has one
  more field, so their `getVault` calls will fail to decode against v1. Point them at
  `InheritanceVaultV1`, or select the ABI by the deployment's version. `withdrawCredit(token, to)`
  still resolves.
- `notify/watcher.js`: the `ClaimInitiated` signature (above) and the new `ClaimCancelled`, which a
  v2 claim tracker must treat as ending a claim.
- APP: the F06 current and pending rate display should read `claimFeeBps()`,
  `pendingClaimFeeBps()`, `pendingClaimFeeAt()` and, for heirs, `feeRecipient()` and
  `feeRecipientActiveAt()`.

---

## Pass 3: check-ins, the hash chain and events

Runtime size after pass 3: **20,262 bytes** (+1,257 over pass 2; optimizer unchanged, 200 runs).
Headroom to EIP-170: 4,314 bytes.

Full suite after pass 3: `npx hardhat test` gives 173 passing, 0 failing (139 before this pass).
The 34 new tests are in `test/AuditPrelim2026-09.ts`. With `VAULT_IMPL=v1` the file gives 26
passing and 84 failing. Of the 34 new tests, 25 fail and the 9 titled "(control)" or "(guard)"
pass. Each failure is the finding's own defect:

- F02: a forged check-in is accepted (24 in the damage loop), or v1 has no domain-separated step,
  no `hbEpoch` or no epoch-checked install;
- F28: the disarm is refused, or a zero value is accepted;
- F18: a check-in that moves nothing succeeds, spends a value or is counted, or bit 4 is missing;
- F15: a skip leaves no log, or the count is 5 or 2 where it should be 2 or 1;
- F27: `DeadlineReset`, `inactivityPeriod` or the indexed old heir is missing.

The pre-pass-3 v1 pattern (17 passing, 59 failing) is unchanged.

### F02: the chain step is domain-separated (Medium)

- `checkInByChain` accepts `preimage` only if
  `keccak256(abi.encode(HB_DOMAIN, block.chainid, address(this), vaultOwner, vaultId, hbEpoch, preimage)) == hbAnchor`.
  `HB_DOMAIN = keccak256("WillAndKey.CheckInChain.v2")` is a public constant. This is the tag the
  auditor's PoC used.
- The per-vault `uint32 hbEpoch` is packed into the free 32 bits of storage slot 3. It is 0
  before the first installation, and every `setCheckInChain` increments it, a disarm included. A
  chain installed at epoch `e` must be built for `e`, so a re-armed chain is unrelated to every
  earlier one, even one from the same seed. `hbEpoch` is in `VaultView`, after `hbLeft`.
- **Beyond the plan (strictly better), four additions:**
  - **`setCheckInChain(uint256 vaultId, bytes32 anchor, uint32 count, uint32 expectedEpoch)`**,
    an overload that reverts `CheckInChainEpochMismatch(expected, next)` unless the installation
    gets exactly `expectedEpoch`. It closes the trap the severity reviewer named: a chain built
    against a stale epoch, or an old printed chain installed again, is otherwise accepted and dead
    from the start, and the failure shows only when a keyless owner needs it. The plan's
    three-argument form is unchanged, and the F28 disarm uses it. The generator and the spec use
    the four-argument form. A test pins both behaviours.
  - **`hbStep(vaultOwner, vaultId, epoch, value)`**, a public view that computes one step, so a
    generator can check its arithmetic against the contract. `checkInByChain` uses it internally.
  - **`CheckInChainSet` gains `uint32 epoch`**, the epoch of the new installation. **Its topic
    hash changes.**
  - The chain's recommended tip is derived by the generator, never the raw seed (below).
- NatSpec corrected. The old "a captured check-in can be replayed but never extended" was wrong
  in both halves. It now says that a spent value is refused, that a value revealed in any other
  context is useless, and that the last check-in reveals the tip. It also says that unspent
  values are bearer credentials, worth up to one inactivity period each as far as the horizon
  (the accurate wording F17 asks for, in the contract's own NatSpec). The header gains a THE
  CHECK-IN CHAIN section.
- **What the contract cannot fix (variant b).** If a chain's tip is the raw seed, its last
  check-in publishes the seed. Anyone can then build every later chain from that seed, epoch or
  not. Only the off-chain derivation closes this, so the test for it is a "(control)" that
  passes on v1 and v2 alike when the reference generator is used.
- **SCRIPT: `scripts/checkin-chain.ts`**, the reference generator. It runs with plain ts-node,
  without Hardhat, and reads the seed from `CHECKIN_SEED`.
  - Construction: `x_0 = tip = keccak256(abi.encode(TIP_TAG, chainId, vault, owner, vaultId, epoch, seed))`
    (pass 4 changed the tag to the string `"WillAndKey/hb/v1"` / `"WillAndKey/hb/v2"`; see below),
    then `x_i = step(x_{i-1})`, `anchor = x_count`. While `hbLeft == L`, the value to submit is
    `x_{L-1}`.
  - **v2 mode:** the step is `hbStep`, and `epoch` is the installation epoch.
  - **v1 mode:** the step is plain `keccak256`, as v1 checks, and `epoch` is an install index
    that the owner prints and never reuses. It protects users of the live contract off-chain.
  - Commands: `seed`, `anchor`, `next`.
  - With `--rpc`, v2 mode reads `hbEpoch`, `hbLeft` and `hbAnchor`, and refuses to print if its
    step disagrees with the contract's `hbStep`. `next` refuses a value that does not lead to the
    installed anchor, and warns when the vault is pinned.
  - Its exports (`tip`, `step`, `link`, `buildChain`, `nextValue`, `readChainState`,
    `checkStepAgainstContract`) are what the tests use.
  - Rehearsed on a local node (port 8547): deploy v2, `anchor --rpc` (epoch picked
    automatically), a guarded install, three relayed `next --rpc` check-ins, then an exhausted
    chain refused and a stale `--epoch` refused. The node was stopped and the rehearsal files
    removed.
- **DOC: `docs/CHECKIN-CHAIN.md`**, the published spec. It covers:
  - status: "advanced, no app support";
  - what a chain is and is not;
  - the exact encodings for v1 and v2, epochs and install indexes, disarming, and the generator
    commands;
  - six rules, and an error table.
- Tests (F02 block):
  - a value from another deployment, another vault of the same owner, another owner (same seed)
    or an earlier installation is refused;
  - damage bound: a stranger with a leaked value forges nothing, and the heir claims on time;
  - the step equals a hand-written `abi.encode`, and owner, vault id and epoch each change it;
  - the generator's v2 chain runs end to end, and its last reveal is the tip, not the seed;
  - `hbEpoch` counts 0, 1, 2, 3 (the disarm too) in `getVault` and `CheckInChainSet`;
  - the epoch-checked install refuses a stale and a re-used paper, and the unguarded form
    installs the re-used paper dead;
  - (control) variant b with the generator, in both modes;
  - (control) the generator's v1 mode against the real `InheritanceVaultV1` bytecode;
  - (guard) the generator's hand-written `getVault` ABI matches the compiled `VaultView`, so a
    later change to the struct breaks a test, not the script.

### F28: disarm, and no zero value (Informational)

- `setCheckInChain(id, 0, 0)` disarms: `hbAnchor = 0`, `hbLeft = 0`, and the epoch moves on.
  Arming still needs both an anchor and a count, so `(0, n)` and `(a, 0)` revert
  `InvalidCheckInChain`, as does `count > MAX_HB_COUNT`.
- A disarm is an owner action like any other: it resets the clock and, before the horizon, ends
  a pending claim (`ACT_SET_CHECKIN_CHAIN`). **Past the horizon it reverts `HorizonReached`**,
  like every installation (B-04). That keeps it from acting as a veto there, which would reopen
  the A-02/B-01 loop. A chain cannot fire past the horizon anyway.
- **Beyond the plan (the finding's REC):** `checkInByChain` refuses a zero value (`BadCheckIn`).
  So `hbAnchor == 0` always means "no chain armed", and an exhausted chain can never pass for a
  disarmed one: bit 3 stays accurate. Cost: a hand-rolled chain whose tip is exactly zero loses
  its last value. The generator never produces one; it would take a 2^-256 accident.
- `hbLeft` is documented as the owner-declared count, which the contract cannot verify (NatSpec on
  the struct, `VaultView` and bit 3). This is not fixable on chain. The generator derives the
  anchor from the count, so the two agree.
- Tests (F28 block):
  - a disarm refuses the remaining value, zeroes `getVault`, leaves bit 3 dark and logs epoch 2;
  - a disarm before the horizon supersedes a claim and resets the clock, and past the horizon
    both forms revert, the claim survives and settles;
  - a zero value is refused;
  - (control) the half-zero forms and an oversized count are refused.

### F18: a check-in that cannot move the deadline reverts (Low)

- `checkIn` and `checkInByChain` revert `DeadlinePinnedAtHorizon(absoluteDeadline)` when
  `deadline >= absoluteDeadline` while the horizon is still ahead. This is the one condition
  under which `_resetClock` cannot move the deadline.
  - The first clamped partial extension, where the deadline is still short of the horizon and
    the check-in moves it onto the horizon, succeeds (control test).
  - The horizon check comes first, so past the horizon the error is still `HorizonReached`.
  - The revert happens before any state change, so no chain value is spent.
- `checkInMany` skips a pinned vault with `CheckInSkipped(..., SKIP_PINNED)` and does not count it
  (F15).
- **Beyond the plan's wording (the finding's REC: "do not consume a chain link when nothing
  moves"):** a second chain check-in in the same second also reverts, `CheckInAlreadyUsed`, and
  keeps its value unspent. The invariant is now exact: `hbLeft` falls only when the deadline
  strictly rises.
  - The owner's own `checkIn` repeated in the second of a reset is left as a harmless success,
    as the plan's wording has it: nothing is spent or counted, and the `CheckedIn` it emits
    carries the true deadline. Reverting it would break an owner's batched transaction for no
    gain. The `CheckedIn` NatSpec says so.
- **Beyond the plan (the finding's REC and SEV-FIX): warnings bit 4 ("pinned")**, set exactly
  when `checkIn` would revert `DeadlinePinnedAtHorizon`. It is clear past the horizon, where bit
  1 already says so; bit 1 is not redefined.
- NatSpec: T3 in the header, and `extendHorizon`, which warns that a horizon within one period of
  now leaves the vault pinned at once.
- Not adopted: raising the `createVault`/`extendHorizon` floor to two periods (SEV-FIX). The plan
  does not ask for it. It would change the B-02 floor and the accepted-horizon semantics. A vault
  created exactly one period from its horizon is now honestly pinned from creation (test).
- Tests (F18 block):
  - a pinned `checkIn` reverts, with the horizon;
  - (control) the first clamped check-in succeeds;
  - a vault is pinned from creation;
  - a pinned `checkInByChain` keeps `hbAnchor`/`hbLeft`, and the same value works after
    `extendHorizon`;
  - a same-second second chain check-in reverts, its value still works a day later (one block,
    tip-ordered);
  - bit 4 is off before pinning, on while pinned, and off past the horizon with bit 1 on;
  - `checkInMany` does not count a pinned vault, and reverts `NothingCheckedIn` on pinned alone;
  - (control) past the horizon, every check-in path still reverts as before, `abortClaim` is
    closed, a pending claim is untouched, and only a real `extendHorizon` stops it (A-02/B-01).

### F15: every skip is logged, and only moved deadlines count (Low)

- New `event CheckInSkipped(address indexed owner, uint256 indexed vaultId, uint8 reason)`,
  emitted for every id `checkInMany` does not refresh. Every id in the call now gets exactly one
  log, `CheckedIn` or `CheckInSkipped`, so a keeper can diff its receipt against what it sent.
- Reasons are public constants, each with NatSpec naming the remedy:
  - `SKIP_UNKNOWN_ID = 1`
  - `SKIP_TERMINAL = 2` (settled or closed)
  - `SKIP_CLAIM_PENDING = 3` (a check-in never ends a claim; `abortClaim` does; review round 3
    scoped it to before the horizon and added `SKIP_CLAIM_PENDING_PAST_HORIZON = 7`)
  - `SKIP_HORIZON_REACHED = 4`
  - `SKIP_PINNED = 5` (F18)
  - `SKIP_REPEATED = 6` (the deadline already moved at this second)
- `refreshed` counts only vaults whose deadline this call moved. The second copy of an id finds
  its deadline already moved at this second (`SKIP_REPEATED`), so the count is of distinct
  vaults in O(n), with no sorting requirement. `NothingCheckedIn` fires only when nothing moved,
  which includes a batch whose only vault was already refreshed in the same block (test).
- Not adopted: requiring ascending ids (SEV-FIX), which moved-only counting makes unnecessary; any
  revert-on-skip mode, which would bring back A-03. `checkInMany` still never touches a pending
  claim.
- Tests (F15 block):
  - one receipt accounts for seven ids in order (in, claim pending, horizon, terminal, pinned,
    unknown, repeated), and the constants read 1 to 6;
  - a keeper's receipt names the claim-pending vault on every run through the window;
  - `[0, 0, 1, 1, 0]` counts 2 and logs two `CheckedIn`;
  - a same-block `checkIn` then `checkInMany([0])` reverts the batch;
  - (control) an unknown-only batch reverts `NothingCheckedIn`.

### F27: event schema (Informational)

- New `event DeadlineReset(address indexed owner, uint256 indexed vaultId, uint64 newDeadline, uint64 absoluteDeadline)`,
  emitted inside `_resetClock`, which is now the only writer of `deadline`.
  - It covers every path: `createVault`, `checkIn`, `checkInMany`, `checkInByChain`, both
    `setCheckInChain` forms (disarm too), `withdraw` (partial and closing), `setBeneficiary`,
    `setInactivityPeriod` (which can move the deadline EARLIER, as the NatSpec says),
    `extendHorizon` and `abortClaim`.
  - It is logged at the write, so **before** the action's own event, including before
    `VaultCreated`.
  - `_resetClock` now takes the vault id; the owner is read from storage.
  - A static (guard) test checks that the deadline is assigned in exactly one line and that one
    `emit DeadlineReset` exists, so no new path can forget it.
- `VaultCreated` gains `uint32 inactivityPeriod`, before `challengeWindow`. **Its topic hash
  changes.**
- `BeneficiaryChanged` is now
  `(address indexed owner, address indexed oldBeneficiary, address indexed newBeneficiary, uint256 vaultId)`.
  - The old heir is indexed. To stay within three indexed fields, `vaultId` moved to the data.
    Owner-centric queries still filter by owner, and the heir-lookup the APP plans (F44) filters
    by beneficiary.
  - The parameter order changed on purpose, so the **topic hash changes** too. Keeping the v1
    order and moving only the `indexed` flags would have kept v1's topic0 with a different
    topic/data layout, so a v1-ABI decoder would silently misread v2 logs.
  - Not adopted: a separate `BeneficiaryRemoved` event (SEV-FIX). The plan chose indexing.
- Tests (F27 block):
  - twelve actions each log exactly one `DeadlineReset`, before their own event, equal to
    `getVault`, including the earlier deadline after a shorter period;
  - an events-only replay ends at the stored deadline;
  - `VaultCreated.inactivityPeriod`;
  - a removed heir finds its removal with a topic filter on its own address;
  - (control) the owner and the new heir still find it;
  - (guard) the single-writer check.

### A-02 / B-01 / B-02 re-verified with every pass-3 path

- No pass-3 path can end a pending claim except `setCheckInChain`, which already could. It still
  reverts `HorizonReached` past the horizon in both forms, arming and disarming (F28 test).
- `checkIn`, `checkInByChain` and `checkInMany` never touch a claim. The new
  `DeadlinePinnedAtHorizon` path applies only to an ACTIVE vault before its horizon, where no
  claim can be pending, because a claim needs `now >= deadline == horizon`. `DeadlineReset` is a
  log only.
- `extendHorizon`'s floor (B-02) is untouched. The F18 control test shows that past the horizon
  only a genuine `extendHorizon` stops a claim, and that it restores a full-period cooldown
  (`NotYetExpired`).
- `test/Audit.ts` (A-01 to A-05) passes unchanged.

### Tests and test infrastructure

- `test/AuditPrelim2026-09.ts` imports the generator. Its chain helpers step the way the
  implementation under test does: plain keccak under `VAULT_IMPL=v1`, the domain step under v2.
  So F18 and F28 tests fail on v1 for their own defect, not on a step mismatch.
- Existing assertions adapted. None was removed or weakened:
  - F42 "a pool-wide gain...": `VaultCreated` `withArgs` now also asserts `inactivityPeriod`
    under v2 (helper `createdArgs`);
  - F14's three exact log-order assertions now expect `DeadlineReset` first under v2 (constant
    `RESET`). Under v1 they are unchanged, so they still fail on F14's defect;
  - `test/InheritanceVault.ts`: `makeChain` builds its two-value chain with the v2 step for
    epoch 1, with the same five assertions (`BadCheckIn` one step too deep, a relayed check-in,
    `CheckInAlreadyUsed`, exhaustion, bit 3);
  - `test/InheritanceVault.ts`: the `BeneficiaryChanged` expectation has the same four values in
    the new order.
- ethers v6 note: `setCheckInChain` is now overloaded. A three-argument call still resolves by
  count, but `interface.getFunction("setCheckInChain")` is ambiguous. Tests name the signature.
- No new mocks were needed; `contracts/test/TestHelpers.sol` is unchanged in this pass.

### Flagged for the lead (outside this pass's files)

- **Any v2 watcher or app**, not the v1 app:
  - new topic hashes for `VaultCreated`, `BeneficiaryChanged` and `CheckInChainSet`;
  - new `DeadlineReset` and `CheckInSkipped`: a keeper must alert on every `CheckInSkipped`,
    above all `SKIP_CLAIM_PENDING`;
  - `hbEpoch` in `VaultView`;
  - warnings bit 4 (pinned: show "extend the horizon", not "checked in").
  `site/assets/abi.js` stays v1 and was not touched.
- DOC for F02, F16, F17 and F28 (README, site, `notify/watcher.js` re-arm text): point to
  `docs/CHECKIN-CHAIN.md`, label the feature "advanced, no app support", say "fresh seed or next
  install index, never re-install a printed anchor", and use the bearer-credential wording.
- `scripts/notify-scenario.ts` still deploys `InheritanceVault` with the three-argument v1
  constructor, so it has failed since pass 1. Pass 2 already flagged `scripts/smoke.ts` and
  `scripts/close-vault.ts`; their `VaultView` decoding now also meets `hbEpoch`.
- `scripts/deploy.ts` and `scripts/transfer-admin.ts` were not changed in this pass. The rest of
  F31 is still open. (Closed in pass 4.)

---

## Pass 4: tooling, tests and close-out

Runtime size after pass 4: **20,317 bytes** (+55 over pass 3, all from the F10 extension below;
optimizer unchanged, 200 runs). Headroom to EIP-170: 4,259 bytes.

Full suite after pass 4: `npx hardhat test` gives 190 passing, 0 failing (173 before this pass).
The 17 new tests are in `test/AuditPrelim2026-09.ts` (5 in the F02 block, 12 in the new F38
block). With `VAULT_IMPL=v1` the file gives 33 passing and 94 failing. Of the 17 new tests, 10
fail on v1 and the 7 titled "(control)" or "(guard)" pass. The pre-pass-4 pattern (26 passing,
84 failing) is unchanged. Each new failure is the finding's own defect: v1 accepts a value walked
forward from another chain, does not check the v2 step, accepts an unlisted rebasing, hook,
double-entry or false-returning token, lets a fee-on-top payout over-debit the pool, writes off a
credit whose transfer moved nothing, lets a stranger push into a frozen address, or has no
partial `withdrawCredit`.

### F31: deploy tooling (Informational)

`scripts/deploy.ts`:

- **Deploys `InheritanceVault` only.** NotifySubscription is gone from the script: no deploy, no
  price, no read-back, no record field, no `CHAINS[].notify` instruction.
- **Mainnets need explicit roles.** A network is a mainnet by name (`base`, `bnb`) or by chain id
  (8453, 56). On a mainnet:
  - `ALLOW_MAINNET=yes` is still required;
  - `ADMIN_ADDRESS` and `FEE_RECIPIENT` must both be set; an unset one is refused, whatever
    override is set;
  - naming the deployer's own address in either is refused unless `ALLOW_DEPLOYER_ROLES=yes`;
  - `FEE_RECIPIENT=none` (or the zero address) means no fee, stated explicitly;
  - the admin and the fee recipient are printed with their kind (wallet, or contract and its
    size) before anything is sent, because Ownable2Step does not protect the constructor.

  On testnets and local chains both still default to the deployer.
  **Deviation (strictly safer than the plan's "refuse if unset or equal to the deployer unless an
  override is set"):** the override only lets an explicitly named address be the deployer. It
  never makes an unset variable default to the hot key.
- **Checks before sending**, so a mistake costs no gas: `CLAIM_FEE_BPS` within 0..100; the admin
  not zero and not a token contract; the fee recipient not `wrappedNative` or a listed token (the
  constructor's F09 rule); the token list (below).
- **Per-chain token lists, keyed by chain id**, so a rehearsal chain merely named `bnb` never
  inherits BNB Chain's list. These are proposals. The user must confirm them before any mainnet
  deploy, because they can never change:
  - Base (8453): USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dp), WETH
    `0x4200000000000000000000000000000000000006` (18), cbBTC
    `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8), EURC
    `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` (6). wrappedNative: WETH.
  - BNB Chain (56): USDT `0x55d398326f99059fF775485246999027B3197955` (18), USDC
    `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18), WBNB
    `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` (18), BTCB
    `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c` (18), ETH
    `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` (18). wrappedNative: WBNB.
  - Base Sepolia and BNB testnet are unchanged from pass 1.
  - **All nine mainnet entries were verified read-only on 2026-09-26** (`eth_getCode`; `eth_call`
    for symbol, decimals, name and totalSupply; `eth_getStorageAt` on the proxy slots). None is
    flagged: each has code and the expected symbol and decimals. Issuer control, recorded in the
    script: Base USDC, EURC and cbBTC and BNB USDC are upgradeable proxies (the FiatToken-style
    ZOS slot; EIP-1967 for BNB USDC); BNB USDT, BTCB and ETH are owner-controlled Binance-Peg BEP20
    tokens, not proxies; WETH and WBNB have no admin.
  - **BNB Chain's USDT and USDC have 18 decimals**, not 6. Any app or watcher must read
    `decimals()`.
  - The script re-checks code, `symbol()` and `decimals()` for every entry, and refuses the whole
    deploy, listing every problem, if one fails. The `SUPPORTED_TOKENS` and `WRAPPED_NATIVE`
    overrides still work and are labelled as overrides in the printout.
- **The record is never overwritten.** `DEPLOYMENT_RECORD` chooses the file (default
  `deployments/<network>.json`), and an existing file is refused before anything is sent. This
  keeps `deployments/base.json` (the live v1 contract and its admin-handover transaction hashes)
  safe from a v2 Base deploy; use `DEPLOYMENT_RECORD=deployments/base-v2.json`. The record gains
  `version: "v2"`, the deployment transaction and block, token metadata, and `readBack` (a
  deployment whose read-back failed is still recorded, so its address is not lost). The
  `--constructor-args` module is written next to it.
- **The read-back covers the v2 state:** runtime size, owner, no pending owner, the claim fee in
  force, no raise pending, the fee recipient, `feeRecipientActiveAt == 0`, the fee cap,
  `FEE_RAISE_DELAY`, `PUSH_GRACE`, the two minimums, not paused, no vaults, `wrappedNative`,
  `supportedTokens()` in order, `isSupportedToken` true for each entry and false for the native
  coin, `HB_DOMAIN`, `hbStep` against `scripts/checkin-chain.ts` on this chain id, zero surplus in
  every lane, and on mainnets an owner and a fee recipient that are not the deployer.
- **Source verification stays a separate step** (the F31 SEV-FIX, not the REC's "same run"). The
  script prints the `hardhat verify` command and the explorer link, so an explorer outage can never
  fail a deployment that has already happened.
- **"Next" no longer tells anyone to wire v2 into the v1 app.** It says not to set
  `site/assets/app.js` `CHAINS[id].contract` to a v2 address until a v2 app exists, and not to
  point the v1 watcher at it.
- Errors set `process.exitCode` instead of calling `process.exit(1)`, which aborted libuv on
  Windows while an RPC handle was closing.

`scripts/transfer-admin.ts`:

- Works with a vault-only record: `contracts.NotifySubscription` is optional, and the subscription
  steps run only when it is present. `DEPLOYMENT_RECORD` selects the record.
- Uses a minimal Ownable2Step and fee-recipient ABI that v1 and v2 share, so one script serves
  both.
- Checks that need no contract read come first (the cold address is set, not zero and not the
  signer; the record's chain id matches the network; each recorded address has code), so a dry run
  always gets as far as the plan.
- Prints the plan, then stops unless `CONFIRM=yes`.
- Moves the fee recipient only when fees are credited to the signing key itself. A zero recipient
  (fees off) is left off, because switching fees on is a fee change, not a handover (and on v2 it
  waits `FEE_RAISE_DELAY`). A recipient that is some other address is left alone.
- Takes the network name, explorer and native coin from the chain, instead of hard-coding "Base",
  "Basescan" and "ETH".

Verified:

- The audit's own F31 PoC (`npx hardhat test audit/2026-09-preliminary/poc/F31.ts`), which runs the
  real scripts as a BNB launch on a rehearsal chain: **5 passing**. It was written to fail on the
  old scripts. Note for the lead: that PoC restores `deployments/bnb.json` but not the
  `bnb.vault-args.js` the script now writes beside it; I deleted the leftover rehearsal file.
- In-process forks of Base (8453) and BNB Chain (56), read-only from public RPCs, with nothing
  broadcast: the full deploy with the real token lists passes every read-back check on both. On
  the Base fork, each of these is refused before sending: no `ALLOW_MAINNET`, no `ADMIN_ADDRESS`,
  the admin equal to the deployer, the fee recipient equal to USDC, and an existing
  `deployments/base.json`.
- A local node on port 8547, stopped afterwards: a testnet-rules deploy; a no-code token and a
  duplicate both refused; then `transfer-admin.ts` as a dry run and with `CONFIRM=yes` on the v2
  vault-only record (fee recipient moved, ownership offered, pending owner set). The rehearsal
  files are in the session scratchpad only.

### F02 and F28: the reference generator (Medium / Informational, SCRIPT)

- **The tip tag now follows the specified encoding.** The tip is
  `keccak256(abi.encode("WillAndKey/hb/v1", chainId, vault, owner, vaultId, installIndex, seed))`
  in v1 mode, and the same with `"WillAndKey/hb/v2"` and the installation epoch in v2 mode. The
  tag is a Solidity `string`, so the tuple is `(string, uint256, address, address, uint256, uint32,
  bytes32)`. Pass 3 had used a bytes32 tag (`keccak256("WillAndKey.CheckInChain.tip.v1")`). Nothing
  had been published or installed with it, so pass 4 switched to the specified encoding. The v1
  chain is plain `keccak256` from that tip, which is what v1 checks. The v2 step (`hbStep`) is
  unchanged.
- **The generator prints the preimages in reveal order.** `anchor` prints the anchor, the count,
  the epoch or install index and the `setCheckInChain` call. It then prints every value, numbered
  in the order it must be submitted, with the `hbLeft` at which to submit it. `--no-values` omits
  them. The new export `revealOrder(mode, ctx, seed, count)` returns `[x_{count-1}, ..., x_0]` in
  one pass. The CLI is now the exported `cli(argv, log, env)`, so tests can drive it in-process.
- Its texts say: one seed per vault per chain; values are bearer credentials; submit at least a
  day before the deadline; in v1 mode, a pinned check-in is accepted and spends a value for
  nothing.
- **`docs/CHECKIN-CHAIN.md`** now gives:
  - the exact encodings for both versions, and a worked check;
  - the `anchor` output;
  - the operational rules: a fresh seed per vault and per chain; never a raw-seed tip; the install
    index and epoch discipline; never re-install a printed anchor; values are bearer credentials;
    size `count` to the keyless window; submit at least a day before the deadline; disarm or
    replace a chain whose seed is exposed.
- Tests, added to the F02 block:
  - a value revealed on another chain at the same contract address cannot be walked forward here
    (fails on v1: accepted);
  - the generator's v2 values work on their own vault only. They are refused on the owner's other
    vault, and refused here when built for another chain id (fails on v1: v1 does not check the v2
    step);
  - (control) the generator's v1 mode, against the real `InheritanceVaultV1` bytecode: a value
    built for another vault or chain is refused, even with one seed everywhere;
  - (guard) the tip equals a hand-written `abi.encode` with the string tag, in both modes; v1
    chains with plain keccak; each of the six context fields changes the tip;
  - (guard) the CLI prints the anchor, the count and the values in reveal order, numbered 1..n
    while hbLeft is n..1. Each value hashes to the one printed before it, the first hashes to the
    anchor, and the last is the derived tip. `--no-values` omits them.
  - The two existing end-to-end tests (v2 on v2, and v1 mode on the v1 bytecode) now submit the
    printed `revealOrder` values and check that they agree with `nextValue`.

### F38: hostile-token regressions (Informational, TESTS)

A new describe block, "F38 hostile tokens: each class meets the v2 control that stops it", has
its own deployment:

- **Listed**, as a careless deployer might list them: fee on transfer, fee on top, double entry,
  transfer cap, false return, a USDC-style blocklist, a Tether-style blocklist and an ERC777-style
  hook.
- **Not listed**: the rest.

After each step, a `lanes` helper checks that the vault's balance covers
`totalLocked + totalCredited`, and that `surplus()` holds no user value.

- Positive rebase: refused at creation, and at the sweep even after it has rebased.
- ERC777-style hook, unlisted: refused before the depositor's sender hook runs.
- (control) ERC777-style hook, listed anyway: the hook's re-entrant `createVault` gets
  `ReentrancyGuardReentrantCall`, and the deposit records exactly what arrived.
- Double entry: the second address can neither deposit nor sweep, and the ledger's value is intact.
- (control) Fee on transfer: create, top-up, withdraw, claim, settle and pull, with every lane
  covered and nothing left over.
- Fee on top: `withdrawCredit`, `pushCredit` and `sweepSurplus` all revert `PayoutOverdebited`.
  The credit is kept and the lanes stay whole.
- False return, unlisted: refused at creation.
- (control) False return, listed: the payout reverts `SafeERC20FailedOperation` and the credit is
  kept. It is paid once the token behaves.
- Reports success but moves nothing, or half: the payout reverts `PayoutShortfall`, the credit is
  kept, and the admin has nothing to sweep (see the F10 extension).
- (control) USDC-style blocklist:
  - a blocklisted heir routes the credit elsewhere;
  - a blocklisted vault freezes every exit, loses nothing and gives the admin nothing;
  - it pays again once unblocked.
- Tether-style blocklist: a stranger's push into the frozen address must wait `PUSH_GRACE`, and
  the heir routes the credit elsewhere.
- Transfer cap: a settled estate above the cap is paid in cap-sized parts, with the lanes covered
  after each.

New mocks in `contracts/test/TestHelpers.sol`: `RebasingToken`, `HookToken` (with the
`IHookImplementer` interface), `HookDepositor`, `FalseReturnToken` and `BlocklistToken`. No name
collides with the `F38_*` mocks in `contracts/audit/`.

Also fixed, in `test/NotifySubscription.ts`: a comment said one second costs "~385 gwei". It
costs ~0.386 gwei (385,802,470 wei at the least). The assertion was already right.

### F10 extension: a payout must debit exactly `amount` (Low; beyond the plan, strictly better)

I found this while writing the F38 matrix. Pass 1's F10 check reverted only when the vault's
balance fell by MORE than `amount`. A listed token whose `transfer` returns true but moves less,
or nothing, passed it (a silent cap, a silent blocklist, a buggy upgrade). The credit was retired,
the unpaid value stayed in the contract outside every lane, and `sweepSurplus` could take it. That
breaks T4 ("the admin cannot reach a wei of any credited payout") for such a token.

- `_payout` now measures `debited = before > after ? before - after : 0`. It reverts
  `PayoutOverdebited(token, debited, amount)` if that is more than `amount`, and the new
  `PayoutShortfall(token, debited, amount)` if it is less. The credit stays in both cases. The
  same check covers `sweepSurplus`.
- Native payouts are unchanged: the EVM moves exactly the value sent.
- NatSpec updated: ACCOUNTING, SUPPORTED TOKENS, `_payout` and the new error.
- **Disclosed cost.** For a token whose sender debit rounds (stETH-style share tokens lose 1-2 wei),
  some payouts now revert instead of leaving dust in surplus. Such tokens are rebasing and must not
  be listed anyway. The credited account can still exit through the partial `withdrawCredit`, with
  an amount that debits exactly. None of the nine proposed mainnet tokens rounds or misreports a
  transfer.
- Test: the F38 "moves nothing, or half" test. It fails on v1, where the credit is written off.

### F39: the A-05 regression test (Informational, TESTS)

Done in pass 1, and unchanged. `test/Audit.ts` A-05 pins each block with
`time.setNextBlockTimestamp(latest + 60)` and asserts exact equalities, including the
inclusive-minimum boundary pair. Pass 4 checked the test's comment that a reverted transaction is
still mined here. It is: a reverted `createVault` sent through hardhat-ethers mines one block. So
each call does need its own pin.

### Close-out: the plan's V2 dispositions against this changelog

Every V2 item is implemented, or is covered with no code change:

| ID | Where |
|---|---|
| F01 | pass 1 |
| F02 | pass 3 (contract), pass 4 (generator and spec) |
| F03 | no semantic change, as the plan says: a check-in still never ends a claim (`checkIn` reverts `ClaimPendingUseAbort`; `checkInMany` skips with `SKIP_CLAIM_PENDING`), and the veto is still `abortClaim`. Review round 3: past the horizon, where `abortClaim` reverts too, `checkIn` reverts `HorizonReached` and the skip reason is `SKIP_CLAIM_PENDING_PAST_HORIZON` |
| F04 | pass 2 |
| F05 | pass 2 (with a documented deviation) |
| F06 | pass 2 |
| F08 | pass 2 (with a documented deviation) |
| F09 | pass 1 (with a documented deviation) |
| F10 | pass 1, extended in pass 4 |
| F11 | pass 1 (covered by F01) |
| F14 | pass 2 |
| F15 | pass 3 |
| F18 | pass 3 |
| F20 | pass 2 |
| F22 | pass 2 |
| F25 | pass 2 (`lockedFeeBps`), pass 3 (`hbEpoch`) |
| F26 | pass 2 |
| F27 | pass 3 |
| F28 | pass 3 (contract), pass 4 (generator and spec) |
| F33 | pass 1 |
| F36 | the V2 part is covered by the F01 allowlist (spam tokens cannot be deposited); no code |
| F42 | pass 1 |

- SCRIPT items: F02 and F28 (the generator, passes 3 and 4) and F31 (pass 1 for the token lists,
  pass 4 for the rest).
- TESTS items: F38 (pass 4) and F39 (pass 1).
- The constructor follows the plan (pass 1).
- Every V2 finding has a describe block in `test/AuditPrelim2026-09.ts`, except F03 and F36, which
  changed no code.

**Plan items not implemented:** none of the V2, SCRIPT or TESTS items. The digest also suggests
three things that are outside the plan's dispositions, and they were not done: fuzz or invariant
tests on the accounting identity, a mutation-testing gate, and the NotifySubscription boundary
tests. That contract is retired; only its wrong comment was fixed.

### Flagged for the lead (outside this pass's files)

- `DEPLOY.md` still describes the old flow: NotifySubscription, `CHAINS[].notify`, and an admin
  that defaults to the deployer. It should match `scripts/deploy.ts`:
  - explicit `ADMIN_ADDRESS` and `FEE_RECIPIENT`;
  - `DEPLOYMENT_RECORD=deployments/base-v2.json` for a v2 Base deploy;
  - verification as a separate step.
- `scripts/smoke.ts`, `scripts/close-vault.ts` and `scripts/notify-scenario.ts` are still as
  flagged in passes 2 and 3 (the v2 ABI against the v1 address; the v1 constructor). `smoke.ts`
  and `close-vault.ts` read `deployments/<network>.json` and ignore `DEPLOYMENT_RECORD`.
- The token lists are proposals. The user confirms them before any mainnet deploy.
- Marking `notify/README.md` as retired (the F31 DOC part) belongs to the docs pass.

---

## Review round 1

Three review lenses (security regression, finding closure, test quality) raised 14 issues against
passes 1 to 4. Each was first confirmed independently: by reading the code, and by running the
reviewer's evidence or an equivalent test in a sandbox. All 14 were confirmed. None was rejected.

- 4 needed a contract change (1, 2, 3, 4 below).
- 1 is a deliberate plan trade-off. Its NatSpec claim was false and has been corrected; the
  behaviour is unchanged (5).
- 9 were test gaps (6 to 14).

Runtime size after review round 1: **20,992 bytes** (+675 from 20,317). The optimizer is still at
200 runs. EIP-170 leaves 3,584 bytes of headroom.

How each fix was shown to be needed (sandbox `scratchpad/poc/FIXER-R1`, a copy of this tree):

- **Contract fixes.** The new tests were run against the pre-round-1 contract, kept byte for byte.
  8 failed, each for its issue's reason:
  - the wrap-and-return and SELFDESTRUCT payees (the admin swept 99.5 ETH);
  - the lane getters (a phantom surplus of 1 token mid-deposit);
  - the fee re-imposed in the settlement block (0.5 ETH);
  - the fee charged one second before `feeRecipientActiveAt`;
  - the F20 NatSpec guard ("gives nobody new power");
  - two `NothingCheckedIn` tests ("expected 1 argument, got 0").
- **Test-only fixes.** Each surviving mutant the reviewers named is now killed by the full suite.
  So is a mutant of each round-1 contract fix. See the table below.
- **v1 run.** `VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts` gives 36 passing, and all
  36 are "(control)" or "(guard)". 106 fail.

### 1. The fee-recipient switch-on was not delayed at settlement (regression lens, Low): FIXED

- **Confirmed.** `finalizeClaim` tested only `feeRecipient == address(0)`, never
  `feeRecipientActiveAt`. Take a claim that locked 50 bps while a recipient was in force. The admin
  removed the recipient (a cut that must reach the heir). In the settlement block, just before the
  permissionless `finalizeClaim`, the admin could set a recipient again and collect the full locked
  fee. The `claimFeeBps` channel has no such hole. This broke the FEES header's same-block rule.
- **Fix.** `finalizeClaim` charges nothing while `block.timestamp < feeRecipientActiveAt`. This is
  the test `initiateClaim` already used, so a recipient is "in force" by one rule everywhere. The
  NatSpec was updated in the FEES header, `feeRecipientActiveAt`, `setFeeRecipient` and
  `finalizeClaim`.
- **Tests (F05 block).**
  - "a cut to zero (recipient removed) during the window cannot be undone in the settlement block,
    just before finalizeClaim". This is the reviewer's PoC, with the block order asserted.
  - "a recipient switched back on reaches claims already pending exactly at feeRecipientActiveAt:
    nothing a second before, the locked rate at it". This pins the new boundary: mutant MF1 (`<` to
    `<=`) is killed by it.

### 2. F09 was enforced by address only: a wrap-and-return or SELFDESTRUCT payee made a payout sweepable (closure lens, Low): FIXED

- **Confirmed.** A payee contract that is neither `wrappedNative` nor listed could receive a native
  payout and send the value straight back to `msg.sender` (the vault): wrapped and forwarded as a
  listed token, or bounced by SELFDESTRUCT. The push retired the credit. The value landed in
  surplus. `sweepSurplus` handed it to the admin. This contradicted T4.
- **Fix, class-level, as the reviewer preferred.** `_payout`'s native branch now measures across
  every asset the admin could sweep. After the call, the native balance must be exactly `amount`
  lower, and every supported token's balance must be unchanged. Otherwise it reverts
  `PayoutReturned(to)` and the credit is kept.
  - The digest comes from a new private `_holdings(less)`: a keccak of the native balance and each
    listed balance.
  - Each listed balance is read with a low-level `staticcall`, and a failing `balanceOf` reads as
    `type(uint256).max`. So a listed token that stops answering cannot also freeze native payouts.
    It cannot be swept either, because `_surplus` reverts on it.
  - Only the payee's own code runs during the call, and the payee is chosen by the credited account
    (or, for a sweep, by the admin). So the new revert lets a payee grief only its own payout, which
    it could already do with a reverting `receive()`.
  - **Corrected in review round 2 (items 1 and 4 there).** The two claims above were false. The
    read copied all returndata and forwarded 63/64 of the gas, so a listed token whose `balanceOf`
    burned its gas, returned a returndata bomb or answered differently on each read froze every
    native payout, whatever the payee.
  - ERC20 payouts are unchanged. A supported token has no transfer hooks, so no payee code runs.
    The existing exact-debit check still covers a bounce in the same token.
- **Cost.** Each native payout makes two `balanceOf` calls per listed token (roughly 6 to 10k gas
  per token). The SUPPORTED TOKENS NatSpec now says to keep the list short.
- **NatSpec.** Updated in T4, PAYOUT ADDRESSES, SUPPORTED TOKENS and `_payout`.
- **Tests (F09 block).** They run on a Base-like deployment, where WETH is both `wrappedNative`
  and listed:
  - "a wrap-and-return helper that is not wrappedNative cannot hand an heir's native payout back as
    admin-sweepable WETH";
  - "a payee that bounces native coin back with SELFDESTRUCT cannot turn the payout into native
    surplus";
  - "(control) the same deployment still pays a contract payee that keeps the coin, and still
    sweeps real surplus".
- Mutants MF3 (listed balances ignored), MF4 (native balance ignored) and MF5 (check removed) are
  killed. The mocks `WrapAndReturnGateway` and `SelfdestructBouncer` are in `TestHelpers.sol`.
- **For the lead (APP).** The APP disposition should warn on any payee with code, not only on the
  known WETH and token addresses. Such a payee is now safe from the admin, but its credit can still
  be stuck (a contract that bounces cannot be paid and may be unable to call `withdrawCredit`).

### 3. F33: the public lane getters still answered mid-deposit (closure lens, Informational): FIXED

- **Confirmed.** `totalLocked` and `totalCredited` were public mappings, which cannot take
  `nonReentrantView`. Read next to `balanceOf(vault)` inside a deposit callback, they showed the
  in-flight deposit as surplus. The VIEWS NatSpec claimed otherwise.
- **Fix, the REACH-FIX.** The mappings are now private `_totalLocked` and `_totalCredited`. New
  external views `totalLocked(address)` and `totalCredited(address)` carry `nonReentrantView`. They
  keep the same names and selectors, so the ABI is unchanged for callers. The VIEWS NatSpec now lists
  six guarded views and says why the others need no guard.
- **Test (F33 block).** "the lane getters are guarded too: mid-deposit, totalLocked and
  totalCredited cannot be read next to the balance as a phantom surplus". It uses the existing
  `ViewProbeToken`, which now also probes the two getters. Mutants MF7 and MF8 (either guard
  removed) are killed.

### 4. F15: an all-skipped `checkInMany` reverted a bare `NothingCheckedIn()` (closure lens, Informational): FIXED

- **Confirmed.** When no deadline moves, the batch reverts and its `CheckInSkipped` logs roll back.
  For a one-vault owner, "a claim is pending" gave the same revert data as "unknown id".
- **Fix.** `error NothingCheckedIn(uint8 skipped)`: bit `1 << r` is set for every SKIP_* reason r
  seen in the batch. A one-vault batch with a claim pending now reverts `NothingCheckedIn(8)`. The
  NatSpec of `checkInMany` and the EVENTS header now say that the "one log per id" promise holds for
  a call that moves something. They also say a keeper must treat `NothingCheckedIn` as "read
  getVault now".
- **Selector change.** The error's selector changed, so any v2 off-chain decoder must use the new
  ABI. The live app talks to v1 and is unaffected.
- **Tests.**
  - F15 block: "when nothing moves, the revert still says why: a one-vault keeper can tell a
    pending claim from an unknown id". It covers each reason alone, both together, and a control
    where the batch moves something.
  - F18 block: the pinned-only batch now also asserts `withArgs(1 << SKIP_PINNED)`.
  - Mutant MF6 (reasons not accumulated) is killed.
- **Test helper.** `test/helpers/deploy.ts`'s v1 hybrid ABI now also swaps in v1's fragment for an
  error whose signature changed. Without that, the existing "(control) a batch that can move
  nothing still reverts NothingCheckedIn" would fail on v1 on a selector mismatch.

### 5. F20: `beneficiaryCancelClaim` lets a stolen heir key redirect a pending payout (closure lens, Informational): NatSpec CORRECTED, design kept, LEAD DECISION FLAGGED

- **Confirmed.** Until `finalizeClaim` is mined, the beneficiary key alone can cancel and
  re-initiate to any address. v1 froze the recipient at `initiateClaim`. The NatSpec said "It gives
  nobody new power over the funds", which is false.
- **What was done.** The reviewer offered two options. Option (b) is in place: keep the plan's
  unrestricted cancel and correct the NatSpec. The plan's F20 disposition specifies the cancel
  without a time limit, and the plan is binding, so the behaviour is not changed without the lead.
  - The NatSpec now states the cost: the payout address is not frozen for the life of a claim; a
    key stolen during the window can redirect the payout, at the price of one more full window
    (vetoable by a living owner, and cancellable by the heir who still holds the key); treat the
    key as hot and finalize promptly.
  - The `initiateClaim` comment "fixed for the whole claim" now reads "recorded for the claim".
- **Tests (F20 block).**
  - "pins the documented cost: until finalizeClaim is mined, the beneficiary key alone can redirect
    a pending payout". It passes on v2, so any future change here is deliberate.
  - "(guard) beneficiaryCancelClaim's NatSpec discloses that cost instead of claiming it gives
    nobody new power". It fails on the pre-round-1 source.
- **For the lead: option (a).** Limit the cancel to a grace after `claimInitiatedAt`, for example
  a `CANCEL_GRACE` of 72 hours with a new revert. That would restore v1's frozen-recipient
  protection against a late key theft, which matters because `ClaimInitiated` publicly announces
  who is about to receive what. The price: a typo the heir notices after the grace becomes
  permanent again, which was F20's original loss. It is a few lines and well within the size
  budget.
- **For the lead (DOC and APP, v2 only).** Tell heirs the beneficiary key is hot until settlement,
  and to finalize promptly.

### 6. F05 switch-on rules were half-tested (tests lens, Low): FIXED (tests)

- **Confirmed.** Mutants M2, M3 and M30 survived the whole suite.
- **Added to the F05 block** (from the reviewer's G2, G3 and G5):
  - "replacing one live recipient with another starts no fee holiday: a claim right after locks
    the normal rate";
  - "a recipient switched on is in force AT feeRecipientActiveAt, not a second later";
  - "a SECOND fee holiday also delays the switch-on by FEE_RAISE_DELAY".
- They assert the lock through `ClaimInitiated`'s `lockedFeeBps`. M2, M3 and M30 are killed.

### 7. The F38 ERC777 test read state after a revert (tests lens, Low): FIXED (tests)

- **Confirmed.** A revert rolls `hookCalls` back whether or not the vault called the token first.
  Mutant M40 (the allowlist check moved after the transfer) survived.
- **Fix.** `HookToken.setTripwire(true)` makes `balanceOf` and `transferFrom` revert
  `TokenCalled()`. The test now arms the tripwire and asserts the deposit reverts
  `UnsupportedToken`, which can only happen if the vault refused the token before calling it. A
  control shows the tripwire does fire on a direct call. M40 is killed; on v1 the test fails with
  `TokenCalled`.
- **F01 comments.** The post-revert reads in the two F01 tests (the admin's `dbl` balance and
  `facade.lastAmount`) now say they only restate the revert on v2, and are what a v1 run measures.

### 8. The F01 guard matched function names only (tests lens, Low): FIXED (tests)

- **Confirmed.** Mutant M42 (`addAsset(address)`) survived.
- **Fix.** The guard now reads the source, strips comments, and requires that every write to the
  list sits inside the constructor body. A write here means an assignment to `isSupportedToken[..]`,
  a `delete` of it, or a push, pop, assignment or length write on `_supportedTokens`. As a sanity
  check, the pattern must see exactly the constructor's two writes. The name check stays as a
  second layer, now also matching `asset`.
- M42 is killed, and so is M42b, an `enable(address)` that only flips `isSupportedToken`.

### 9. The header claimed every non-control test fails on v1 for its finding's reason (tests lens, Low): FIXED (tests)

- **Confirmed.**
  - The generator test "v2 values work on their own vault only" builds v2-mode values. v1 refuses
    those everywhere, so on v1 it fails only on its positive line.
  - "v2 chain runs end to end" fails on v1 on a missing selector.
- **Fix.**
  - Both are relabelled "(guard)", with a comment saying why.
  - The file header now defines "(guard)" as a check on v2's own ABI, source, NatSpec or tooling,
    which may fail on v1 but never because of the finding.
  - The header also lists the new-API tests that fail on v1 only because the function is absent.
  - This changelog's intro now says the same.
- **Checked.** The v1 run gives 36 passing, all "(control)" or "(guard)". The only failing guards
  are these two.

### 10. F38 lacked the no-bool, pausable and NotifySubscription boundary cases (tests lens, Low): FIXED (tests)

- **Token matrix.** `NoBoolPausableToken` (already in `TestHelpers.sol`) is listed in the F38
  fixture. It returns nothing from `transfer`, `transferFrom` and `approve`, and its issuer can
  pause it. New test: "(control) no-bool (USDT-on-Ethereum style) and pausable: a whole lifecycle
  keeps every lane covered; a pause freezes every exit, loses nothing and gives the admin
  nothing". It covers create, topUp, withdraw, `withdrawCredit`, claim and finalize. While paused,
  `withdrawCredit`, `pushCredit` and a new deposit revert, the credit survives and there is no
  surplus. After the unpause, every lane drains to zero.
- **NotifySubscription boundary tests** (retired but live, and still accepting payments):
  - 385,802,469 wei reverts and 385,802,470 wei buys exactly 1 s;
  - a purchase exactly at `now + MAX_PREPAID` succeeds and one second more reverts `TooFarAhead`;
  - `minSecondsAdded == added` succeeds and `+1` reverts `PriceMoved(added, added + 1)`;
  - `withdraw(address(0))` reverts;
  - a non-payable recipient reverts `NativeTransferFailed` and the revenue is kept;
  - a plain transfer is refused;
  - the Ownable2Step handover: nothing changes until acceptance, a stranger cannot accept, and
    afterwards only the new admin can act.
- Mutants N1 to N5 of `NotifySubscription.sol` are all killed (see the table).

### 11. `_credit`'s "at least as large" restart was untested at the boundary (tests lens, Informational): FIXED (tests)

- Added to the F08 block (the reviewer's G1): "a new credit EQUAL to what is owed restarts the grace
  ('at least as large'); one wei smaller does not". M1 is killed.

### 12. TokenSupported was never asserted (tests lens, Informational): FIXED (tests)

- Added to the F01 block (the reviewer's G4): "the constructor logs TokenSupported once per listed
  token, in list order". It reads the deployment receipt and checks the fixture vault's own logs.
  M4 is killed.

### 13. The F27 guard's regex missed writes through an index expression (tests lens, Informational): FIXED (tests)

- The pattern is now `/\.deadline\s*(?:[-+*\/%|&^]|<<|>>)?=(?!=)/`, which catches plain and
  compound assignment through any expression. The `o.deadline` exclusion is kept. M43 is killed.

### 14. The F09 control's title claimed "no fee" without settling (tests lens, Informational): FIXED (tests)

- The control now finalizes after the window and asserts `ClaimSettled(..., DEPOSIT - ONE, 0)` and
  the recipient's credit. It also asserts the first payout with `changeEtherBalance`. It still
  passes on v1.

### Mutation check (sandbox, full suite: AuditPrelim2026-09.ts + Audit.ts + InheritanceVault.ts; NotifySubscription.ts for N*)

All 22 mutants are KILLED. Each one survived, or would have survived, the suite before round 1.
The runner is `scratchpad/poc/FIXER-R1/mutate.js`, and its results are in `mutants-result.txt`
next to it.

| Mutant | Change | Killed by |
|---|---|---|
| M1 | `_credit` restart `>=` to `>` | F08 "a new credit EQUAL to what is owed restarts the grace" |
| M2 | live-to-live `setFeeRecipient` restarts the delay | F05 "replacing one live recipient with another starts no fee holiday" |
| M3 | `initiateClaim` `>= feeRecipientActiveAt` to `>` | F05 "a recipient switched on is in force AT feeRecipientActiveAt" |
| M4 | no `TokenSupported` emit | F01 "the constructor logs TokenSupported once per listed token" |
| M30 | no delay on a second switch-on | F05 "a SECOND fee holiday also delays the switch-on" |
| M40 | `_pull` checks the allowlist after the transfer | F38 ERC777 tripwire test |
| M42 | `addAsset(address)` edits the list | F01 source guard |
| M42b | `enable(address)` flips `isSupportedToken` only | F01 source guard |
| M43 | a second `deadline` write through `_vaults[..][..]` | F27 guard |
| MF1 | `finalizeClaim` `< feeRecipientActiveAt` to `<=` | F05 boundary test |
| MF2 | `finalizeClaim` ignores `feeRecipientActiveAt` (the pre-fix line) | F05 settlement-block and boundary tests |
| MF3 | `_holdings` ignores listed tokens | F09 wrap-and-return test |
| MF4 | `_holdings` ignores the native balance | F09 SELFDESTRUCT test |
| MF5 | the holdings check removed | both F09 payee tests |
| MF6 | skip reasons not accumulated | F15 reasons test, F18 pinned batch |
| MF7 / MF8 | `totalLocked` / `totalCredited` unguarded | F33 lane-getter test |
| N1 | NotifySubscription cap `>` to `>=` | "a purchase landing exactly on now + MAX_PREPAID" |
| N2 | slippage floor `<` to `<=` | "minSecondsAdded equal to what the payment buys" |
| N3 | seconds bought rounded up | "one second costs 385,802,470 wei" (and the existing dust test) |
| N4 | `withdraw(address(0))` accepted | "withdraw refuses address(0)" |
| N5 | `withdraw` ignores a failed transfer | "a non-payable recipient reverts NativeTransferFailed" |

### Files changed in review round 1

- `contracts/InheritanceVault.sol`:
  - `finalizeClaim`, `_payout`, the new `_holdings`, `checkInMany`;
  - the new error `PayoutReturned`, and `NothingCheckedIn(uint8)`;
  - the private lanes plus the guarded `totalLocked` and `totalCredited` views;
  - NatSpec: T4, FEES, SUPPORTED TOKENS, PAYOUT ADDRESSES, VIEWS, EVENTS, `feeRecipientActiveAt`,
    `setFeeRecipient`, `beneficiaryCancelClaim`, and the `initiateClaim` comment.
- `test/AuditPrelim2026-09.ts`: the header, and new or changed tests in F01, F09, F33, F05, F08,
  F20, F02 (relabels), F18, F15, F27 and F38.
- `test/NotifySubscription.ts`: the `boundaries` describe (6 tests).
- `test/helpers/deploy.ts`: the v1 hybrid ABI also swaps changed error fragments.
- `contracts/test/TestHelpers.sol`: the round-1 mocks (`WrapAndReturnGateway`,
  `SelfdestructBouncer`, `NoBoolPausableToken`, the `HookToken` tripwire, and the `ViewProbeToken`
  lane probes).

Full suite after review round 1: `npx hardhat test` gives **211 passing, 0 failing** (190 before).
There are 21 new tests: F01 +1, F09 +3, F33 +1, F05 +5, F08 +1, F20 +2, F15 +1, F38 +1, and 6 in
NotifySubscription. The F01 name guard was replaced by the source guard, so it is not counted as
new.

---

## Review round 2

Three review lenses (security regression, finding closure, test quality) raised 10 issues against
review round 1. Each was first confirmed independently, in the sandbox `scratchpad/poc/FIXER-R2` (a
copy of this tree, with the pre-round-2 contract kept as `InheritanceVault.sol.orig`):

- the reviewers' PoCs were re-run against the pre-round-2 contract;
- their four surviving mutants were re-run against the vault suite;
- the L2ToL1MessagePasser claim was checked with a read-only `eth_call` on Base.

All 10 were confirmed. None was rejected.

- 3 needed a contract change: 1 and 4 (one fix), 2, and 5.
- 1 is a plan-mandated behaviour. Its NatSpec was incomplete; the NatSpec and the check-in chain doc
  are corrected, the behaviour is pinned, and a lead decision is flagged (3).
- 5 were test gaps (6 to 10).

Runtime size after review round 2: **20,830 bytes** (-162 from 20,992). The optimizer is still at 200
runs. EIP-170 leaves 3,746 bytes of headroom.

How each fix was shown to be needed:

- **Against the pre-round-2 contract.** The round-2 tests of `test/AuditPrelim2026-09.ts` were run in
  the sandbox. 7 failed, each for its issue's reason:
  - a wallet payout under a hostile listed token: `Transaction ran out of gas` at 16,777,216 gas;
  - a contract payee under a gas-burning `balanceOf`: out of gas;
  - the wallet route under inconsistent reads: `PayoutReturned` (the wallet was measured too);
  - an unlisted `wrappedNative` deployed;
  - 1 ETH handed to the message passer;
  - the passer accepted as the initial fee recipient;
  - the F20 NatSpec guard.
- **Tests for gaps.** Each gap's test passes on the pre-round-2 contract, as a test of existing
  behaviour should. It kills the reviewer's mutant, re-applied to the round-2 source (see the table
  below).
- **v1 run.** `VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts` gives 41 passing and 113
  failing. All 41 are "(control)" or "(guard)".

### 1 and 4. A listed token's `balanceOf` could freeze every native payout (regression lens, Low; closure lens, Low): FIXED

- **Confirmed.** Round 1's `_holdings` read each listed token with a Solidity `staticcall`. That
  forwards 63/64 of the gas and copies the whole returndata. The reviewers' PoCs, re-run on the
  pre-round-2 contract, gave:
  - a `balanceOf` returning a returndata bomb: every native `withdrawCredit`, `pushCredit` (by the
    account or a keeper) and `sweepSurplus(NATIVE)` ran out of gas, at 1M, 5M and 16,777,216 gas
    (the most one transaction may use);
  - a `balanceOf` burning its gas: the same;
  - a `balanceOf` answering differently on its two reads: every native payout reverted
    `PayoutReturned`.
  - Only a reverting `balanceOf`, the one case round 1 handled, paid.
  - This hit plain wallet heirs too. v1 reads no token on a native payout, so it is a regression.
    One issuer of an upgradeable listed token (Base USDC, EURC, cbBTC; BNB USDC) could hold up every
    ETH/BNB inheritance.
  - Nothing was lost: the credit paid once the token behaved.
- **Fix: both reviewers' parts.**
  - **A payee with no code is not measured.** `_payout` measures only when `to.code.length != 0`.
    An address with no code runs nothing when paid, so it cannot send value back. Its payout reads
    no token at all, so wallet heirs (the common case) are immune to every token mode, including
    inconsistent reads. An EIP-7702 delegated account has code (the `0xef0100` designator), so it
    stays measured.
  - **Each read is bounded.** `_holdings` reads each listed balance in assembly with a gas cap
    (`BALANCE_READ_GAS` = 100,000, about ten times what the proposed tokens use cold) and a 32-byte
    output buffer. A read that fails, runs out of that gas or returns less than a word still counts
    as `type(uint256).max` (round 1's fail-open rule). A burning or bombing token now costs a
    contract payee's payout gas, never the payout.
  - Measured with two listed tokens:

    | Payee | normal | reverting | gas burn | returndata bomb |
    |---|---|---|---|---|
    | wallet | 44,316 | 44,316 | 44,316 | 44,316 |
    | contract | 66,829 | 66,399 | 260,626 | 238,985 |

  - A caller cannot starve a read to hide a return. A starved read counts as failed, and a failed
    read hides a change only if the other read failed too. A first read starved of gas leaves 1/64
    of too little for the payee's call itself.
- **A defect in my own first version, caught by the suite.** The first draft wrote
  `if and(staticcall(..), gt(returndatasize(), 0x1f))`. Yul evaluates arguments right to left, so
  `returndatasize()` was the PREVIOUS call's. Every read counted as failed, and the measurement
  silently covered no token. Round 1's wrap-and-return test failed on it at once. The call is now
  its own statement, with a comment. Mutant MR4 pins it; four tests kill it.
- **Residuals, disclosed in `_holdings` and PAYOUT ADDRESSES.** Both need a listed token to
  malfunction.
  - A token that answers `balanceOf` differently on each read still blocks native payouts to
    payees with code (`PayoutReturned`, credit kept). The credited account can route through a
    wallet.
  - A value returned INTO a token whose reads fail both times goes unnoticed. It is sweepable
    surplus once that token answers again.
- **NatSpec.** T4, SUPPORTED TOKENS (the list's issuer risk and "keep the list short"), PAYOUT
  ADDRESSES, `_payout` and `_holdings`. Round 1's item 2 above now carries a correction note.
- **Tests (F09 block, "review round 2").** `BalanceModeToken` (new, in `TestHelpers.sol`) is a
  listed token with the modes revert, gas burn, returndata bomb and inconsistent answers.
  - "(control) whatever a listed token's balanceOf does, a native payout to a wallet goes through:
    withdrawCredit, pushCredit by the account and by a stranger, and sweepSurplus". It runs all four
    modes at 16,777,216 gas, and passes on v1.
  - "(control) a contract payee is still paid while a listed token's balanceOf reverts, burns its
    gas or returns a returndata bomb: each read is capped". It asserts < 400,000 gas, and kills
    MX1 (the reviewer's plain `balanceOf`) and MR5 (the cap removed).
  - "pins the documented residual: a listed token that answers balanceOf differently on each read
    blocks native payouts to payees with code, keeps the credit, and the account routes through its
    wallet".
  - "an EIP-7702 delegated wallet is measured like a contract: delegated to a wrap-and-return
    helper, it cannot hand the payout back as sweepable WETH". This is the adversarial check of the
    code-length skip. It sends a real type-4 transaction (hardhat runs Osaka), and kills MR3
    (`code.length > 23`).

### 2. `wrappedNative` was not required to be a listed token (regression lens, Informational): FIXED

- **Confirmed.** The reviewer's PoC gave a vault with `supported: []` and `wrappedNative: WETH`. A
  wrap-and-return payee was paid (the credit was retired). The WETH sat in the vault outside every
  lane, and `sweepSurplus` refused it (`UnsupportedToken`), so it was stranded for good. The
  measurement covers listed tokens only, and PAYOUT ADDRESSES promised the wrap case was covered.
- **Fix.** The constructor reverts `InvalidTokenConfig(wrappedNative_)` unless `wrappedNative_` is
  address(0) or listed. That replaces the old `wrappedNative_ == address(this)` check, since this
  contract can never be listed. `wrappedNative` is now always measured.
- **Simplified with it.** Two clauses became dead code and were removed:
  - `_checkPayee`'s separate `to == wrappedNative` test;
  - the constructor's hand-written fee-recipient rule. The constructor now calls
    `_checkPayee(initialFeeRecipient)`, which reads no immutable. Round 1 had spelled the rule out
    only because `_checkPayee` read one.
- **`scripts/deploy.ts`** refuses an unlisted `WRAPPED_NATIVE` before sending. That was checked on
  the in-process network. The per-chain tables already list WETH/WBNB.
- **Tests.**
  - F09: "the constructor refuses a wrapped-native token that is not listed, so a native payout's
    measurement always covers it". It also shows the listed configuration catching the helper.
  - The main fixture, the F09 fee-recipient test and the F01 clean-list deploy now list WETH.
    Their assertions are unchanged.
- **Wider disclosure.** A payee that hands a payout back in an asset that is not listed at all was
  paid. That asset stays here, stranded like any unlisted token sent directly. This is now in
  PAYOUT ADDRESSES.

### 3. `beneficiaryCancelClaim` is not atomic with re-initiation (regression lens, Informational): NatSpec and doc CORRECTED, behaviour pinned, LEAD DECISION FLAGGED

- **Confirmed**, both halves (the reviewer's tests, re-run):
  - (a) Past the horizon, a pending claim makes `setBeneficiary` revert `HorizonReached`. After the
    cancel it succeeds, and the new heir claims at once.
  - (b) Before the horizon, after the cancel, anyone holding an unspent chain value can check in,
    and the heir's re-initiate reverts `NotYetExpired` for a full period.
  - The NatSpec mentioned only "the owner (or a check-in chain relayer)".
- **Why the behaviour is kept.** The plan's F20 disposition says the cancel "returns the vault to
  ACTIVE without moving the deadline". The plan is binding. Also, (a) gives the owner no new power
  over the funds: past the horizon a full withdrawal is always open, claim or not. (b) is the bearer
  credential F17 already discloses, given one more opening by the heir's own cancel.
- **What was done.**
  - The `beneficiaryCancelClaim` NatSpec has a new paragraph, "The gap is the heir's cost". It says:
    - anyone holding an unspent chain value (and the owner or the owner's automation) can postpone
      the new claim by a full period;
    - past the horizon, the owner may name a new heir, who claims at once;
    - the re-lock can be higher than the cancelled claim's lock (up to the ceiling);
    - re-initiate straight away (a smart-account heir can batch the two).
  - `docs/CHECKIN-CHAIN.md` says the same under "Unspent values are bearer credentials".
- **Tests (F20 block).**
  - "pins the documented cost of the gap (past the horizon)".
  - "pins the documented cost of the gap (before the horizon)".
  - "(guard) beneficiaryCancelClaim's NatSpec discloses the cost of the ACTIVE gap". It fails on
    the pre-round-2 source.
  - The existing "past the horizon it reopens no veto" is retitled "it reopens neither abortClaim
    nor checkIn". It did reopen `setBeneficiary`. Its assertions are unchanged.
- **For the lead: the reviewer's option.** An atomic `beneficiaryReplaceRecipient(vaultOwner,
  vaultId, newRecipient)`: current beneficiary only, while CLAIM_PENDING. It would:
  - run `_checkPayee`;
  - keep the claim pending and restart `claimInitiatedAt` (a full window for the owner's veto);
  - re-lock the fee as min(old lock, rate in force, recipient rule), so it can only fall;
  - emit `ClaimInitiated`.

  It closes (a) and (b) for an honest heir fixing a typo. Dropping the plain cancel as well would
  also end round 1's abortClaim front-run grief, but the plan names the cancel, so that is the
  lead's call. A size-only prototype (compiled, NOT tested, not in the tree) measured **21,439
  bytes** (+609). The heir docs and app (v2 only) need the same warning whichever way it goes; they
  are outside this pass's files.

### 5. A native payout to Base's L2ToL1MessagePasser credits this contract's own address on L1 (closure lens, Informational): FIXED in v2

- **Confirmed.** A read-only `eth_call` on `mainnet.base.org`, from the v1 vault address, sending 1
  wei to `0x4200…0016` returns `0x` (success). The same call to `0x4200…0010` reverts
  "StandardBridge: function can only be called from an EOA". The passer's `receive()` starts a
  withdrawal to `msg.sender`, which is the vault. Both address rule and measurement pass it. The
  value is then collectable only by code at the vault's address on L1. Only the deployer key,
  sending from the deployment nonce there, could put code at it. It is the same in v1.
- **Why fix it in the contract.** An heir who wants the inheritance on L1 could plausibly paste the
  passer as "withdraw to L1" and lose the whole payout. The refusal costs one shift-and-compare, and
  the range is unused on chains that are not OP-stack.
- **Fix.** `_checkPayee` refuses the OP-stack predeploy namespace `0x4200…0000` to `0x4200…07FF`
  (`ForbiddenPayoutAddress`), for every payout path, the claim recipient, the fee recipient
  (constructor included) and the sweep target. PAYOUT ADDRESSES now says why, and that no rule can
  see a payee forwarding to this address on ANOTHER chain in general.
- **`scripts/deploy.ts`.**
  - It refuses a predeploy `FEE_RECIPIENT` or `ADMIN_ADDRESS` before sending.
  - It records `deployment.deployerNonce`, with a comment on why it matters: once the deployer's
    nonce on a chain has passed it, nobody can ever put code at this address there.
- **Test (F09).** "an OP-stack predeploy is refused as a payee". It installs `WithdrawalPasserMock`
  (new) at `0x4200…0016` with `hardhat_setCode` and checks `withdrawCredit`, `withdraw`,
  `setFeeRecipient` and `initiateClaim`. It also checks both ends of the range and one address on
  either side, which kills MR8 and MR8b. The F09 fee-recipient test now includes the passer.
- **For the lead (APP/DOC, v1 and v2).** Refuse `0x4200…0000`–`0x4200…07FF` as a payout, withdraw
  or claim-recipient address in the app on Base, and add it to the payout-address guidance. v1
  accepts it.

### 6. The per-vault fee ceiling at `initiateClaim` was untested (tests lens, Medium): FIXED (tests)

- **Confirmed.** Mutant MX3 (`locked = current;`) gave 198 passing, 0 failing on the vault suite.
- **Added to F06.** "(control) a claim begun after a matured raise ABOVE the vault's creation
  ceiling locks the ceiling, and settles at it". On v2 it checks `ClaimInitiated`'s and `getVault`'s
  `lockedFeeBps`. On both versions it checks `ClaimSettled`. It passes on v1, which clamps too.
  MX3 is killed.

### 7. `beneficiaryCancelClaim` was never tried on a SETTLED or CLOSED vault (tests lens, Medium): FIXED (tests)

- **Confirmed.** Mutant MX2 (`if (v.state == STATE_ACTIVE) revert NoClaimPending`) gave 198
  passing, 0 failing. That mutant resurrects terminal vaults outside `_openIds`.
- **Added to F20.** "only a pending claim: a SETTLED vault, and one CLOSED while a claim was
  pending, cannot be cancelled back to life". It asserts `NoClaimPending(id)` for both, the states
  (3 and 4), and an empty open set. MX2 is killed.

### 8. The tolerant `balanceOf` read in `_holdings` was untested (tests lens, Low): FIXED (tests)

- **Confirmed.** Mutant MX1 (a plain `IERC20.balanceOf`) gave 198 passing, 0 failing.
- **Fixed** by the item 1/4 tests. Wallet payouts no longer read any token, so the kill has to come
  from a contract payee. The contract-payee control's reverting mode kills MX1f, MX1 re-applied to
  the round-2 source.

### 9. The constructor's own-address fee-recipient check was untested (tests lens, Low): FIXED (tests)

- **Confirmed.** Mutant MX4 (the check deleted) gave 198 passing, 0 failing.
- **Added to F09.** "(control) the constructor still refuses the vault's own address as the initial
  fee recipient". It predicts the address with `getCreateAddress`. It passes on v1, which has the
  same check. It kills MX4f (self exempted from the round-2 `_checkPayee` call) and, with the
  fee-recipient test, MX4g (the call removed).

### 10. The TokenSupported test failed on v1 inside the harness (tests lens, Informational): FIXED (tests)

- **Confirmed.** In v1 mode `deployVault` returned `new Contract(address, …)`, whose
  `deploymentTransaction()` is null. The test died on `.wait()`.
- **Fix.** `test/helpers/deploy.ts` now passes v1's deployment transaction as `BaseContract`'s fourth
  constructor argument (`Contract` is `BaseContract` at runtime; only `BaseContract`'s typing names
  it). On v1 the test now fails on "expected [] to deeply equal [...]": no TokenSupported logs, the
  finding's reason.
- **Header.** The file header's list of v2-added API now includes the constructor's `supported`
  and `wrappedNative` arguments. v1 does not take them, and the new constructor test fails on v1
  for that reason.

### Mutation check (sandbox, vault suite: AuditPrelim2026-09.ts + Audit.ts + InheritanceVault.ts)

All 14 mutants of the round-2 source are KILLED; the suite has 210 tests. The runner is
`scratchpad/poc/FIXER-R2/mutate-r2.js`; the mutants are in `mutants-fixed.js` and the results in
`mutants-result-mutants-fixed.txt` next to it. The reviewers' MX1 to MX4 survive the pre-round-2
suite (198 passing), confirmed with the same runner (`mutants-orig.js`).

| Mutant | Change | Killed by |
|---|---|---|
| MX1f | `_holdings` reads with a plain, reverting, unbounded `balanceOf` | contract-payee control |
| MX2 | cancel refuses only ACTIVE | F20 "only a pending claim: a SETTLED vault, and one CLOSED" |
| MX3 | `initiateClaim` locks the rate without the ceiling | F06 ceiling control |
| MX4f | constructor exempts its own address | F09 self control |
| MX4g | constructor applies no payee rule | F09 fee-recipient test, self control |
| MR1 | wallets measured too | wallet control, residual pin |
| MR2 | nothing measured | wrap-and-return, SELFDESTRUCT, 7702, residual pin, wrappedNative test |
| MR3 | delegated accounts (23-byte code) not measured | 7702 test |
| MR4 | `returndatasize()` read before the call (the Yul trap) | wrap-and-return, 7702, residual pin, wrappedNative test |
| MR5 | read not gas-capped | contract-payee control |
| MR7 | unlisted `wrappedNative` accepted | wrappedNative test |
| MR8 / MR8b | predeploy range 4096 / 1024 addresses | predeploy test (range ends and neighbours) |
| MR9 | predeploy range not refused | predeploy test, fee-recipient test |

### Files changed in review round 2

- `contracts/InheritanceVault.sol`:
  - the constructor (listed `wrappedNative`; `_checkPayee` for the fee recipient);
  - `_checkPayee` (the predeploy range; the redundant `wrappedNative` clause removed);
  - `_payout` (wallets not measured) and `_holdings` (bounded assembly read);
  - the new constants `OP_STACK_PREDEPLOYS` and `BALANCE_READ_GAS`;
  - NatSpec: T4, SUPPORTED TOKENS, PAYOUT ADDRESSES, `wrappedNative`, the constructor, `_checkPayee`,
    `_payout`, `_holdings` and `beneficiaryCancelClaim`.
- `contracts/test/TestHelpers.sol`: `BalanceModeToken`, `WithdrawalPasserMock`, and the OZ `Math`
  import.
- `test/AuditPrelim2026-09.ts`:
  - the header, the fixture (WETH listed), and the constants `PASSER` and `TX_GAS_CAP`;
  - F01: the clean-list deploy;
  - F09: the fee-recipient test, and 7 new tests;
  - F06: 1 new test;
  - F20: 4 new tests and a retitle.
- `test/helpers/deploy.ts`: v1 mode keeps the deployment transaction.
- `scripts/deploy.ts`: the unlisted-`WRAPPED_NATIVE` and predeploy checks; `deployerNonce` in the
  record.
- `docs/CHECKIN-CHAIN.md`: the cancel gap under bearer credentials.

Full suite after review round 2: `npx hardhat test` gives **223 passing, 0 failing** (211 before).
There are 12 new tests: F09 +7, F06 +1 and F20 +4.

---

## Review round 3

Three review lenses (security regression, finding closure, test quality) raised 10 issues against
review round 2. Each was first confirmed independently, in two sandboxes: `scratchpad/poc/FIXER-R3`
(a copy of the pre-round-3 tree, with the contract, generator, test file and changelog kept as
`*.orig`) and `scratchpad/poc/FIXER-R3-mut` (mutation runs):

- the reviewers' PoCs were re-run against the pre-round-3 tree: `rev3-pinned-natspec.ts`
  (regression lens), `poc-REV3-closure.ts` (closure lens) and `rev3-probe.ts` P1 and B1 to B4
  (tests lens);
- their six surviving mutants (T1, T2, T3, T6, T7, T10) were re-run against the vault suite with
  their own runner. Each survived: 210 passing, 0 failing;
- the generator gap was checked by grep. The only CLI call in the tests was an offline `anchor`.

All 10 were confirmed. None was rejected.

- 1 needed a contract change: 3 (a new skip reason, and `checkIn`'s error past the horizon).
- 3 were wrong or incomplete NatSpec and docs: 1, 2 and 4. Item 4 keeps its design, for the
  reason given there.
- 6 were test gaps: 5 to 10. Item 7 also changed the generator (a test hook, and one refusal
  message that sent an owner to the wrong fix).

Runtime size after review round 3: **20,928 bytes** (+98 from 20,830). The optimizer is still at
200 runs. EIP-170 leaves 3,648 bytes of headroom.

How each fix was shown to be needed:

- **Against the pre-round-3 contract and doc.** The round-3 test file was run in the sandbox, with
  the round-3 mocks and generator and the pre-round-3 contract and `docs/CHECKIN-CHAIN.md`: 163
  passing, 5 failing, each for its issue's reason:
  - the ACCOUNTING guard: the header still said "the two measurement paths" (item 2);
  - the credit-lane guard: "so the account always has that long to route it elsewhere first"
    (item 4);
  - the check-in guard: "in the last inactivity period before the horizon" (item 1). With the
    round-3 contract and the old doc it fails on the doc's "in v2 one period earlier";
  - the F18 control: past the horizon, with a claim pending, `checkIn` reverted
    `ClaimPendingUseAbort` (item 3);
  - the new F15 test: the receipt read `[0:in, 1:skip3, 2:skip3]`, not `[0:in, 1:skip7, 2:skip3]`
    (item 3).
- **Tests for gaps.** Each passes on the pre-round-3 contract, as a test of existing behaviour
  should. Those for items 5 to 8 kill the reviewer's mutants, re-applied to the round-3 source
  (see the table below). Items 9 and 10 change what a test asserts, not what it can catch.
- **v1 run.** `VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts` gives 48 passing and 120
  failing. All 48 are "(control)", "(guard)" or "(pin)". It was 41 and 113 before.
  - The 7 more passing are the two pins that now assert what v1 does (item 9), the new F08 pin,
    and four new guards or controls.
  - Of the 14 new tests, 9 fail on v1: the three F06 tests, the F15 test and the five generator
    guards. With the two pins moved to passing, that is 7 more failing.
  - The F06 tests fail because `applyClaimFee` is absent, or for F06's reason (the `setClaimFee`
    at the boundary second). The F15 test fails for F15's reason (no `CheckInSkipped`). The
    generator guards fail because the generator's v2 `getVault` ABI cannot decode v1's.

### 1. `checkInByChain`'s NatSpec and the chain doc said check-ins stop one period before the horizon (regression lens, Informational): CORRECTED

- **Confirmed.** The reviewer's test, re-run on the pre-round-3 tree: "as documented" fails (the
  chain check-in is not reverted), "actual" passes. A vault has its horizon 1.5 periods out and an
  armed 3-value chain. A chain check-in at t0 + PERIOD - 1 day, inside the last period, emits
  `CheckedIn(alice, 0, horizon, true)`. It moves the deadline more than 14 days and spends a value
  (`hbLeft` 3 to 2). Only the next value reverts `DeadlinePinnedAtHorizon`.
  - The code was right, and so were the generator (`deadline >= absoluteDeadline`) and `checkIn`'s
    comment. Three texts were wrong.
  - Following them, a keyless owner's relayer stops at horizon minus one period, leaves the
    deadline short of the horizon, and lets the heir claim up to almost a period early.
- **Fix (NatSpec and doc).**
  - `checkInByChain` now says: a value is spent only when it moves the deadline. Once the deadline
    sits at the horizon, or a second time in one second, the call reverts and the value stays
    unspent. The first check-in within one inactivity period of the horizon still moves the
    deadline, to the horizon itself, and spends a value. Keep a relayer running until warnings
    bit 4 (pinned) is set.
  - T3's "(the last inactivity period before it)" is now "(which the first check-in within one
    inactivity period of it brings about)".
  - `docs/CHECKIN-CHAIN.md`: the bullet is now "Check-ins move the deadline only as far as the
    horizon". It gives the same rule, says to keep the relayer running until the vault is pinned,
    and says what stopping early costs. The `next` section says `next` gives no warning before
    that point.
- **Tests (F18).**
  - "(control) the first CHAIN check-in within one inactivity period of the horizon still moves
    the deadline, to the horizon, and spends a value". It passes on v1 and v2. On v2 it also checks
    that bit 4 rises only then, and that only the next value reverts.
  - "(guard) checkInByChain's NatSpec, the T3 header and the chain doc say the first check-in
    within one period of the horizon still moves the deadline". It fails on the pre-round-3
    contract, and on the pre-round-3 doc.
  - The generator's side is item 7's pinned-warning test.

### 2. The ACCOUNTING header named two measurement paths (regression lens, Informational): CORRECTED

- **Confirmed** by reading. Since review round 1, `_payout` measures a native payout to an address
  with code through `_holdings`, which reads the native balance and every listed token's balance,
  twice. The header is the stated place to check the accounting "without reading the state
  machine", and it listed only deposits and ERC20 payouts.
- **Fix (NatSpec).** The header now lists three measurement paths:
  - deposits, the only one that feeds a lane, capped at the amount sent;
  - ERC20 payouts, which must debit exactly the amount paid;
  - native payouts to an address with code (`_holdings`): the native balance must fall by exactly
    the amount paid, and every listed token's balance must stay unchanged.
- **Test (F09).** "(guard) the ACCOUNTING header names every place a live balance is read". It
  checks the text. It also scans the code: the functions that read this contract's own balance
  (`address(this).balance`, `balanceOf(address(this))`, or the `0x70a08231` selector) must be
  exactly `_pull`, `_payout`, `_holdings` and `_surplus`. So a new balance read anywhere else
  fails it, until the header and the list are updated together. It fails on the pre-round-3
  source.

### 3. F15: past the horizon a pending claim was reported as `SKIP_CLAIM_PENDING`, whose remedy (`abortClaim`) reverts there (closure lens, Low): FIXED

- **Confirmed.** The reviewer's PoC, re-run on the pre-round-3 tree:
  - the receipt gives `[[1, 3]]` for a vault past its horizon with a claim pending;
  - a one-vault batch reverts `NothingCheckedIn(8)`, the same as before the horizon;
  - the remedy the reason names, `abortClaim`, reverts `HorizonReached`.

  A keeper or app that maps the reason to its documented remedy sends a veto that cannot work,
  while a challenge window of as little as 7 days runs out. That is the F03/F19 trap, back through
  the new API. `checkIn`'s `ClaimPendingUseAbort` pointed the same wrong way (inherited from v1).
- **Fix (contract).**
  - A new reason, `SKIP_CLAIM_PENDING_PAST_HORIZON = 7`. `checkInMany` gives it when a claim is
    pending and the horizon has passed. Its bit (128) fits `NothingCheckedIn`'s `uint8`. Its
    NatSpec names the remedies that work there: `extendHorizon` to at least now +
    `inactivityPeriod`, or `withdraw(id, type(uint256).max, to)`, before `finalizeClaim` is mined.
  - `SKIP_CLAIM_PENDING`'s NatSpec is scoped to "the horizon is still ahead". `NothingCheckedIn`
    says 8 before the horizon and 128 past it. `checkInMany`'s NatSpec names both reasons and
    their different remedies.
  - `checkIn` (the reviewer's optional part, taken). Past the horizon a pending claim now reverts
    `HorizonReached`, whose remedy (`extendHorizon`) is one of the two actions that still end a
    claim there. Before the horizon it still reverts `ClaimPendingUseAbort`. A settled or closed
    vault still reverts `VaultNotActive`. `ClaimPendingUseAbort` now has NatSpec saying so. No
    state changes, only which error a reverting call gives.
  - Not taken: testing the horizon before the claim state in `checkInMany`. That would report
    `SKIP_HORIZON_REACHED` and hide the pending claim, the most urgent thing a keeper can see.
- **Tests.**
  - F15: "a pending claim past the horizon has its own reason, naming the remedy that works there:
    SKIP_CLAIM_PENDING_PAST_HORIZON, NothingCheckedIn(128), and checkIn's HorizonReached". One batch
    holds a healthy vault, a pending claim past its horizon and one before it. The receipt is
    `[0:in, 1:skip7, 2:skip3]`. One-vault batches revert with bit 128 and bit 8. `checkIn` gives
    `HorizonReached` and `ClaimPendingUseAbort`. `abortClaim` fails past the horizon, and
    `extendHorizon` ends that claim (`ClaimSuperseded(..., ACT_EXTEND_HORIZON)`). `abortClaim` ends
    the other. A closed vault still gets `VaultNotActive` from the reordered `checkIn`. The two
    constants' NatSpec is checked too.
  - F18: "(control) past the horizon the check-in paths still revert and a pending claim is
    untouched (A-02/B-01)". It is retitled (it dropped "as before"). Its `checkIn` assertion now
    expects `HorizonReached` on v2 and still `ClaimPendingUseAbort` on v1. Every other assertion is
    unchanged.
- **For the lead (APP/DOC, v2 only).** A v2 app or watcher must map reason 7 and bit 128 to
  "extend the horizon to at least now + inactivity period, or withdraw everything", never to
  Veto. The v1 app and `notify/watcher.js` are unaffected: v1 has no `CheckInSkipped`, and its
  `checkIn` keeps `ClaimPendingUseAbort`, which F19's APP change already routes around.

### 4. F08: a credit smaller than what the account already owes gets no grace of its own (closure lens, Informational): NatSpec CORRECTED, design kept

- **Confirmed.** The reviewer's PoC, re-run on the pre-round-3 tree. Two same-token vaults name
  bob (100 and 10). Vault 0 settles, bob does not pull for 30 days, and the issuer blocklists him.
  A stranger's `SettleAndPush` on vault 1 WENT THROUGH, and `destroyBlackFunds` then wiped both
  inheritances. The control (an account that owes nothing) reverts `PushTooEarly`. The NatSpec
  overstated the guarantee: "so the account always has that long to route it elsewhere first", and
  "a credited account that CAN act always gets to route its credit first".
- **Why no code change** (the reviewer's recommendation, checked):
  - Restarting the clock on every credit, or once the old clock has run out, lets anyone postpone
    a push to a passive account (an exchange deposit address) forever, for 1 wei every
    `PUSH_GRACE`. The "at least as large" rule exists to prevent that.
  - A clock weighted by the new credit's share was considered and not taken. It changes what the
    public `creditedSince` getter means, this late, and still leaves the new credit short of a
    full grace.
  - The exposed value is the heir's own: the older credit could already be pushed by anyone.
- **Fix (NatSpec).**
  - THE CREDIT LANE has a new bullet. The grace runs per account balance, not per credit. A credit
    smaller than what is owed joins the older clock, and once that clock has run out, anyone may
    settle it and push the whole balance in one transaction. An heir should withdraw an older
    credit before settling another claim into the same address, or name a fresh recipient per
    claim (`beneficiaryCancelClaim` can still change it before settlement). The bullet also says
    why the clock does not restart on smaller credits.
  - The two overstatements are gone. `pushCredit`'s `@dev` and `_credit`'s `@dev` say the same.
- **Tests (F08).**
  - "(pin) a credit SMALLER than what the account already owes joins the older clock: once that
    has run out, a stranger settles and pushes it in one transaction". This is the PoC as a pin.
    It passes on v1 too, which has no grace at all.
  - "(guard) THE CREDIT LANE and pushCredit's NatSpec say the grace runs per account balance, and
    what an heir should do about it". It fails on the pre-round-3 source.
- **For the lead (DOC/APP, heir guidance; outside this pass's files).** Heirs of a split estate or
  a second estate should withdraw any older credit before settling another claim into the same
  address, or name a fresh recipient per claim.

### 5. The F01 source guard was bypassed by a storage alias (tests lens, Low): FIXED (tests)

- **Confirmed.** T10, the reviewer's owner-only `enable(address)` that writes the list through
  local storage aliases, survives the pre-round-3 vault suite (210 passing). Five more ways to
  write the list, each applied to the pre-round-3 contract, also passed the round-1 guard:
  - T10b: a tuple assignment, `(isSupportedToken[t], x) = (true, 1)`;
  - T10c: a private getter returning `mapping(...) storage`;
  - T10d: the mapping passed as a storage argument;
  - T10e: an assembly `sstore` to the mapping's `.slot`;
  - T10f: a named storage return aliasing the array.

  (`scratchpad/poc/FIXER-R3/old-guard-variants.txt`: round-1 guard 1 passing, round-3 guard 1
  failing, for all six.)
- **Fix: the guard whitelists the reads.** Outside the constructor, every mention of
  `isSupportedToken` or `_supportedTokens` must be one of:
  - an indexed read, `[...]` not followed by an assignment operator, `++` or `--`, and not
    preceded by `delete`, `++` or `--`;
  - `_supportedTokens.length`, not assigned;
  - `return _supportedTokens;` inside `supportedTokens()`, whose signature returns `memory`.

  On top of that:
  - each declaration appears exactly once;
  - no tuple assignment's left-hand side names either variable;
  - no `sstore` or `.slot` appears anywhere in the source (the contract uses neither).

  The constructor's two-write check and the function-name layer are kept. The test is retitled
  "... outside it the source only reads the list, in known read forms".
- All six mutants are killed.

### 6. The new F06 branches were untested at their boundary second (tests lens, Low): FIXED (tests)

- **Confirmed.** T1 (`applyClaimFee` refuses AT `pendingClaimFeeAt`), T2 (a matured raise recorded
  only a second after) and T3 (every cut logs `ClaimFeeRaiseCancelled`) each gave 210 passing, 0
  failing. The existing tests reached the boundary with `time.increaseTo(at)`, so the call landed
  at `at + 1`.
- **Added to F06** (the reviewer's B1 to B3, each pinned with `time.setNextBlockTimestamp(at)`):
  - "applyClaimFee succeeds AT pendingClaimFeeAt, the second claimFeeBps() already reports the
    raise";
  - "a setClaimFee AT pendingClaimFeeAt is measured from the matured raise: 70 is a cut from 90,
    not a raise from 40". Under T2 the rate in force would fall back to 40;
  - "a cut with no raise pending logs no ClaimFeeRaiseCancelled: an indexer sees no cancelled
    raise". It also checks a cut after an applied raise.
- T1, T2 and T3 are killed.

### 7. The reference generator's refusals and its `next` command had no test (tests lens, Low): FIXED (tests, and the generator)

- **Confirmed** by grep: the only CLI call in the suite was `cli(["anchor", ...])` offline. No
  test ran `next` or any `--rpc` branch. That agrees with the reviewer's run: both refusals
  disabled, and the suite still gave 154 passing.
- **Generator changes (`scripts/checkin-chain.ts`).**
  - `cli` takes a fourth parameter, `connect(url)`, which turns the `--rpc` URL into a provider.
    The default is `new JsonRpcProvider(url)`, as before. Tests pass one that returns
    `ethers.provider`, so every on-chain branch runs exactly as it does against a node.
  - Found while writing the tests: `next --rpc` on a vault with no chain armed said "the chain is
    exhausted" when the vault was disarmed (`hbLeft` 0), or "epoch must be an integer from 1" when
    no chain was ever installed (`hbEpoch` 0). Both send the owner looking for the wrong fix. It now
    says "no chain is armed on this vault (never installed, or disarmed); nothing to submit",
    checked before anything is derived.
  - The file header, and `docs/CHECKIN-CHAIN.md` (a new list under "Using the generator"), name
    every refusal.
- **Tests (F02, all "(guard)").**
  - "the generator's `next` prints the value checkInByChain accepts: with --rpc, and offline with
    --left". The chain is installed from the printed `anchor --rpc` call, and each printed value is
    submitted.
  - "the generator refuses an --epoch that disagrees with the vault: hbEpoch + 1 for `anchor`,
    hbEpoch for `next`".
  - "`next --rpc` says "do not submit" when the seed does not lead to the installed anchor: a wrong
    seed, or a chain the owner has since replaced".
  - "`next` refuses a vault with no chain armed (never installed, or disarmed) and a used-up chain;
    both commands refuse a zero seed and epoch 0". It covers `--left 0` offline too.
  - "`next --rpc` warns once the deadline is pinned at the horizon, and not in the last period
    before, where a check-in still moves it" (item 1's generator side).
- The mutants G1 to G7 (every refusal disabled in turn, and the pinned warning moved a period early)
  are all killed.

### 8. `lockedFeeBps` after settlement or supersession, and the rising-balance payout (tests lens, Informational): FIXED (tests)

- **Confirmed.** T7 (`getVault` shows the lock for a SETTLED vault) and T6 (`_payout`'s `debited`
  by checked subtraction) each gave 210 passing, 0 failing.
- **F25.** "the lock is shown only while a claim is pending, never as a stale value" now also
  checks 0 after `finalizeClaim` (SETTLED), after `setBeneficiary` supersedes a claim, and after a
  closing `withdraw` with a claim pending (CLOSED). It kills T7 and T7b (the stored lock shown in
  every state).
- **F38.** `FalseReturnToken` gains mode 4: `transfer` reports success, moves nothing and mints the
  sender one unit, so the vault's balance RISES across the payout (a reward settled on touch). "a
  listed token whose transfer reports success but moves nothing, or half, or even raises the
  vault's balance" (retitled) now asserts `PayoutShortfall(token, 0, amount)`, the credit kept and
  `NoSurplus` for mode 4 as well. T6 would give a `Panic(0x11)` there instead, and is killed.

### 9. Five "pins" of v2 costs were counted as v1 failures (tests lens, Informational): FIXED (tests)

- **Confirmed** from the reviewer's v1 run (`REV3-tests/v1-fail-summary.txt`). Two tests fail on v1
  because v1 pays: the F09 inconsistent-`balanceOf` residual, and the F33 receiver that reads a
  guarded view. Three fail because `beneficiaryCancelClaim` is absent: the F20 redirect and the
  two gap costs. None is evidence that v1 has a defect.
- **Fix.**
  - The five are titled "(pin) ...". The label is defined in the test file's header and in this
    changelog's intro.
  - The F09 and F33 pins now branch on `VAULT_IMPL`: on v1 they assert that v1 pays
    (`changeEtherBalance`), so the v1 run shows the cost v2 accepted. They pass there.
  - The three F20 pins still fail on v1, because the function is absent.
  - One new pin is item 4's, in F08. The file now has six pins; three pass on v1.
  - The titles quoted in the earlier rounds above are the pre-round-3 ones.

### 10. The F20 hostile-heir control checked its limitation only conditionally (tests lens, Informational): FIXED (tests)

- **Confirmed.** The reviewer's P1, re-run: the block order is `[cancel, abort, initiate]` and the
  statuses are `[1, 0, 1]`. So the conditional assertion does run on v2 today. It would silently
  stop running if the order or the cancel changed.
- **Fix.** Under `VAULT_IMPL === "v2"` the control now asserts, unconditionally, the block's
  transaction order `[cancel, abort, initiate]`, the statuses `[1, 0, 1]`, and that the vault is
  CLAIM_PENDING afterwards. The v1 branch is unchanged: there the cancel does not exist, and the
  test goes on to its owner-action assertions.

### Mutation check (sandbox, vault suite: AuditPrelim2026-09.ts + Audit.ts + InheritanceVault.ts)

All 27 mutants of the round-3 source are KILLED; the suite has 224 tests. The runner is
`scratchpad/poc/FIXER-R3-mut/mutate-r3.js`. The results are in `r3-mutants-result-run1.txt` next to
it, and `-run2.txt` re-runs the four `checkIn` mutants against the final F15 test, which gained a
terminal-vault control after run 1 had killed R3M3 through one test only. The reviewers' T1, T2,
T3, T6, T7 and T10 survive the pre-round-3 suite (210 passing), confirmed with their own runner
(`FIXER-R3-mut/confirm-pre-r3.txt`).

| Mutant | Change | Killed by |
|---|---|---|
| T1 | `applyClaimFee` refuses AT `pendingClaimFeeAt` | F06 "applyClaimFee succeeds AT ...", "a cut with no raise pending ..." |
| T2 | a matured raise is recorded only a second after `pendingClaimFeeAt` | F06 "applyClaimFee succeeds AT ...", "a setClaimFee AT ..." |
| T3 | every cut logs `ClaimFeeRaiseCancelled` | F06 "a cut with no raise pending ..." |
| T6 | `_payout`'s `debited` by checked subtraction | F38 "... or even raises the vault's balance ..." |
| T7 / T7b | the lock shown for a SETTLED vault / in every state | F25 "the lock is shown only while a claim is pending ..." |
| T10, T10b to T10f | the list written through local aliases, a tuple assignment, a storage getter, a storage argument, an `sstore` to `.slot`, a named storage return | F01 guard |
| R3M1 | `checkInMany` gives reason 3 whatever the horizon | F15 "a pending claim past the horizon has its own reason ..." |
| R3M2 | `checkIn` names the veto past the horizon (the old order) | that F15 test, F18 past-horizon control |
| R3M3 | `checkIn` no longer refuses a terminal vault | that F15 test (run 2), InheritanceVault.ts "closes on full withdrawal ..." |
| R3M4 | `checkIn` lets a pending claim through before the horizon too | that F15 test, InheritanceVault.ts "... refuses during a claim" |
| G1 | generator: the `--epoch` cross-check off | F02 epoch guard |
| G2 | generator: the "do not submit" check off | F02 "do not submit" guard |
| G3 / G3b | generator: the pinned warning off / given a period early | F02 pinned-warning guard |
| G4 to G7 | generator: no-chain-armed refusal off; zero seed, `hbLeft` 0, epoch 0 accepted | F02 refusals guard |
| R2_MR1, R2_MX2, R2_MX3 | round-2 mutants, re-checked on the round-3 tree | as in round 2 |

### Not raised, noted

The reviewer's run also had T8 (`beneficiaryCancelClaim` without `nonReentrant`) and T9 (`_holdings`
accepting a sub-word `balanceOf` return) surviving. Neither was in the issue list. Neither is
tested now:

- T8: the function makes no external call. A re-entrant cancel, from a payee's `receive()` or a
  token hook, touches no value and no lane (`topUp` re-checks the state after its transfer).
- T9: with a short return the mutant reads a word that mixes the returned bytes with the call's
  own input, where the fixed rule counts the read as failed. Either way that token goes
  unmeasured, which is the documented residual for a token whose reads fail both times.

### Files changed in review round 3

- `contracts/InheritanceVault.sol`:
  - `SKIP_CLAIM_PENDING_PAST_HORIZON` (new) and its use in `checkInMany`;
  - `checkIn`: the claim test is scoped to before the horizon, and the state test reordered;
  - NatSpec: T3, ACCOUNTING, THE CREDIT LANE, `SKIP_CLAIM_PENDING`, `NothingCheckedIn`,
    `ClaimPendingUseAbort`, `_credit`, `checkInMany`, `checkInByChain` and `pushCredit`.
- `contracts/test/TestHelpers.sol`: `FalseReturnToken` mode 4.
- `test/AuditPrelim2026-09.ts`:
  - the header (the "(pin)" label, and the v2-added API list);
  - the `prose()` helper;
  - F01: the guard rewritten;
  - F09: 1 new guard, and 1 pin retitled with a v1 branch;
  - F33: 1 pin retitled with a v1 branch;
  - F06: 3 new tests;
  - F08: 1 new pin and 1 new guard;
  - F20: 3 pins retitled, and the hostile-heir control made unconditional on v2;
  - F25: 1 test extended;
  - F02: 5 new generator guards;
  - F18: 1 new control and 1 new guard, and 1 control changed;
  - F15: 1 new test;
  - F38: 1 test extended.
- `scripts/checkin-chain.ts`: `cli`'s `connect` parameter and `ChainReader` type; the
  no-chain-armed refusal; the header.
- `docs/CHECKIN-CHAIN.md`: the horizon bullet, the `next` warning, and the list of refusals.
- `CHANGELOG-v2.md`: this section; the "(pin)" label in the intro; correction notes on pass 3's
  `SKIP_CLAIM_PENDING` line and on pass 4's F03 close-out row.

Full suite after review round 3: `npx hardhat test` gives **237 passing, 0 failing** (223 before).
There are 14 new tests: F09 +1, F06 +3, F08 +2, F02 +5, F18 +2 and F15 +1.

## Review round 4

Two review lenses (finding closure, test quality) raised 8 issues against review round 3. Each was
first confirmed independently, in sandboxes under `scratchpad/poc/`:

- `FIXER-R4`: a copy of the pre-round-4 tree, with the contract, `TestHelpers.sol`, the test file
  and this changelog kept as `*.orig`. The reviewers' PoCs were re-run there: `poc-REV4.ts` (closure
  lens, 8 passing) and `poc-R4-tests.ts` (tests lens, 2 passing), both on the unmodified contract.
- `FIXER-R4-mut` and `FIXER-R4-pre`: mutation runs on the pre-round-4 vault suite, with one runner
  (`mutate-r4-fixer.js`) holding the reviewers' surviving mutants and some of mine. Each of the
  reviewers' 16 survived: 224 passing, 0 failing (`FIXER-R4-mut/pre-r4-mutants-result.txt`). So did
  my GB3, GC2 and GC3, and five more horizon-second flips the reviewers did not name, SC1, WD1,
  WB1, WB4 and GV1 (`FIXER-R4-pre/pre-extra-result.txt`; see item 3).
- `FIXER-R4-layers`, `FIXER-R4-r3` and `FIXER-R4-deploy`: the two rewritten guards layer by layer,
  the round-3 mutants re-run on the round-4 tree, and `scripts/deploy.ts`.
- Item 2 was also checked read-only on Base and BNB (`FIXER-R4/entrypoint-probe.js`), and item 8
  with git.

All 8 were confirmed. None was rejected.

- 1 needed a contract change: 2 (four more refused payout addresses), with its NatSpec.
- 1 was wrong NatSpec: 1. It keeps its design, for the reason given there.
- 5 were test gaps: 3 to 7.
- 1 is outside this pass's files: 8 (the repository cannot be rebuilt from git). It is flagged
  for the lead.

Runtime size after review round 4: **21,080 bytes** (+152 from 20,928). The optimizer is still at
200 runs. EIP-170 leaves 3,496 bytes of headroom.

How each fix was shown to be needed:

- **Against the pre-round-4 contract.** The round-4 test file and `TestHelpers.sol` were run in
  `FIXER-R4` against the pre-round-4 contract: 172 passing, 3 failing, each for its issue's reason:
  - the new F09 EntryPoint test: the payout went through and the EntryPoint booked 1 ETH as a
    deposit owned by the vault (item 2);
  - the new F09 pin: the PAYOUT ADDRESSES text does not name the class (item 2);
  - the new F06 guard: the header still said "a cut during the challenge window still reaches the
    heir" (item 1).
- **Tests for gaps.** Each passes on the pre-round-4 contract, as a test of existing behaviour
  should, and kills the mutants re-applied to the round-4 source (see the table below).
- **v1 run.** `VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts` gives 51 passing and 124
  failing. All 51 are "(control)", "(guard)" or "(pin)". It was 48 and 120 before.
  - The 3 more passing are the two new pins that v1 shares (the EntryPoint-class residual and the
    fee-cut reversal) and the new F06 guard, which reads the v2 source.
  - The other 4 new tests fail on v1. The EntryPoint test fails for F09's reason (v1 pays the
    EntryPoint, which books the deposit). The horizon-second test fails for F15's reason
    (`NothingCheckedIn` has no argument on v1). The one-unit test fails for F10's reason (v1 pays
    and reverts nothing). The second F06 pin fails because `beneficiaryCancelClaim` is absent.
  - Found while checking this: the new tests first closed vaults with `withdraw(id,
    type(uint256).max, to)`, which v1 does not have (F22), so on v1 they failed in their setup
    rather than for F15's reason. They now close by the exact balance, which both versions accept.

### 1. FEES said a fee cut during the challenge window always reaches the heir (closure lens, Informational): NatSpec CORRECTED, design kept, LEAD DECISION FLAGGED

- **Confirmed.** The reviewer's PoC, re-run on the pre-round-4 tree. A vault has a 60-day window and
  50 bps locked.
  - The admin cuts to 0 on day 1. `finalizeClaim` reverts `ChallengeWindowOpen` while the cut is in
    force.
  - On day 2 the admin schedules 50 again, effective day 32.
  - At `finalizableAt` the heir pays the full locked fee: `ClaimSettled(alice, 0, bob, 99.5 ETH,
    0.5 ETH)`.
  - The same happens with `setFeeRecipient(0)` on day 1 and the recipient switched back on on day 2.
  - The control holds: cancel and re-initiate while the cut is in force settles with no fee, after
    a fresh 60-day window.

  The heir never pays more than the lock, and the reversal is public, 30 days ahead. But the header
  told an heir who sees a cut that nothing more is needed. That holds only for an heir who settles
  promptly on a window no longer than `FEE_RAISE_DELAY`, which is all the earlier F05/F06 tests
  tried (14 days).
- **Why no code change.** The reviewer's optional `ratchetLockedFee(owner, id)` was considered and
  not taken:
  - it is a new permissionless state-writing function, with its own event and tests, added after
    three review rounds, on a path that moves no value and can only lower an admin's own revenue;
  - it still needs someone to send a transaction while the cut is in force, as cancel and
    re-initiate does today; it saves that path's fresh window and the gap `beneficiaryCancelClaim`
    describes;
  - the guarantee that matters holds without it: no rise, in any order, takes a claim above its
    lock, and every reversal is announced `FEE_RAISE_DELAY` ahead.
- **Fix (NatSpec).**
  - FEES: the lock is a maximum, which no rise can take a claim above. A cut reaches the heir only
    if it is still in force when `finalizeClaim` is mined. The admin may reverse it before then,
    with `FEE_RAISE_DELAY` of notice, and with a longer window the reversal can take effect before
    the heir can settle. An heir keeps a cut for good only by `beneficiaryCancelClaim` and
    `initiateClaim` while it is in force, at the price of a fresh window and the gap.
  - `finalizeClaim`'s comment: a cut "still in force at settlement" reaches the heir, "while a rise
    can never take the fee above the lock"; a cut reversed before the transaction does not count.
- **Tests (F06).**
  - "(pin) with a challenge window longer than FEE_RAISE_DELAY, a cut made during it can be
    reversed, with notice, before the heir can settle: the heir pays the lock, never more". It runs
    both reversals, a rate and a recipient. On v2 it also checks that the notice
    (`ClaimFeeRaiseScheduled`, or `feeRecipientActiveAt`) names a second before `finalizableAt`. It
    passes on v1 too, where the reversal needs no notice at all.
  - "(pin) the heir keeps a cut for good by cancelling and re-initiating while it is in force, at
    the price of a fresh window".
  - "(guard) FEES and finalizeClaim say a cut reaches the heir only while still in force at
    settlement, and how an heir keeps one". It fails on the pre-round-4 source.
- **For the lead.**
  - LEAD DECISION: the ratchet above, if heirs of long-window vaults should keep a cut without a
    fresh window.
  - DOC (v1): `README.md` (the `finalizeClaim` rule in the fee list), `site/how-it-works.html` and
    `site/index.html` carry the same sentence about v1, where a raise has no delay at all. There
    the admin can reverse a cut at any time before settlement, up to the lock (outside this pass's
    files).
  - APP (v2): show heirs any pending raise, or recipient switch-on, whose effective time falls
    before `finalizableAt`, and say what re-initiating would cost.

### 2. A payee that credits `msg.sender` in its own ledger, such as an ERC-4337 EntryPoint, passed both the address rule and the measurement (closure lens, Informational): FIXED in v2

- **Confirmed.**
  - The reviewer's PoC, re-run on the pre-round-4 tree. The heir names a ledger that books value to
    `msg.sender` as the recipient, and a stranger pushes after `PUSH_GRACE`. The push succeeds, the
    ledger holds a 99.5 ETH deposit for the vault, and `surplus(NATIVE)` is 0.
  - Read-only, on Base and BNB (`FIXER-R4/entrypoint-probe.txt`). The EntryPoints v0.6
    (`0x5FF1…2789`), v0.7 (`0x0000…a032`) and v0.8 (`0x4337…f108`) have the same code sizes on both
    chains (23,689, 16,035 and 21,738 bytes). So does v0.9 (`0x4337…D009`, 22,425 bytes), which the
    reviewer did not list.
  - For each of the four, `eth_simulateV1` on Base, from the v1 vault's address (with a balance
    override), sent 0.01 ETH. It succeeded, logged `Deposited(vault, 0.01 ETH)`, and afterwards
    `balanceOf(vault)` was 0.01 ETH. Only the vault could withdraw it (`withdrawTo`), and it has no
    function that makes that call. It is the same in v1.
- **Why fix it in the contract.** It is the same shape as the round-2 passer, which was fixed in
  the contract: a payee that keeps the value, so the measurement passes, and leaves it owed to this
  contract where it can never collect it. A plain transfer to an EntryPoint always credits the
  sender, never anyone's account, so no legitimate payout goes there. The refusal costs four
  comparisons.
- **Fix.**
  - `ENTRYPOINT_V06` to `ENTRYPOINT_V09` (new constants). `_checkPayee` refuses all four
    (`ForbiddenPayoutAddress`), for every payout path, the claim recipient, the fee recipient
    (constructor included) and the sweep target.
  - PAYOUT ADDRESSES is restructured. The wrap-on-receive refusal is the one the measurement backs.
    Since round 2, "That refusal is by address; the rule behind it is enforced by measurement"
    followed the passer sentence, so it read as if the measurement backed the passer refusal. It
    cannot: the passer keeps the value. The predeploy and EntryPoint refusals are now described
    together, as payees that KEEP the value. The text names the class no rule can see in general: a
    payee that books the value to `msg.sender` in a ledger of its own (an EntryPoint at any other
    address, a staking or deposit contract that credits its sender). The payout is lost, though
    never sweepable.
- **`scripts/deploy.ts`.** It refuses an EntryPoint `FEE_RECIPIENT` or `ADMIN_ADDRESS` before
  sending. The comparisons are now case-insensitive. Checked in `FIXER-R4-deploy` on the in-process
  network: an EntryPoint fee recipient, checksummed or lowercase, and an EntryPoint admin are each
  refused, and a default deployment still goes through.
- **Tests (F09).**
  - "the ERC-4337 EntryPoints are refused as a payee: native coin paid to one is booked as a
    deposit owned by this contract, which can never withdraw it". It installs
    `EntryPointDepositMock` (new) at all four addresses with `hardhat_setCode`. For each it checks
    `withdrawCredit`, `withdraw`, `initiateClaim`, `setFeeRecipient`, `sweepSurplus` and the
    constructor's fee recipient, and that no deposit was booked. It kills EP06 and EP09 (one
    refusal dropped each).
  - "(pin) the documented residual: a payee at any other address that books the value to its
    sender takes the payout; the vault is left with a claim it can never exercise, and nothing is
    sweepable". It checks the PAYOUT ADDRESSES text too. It passes on v1.
- **For the lead (APP, v1 and v2).** Refuse the four EntryPoint addresses as a payout, withdraw or
  claim-recipient address in the app, and keep warning on any payee with code. v1 accepts them.

### 3. No test landed on the horizon second (tests lens, Low): FIXED (tests)

- **Confirmed.** Mutants K1 (reason 7), H1 and H2 (`checkIn`), CB1 (`checkInByChain`), KH1 (reason
  4), AB1 (`abortClaim`) and CP1 (`_clearPending`), each flipping one horizon comparison at the
  boundary, gave 224 passing, 0 failing on the pre-round-4 suite. The round-3 tests ran about a
  day past the horizon, and the F18 control at horizon + 1.
- **The gap was wider than reported.** Every other comparison of the clock with the horizon
  survives the same flip too (224 passing each):
  - SC1: `setCheckInChain` goes through at the horizon second;
  - WD1: a partial `withdraw` there still displaces a pending claim, which T3 says it no longer
    does once the horizon is reached;
  - WB1 and WB4: `warningsOf` sets bit 1 (horizon reached) only a second late, and keeps bit 4
    (pinned) a second too long;
  - GV1: `getVault`'s `horizonReached` turns true a second late.
- **Test (F15).** "AT the horizon second itself the horizon has been reached everywhere: reason 7
  and HorizonReached, never the veto; a second earlier, reason 3 and the veto". This is the
  reviewer's test A, with each assertion in its own block stamped with
  `time.setNextBlockTimestamp` and rolled back with a snapshot.
  - At H it checks `NothingCheckedIn(128)` for the pending claim, and `HorizonReached(H)` from
    `checkIn`, `abortClaim` and `setBeneficiary` on it.
  - For an active vault with a chain armed, `checkIn` and `checkInByChain` give `HorizonReached(H)`
    and `checkInMany` gives `NothingCheckedIn(16)`.
  - A vault closed before H gives `VaultNotActive(2, 4)`.
  - Added for the wider gap. `setCheckInChain` gives `HorizonReached(H)`. A partial withdrawal from
    the pending vault logs no `ClaimSuperseded` and leaves it CLAIM_PENDING. A vault pinned since
    day 2 reads `warningsOf` 3 (expired, horizon reached) and `horizonReached` true, from a block
    mined at H.
  - At H - 1, the control: `NothingCheckedIn(8)`, `ClaimPendingUseAbort`, a working `abortClaim`, a
    chain check-in that moves the deadline onto H, a partial withdrawal that supersedes the claim
    (`ACT_WITHDRAW`), and `warningsOf` 16 (pinned only) with `horizonReached` false.
- All twelve mutants are killed, and H3 too (item 7).

### 4. The exact-debit rule was tested only with deviations of 1%, 50% and 100% (tests lens, Low): FIXED (tests)

- **Confirmed.** D1 and D2 (one unit tolerated over or short), D6 (0.5% over) and D7 (25% short)
  each gave 224 passing, 0 failing.
- **Mock.** `FalseReturnToken` gains mode 5 (moves `value` and burns one more unit from the sender)
  and mode 6 (moves `value - 1`), each reporting success.
- **Test (F38).** "a listed token whose transfer is off by a single unit, over or short, meets the
  same wall: PayoutOverdebited(amount + 1), PayoutShortfall(amount - 1), the credit kept". Two
  users share the pool, so the unit over would come out of dave's lane. It checks `withdrawCredit`
  and `pushCredit` in both modes, the credit kept, and the lanes whole. The control is an exact
  payout. All four mutants are killed.

### 5. The F01 source guard accepted a parenthesised delete of the list (tests lens, Low): FIXED (tests)

- **Confirmed.** GA (`delete (isSupportedToken[t])`), GB (`delete (_supportedTokens[i])`) and GB2
  (no space) each gave 224 passing, 0 failing, and so did GB3 (`delete ((…))`, mine). GB's harm is
  real: a blanked array slot makes `_holdings` read `address(0)` for WETH, so WETH stops being
  measured while `sweepSurplus(weth)` still works. That reopens F09's wrap-and-return sweep.
  - Two neighbours were already caught: GB4 (`delete /* x */ …`; comments are stripped first) and
    GB5 (`(_supportedTokens[i]) = …`, by the tuple check).
- **Fix: three changes, two layers.**
  - The text layer looks through parentheses on both sides of a mention, so the operator and the
    name can be separated by them.
  - It also refuses any `delete` whose operand names either variable, however it is spelled.
  - A new AST layer reads the compiler's own AST of the v2 source (Hardhat's build info). Outside
    the constructor, every reference to either declaration must be one of: an index read of a value
    (`IndexAccess` with `lValueRequested` false, which a delete, an assignment or a tuple target
    never is, with or without parentheses), `.length`, or the return in `supportedTokens()`, which
    must return `memory`. No inline assembly may name either declaration.
- **Each layer stands alone** (`FIXER-R4-layers/layers-result.txt`). Each variant was applied to
  the round-4 contract and run against the guard as shipped, its text layers only and its AST
  layer only. GA, GB, GB2, GB3, GB5 and the round-3 T10 to T10f are caught by each. With no variant,
  and with a new function that only reads the list (`isSupportedToken[t] &&
  _supportedTokens.length > 0`), none of the three fails.

### 6. The ACCOUNTING guard missed a balance read through a local alias of `address(this)` (tests lens, Informational): FIXED (tests)

- **Confirmed.** GC (`address me = address(this); return me.balance;`) gave 224 passing, 0 failing.
  So did GC2 (`balanceOf(self)` through an alias) and GC3 (`selfbalance()` in assembly), mine.
- **Fix.** The code scan of "(guard) the ACCOUNTING header names every place a live balance is
  read" now walks the AST. A function reads a live balance if it contains any of these:
  - a `.balance` whose operand has type `address` (the struct field `Vault.balance` does not);
  - any `balanceOf` member;
  - Yul `selfbalance()` or `balance(…)`;
  - the selector `0x70a08231` as a Solidity or Yul literal, or a string literal naming
    `balanceOf(`.

  The set must still be exactly `_holdings`, `_payout`, `_pull` and `_surplus`. GC, GC2 and GC3
  are killed.

### 7. The round-3 terminal-vault control could not see the order it claimed to check (tests lens, Informational): FIXED (tests)

- **Confirmed.** H3 (the horizon test moved above the terminal-state test in `checkIn`) gave 224
  passing, 0 failing. The control closed vault 1 right after `extendHorizon` had moved its horizon
  into the future, where `HorizonReached` could not fire whatever the order.
- **Fix.** The round-3 F15 test now opens a vault 3 with the same near horizon, closes it at once,
  and checks it in once it is past that horizon: `VaultNotActive(3, CLOSED)`. The item-3 test does
  the same at the horizon second. H3 is killed by both.

### 8. The suite and the deploy script cannot be built from git (tests lens, Informational): CONFIRMED, outside this pass's files, FLAGGED FOR THE LEAD

- **Confirmed.**
  - `git status --short` lists as untracked `test/helpers/`, `test/AuditPrelim2026-09.ts`,
    `scripts/checkin-chain.ts`, `contracts/v1/`, `contracts/audit/`, `docs/` and this file.
  - Tracked, modified files import two of them: `test/Audit.ts` and `test/InheritanceVault.ts`
    import `./helpers/deploy`, and `test/InheritanceVault.ts` and `scripts/deploy.ts` import
    `checkin-chain`.
  - The reviewer's `R4-tracked-only` sandbox (tracked files only) fails at module load with
    "Cannot find module './helpers/deploy'".
  - `git tag -l` is empty, and `git rev-parse --verify -q v1-base` prints nothing, while the header
    of `contracts/v1/InheritanceVaultV1.sol` cites "git tag v1-base (commit b8baf34)". Commit
    `b8baf34` exists.
- **Not fixed here.** This pass may not commit, and `contracts/v1/` is outside its files.
- **For the lead (a publish gate, already open in `fix-review-rounds-1-3.json`).** Before anything
  else on `agent/willandkey-hardening`:
  - commit every file the suite and the scripts reference, not only tracked changes (`git commit
    -a` or `git add -u` would leave the tree unloadable);
  - create `v1-base` at `b8baf34`;
  - push the branch and the tag.

  Otherwise, change the v1 header to cite commit `b8baf34` alone.

### Mutation check (sandbox, vault suite: AuditPrelim2026-09.ts + Audit.ts + InheritanceVault.ts)

All 28 mutants of the round-4 source are KILLED; the suite has 231 tests (224 before). The final
run is in `scratchpad/poc/FIXER-R4-mut2` (`mutate-r4-fixer.js` with `mutants-extra.js`; results in
`post-r4-mutants-result.txt`). The pre-round-4 runs are in `FIXER-R4-mut/pre-r4-mutants-result.txt`
and `FIXER-R4-pre/pre-extra-result.txt`. The 27 round-3 mutants, re-run on the round-4 tree with
round 3's own runner, are all still killed (`FIXER-R4-r3/r3-mutants-result.txt`).

| Mutant | Change | Pre-round-4 suite | Killed by |
|---|---|---|---|
| D1 / D2 | one unit tolerated over / short | survived | F38 "... off by a single unit ..." |
| D6 / D7 | 0.5% over / 25% short tolerated | survived | the same |
| K1 | reason 3 given AT the horizon second | survived | F15 "AT the horizon second itself ..." |
| H1 / H2 | `checkIn` names the veto / goes through AT the horizon second | survived | the same |
| CB1 / KH1 | `checkInByChain` / reason 4 AT the horizon second | survived | the same |
| AB1 / CP1 | `abortClaim` / `_clearPending` AT the horizon second | survived | the same |
| SC1 / WD1 | `setCheckInChain` goes through / a partial withdraw displaces a claim, AT the horizon second | survived | the same |
| WB1 / WB4 / GV1 | `warningsOf` bit 1 late / bit 4 late to clear / `horizonReached` late, at the horizon second | survived | the same |
| H3 | `checkIn` tests the horizon before the terminal state | survived | that test, and the F15 round-3 test's control |
| GA, GB, GB2, GB3 | a parenthesised `delete` of the list | survived | F01 guard |
| GB4 / GB5 | `delete` with a comment between / `(x[i]) = v` | killed | F01 guard |
| GC, GC2, GC3 | a live balance read through an alias, or `selfbalance()` | survived | F09 ACCOUNTING guard |
| EP06 / EP09 | `_checkPayee` stops refusing EntryPoint v0.6 / v0.9 | (new code) | F09 "the ERC-4337 EntryPoints are refused ..." |

### Files changed in review round 4

- `contracts/InheritanceVault.sol`:
  - `ENTRYPOINT_V06` to `ENTRYPOINT_V09` (new), and `_checkPayee` refusing them;
  - NatSpec: FEES, PAYOUT ADDRESSES (restructured), and `finalizeClaim`'s fee comment.
- `contracts/test/TestHelpers.sol`: `EntryPointDepositMock` (new); `FalseReturnToken` modes 5 and 6.
- `test/AuditPrelim2026-09.ts`:
  - `ENTRYPOINTS`, the `artifacts` import, and the `vaultAst()` and `walkAst()` helpers;
  - F01: the guard's text layer looks through parentheses and refuses any `delete` of the list,
    and it gains an AST layer;
  - F09: 1 new test and 1 new pin; the ACCOUNTING guard's code scan now walks the AST;
  - F06: 2 new pins and 1 new guard;
  - F15: 1 new test, at the horizon second, also covering the five horizon comparisons item 3
    found beyond the report; the round-3 test's terminal-vault control checks a vault past its
    horizon;
  - F38: 1 new test.
- `scripts/deploy.ts`: the EntryPoint refusal, and case-insensitive comparisons.
- `CHANGELOG-v2.md`: this section.

Full suite after review round 4: `npx hardhat test` gives **244 passing, 0 failing** (237 before).
There are 7 new tests: F09 +2, F06 +3, F15 +1 and F38 +1.

## Review round 5: recorded, not fixed

R5-1 to R5-5 were resolved later, in the pre-launch finalization (the next section).

Round 5 was a confirmation round of three fresh reviewers (security regressions, finding closure,
tests) on the round-4 tree. They reported six issues: one low and five informational. None is
medium or above, and none lets anyone move value away from a correctly named recipient.

The rounds so far found 14, 10, 10, 8 and 6 issues: 48 in all, with medium or above only in round 2.
The lead stopped the loop here and records the six items below for the independent audit, rather
than fixing them without a further review round. **v2 remains undeployed source.**

| # | Severity | Issue | Disposition |
|---|---|---|---|
| R5-1 | Informational | PAYOUT ADDRESSES says a payout booked by a credit-the-sender ledger is "lost, though never sweepable". That holds only if nobody but the booking's owner can move it. A ledger that lets anyone release a booking to its owner (for example an "ETH, else WETH" refund), or that force-sends native coin, returns the value to the vault as surplus, which `sweepSurplus` can take. | **Resolved** in the pre-launch finalization: the NatSpec corrected, the round-4 pin retitled, and the counter-example pinned. No code change is possible: a later return cannot be told apart from any other force-feed. |
| R5-2 | **Low** | F20 × F13: `beneficiaryCancelClaim` lets an heir fix a mistyped recipient only until someone mines `finalizeClaim`. That call is permissionless from `finalizableAt`, so the last safe moment to correct a recipient is `finalizableAt`, not "until finalizeClaim is mined" as the NatSpec says. | **Resolved** in the pre-launch finalization: the NatSpec corrected and the race pinned. The lead kept the design (no grace period, no atomic re-point). A v2 app must confirm the recipient at claim start and show `finalizableAt` as the correction deadline. |
| R5-3 | Informational | Venus vBNB (0xA07c5b74C9B40447a954e1466938b865b6BBea36, BNB Chain) mints to msg.sender on a plain transfer, the same shape as the EntryPoints, and `_checkPayee` does not refuse it. | **Resolved** in the pre-launch finalization: v2 refuses it (`VENUS_VBNB`). The live app already refuses it (and the four EntryPoints and the OP-stack predeploy range) as a heir, payout or claim-recipient address. |
| R5-4 | Informational | No test calls `checkIn` or `checkInMany` on a SETTLED vault. Every terminal-state assertion uses a CLOSED one. | **Resolved** in the pre-launch finalization (test only). |
| R5-5 | Informational | The F27 guard ("the deadline is written in exactly one place") is still a text regex: `delete`, tuple and `++` writes to `deadline` would pass it. | **Resolved** in the pre-launch finalization (tests only): the guard reads the AST, as round 4's F01 guard does. |
| R5-6 | Informational | Carry-over: the suite depended on untracked files, and the `v1-base` tag did not exist. | Resolved by the lead's release commit, which adds every referenced file, and by tag `v1-base` at `b8baf34`. |

Round-5 evidence (sandbox tests) is recorded in `audit/2026-09-preliminary/record/fix-review-rounds-4-5.json`.

**Live-site follow-ups the lead made from round 4** (not v2 changes):
- `README.md`, `site/how-it-works.html` and `site/index.html` said a fee cut during a claim "still reaches the heir". On v1 a fee rise has no delay, so the admin can reverse a cut at any moment before settlement. All three now say a cut helps only if it is still in force at settlement.
- The live app refuses the four ERC-4337 EntryPoints, Venus vBNB (BNB Chain only) and the OP-stack predeploy range as a heir or payout address.

## Pre-launch finalization

On 27 September 2026 the launch plan set the lead's design decisions for the final v2 source.
This pass implements them: R5-1 to R5-5 and the F20 NatSpec. It then reads every NatSpec block
and comment against the code, as the engineer who will ship it. The launch deploys v2 on Base once
the v2 app is built and tested on local networks and forks. The independent audit comes later.

- **One behaviour change:** v2 refuses one more payout address, Venus vBNB (R5-3). Everything else
  is NatSpec, comments and tests.
- **No real bug was found** in the final read.
- Runtime size: **21,119 bytes** (+39 from 21,080). The optimizer is still at 200 runs. EIP-170
  leaves 3,457 bytes of headroom. The source has 1,615 lines (1,573 before).

### Lead decisions, recorded

- **F20:** `beneficiaryCancelClaim` stays as implemented, with no grace period after
  `finalizableAt` and no atomic re-point. The NatSpec now names `finalizableAt` as the last safe
  moment to correct a recipient (R5-2 below), and the app shows that deadline.
- **F33:** `nonReentrantView` stays on the six guarded views. Its cost has been pinned since pass 1.
- **Optional `ratchetLockedFee`** (review round 4, item 1): not added. A cut reaches a claim only
  if it is still in force when `finalizeClaim` is mined, and an heir keeps one for good only by
  cancelling and re-initiating while it is in force. FEES says so.

### How each change was shown to be needed

- **Against the pre-finalization contract.** The final test file and `TestHelpers.sol` were run
  against the unmodified contract in `scratchpad/poc/FINAL-prove`: 176 passing, 10 failing
  (`prove-old-contract.txt`). Each failure is its item's reason:
  - the vBNB test: the payout went through and 50 vBNB were minted to the vault (R5-3);
  - the two F09 pins: PAYOUT ADDRESSES still said the payout "is lost, though never sweepable"
    (R5-1);
  - the new F20 guard: `beneficiaryCancelClaim` did not name `finalizableAt` (R5-2);
  - the five F21 and F29 guards: each runs the contract first, then finds the audited wording
    that the run contradicts;
  - the round-3 F15 test: reason 7 still said "the horizon has passed".
- **Tests for gaps (R5-4, R5-5).** They pass on the pre-finalization contract, as tests of
  existing behaviour should. The mutation check below shows what each adds.
- **v1 run.** See Counts at the end of this section.

### R5-1 (Informational): PAYOUT ADDRESSES said a mis-routed payout is "never sweepable": RESOLVED (NatSpec, tests)

- **Fix (NatSpec).**
  - A payout to a payee that books the value to this contract is now "lost to whoever named it".
    Whether the admin can ever reach it depends on the payee: it stays out of reach only while
    nothing but its owner, this contract, can move the booking.
  - A ledger that lets anyone release a booking to its owner, in a listed token (an "ETH, else
    WETH" refund) or by force-sending the native coin, returns the value in a later transaction,
    as surplus that `sweepSurplus` can take. No rule can tell that return from any other
    force-feed, so there is no code change.
  - The parenthesis on value "a payee sends back later" now says that such value is surplus.
    "can turn a payout into surplus the admin could sweep" became "can hand a payout straight back
    as surplus the admin could sweep", which is what the measurement proves.
- **Tests (F09).**
  - The round-4 pin is retitled "... where only the booking's owner can move it, takes the payout;
    the vault is left with a booking it can never withdraw, and nothing is sweepable". It checks
    the new text, and that "the payout is lost, though never sweepable" is gone.
  - New: "(pin) the documented residual, other side: a ledger that lets anyone release a booking
    to its owner hands a mis-routed payout back here as surplus, in a listed token or in native
    coin, and the admin can sweep it". It uses `ReleasableLedgerMock` (new) and runs both returns:
    `release()` sends WETH because the vault refuses the coin, and `forceRelease()` force-sends
    the coin with SELFDESTRUCT. Both times the admin sweeps the returned value. It passes on v1
    too.

### R5-2 (Low), F20: the last safe moment to correct a recipient is finalizableAt: RESOLVED (NatSpec; design kept)

- **Fix (NatSpec).**
  - `beneficiaryCancelClaim`: a new paragraph. The last safe moment to correct a recipient is
    `finalizableAt` (in `getVault` and in `ClaimInitiated`), not settlement. From that second
    anyone may call `finalizeClaim`, and a keeper's or a stranger's call mined first settles the
    claim to the recorded recipient. The credit is then that recipient's alone to withdraw, and a
    push can deliver it nowhere else. A cancel is certain to work only if it is mined before
    `finalizableAt`.
  - The disclosure that a stolen beneficiary key can redirect the payout "until finalizeClaim is
    mined" stays. That is the attacker's window, not the heir's.
  - `initiateClaim`: check the recipient before sending, because only `beneficiaryCancelClaim` can
    change it, and only safely before `finalizableAt`.
  - `finalizeClaim`: whoever mines it first from `finalizableAt` settles the claim to the recorded
    recipient.
  - THE CREDIT LANE: "(beneficiaryCancelClaim can still change it, safely only before
    finalizableAt)" instead of "before settlement".
- **Tests (F20).**
  - "(pin) the documented cost: from finalizableAt a stranger's finalizeClaim mined first settles
    the estate to the mistyped recipient for good, so the heir's cancel is certain only before
    that second". One block stamped `finalizableAt` holds a stranger's `finalizeClaim` (the higher
    tip) and the heir's cancel. The statuses are [1, 0]. The estate is credited to the typo, the
    heir cannot withdraw it, and after `PUSH_GRACE` a push delivers it to the typo. Rolled back
    and stamped one second earlier, the statuses are [0, 1], and the re-initiated claim settles to
    the heir.
  - "(guard) the NatSpec names finalizableAt, not settlement, as the last safe moment to correct a
    recipient": the four places above.

### R5-3 (Informational): Venus vBNB is refused as a payee: RESOLVED (contract)

- **Fix.** `VENUS_VBNB` (new internal constant, `0xA07c5b74C9B40447a954e1466938b865b6BBea36`) is
  refused in `_checkPayee`, like the EntryPoints. That covers every payout path, the claim
  recipient, the fee recipient (constructor included) and the sweep target. PAYOUT ADDRESSES names
  it, and its list of what no rule can see now reads "a staking, lending or deposit contract".
- **Checked read-only on 27 September 2026** (`FINAL-work/check-vbnb.js`). The address has 19,906
  bytes of code on BNB Chain. On Base it has no code and nonce 0, but it holds 1,525,300,000,000
  wei of dust, so the NatSpec says "has no code on Base", not "empty".
- **Test (F09).** "Venus vBNB is refused as a payee: native coin paid to it mints vBNB to this
  contract, which can neither redeem nor sweep it". It installs `NativeMarketMintMock` (new) at the
  address. It checks `withdrawCredit`, `withdraw`, `setFeeRecipient`, `sweepSurplus`, the
  constructor and `initiateClaim`; that nothing was minted to the vault; that the credit is kept;
  and that `sweepSurplus(vBNB)` reverts `UnsupportedToken`, because it is not listed. On the
  pre-finalization contract and on v1 the payout goes through, and the vault holds 50 vBNB.
- **Cost:** +39 runtime bytes.

### R5-4 (Informational): no test used a SETTLED vault in checkIn or checkInMany: RESOLVED (test)

- **Test (F15).** "a SETTLED vault is terminal for checkIn and checkInMany, before and past its
  horizon: VaultNotActive(id, SETTLED) and SKIP_TERMINAL, never HorizonReached". It settles two
  vaults: one with its horizon far off, and one whose horizon then passes.
  - `checkIn` reverts `VaultNotActive(id, 3)` before and past the horizon, never `HorizonReached`.
  - `checkInMany([0, 1, 2])` logs `0:skip2`, `1:skip2` and `2:in`.
  - `checkInMany([0, 1])` reverts `NothingCheckedIn(4)`, and so does `checkInMany([1])` past the
    horizon.
- Round 5's mutants H9 and K8 survive the pre-finalization suite (231 passing). This test kills
  both.

### R5-5 (Informational): the F27 guard was a text regex: RESOLVED (tests)

- **The guard keeps its text layer and gains an AST layer**, read from the compiler's own AST
  (Hardhat's build info), as round 4 did for F01:
  - every `deadline` member of a stored `Vault` (type `struct InheritanceVault.Vault storage ...`)
    that is an lvalue must sit in `_resetClock`, and there must be exactly one. A delete, a tuple
    target and `++` are all lvalues;
  - no whole stored `Vault` may be an lvalue (assigned into, deleted or a tuple target). The one
    lvalue allowed is a storage pointer being pointed at a vault (`v = _vaults[o][id]` in
    `_vault`), which writes nothing;
  - no inline assembly may `sstore` or take a `.slot`;
  - `DeadlineReset` is emitted only in `_resetClock`.
- **New behavioural test (F27).** "DeadlineReset stays a complete record through a claim, a
  cancel and a settlement: after each, getVault's deadline is the last one logged". It covers the
  three claim paths that the owner-action test does not. On v1 it fails for F27's reason: there is
  no DeadlineReset.
- `delete v` on the storage pointer itself does not compile (TypeError), so no layer needs to
  cover it.

### Mutation check (sandbox, vault suite: AuditPrelim2026-09.ts + Audit.ts + InheritanceVault.ts)

The runner is `scratchpad/poc/mutate-final.js`. It applies each mutant to one copy of the
pre-finalization source with its suite (`FINAL-mut-old/mutants-old-result.txt`) and to one copy
of the final source with its suite (`FINAL-mut-new/mutants-new-result.txt`).

| Mutant | Change | Pre-finalization suite (231 tests) | Final suite (242 tests) |
|---|---|---|---|
| H9 | `checkIn` treats only CLOSED as terminal | survived | killed: F15 SETTLED test |
| K8 | `checkInMany` skips only CLOSED as terminal | survived | killed: the same |
| F27a | `delete v.deadline` in `finalizeClaim` | survived | killed: F27 behavioural test; F27 guard, AST member write |
| F27b | a tuple write of the deadline in `initiateClaim` | survived | killed: the same |
| F27c | `v.deadline++` in `initiateClaim` | survived | killed: the same |
| F27d | a whole-struct write of a copy with the deadline + 1, in `beneficiaryCancelClaim` | killed: F20 "deadline and horizon untouched" | killed: F20; F27 behavioural test; F27 guard, AST whole struct |
| F27d0 | a whole-struct write of an unchanged copy, same place | survived | killed: F27 guard, AST whole struct, alone |
| F27f | an `sstore` of the vault's slot 1 with its own value, same place | killed: F01 guard | killed: F01 guard; F27 guard, AST assembly |
| F27g | `delete v` of the storage pointer | does not compile | does not compile |
| VB1 | `_checkPayee` stops refusing vBNB | (new code) | killed: F09 vBNB test |

Each AST rule was seen to fail on its own mutant, with the message naming it: the member rule
on F27a to F27c, the whole-struct rule on F27d0 and the assembly rule on F27f.

### Final read of the NatSpec and comments

Every NatSpec block and every comment was read against the code. No real bug was found. The
items below were stale or wrong. They are corrected, in NatSpec and comments only.

- **F21 and F29: comments the audit report says v2 "still carries".** Each now has a guard in a
  new block, "F21 and F29 the v2 source comments say what the code does". Each guard runs the
  contract first, then checks the comment, so each fails on the audited wording.
  - T1 said the owner key can "veto any claim". Past the horizon `abortClaim` reverts. Now the
    owner key can stop any claim that has not settled, with the veto before the horizon and past
    it only as T3 says.
  - T2 said a lost heir key leaves the funds "stuck until the horizon". Nothing opens at the
    horizon: only the beneficiary can ever start a claim, so the funds are stuck for good. The
    guard looks 20 years past `guaranteedInheritanceAt`.
  - T3 called `extendHorizon` "the ONLY way past the date". It priced each override at "one full
    inactivity period" and said nothing moves the date "without bound". Now, and each point is
    checked by the guard:
    - nothing but the live owner key can move the date;
    - it can move the date or stop a claim only in two logged ways: withdrawing everything, or
      `extendHorizon` to at least one inactivity period and at most `MAX_HORIZON` ahead;
    - either one ends a pending claim;
    - the date holds for an heir who claims by the horizon;
    - the period can first be cut to `MIN_INACTIVITY` (7 days) while no claim is pending;
    - one call can move the horizon 100 years ahead;
    - naming a new heir past the horizon does not move the date.
  - `_clearPending` said "Any owner action supersedes a running claim", but a check-in and a
    top-up do not. It now names the five actions that do. It also says a full withdrawal ends a
    claim by closing the vault, without going through `_clearPending`.
  - `_setCheckInChain` said that installing a chain past the horizon "would take a fee". The call
    is not payable, and the comment now says "would cost gas".
- **Also corrected.**
  - The contract `@notice` said the heir "is paid" at finalization, where finalization records a
    credit. It also offered the veto for the whole window, which holds only before the horizon.
  - `beneficiaryCancelClaim`'s list of gap costs called `extendHorizon` "the only way to stop the
    claim itself". A full withdrawal stops it too. This is the same overstatement as T3.
  - `SKIP_HORIZON_REACHED` and `SKIP_CLAIM_PENDING_PAST_HORIZON` said the horizon "has passed".
    Both are given AT the horizon second (`>=`, pinned in round 4), so they now say "has been
    reached". The round-3 F15 test pins both.
  - `ClaimFeeChanged` said "the rate in force changed". `setClaimFee` at the rate in force, which
    is how a raise is called off, emits it with both rates equal. The F06 test now asserts
    `ClaimFeeChanged(20, 20)`.
  - `setFeeRecipient` named only `wrappedNative` and the listed tokens as refused. It refuses every
    address the payout rule refuses.
  - `BALANCE_READ_GAS` said "about ten times what the proposed tokens ... use cold". The list is no
    longer a proposal. Measured read-only on Base (`FINAL-work/measure-balanceof.js`), a cold
    `balanceOf` costs about 12,600 gas through the USDC, EURC and cbBTC proxies and 5,300 for
    WETH. The cap is about eight times the first figure.
  - `topUp`'s comment said a token's callback could close a vault during `_pull`. Every function
    that changes a vault is `nonReentrant`, and the F38 hook test shows the re-entry refused, so
    the re-check is defence in depth. Its NatSpec said the refusal mid-claim keeps "the amount an
    heir is claiming" from moving. Past the horizon a partial withdrawal still moves it, so the
    NatSpec now says only that a gift cannot.
  - `checkInMany`'s explanation sat inside its `@return` tag. It is now `@dev`, and `@return`
    comes last.
- **Read and found accurate:** ACCOUNTING, SUPPORTED TOKENS, FEES, NOT SUPPORTED, VIEWS, THE
  CHECK-IN CHAIN and EVENTS; T4; THE CREDIT LANE apart from R5-2; the struct and view field notes;
  every event and error apart from `ClaimFeeChanged`; the constructor; `_holdings`, `_payout`,
  `_pull`, `_credit`, `_payCredit` and `_nextDeadline`; `checkInByChain`, `setCheckInChain`,
  `extendHorizon`, `abortClaim`, `withdraw`, `pushCredit` and the fee functions.

### Launch-neutral wording outside the marker script's reach

`scripts/set-launch-values.js` replaces the launch markers in site/, README.md, SECURITY.md,
AUDIT_SCOPE.md, DEPLOY.md and the report generator's inputs. Three of this pass's files state v2's
deployment status and are not on that list. They now say nothing that the launch would make false:

- `docs/CHECKIN-CHAIN.md`: "**It is not deployed.**" is removed, and v1 is named by its address
  instead of "the Base deployment";
- `scripts/checkin-chain.ts`: the same, in its header;
- this file's header, which is now dated.

### Flagged for the lead (outside this pass's files)

- **Report generator** (`tmp/audit-2026-09-workbench/report-gen/gen.cjs`). It reads the v2 source.
  - Its line gate expects 1,573 lines. The source now has 1,615.
  - Its `V2_BASELINE` expects all five audited comments (t1, t2, t3, clear, fee). All five are now
    reworded, so it warns for each. Its F21 and F29 "In v2 source" text switches to "reworded since
    the audit" by itself; re-read both before publishing.
  - Hard-coded figures to update: 21,080 bytes becomes 21,119; `npx hardhat test` 244 becomes
    255; the v1 run's 51 and 124 become 57 and 129.
- **`scripts/deploy.ts`** refuses an EntryPoint `FEE_RECIPIENT` or `ADMIN_ADDRESS` before sending.
  Add vBNB before a BNB deploy. The constructor now refuses it as the fee recipient anyway, and it
  does not matter on Base, where the fee recipient is the Ledger.
- **APP (v2).** Confirm the recipient at claim start and show `finalizableAt` as the correction
  deadline (R5-2). Keep warning on any payee with code (R5-1).

### Files changed in the pre-launch finalization

- `contracts/InheritanceVault.sol`: `VENUS_VBNB` (new) and `_checkPayee` refusing it; NatSpec and
  comments as listed above.
- `contracts/test/TestHelpers.sol`: `NativeMarketMintMock`, `ForceSend` and `ReleasableLedgerMock`
  (new).
- `test/AuditPrelim2026-09.ts`:
  - `VENUS_VBNB` and the `docAbove()` helper;
  - F09: 2 new tests, and the round-4 pin retitled;
  - F20: 1 new pin and 1 new guard;
  - F15: 1 new test, and the round-3 test's NatSpec check;
  - F27: 1 new test, and the guard's AST layer;
  - F06: one assertion added;
  - a new block, F21 and F29: 5 guards.
- `docs/CHECKIN-CHAIN.md`, `scripts/checkin-chain.ts`: launch-neutral wording.
- `CHANGELOG-v2.md`: the header, the round-5 table and this section.

### Counts

- `npx hardhat test`: **255 passing, 0 failing** (244 before). There are 11 new tests: F09 +2,
  F20 +2, F15 +1, F27 +1, and F21 and F29 +5.
- `VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts`: **57 passing, 129 failing** (51 and
  124 before). All 57 are "(control)", "(guard)" or "(pin)".
  - The 6 more passing: the new F09 pin, which v1 shares; the new F20 guard; and the T1, T2, T3
    and "would take a fee" guards. All four behave the same on v1 and read the v2 source.
  - The 5 more failing:
    - the vBNB test fails for F09's reason: v1 pays vBNB;
    - the SETTLED test fails for F15's reason: v1's `checkInMany` logs no skip;
    - the DeadlineReset test fails for F27's reason: v1 emits none;
    - the new F20 pin fails in its control half only, because v1 has no `beneficiaryCancelClaim`;
    - the `_clearPending` guard fails because v1 cannot disarm a chain (F28), not because of F29.

## Pre-launch review

On 27 September 2026 three fresh reviewers (security, launch configuration, tests) read the
finalized source, `scripts/deploy.ts` and the suite. They reported 16 issues: one medium, ten low
and five informational. **None is high or critical, and none is a defect in the v2 contract.**
Each was reproduced independently in a sandbox before anything changed, and all 16 hold.

- **No contract change.** Runtime size: **21,119 bytes**, unchanged.
- **Items 10 to 16 (tests): FIXED.** The medium one is a gap in the tests on a fund-safety guard,
  not a bug. 8 new tests and 1 corrected test in `test/InheritanceVault.ts`, and one header
  correction in `test/AuditPrelim2026-09.ts`. A mutation check (below) shows what each adds.
- **Items 1 to 9 (`scripts/deploy.ts`, `DEPLOY.md`): CONFIRMED, NOT FIXED HERE.** They are six
  distinct defects (three were reported twice). Neither file belongs to this pass: the deploy
  script belongs to the deploy rehearsal, and `DEPLOY.md` to the documentation track. No user
  funds are at risk in any of them. But a stranger can make a correct deployment read as failed
  (1, 7), a failed RPC read can lose the record and lead to a second vault (2, 4), and a wrong
  permanent admin, token list or fee deploys with no alarm (3, 5, 6, 8). **Fix them before the
  mainnet run.** A tested reference patch is in `scratchpad/plfix-deploy-proposed.ts` (diff:
  `scratchpad/plfix-deploy-ts.diff`); see "For the owner of scripts/deploy.ts" below.

| # | Lens | Severity | Issue | Disposition |
|---|---|---|---|---|
| 10 | tests | **Medium** | No test asserted `VaultTerminal`: either terminal arm of `_requireLive` could be dropped | FIXED (tests) |
| 11 | tests | Low | `checkInByChain` on a SETTLED or CLOSED vault was untested | FIXED (tests) |
| 12 | tests | Low | `topUp` on a terminal vault was untested, although a test's title said it was | FIXED (tests) |
| 13 | tests | Low | The constructor's fee cap was untested | FIXED (tests) |
| 14 | tests | Informational | The terminal views and `initiateClaim`'s state check were unpinned | FIXED (tests) |
| 15 | tests | Informational | Two one-second boundaries were unpinned (the `MAX_HORIZON` cap, `expired`) | FIXED (tests) |
| 16 | tests | Informational | The v1-run header's list of v2-only API omitted `HB_DOMAIN` | FIXED (test header) |
| 1, 7 | security, launch config | Low | 1 wei sent to the predictable vault address fails the read-back: "do NOT use" | CONFIRMED; deploy.ts |
| 2, 4 | security, launch config | Low | The record is written after ~30 unguarded reads; a thrown read loses it, and a re-run deploys a second v2 | CONFIRMED; deploy.ts |
| 3, 6 | security, launch config | Informational, Low | Lowercase role addresses skip the EIP-55 check; nothing pauses before the send; the vault can own itself | CONFIRMED; deploy.ts |
| 5 | launch config | Low | `SUPPORTED_TOKENS` / `WRAPPED_NATIVE` overrides are accepted on a mainnet with no metadata check, and read back "ok" | CONFIRMED; deploy.ts |
| 8 | launch config | Low | A blank `CLAIM_FEE_BPS` parses as 0 bps and deploys | CONFIRMED; deploy.ts |
| 9 | launch config | Informational | deploy.ts's printed step 2 and `DEPLOY.md` contradict the launch plan | CONFIRMED; deploy.ts and `DEPLOY.md` |

### 10. No test asserted VaultTerminal (tests lens, Medium): FIXED (tests)

- **Confirmed.** `grep VaultTerminal test/*.ts` finds nothing. Dropping the SETTLED arm (ST3) or
  the CLOSED arm (ST4) of `_requireLive` passes all 242 vault tests (`PLFIX-old-*`), and so does
  dropping the call from any one of its five callers (RLW, RLB, RLI, RLH, RLC).
- **The damage, confirmed by a probe that only logs** (`scratchpad/poc/PLFIX-probe/test/pl-probe.ts`).
  Alice's vault 0 has settled; her vault 1 is live and alone in the open set.
  - Real v2: the stray `withdraw(0, type(uint256).max, alice)` reverts `VaultTerminal(0, 3)`; the
    open set stays `[1]`; bob's claim on vault 1 settles, and Alice's full withdrawal of it works.
  - Under ST3: the stray call goes through for 0 and closes vault 0 again at its stale
    `openIndex` 0. That pops the LIVE vault 1: the open set is `[]` and `vaultsClosed` is 1. Bob's
    `finalizeClaim(1)` and Alice's own `withdraw(1, max)` then both panic 0x11, for good.
  - The contract is correct today. The gap was that nothing would have caught a regression on
    this line.
- **Tests (`test/InheritanceVault.ts`, new block "terminal vaults").**
  - "every owner action refuses a SETTLED and a CLOSED vault with VaultTerminal, before and past
    its horizon". It covers `withdraw` with the sentinel and with 1 wei, `setBeneficiary`,
    `setInactivityPeriod`, `extendHorizon`, and `setCheckInChain` in both forms and as a disarm.
    Each must revert `VaultTerminal(id, state)`, also past the horizon, where a horizon test
    placed first would answer `HorizonReached` instead.
  - "a stray close or settlement of a terminal vault cannot drop a live vault from the open set
    or strand it". Vaults 0 (settled) and 1 (closed) both left the open set from slot 0; live
    vaults 2 and 3 fill slots 0 and 1. After stray `withdraw(max)` calls on 0 and 1, and a keeper's
    repeated `finalizeClaim` on each, the open set must still be `[2, 3]`. Then bob settles 2 and
    Alice closes 3. This pins what the refusals protect, whatever error they use.

### 11. checkInByChain's refusal of terminal vaults was untested (tests lens, Low): FIXED (tests)

- **Confirmed.** ST1 (SETTLED accepted) and ST2 (only CLAIM_PENDING refused) pass all 242 vault
  tests. Round 5's R5-4 covered `checkIn` and `checkInMany` only.
- **Test.** "checkInByChain refuses a SETTLED and a CLOSED vault, before and past the horizon, and
  the armed value stays unspent". Each vault is armed with a one-value chain built by
  `scripts/checkin-chain.ts`; vault 0 then settles, vault 1 is closed. `checkInByChain` must
  revert `VaultNotActive(0, 3)` and `VaultNotActive(1, 4)`, with `hbAnchor` and `hbLeft`
  unchanged, before vault 0's horizon and past it. The second pass also pins the order: the
  state test comes before the horizon test (mutant ORDB).

### 12. topUp's refusal of terminal vaults was untested (tests lens, Low): FIXED (tests)

- **Confirmed.** "is refused mid-claim and on terminal vaults" only tried a pending claim. ST10
  (SETTLED accepted by both checks) passes all 242 vault tests, and so does ST10c (CLOSED).
- **Fix.** The same test now also tops up a SETTLED and a CLOSED vault: `VaultNotActive(0, 3)` and
  `VaultNotActive(1, 4)`, and `totalLocked` stays 0. The pending case now checks its arguments
  too.

### 13. The constructor's fee cap was untested (tests lens, Low): FIXED (tests)

- **Confirmed.** The only `FeeTooHigh` assertion was `setClaimFee(101)`. FT17 (the constructor
  refuses only 65,535) passes all 242 vault tests.
- **Test.** "the constructor refuses a claim fee above MAX_CLAIM_FEE_BPS, and accepts the cap
  itself": 101, 5,000 and 65,535 revert `FeeTooHigh(bps, 100)` (matched on the factory), and a
  deployment at 100 reports `claimFeeBps()` 100.

### 14. The terminal views and initiateClaim's state check were unpinned (tests lens, Informational): FIXED (tests)

- **Confirmed.** ST7 (a SETTLED vault reports `finalizableAt` and `finalizable` from its old
  claim, which `finalizeClaim` leaves in storage), ST6b (a CLOSED vault loses warnings bit 7) and
  ST11 (`initiateClaim` on a SETTLED vault reaches `NothingToClaim`) each pass all 242 vault tests.
- **Tests.**
  - "getVault and warningsOf report a SETTLED or CLOSED vault as terminal alone: nothing
    finalizable, no locked fee, also past its horizon": warnings 128, `finalizable` false,
    `finalizableAt` 0 and `lockedFeeBps` 0 for both vaults, once terminal and past the horizon.
    The test first checks that both deadlines have passed, so a lost bit 7 would show.
  - "every claim call refuses a SETTLED and a CLOSED vault": `initiateClaim` reverts
    `VaultNotActive(id, state)`; `beneficiaryCancelClaim`, `abortClaim` and `finalizeClaim` revert
    `NoClaimPending(id)`; bob's credit is unchanged.

### 15. Two one-second boundaries were unpinned (tests lens, Informational): FIXED (tests)

- **Confirmed.** HZ19 (`createVault` refuses a horizon exactly `MAX_HORIZON` out) and HZ23
  (`getVault().expired` one second late) pass all 242 vault tests. So does HZ19b, which accepts a
  horizon one second past the cap.
- **Tests.**
  - "accepts a horizon exactly MAX_HORIZON ahead, and refuses one a second further": in blocks
    stamped exactly, `t + MAX_HORIZON + 1` reverts `HorizonTooFar(t + MAX_HORIZON + 1,
    t + MAX_HORIZON)`, and `t + MAX_HORIZON` is accepted and recorded.
  - "getVault's expired flag turns AT the deadline second, the second from which the heir may
    claim": false with warnings 0 a second before; at the deadline second the heir's
    `initiateClaim` goes through and `expired` is true.

### 16. The v1-run header omitted HB_DOMAIN (tests lens, Informational): FIXED (test header)

- **Confirmed.** In a fresh v1 run (`PLFIX-v1`, 57 passing, 129 failing), 18 tests fail with
  "function selector was not recognized", 13 of them unlabelled. Each of the 13 calls API on the
  header's list, except the F02 step test, whose first call is `HB_DOMAIN()`.
- **Fix.** The header of `test/AuditPrelim2026-09.ts` now names `HB_DOMAIN` first in that list.
  The failure itself is legitimate: the domain tag is part of the F02 fix.

### Beyond the report

Found while confirming items 10 to 15, and pinned by the same tests:

- **`finalizeClaim` on a SETTLED vault** (mutant FZ1) was unpinned too, and its regression would
  be worse than ST3: `finalizeClaim` is permissionless. Under FZ1 the probe shows a stranger's
  second `finalizeClaim(0)` going through, emptying the open set (`vaultsSettled` 2), and the same
  two panics on the live vault. A stranger could have frozen any owner's live vault.
- **`abortClaim` on a SETTLED vault** (AB2) was unpinned.
- **The order of the terminal and horizon tests** in `_setCheckInChain` (ORDC), as in
  `checkInByChain` (ORDB), was unpinned.

### For the owner of scripts/deploy.ts (items 1 to 9): CONFIRMED, NOT FIXED HERE

Each was reproduced with the UNMODIFIED script in `scratchpad/poc/PLFIX-deploy` (the wrapper
`scripts/pl-wrap.ts` only prepares the chain, then loads `deploy.ts`):

- **1, 7: the native-surplus read-back.** A stranger sends 1 wei to the predicted address, then
  the deploy runs: "note surplus reachable by admin in native coin: 1", "1 post-deploy check(s)
  failed: do NOT use", exit 1, record `readBack` "1 check(s) FAILED: do not use". Read-only on
  Base at block 51,852,626: the hot key's next nonce is 8, and the addresses for nonces 8, 9 and
  10 hold 0 wei, so the defect is latent. **The same class, beyond the report:** a stranger's
  `createVault` on the new contract before the read-back makes "no vaults yet" FAIL the same way
  (reproduced). Nothing a third party can do after the send is a property of the deployment.
- **2, 4: the record.** With the first `eth_call` to the new contract failing (as a lagging or
  rate-limited RPC would), the vault was deployed, no record or args file was written, and exit
  was 1. The same command run again on the same node deployed a second vault at the next nonce and
  recorded only that one (`PLFIX-deploy`, a local node on port 8631, nonces 1 and 2).
- **3, 6: the role addresses.** `ethers.getAddress` refuses the checksummed Ledger address with
  one digit wrong, but accepts the same typo in lowercase. The script has no dry run and no
  confirmation step (`scripts/transfer-admin.ts` has `CONFIRM=yes`). On an unforked chain with id
  8453, where the script takes its Base mainnet branches (`hardhat.8453.config.ts`, with stand-ins
  answering the four tokens' symbols and decimals), the lowercase typo deployed as the owner with
  `readBack` "ok". With `ADMIN_ADDRESS` set to the vault's own predicted address it deployed a
  vault that owns itself, printed as "wallet (no code)", also with `readBack` "ok". On Base today
  `v1.owner()` and `v1.feeRecipient()` are both the Ledger.
- **5: token overrides.** An override entry is `{ address }` alone, so the symbol and decimals
  checks are skipped; `overridden` is used only for a printed line; nothing refuses an override on
  a mainnet; and the read-back compares with the overridden inputs. On the chain-8453 run,
  `SUPPORTED_TOKENS` = WETH alone deployed a one-token list for good, and `WRAPPED_NATIVE` = USDC
  deployed with USDC as `wrappedNative`, both with `readBack` "ok".
- **8: the fee.** `CLAIM_FEE_BPS=" "` and `CLAIM_FEE_BPS=` each deployed at 0 bps with `readBack`
  "ok"; `0x32` and `5e1` were read as 50.
- **9: the runbook.** deploy.ts prints "Do NOT set site/assets/app.js CHAINS[...].contract to it
  ... Ship a v2 app first", which the plan reverses. `DEPLOY.md` still deploys NotifySubscription,
  verifies with v1's three constructor arguments, and makes an independent review a precondition
  of mainnet, against the owner's decision. (`DEPLOY.md` is the documentation track's, which is
  already rewriting it for v2.)

**The reference patch** (`scratchpad/plfix-deploy-proposed.ts`, tested in
`scratchpad/poc/PLFIX-deploy2`: 26 cases in `pl-cases.sh`, on chain 31337, on an unforked chain
8453 with stand-ins for the four Base tokens, and on a local node; results in `pl-cases.out`):

- On a mainnet nothing is sent without `CONFIRM=yes`. The first run is a dry run that prints the
  deployer's next nonce and the vault's future address. The send also needs
  `EXPECT_DEPLOYER_NONCE` equal to that nonce, and the deployment is sent from exactly that nonce,
  so no re-run can send a second vault.
- The record, with the transaction hash, nonce and address and `readBack` "pending", is written
  the moment the deployment is sent. A failed receipt or a failed read-back call is recorded as
  such (never as a pass), the script stops with "do NOT deploy again", and `READBACK=yes` re-runs
  the read-back alone. A re-run of the deploy is refused because the record exists.
- The read-back reads the deployment block, and reports vault activity and surplus as notes: a
  stranger's 1 wei or `createVault` is not a fault.
- On a mainnet, role addresses must be pasted in checksummed form, and on every chain neither may
  be the vault's own address. On Base the launch plan (admin = fee recipient = the Ledger, 50 bps,
  the table's four tokens) is enforced unless `ALLOW_PLAN_OVERRIDE=yes`.
- On a mainnet, token overrides need `ALLOW_TOKEN_OVERRIDE=yes` and `0xADDRESS:SYMBOL:DECIMALS`
  for each entry, and a table chain's wrapped-native token cannot be overridden.
- `CLAIM_FEE_BPS` must be digits from 0 to 100; a blank value is refused.
- Step 2 prints the `scripts/set-launch-values.js` command with the address, block, transaction
  and date for chains 8453 and 84532. `_checkPayee`'s vBNB is added to the pre-send refusals.

The runbook changes with it: a dry run first, then the same command with `CONFIRM=yes` and
`EXPECT_DEPLOYER_NONCE`. Run the mainnet deploy against a keyed `BASE_RPC_URL`, not the public
rate-limited endpoint (item 2's operational half). The deploy rehearsal on a Base fork should run
the patched script before the user does.

### Mutation check (sandbox, vault suite: AuditPrelim2026-09.ts + Audit.ts + InheritanceVault.ts)

Runner `scratchpad/poc/plfix-mutate.js` with `plfix-mutants.js`: each mutant is applied to a copy of
the finalized source (every anchor occurs exactly once) and run against the suite before this
review (`PLFIX-old-*`, 242 tests) and after it (`PLFIX-new-*`, 250 tests). Results in
`plmut-old-*.tsv` and `plmut-new-*.tsv`.

| Mutant | Change | Before (242 tests) | After (250 tests): killed by |
|---|---|---|---|
| ST3 / ST4 | `_requireLive` drops SETTLED / CLOSED | survived | owner actions; stray close (open set `[3]`, not `[2, 3]`) |
| RLW, RLB, RLI, RLH, RLC | one caller drops `_requireLive` (`withdraw`, `setBeneficiary`, `setInactivityPeriod`, `extendHorizon`, `_setCheckInChain`) | survived | owner actions (RLW also the stray close) |
| ORDC | `_setCheckInChain` tests the horizon first | survived | owner actions, past the horizon |
| ST1 / ST2 | `checkInByChain` accepts SETTLED / SETTLED and CLOSED | survived | `checkInByChain` test |
| ORDB | `checkInByChain` tests the horizon first | survived | the same, past vault 0's horizon |
| ST10 / ST10c | `topUp` accepts SETTLED / CLOSED (both checks) | survived | `topUp` "on terminal vaults" |
| ST11 | `initiateClaim` on SETTLED reaches `NothingToClaim` | survived | claim calls |
| FZ1 | `finalizeClaim` accepts SETTLED again | survived | claim calls; stray close |
| AB2 | `abortClaim` accepts SETTLED | survived | claim calls |
| ST7 | SETTLED reports `finalizableAt` / `finalizable` | survived | terminal views |
| ST6b | CLOSED loses warnings bit 7 | survived | terminal views |
| FT17 | constructor refuses only 65,535 | survived | constructor fee cap |
| FT18 | constructor refuses the cap itself | killed (F05 test) | the same, and constructor fee cap |
| HZ19 / HZ19b | `createVault` refuses exactly `MAX_HORIZON` / accepts a second more | survived | `MAX_HORIZON` boundary |
| HZ23 | `expired` one second late | survived | `expired` at the deadline second |

### Files changed in the pre-launch review

- `test/InheritanceVault.ts`: `vaultFactory` imported; "is refused mid-claim and on terminal
  vaults" completed; 3 new tests (the `MAX_HORIZON` boundary, the constructor's fee cap,
  `expired` at the deadline second); a new block "terminal vaults" with 5 tests.
- `test/AuditPrelim2026-09.ts`: the header names `HB_DOMAIN`.
- `CHANGELOG-v2.md`: the header's date scope, and this section.
- Unchanged: `contracts/InheritanceVault.sol`, `contracts/test/TestHelpers.sol`,
  `scripts/checkin-chain.ts`, `docs/CHECKIN-CHAIN.md`.

### Flagged for the lead (outside this pass's files)

- **`scripts/deploy.ts`: items 1 to 9, before the mainnet run.** Apply the reference patch or an
  equivalent, and rehearse it on the Base fork.
- **`DEPLOY.md`:** item 9 (documentation track).
- **Report generator** (`gen.cjs`): `npx hardhat test` is now 263, not 255. The v1 run (57 and
  129) and the runtime size (21,119 bytes) are unchanged.

### Counts

- `npx hardhat test`: **263 passing, 0 failing** (255 before). The 8 new tests are all in
  `test/InheritanceVault.ts`.
- `VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts`: **57 passing, 129 failing**,
  unchanged. All 57 are "(control)", "(guard)" or "(pin)". The new tests are in a file the v1 run
  does not load: they pin checks that v1 has too, not audit findings, so they belong in the unit
  suite rather than the regression file.
- Runtime size: **21,119 bytes**, unchanged; EIP-170 leaves 3,457 bytes of headroom.
