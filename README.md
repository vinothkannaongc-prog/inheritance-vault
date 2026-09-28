# InheritanceVault

A self-custody **dead man's switch** for EVM chains: deposit ETH or a listed ERC-20 token, name an
heir, and check in on a schedule you chose. Stop checking in for longer than your inactivity
period and your heir may claim; a challenge window then runs during which you can still stop the
claim (with a veto before your horizon; past the horizon, only by extending it or withdrawing
everything); once the window has run, anyone can finalize and your heir's payout is credited to
them. No custodian, no lawyer holding a seed phrase, no key-sharing while you're alive.

**Will & Key sends no alerts of any kind.** Nobody will notify you if your timer expires or a claim
is filed, your wallet will not show a claim against your vault, and nobody notifies your heir. The
veto only helps if you look.

**Version 2 is live on Base** (chain id 8453) at `0xA07b59d9249A996604A5fF482f1E564EdeE3A774`, deployed on 2026-09-28
(transaction `0x4bbd4b1d74924f64e0c817ff1815ade20a0141094c091003ec1f527b86413e8e`, block 51900754). Version 1 (`0xC821849A1D74959753450409b594b23eCE7fEe2f`)
is retired. **BNB Chain is planned, not deployed.** Those are the only chains the contract has been
reviewed for. Its token list is permanent and must meet the rules in the contract's SUPPORTED TOKENS
comment; on a chain whose native coin also has an ERC-20 address (Celo and Moonbeam are examples),
never list that address, or the admin's surplus sweep could reach vault balances.

## Security status (2026-09-28)

- **Live contract (v2):** `InheritanceVault` at `0xA07b59d9249A996604A5fF482f1E564EdeE3A774` on Base, deployed on 2026-09-28
  (transaction `0x4bbd4b1d74924f64e0c817ff1815ade20a0141094c091003ec1f527b86413e8e`, block 51900754). It is immutable. Its source is
  [`contracts/InheritanceVault.sol`](contracts/InheritanceVault.sol); the runtime bytecode
  fingerprints are in [AUDIT_SCOPE.md](AUDIT_SCOPE.md).
- **v2 is not independently audited.** It was written in response to the 2026-09 preliminary audit
  of v1, and since then it has been reviewed only by AI agents of the same kind that wrote it: five
  fix-review rounds (48 issues), a pre-launch finalization and a pre-launch review (16 issues, none a
  defect in the contract). Every change and review item is in [CHANGELOG-v2.md](CHANGELOG-v2.md).
- **Retired contract (v1):** `0xC821849A1D74959753450409b594b23eCE7fEe2f` on Base, live from
  2026-08-09 to 2026-09-28 and source-verified on Basescan. Its deployed source is
  `contracts/InheritanceVault.sol` at the tag `v1-base` (commit `b8baf34`); the working tree keeps it
  as [`contracts/v1/InheritanceVaultV1.sol`](contracts/v1/InheritanceVaultV1.sol), identical except
  for the contract name and a header comment. Its new-vault creation is paused (transaction
  `0x195ddeb6ec795a327c430e772ab5239a10b4a682f172b10fefd41cfb2af647c7`). On 2026-09-27 it held no user funds: one vault had ever been created on it, the
  project's own test, since closed, and its only balance was a 0.00002 ETH credit owed to the former
  deploy key. It cannot change, so every contract behaviour the preliminary audit reported is still
  present in it. Do not send it funds; a v1 credit can still be withdrawn with `withdrawCredit`.
- **Internal review (2026-08):** [AUDIT-2026-08-09.md](AUDIT-2026-08-09.md), of v1, run by the same
  system that wrote the code. Not independent.
- **Preliminary audit (2026-09):** of v1, performed by AI auditing agents at the project's request.
  Not independent. 47 findings (5 medium, 21 low, 21 informational; none rated high or critical),
  published at <https://willandkey.com/audit>, with executable evidence against v1 in
  [audit/2026-09-preliminary/](audit/2026-09-preliminary/). Each of v2's contract fixes has a
  regression test in [`test/AuditPrelim2026-09.ts`](test/AuditPrelim2026-09.ts), which covers 23 of
  the 47 findings; the other 24 have no contract fix to test (they concern the app, the
  documentation, tooling or operations, or were kept by design).
- **Independent third-party audit:** still pending, for v1 and v2. Do not use material value until it
  is complete. A full-duration Base Sepolia lifecycle test of v2 has not been completed either.

Everything below describes v2.

## How it works

```
create ──► ACTIVE ──(deadline passes, heir claims)──► CLAIM_PENDING ──(window passes, anyone finalizes)──► SETTLED
            │  ▲                                          │
            │  └── owner veto or other cancelling action ──┤
            │      heir cancels their own claim ───────────┘
            └──(owner withdraws everything, also mid-claim)──► CLOSED
```

- **Tokens:** a vault holds the native coin or one ERC-20 from the list fixed in the constructor
  (`supportedTokens()`). No function adds or removes a token, and `createVault` refuses any other
  (`UnsupportedToken`). See [Supported tokens](#supported-tokens).
- **Check-in** (`checkIn`): moves the inactivity deadline to `now + inactivityPeriod`, but never past
  the horizon. The first check-in within one inactivity period of the horizon moves the deadline to
  the horizon itself; from then on the deadline is pinned and `checkIn` reverts
  `DeadlinePinnedAtHorizon` (warnings bit 4), and from the horizon on it reverts `HorizonReached`.
  With a claim pending before the horizon it reverts `ClaimPendingUseAbort`: a check-in never
  cancels a claim.
- **Batch check-in** (`checkInMany`, up to 32 ids): refreshes what it can and logs
  `CheckInSkipped(owner, vaultId, reason)` for every id it skips: 1 unknown id, 2 settled or closed,
  3 claim pending before the horizon (use `abortClaim`), 4 horizon reached, 5 pinned, 6 already moved
  in this second, 7 claim pending at or past the horizon (only `extendHorizon` or a full withdrawal
  ends it). If it moves no deadline it reverts `NothingCheckedIn(skipped)`, with bit `1 << reason`
  set for every reason seen.
- **Claim:** only the named beneficiary can initiate, only after the deadline. The heir names the
  payout address when the claim starts (refused addresses: [Payouts](#payouts)). The claim locks the
  fee ([Revenue](#revenue)). The challenge window (min 7 days; we recommend at least 14) is your veto
  period.
- **What cancels a claim:**
  - Before the horizon: Veto (`abortClaim`), `setBeneficiary`, `setInactivityPeriod`,
    `setCheckInChain` (a disarm included), `extendHorizon`, or any `withdraw`. Each needs your wallet
    key, restarts the clock and logs `ClaimSuperseded` (Veto logs `ClaimAborted`).
  - Not a cancellation: `checkIn` (reverts `ClaimPendingUseAbort`), `checkInMany` (skips the vault),
    `checkInByChain` and `topUp` (revert `VaultNotActive`), and ordinary wallet activity. Only
    transactions sent to this contract count.
  - At or after the horizon: only `extendHorizon` to at least `now + inactivityPeriod` (and at most
    `now + MAX_HORIZON`), or withdrawing everything, which closes the vault
    (`withdraw(id, type(uint256).max, to)` closes it whatever the balance has become). `abortClaim`,
    `setBeneficiary`, `setInactivityPeriod` and `setCheckInChain` revert `HorizonReached`; a partial
    `withdraw` goes through but no longer ends the claim, so the heir inherits less.
  - The end of the window is not a veto deadline. `finalizeClaim` becomes callable, but until a
    finalize transaction is mined the owner key can still cancel. Heirs should finalize promptly;
    owners should not count on the grace.
  - A veto must be included on chain in time. On Base that depends on the sequencer; if it is down
    or censoring, a transaction can be forced in through Ethereum L1, which can take up to about
    12 hours. On BNB Chain it depends on the validators.
- **The heir's cancel** (`beneficiaryCancelClaim`): the current beneficiary can withdraw their own
  pending claim, for example to correct a mistyped payout address. The vault returns to ACTIVE with
  its deadline and horizon unchanged, and the heir can initiate again at once, with a new recipient
  and a fresh, full challenge window.
  - The last safe moment to correct a recipient is `finalizableAt` (in `getVault` and
    `ClaimInitiated`), not settlement: from that second anyone may call `finalizeClaim`, and the call
    mined first settles the claim to the recorded recipient.
  - Until settlement a stolen beneficiary key can cancel and re-initiate to any address, at the price
    of one more full window. Treat the beneficiary key as hot until settlement.
  - Between the cancel and the new claim the vault is ACTIVE with its deadline passed: before the
    horizon the owner, the owner's automation or any holder of an unspent check-in-chain value can
    check in and postpone the new claim by up to a full period; past the horizon the owner can name a new
    heir, who can claim at once. The new claim re-locks the fee at the rate then in force (up to the
    ceiling). Re-initiate straight after the cancel.
- **Horizon (long-stop)**: `absoluteDeadline` is the last date to which check-ins can push the
  deadline, so runaway check-in automation cannot defer the inheritance forever. It is not a
  guaranteed payout date. `guaranteedInheritanceAt` (= horizon + challenge window) is the earliest
  finalization if the heir claims exactly at the horizon and the owner key does nothing; the heir
  still has to claim and finalize. Past the horizon the live owner key can still stop a claim, in
  two logged ways: `extendHorizon` (at least one inactivity period ahead, which the owner can first
  cut to 7 days while no claim is pending; at most 100 years ahead; repeatable), or withdrawing
  everything. Naming a new heir past the horizon does not move the date. Never give `extendHorizon`
  to automation.
- **Payouts** go through a pull-payment credit lane ([Payouts](#payouts)): settlement never makes an
  external call, so a hostile recipient can't jam a vault.
- **Paper-seed check-in chain (advanced, no app support)**: an optional S/KEY hash chain
  (`setCheckInChain` / `checkInByChain`) lets whoever holds a 32-byte paper seed keep the vault
  alive after you lose your wallet. The app has no screen for it. The construction is specified in
  [docs/CHECKIN-CHAIN.md](docs/CHECKIN-CHAIN.md).
  - Every step is bound on chain to the chain id, this contract, the owner, the vault id and the
    installation epoch (`hbStep`, domain `HB_DOMAIN`), so a value revealed on another vault,
    deployment, chain or installation is useless here. Every `setCheckInChain` moves the vault to a
    new epoch, so re-arming never revives an old chain; install with the epoch-checked
    `setCheckInChain(id, anchor, count, expectedEpoch)`. `setCheckInChain(id, 0, 0)` disarms.
  - A value is spent only when it moves the deadline; a check-in that cannot move it reverts and
    keeps the value.
  - A chain check-in is safe only if it is mined **strictly before** the deadline: from the deadline
    on, the heir can start a claim first. Once the heir has started a claim the chain cannot stop it
    and its values are refused while the claim is pending; only your wallet key can stop it. Submit
    at least a day early.
  - Chain values are **bearer credentials**. They cannot withdraw, change the heir or veto a claim,
    but whoever holds the seed, or any unused value, can postpone your heir's claim by up to
    `count` × `inactivityPeriod`, never past the horizon, including in the gap after the heir
    cancels a claim. Size `count` to the time you actually need and guard the seed like a key.
- **Views:** `surplus`, `totalLocked`, `totalCredited`, `getVault`, `getOpenVaults` and `creditOf`
  revert while a state-changing call of this contract is running, so no callback can read a
  half-applied state. A payout recipient whose `receive()` reads one of them cannot be paid by
  `pushCredit`.

## Supported tokens

The Base deployment lists four ERC-20 tokens, fixed at deployment, besides ETH:

| Token | Address | Issuer controls |
|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Circle: upgradeable, pause, blocklist |
| WETH (also `wrappedNative`) | `0x4200000000000000000000000000000000000006` | none |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | Coinbase: upgradeable, pause, blocklist |
| EURC | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | Circle: upgradeable, pause, blocklist |

Each meets the contract's SUPPORTED TOKENS rules: one address per ledger, a balance that changes
only by transfers (no rebasing, yield, reflection or holding fee), no fee on transfer and no
transfer hooks. The contract does not trust that vetting blindly: an ERC-20 payout that does not
debit the vault by exactly the amount paid reverts (`PayoutShortfall`, `PayoutOverdebited`), and a
deposit never records more than the amount sent.

What the list cannot rule out is an issuer action. All vaults in one token share one balance at the
vault contract, so a pause, a blocklisting of the vault contract, or an upgrade that wipes its
balance would freeze or take that token for every vault at once. Claims still settle on schedule;
payouts wait until a freeze lifts.

Not supported: every other ERC-20, which `createVault` refuses (one sent to the contract directly is
stranded: `sweepSurplus` refuses unlisted tokens), NFTs (ERC-721/1155), and more than one asset per
vault.

## Payouts

`withdraw` and `finalizeClaim` move no value: they record a credit (`Withdrawn`, `ClaimSettled`).
Value leaves the contract only in `withdrawCredit`, `pushCredit` and `sweepSurplus`, whose events
(`CreditPaid`, `SurplusSwept`) are emitted after the transfer succeeded.

- `withdrawCredit(token, to)` pays the caller's whole credit to `to`; `withdrawCredit(token, to,
  amount)` pays part of it, so a token that caps a single transfer cannot freeze a large credit.
- `pushCredit(token, account)` pays `account`'s whole credit to `account` itself. The account may do
  so at any time; anyone else only from `creditedSince[token][account] + PUSH_GRACE` (30 days). The
  grace restarts when a new credit is at least as large as what is already owed; a smaller credit
  joins the running clock. So an heir whose address still holds an older credit should withdraw it
  before another claim settles into that address, or name a fresh recipient for each claim.
- Every ERC-20 payout, and every native payout to an address with code, is measured: an ERC-20
  payout must debit the contract by exactly the amount, and a native payout to an address with code
  must lower the native balance by exactly the amount and leave every listed token's balance
  unchanged (`PayoutReturned` otherwise). A native payout to an address with no code runs nothing,
  so it cannot send anything back and is not measured. A failed payout keeps the credit.
- Refused as a withdraw or `withdrawCredit` destination, a claim recipient, the fee recipient and a
  sweep target: this contract, every listed token (`wrappedNative` included), the OP-stack predeploy
  range `0x4200000000000000000000000000000000000000` to `0x42000000000000000000000000000000000007FF`,
  the four canonical ERC-4337 EntryPoints (v0.6 to v0.9) and Venus vBNB
  (`0xA07c5b74C9B40447a954e1466938b865b6BBea36`, BNB Chain). No rule can refuse every payee that
  books value to its sender (a staking, lending or deposit contract): a payout to one is lost to
  whoever named it. Pay to ordinary wallets.

## Trust model, honestly

| Scenario | Outcome |
|---|---|
| Owner key lost | Vault expires; the heir claims and finalizes. This is the designed recovery. |
| Owner key stolen | Stolen vault. The owner key is the ultimate authority — this contract defends against absence, not compromise. |
| Heir key lost (owner alive) | Owner names a new heir with `setBeneficiary`. |
| Heir key lost (owner gone) | Funds stuck permanently: only the named heir can claim, nothing happens at the horizon, and no admin rescue exists. |
| Heir key stolen during a claim | The thief can cancel and re-initiate to their own address until settlement (see the heir's cancel). |
| Nobody is watching | Will & Key sends no alerts. A claim or an expired timer goes unnoticed unless the owner or heir checks. |
| Token issuer acts | All vaults in one token share one balance at the vault contract. The issuers of USDC and EURC (Circle) and cbBTC (Coinbase) can pause, blocklist or upgrade their tokens, and so freeze every vault in that token at once. Claims still settle on schedule; payouts wait until the freeze lifts. A wipe is a loss the contract cannot prevent. |
| Admin misbehaves | Can pause *new* vault creation, cut the claim fee at once or raise it after 30 days' notice (up to 1%; a vault is never charged more than its creation-time rate), change the fee recipient (switching fees back on after none also waits 30 days), sweep surplus in ETH or a listed token, and transfer administration in two steps. It cannot add a token, and it cannot take a wei of locked or credited value beyond the settlement fee: `surplus()` is the balance minus `totalLocked` minus `totalCredited` for the same token. |

## Admin

The owner of the v2 vault, and its fee recipient, is a single Ledger hardware-wallet key,
`0x883C821103B5415C53B11E584D3592205B5CdCA3`, named in the constructor when v2 was deployed on
2026-09-28; the deploy key (`0x4306a8875a04c0FbaC76CE2FC860E0b3c7aAd986`) never held a v2 role. It
is not a multisig; moving administration to a multisig is recommended.

The same key has owned v1 and the retired `NotifySubscription` since 2026-09-24, when it took over
from the deploy key with `scripts/transfer-admin.ts` and a two-step accept. Handover transactions on
Base (also in `deployments/base.json`):

| Step | Transaction |
|---|---|
| v1 vault `setFeeRecipient` | `0x83f734ad7bf258d2d6daf64f64bb7562565d199ea0d506ae1e45fe2c5851e894` |
| v1 vault `transferOwnership` | `0x29bc7cdd3ea9bc5b611645a231d22515d536e1bbf2ac42aa134041e875343f06` |
| subscription `transferOwnership` | `0x556b174a26f670fe481d08d6fef92cdaae8b789ae728effc8c462d962ddd0527` |
| v1 vault `acceptOwnership` | `0x5a0bb97d2d421eccc399b6727c49ea37c008a0a7bb782d53cf5a59d1ce85d532` |
| subscription `acceptOwnership` | `0xff034fda9c4065a5dfa6579fa6afba3c6fb6be55da2c5b71ea323780077fd906` |

Admin functions on the v2 `InheritanceVault`, the complete list:

- `setCreationPaused(bool)`: blocks only `createVault`. Top-ups, check-ins, withdrawals, claims,
  finalization and credit withdrawals keep working, so the pause cannot stop deposits into
  existing vaults. In a migration, owners should withdraw in full, which closes the vault.
- `setClaimFee(uint16)`: 0–100 bps. A rate at or below the one in force applies at once and cancels
  any pending raise (`setClaimFee(claimFeeBps())` calls a raise off). A higher rate is only
  scheduled: it takes effect `FEE_RAISE_DELAY` (30 days) after it is announced
  (`ClaimFeeRaiseScheduled`), at that second whether or not anyone calls the permissionless
  `applyClaimFee`, and replaces any raise already pending.
- `setFeeRecipient(address)`: effective at once. `address(0)` means no fee is taken, which reaches
  pending claims too. Setting a recipient after a period with none is a raise from zero: it is in
  force only from `feeRecipientActiveAt` (now + 30 days). Refuses the payout-refused addresses.
- `sweepSurplus(token, to)`: native coin or a listed token only; moves `surplus(token)`, the balance
  above `totalLocked + totalCredited`.
- `transferOwnership` / `acceptOwnership` (two-step). `renounceOwnership` is disabled.

On v1 the same key can pause creation, change the fee at once with no delay, change or unset the fee
recipient, sweep surplus in any token, and transfer ownership. On the retired `NotifySubscription`:
`setPrice`, `withdraw`, and the same ownership functions.

## Revenue

A claim fee in basis points is taken **only when an inheritance settles** — never on deposits,
check-ins, owner withdrawals or credit payouts. How the rate is set:

1. `MAX_CLAIM_FEE_BPS = 100` (1%) is burned into the bytecode. v2 was deployed on Base on
   2026-09-28 with a claim fee of 50 bps (0.5%).
2. Each vault snapshots `claimFeeBps()`, the rate in force when `createVault` is mined, as its
   **ceiling**. A raise that is only scheduled does not count yet. The admin can never raise a vault
   above its ceiling.
3. Cuts apply at once; raises take effect 30 days after they are announced. So no rate a user pays
   can be raised in the same block as, and just before, that user's transaction.
4. `initiateClaim` locks `min(ceiling, claimFeeBps())` as `lockedFeeBps` (shown in `getVault` and in
   `ClaimInitiated`), or 0 when no fee recipient is in force. `finalizeClaim` charges
   `min(lockedFeeBps, claimFeeBps())`, and nothing when no recipient is in force at settlement. So a
   rise after the claim starts can never take the fee above the lock.
5. A cut reaches the heir only if it is still in force when `finalizeClaim` is mined. The admin may
   reverse it before then with 30 days' notice, and with a challenge window longer than 30 days the
   reversal can take effect before the heir is able to settle. An heir keeps a cut for good only by
   `beneficiaryCancelClaim` and `initiateClaim` while it is in force, at the cost of a fresh window
   and the gap described above.
6. No fee recipient in force at settlement ⇒ no fee taken, so an abandoned admin can never strand a
   claim. A recipient set after a period with none is in force only from `feeRecipientActiveAt`, for
   `initiateClaim` and `finalizeClaim` alike, so a claim started while none was in force locked a
   zero fee and stays fee-free.

## Development

```bash
npm install
npm test          # the v2 suite: unit tests, and the regression tests for the audit's contract fixes
npm run build
VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts   # the regression tests against v1: they fail, except controls, guards and pins
npm run audit:v1  # v1 evidence suite; expected to fail, see audit/2026-09-preliminary/README.md
```

Deploy keys are env-only (`DEPLOYER_KEY`), never committed; see [DEPLOY.md](DEPLOY.md). Networks
configured: `base`, `baseSepolia`, `bnb`, `bnbTestnet`.

## Lineage

The state machine is adapted from PQVault (Ozone Chain), which survived an adversarial
multi-round audit. The post-quantum WOTS-K256 signature layer was deliberately not carried over:
this contract targets mainstream wallets, where ordinary ECDSA keys are the authority — see the
trust-model header of [`contracts/InheritanceVault.sol`](contracts/InheritanceVault.sol) for exactly
what that trades away. (The header of
[`contracts/v1/InheritanceVaultV1.sol`](contracts/v1/InheritanceVaultV1.sol) describes the retired
v1.)

## Production status

On Base:

- `InheritanceVault` v2 (live): `0xA07b59d9249A996604A5fF482f1E564EdeE3A774`
- `InheritanceVault` v1 (retired, creation paused): `0xC821849A1D74959753450409b594b23eCE7fEe2f`
- Retired reminder billing contract: `0x60749aF621180de1DC05DB4f3d158D09dE979dC6`

Paid reminder sales are disabled on the website and the reminder watcher is not running. Sales are
also disabled **on chain** since 2026-09-26: the admin called `setPrice(type(uint256).max)` on the
retired billing contract (tx
`0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca`, block 51823544, recorded in
`deployments/base.json` as `subscriptionSalesDisabled`), so every `subscribe` now reverts
(`ZeroAmount`). Only the admin could reverse that. Do not send the contract funds or call it
directly; refund requests for earlier payments are handled under the site's terms. The website is
a static Cloudflare Pages deployment with locally hosted dependencies and a restrictive Content
Security Policy. Since 2026-09-28 its app manages v2 vaults only; it reads v1 only to show a
connected wallet what it still has there.

**Status: v2 deployed; reviewed only by AI agents; no independent third-party audit yet.** See
[AUDIT_SCOPE.md](AUDIT_SCOPE.md), [CHANGELOG-v2.md](CHANGELOG-v2.md),
[audit/2026-09-preliminary/](audit/2026-09-preliminary/), [AUDIT-2026-08-09.md](AUDIT-2026-08-09.md)
and [SECURITY.md](SECURITY.md).
