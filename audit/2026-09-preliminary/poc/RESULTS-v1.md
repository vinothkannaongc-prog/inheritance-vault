# v1 evidence run: results

Run of `npm run audit:v1` against v1, recorded 2026-09-26 (05:13 to 05:32 UTC). Read `../README.md` first.

- **Source under test.** `contracts/v1/InheritanceVaultV1.sol` (the v1 source deployed at
  `0xC821849A1D74959753450409b594b23eCE7fEe2f` on Base, renamed; byte-exact source at tag `v1-base`, commit
  `b8baf34`) and the unchanged `contracts/NotifySubscription.sol`.
- **Working tree.** HEAD `5bbad6e`. `git status` was identical before and after the run: the only tracked changes were `package.json` (the `audit:v1` script added with this suite) and `site/guides/what-happens-to-your-crypto-when-you-die.html` (another session's uncommitted edit, which only F44 reads, as one of all the guides). No remediation edit was present in `site/`, `notify/`, `scripts/`, the docs or `contracts/InheritanceVault.sol`, so the app, doc and script PoCs below record the v1 state at `5bbad6e`.
- **Environment.** Windows 11, Node 24.18.0, Hardhat 2.29.0, solc 0.8.28 (cancun, optimizer 200 runs). `https://mainnet.base.org` was reachable: F23's fork tests and F30's live `eth_getCode` check ran, none were skipped. The one skipped test is F29's opt-in live check (`F29_LIVE=1`).
- **Totals.** 184 failing, 88 passing, 1 skipped, in 18 minutes. The exit code is
  non-zero by design: **the failures are the evidence.**

## What "matches" means

Every PoC asserts the safe property: what the contract, the site or the docs promise. The expectation is
that on v1 **each finding's safe-property assertions fail, for the reason the finding gives**, and that the
file's controls and characterisation tests pass. A row matches when:

1. every failing test fails on its safe-property assertion (not on setup, a harness error or an
   unrelated revert), and
2. the failing and passing counts equal those of the finding's audit sandbox run ("Sandbox" column,
   failing / passing), or any difference is explained below.

**46 of 47 rows match.** The exception is **F38**, whose two SafeERC20 mutants show as killed and whose control fails, in both cases only because the shipped A-05 test (finding F39) fails on this machine; see the notes.

## Per finding

| ID | Sev | Tests | Failing | Passing | Sandbox | What the failing assertions show on v1 | Matches |
|---|---|---|---|---|---|---|---|
| F01 | M | 5 | 5 | 0 | 5 / 0 | `surplus(B)` prices 15 T of depositors' funds as surplus through the token's second address; one admin sweep takes all of it, the vault holds 0 against 10 T locked + 5 T credited, the owner's and heir's `withdrawCredit` revert, and the native-facade variant asks the facade to move the whole 10 ETH. | Yes |
| F02 | M | 7 | 7 | 0 | 7 / 0 | A stranger's forged `checkInByChain` is accepted with a link leaked on another deployment, another vault, another owner or an earlier installation; with one leaked link the dead owner's deadline moves ~700 days to the horizon, and the recovery chain is burned from 100 to 8 links in one block. | Yes |
| F03 | M | 5 | 3 | 2 | 3 / 2 | During a pending claim the owner's `checkIn` reverts `ClaimPendingUseAbort`, the app's batch `checkInMany` is confirmed (refreshed = 1) while vault 1 stays CLAIM_PENDING, and a third party then settles it to the heir (9.95 ETH). | Yes |
| F04 | M | 5 | 4 | 1 | 4 / 1 | The heir recovers 0 of a credit above the token's 100-unit maxTx (109.45, 100.005, 199, 100.097): every exit moves the whole credit in one transfer and there is no partial exit; a stranger's 10.6 donation freezes 89.55 of inheritance. The under-cap CONTROL passes. | Yes |
| F05 | L | 4 | 3 | 1 | 3 / 1 | A claim begun with no fee recipient is charged once the admin sets one mid-window: 0.5 % (0.05 ETH, also in a one-block sandwich) and the full 1 % cap on a fresh deployment. The no-recipient control passes. | Yes |
| F06 | L | 4 | 4 | 0 | 4 / 0 | A same-block admin front-run gives Alice's vault a 100 bps ceiling when 50 was quoted, the claim sandwich charges 50 bps where 10 was public, and the combined attack takes the 1 % cap (0.1 ETH) though the public rate never exceeded 0.5 %. | Yes |
| F07 | L | 2 | 2 | 0 | 2 / 0 | After the vault's rate was lowered to 0, the heir still pays 0.05 ETH (50 bps): the effective rate goes back up. | Yes |
| F08 | L | 5 | 3 | 2 | 3 / 2 | A third party's `finalizeClaim` + `pushCredit` moves a blocklisted heir's 995-token credit into his frozen address (issuer can burn it), and front-running the forwarder's pull strands it there. Both routing controls pass. | Yes |
| F09 | L | 3 | 3 | 0 | 3 / 0 | A credit pushed to the wrapped-native contract becomes vault-owned WETH that the admin sweeps as surplus: 9.95 of the heir's credit, 4 of an owner's withdrawal, or all of it with no accomplice. | Yes |
| F10 | L | 5 | 4 | 1 | 4 / 1 | Fee-on-top and shrinking tokens leave the pool under-backed: Alice's exit leaves 99 for Carol's 100, a sweep dips into the locked lane (199.9 for 200), an unrelated heir gets nothing, a later depositor funds the shortfall (90 for 100). The calibration test passes. | Yes |
| F11 | L | 3 | 3 | 0 | 3 / 0 | Yield on a positive-rebase deposit (6,288.95 T) and reflections (4,807.73 T) are swept by the admin as surplus; the heir inherits only the nominal deposit. | Yes |
| F12 | L | 4 | 1 | 3 | 1 / 3 | Blocklisting the vault address, the custodian of one owner's deposit, freezes unrelated users' withdrawals and payouts. The three characterisation tests pass. | Yes |
| F13 | L | 11 | 11 | 0 | 11 / 0 | After the challenge window closes, `abortClaim`, `setBeneficiary`, `setInactivityPeriod`, `setCheckInChain`, a 1-wei withdraw, `extendHorizon` and a full withdraw all still succeed against the matured claim (none reverts); a veto ordered ahead of the heir's finalize costs the heir 44 days. | Yes |
| F14 | L | 5 | 4 | 1 | 4 / 1 | A full withdraw that ends a pending claim emits only `Withdrawn`, so an event-sourced tracker keeps a finalizable claim that reverts `NoClaimPending` and never clears. The control passes. | Yes |
| F15 | L | 4 | 4 | 0 | 4 / 0 | `checkInMany` skips a claim-pending or horizon-reached vault with no log (receipts mention only vault 0), and a repeated id is counted twice. | Yes |
| F16 | I | 4 | 2 | 2 | 2 / 2 | A valid chain check-in mined in the same block as the heir's `initiateClaim` reverts, and the vault settles to the heir 23 months before the horizon. The two characterisation tests pass. | Yes |
| F17 | L | 3 | 2 | 1 | 2 / 1 | A broadcast-but-unmined chain value pushes the deadline ~90 days past the owner's last real action, and a non-owner holding the seed keeps the heir out (`NotYetExpired`). The quantifying test passes. | Yes |
| F18 | L | 7 | 7 | 0 | 7 / 0 | In the final period before the horizon, `checkIn`, `checkInMany` and `checkInByChain` succeed and are counted while the deadline cannot move; a chain link is consumed (hbLeft 3 to 2) and no warning bit is raised. | Yes |
| F19 | L | 5 | 4 | 1 | 4 / 1 | Past the horizon the app's owner card offers Veto and Change heir, which revert `HorizonReached`, never states the minimum horizon, and submits an `extendHorizon` date below the contract floor; the vault settles although the owner objected. The contract ground-truth test passes. | Yes |
| F20 | L | 4 | 3 | 1 | 3 / 1 | The heir cannot re-point a pending claim from a mistyped recipient (`claimRecipient` stays 0x...dEaD); a third party then pushes 9.95 ETH to the typo, or a recipient contract with no `receive()` freezes it. The control passes. | Yes |
| F21 | I | 6 | 2 | 4 | 2 / 4 | `getVault` reports a `guaranteedInheritanceAt` that has passed while the heir cannot yet finalize, and past the horizon a cheap override costs the heir 7 days instead of the 365-day period. | Yes |
| F22 | L | 2 | 1 | 1 | 1 / 1 | A 1-wei front-run `topUp` leaves the vault ACTIVE (state 1) after the owner's exact-balance close. The damage test passes. | Yes |
| F23 | L | 4 | 2 | 2 | 2 / 2 | On a fork of Base, the live retired NotifySubscription accepts a 0.012 ETH `subscribe` (expected `ZeroAmount`) and keeps it. The local kill-switch test and the fork check of `setPrice(max)` pass. | Yes |
| F24 | I | 4 | 4 | 0 | 4 / 0 | The report's headline tallies (high 2 / medium 5 / low 5 against itemised 3 / 3 / 4; 5 off-chain criticals against 6) and the FAQ ("Twelve defects" against 10 or 20 itemised; "five independent passes") do not match the itemised report. | Yes |
| F25 | I | 6 | 6 | 0 | 6 / 0 | `VaultView` has no locked or effective fee field and `ClaimInitiated` carries no fee (the view overstates the fee taken, 0.05 against 0.02 ETH); CLOSED and SETTLED vaults still report `expired == true`. | Yes |
| F26 | I | 7 | 5 | 2 | 5 / 2 | `Withdrawn` and `ClaimSettled` name payees that received nothing (the funds are only credited), and `CreditPaid.amount` and `withdrawCredit`'s return value report 99 where the payee received 98.01 of a fee-on-transfer token. The two boundary tests pass. | Yes |
| F27 | I | 11 | 9 | 2 | 9 / 2 | Five clock-resetting events carry no new deadline (an events-only indexer is 20 days early and an heir acting on it gets `NotYetExpired`), `VaultCreated` has no `inactivityPeriod`, and the removed heir is not an indexed topic. The two controls pass. | Yes |
| F28 | I | 5 | 5 | 0 | 5 / 0 | An exhausted chain raises no warning bit (also when its last element is zero), an overstated count leaves hbLeft > 0 (reverts `InvalidCheckInChain` where `CheckInChainExhausted` was expected), and `setCheckInChain` cannot disarm a chain. | Yes |
| F29 | I | 9 (1 skipped) | 7 | 1 | 7 / 1 | Seven doc-versus-code mismatch lists are non-empty: T2 "stuck until the horizon", the `_clearPending` NatSpec, "exactly two addresses" and the admin rows, "cannot ... raise your fee", "any ERC-20", "would take a fee", and the admin-handover and BNB claims. The control passes; the opt-in live test is skipped. | Yes |
| F30 | I | 5 | 1 | 4 | 1 / 3 | The fingerprints labelled "SHA-256" in `site/security.html` and `AUDIT_SCOPE.md` are keccak-256 (EXTCODEHASH) of the runtime, not SHA-256. The sanity, diagnostic, `[port]` and live checks pass. | Yes |
| F31 | I | 5 | 5 | 0 | 5 / 0 | The rehearsed `bnb` deploy makes the hot key admin and fee recipient, deploys the retired NotifySubscription (which then accepts 0.001), tells the operator to set `CHAINS[...].notify` (absent from `app.js`), and `transfer-admin.ts` cannot dry-run without a subscription (exits 1). | Yes |
| F32 | I | 3 | 2 | 1 | 2 / 1 | While creation is paused, a third party's `topUp` is accepted and 20 ETH of new value enters the contract. The guard test passes. | Yes |
| F33 | I | 4 | 3 | 1 | 3 / 1 | `surplus()` answers during an in-flight deposit, top-up or payout with the whole in-flight amount (1,000, 50, 400) as phantom surplus. The bounding test passes. | Yes |
| F34 | I | 2 | 2 | 0 | 2 / 0 | An owner `setPrice` mined ahead of a payment reprices it: 0.012 ETH quoted at 31,104,000 s is credited 311,040 s, or 1 s, and the admin withdraws it. | Yes |
| F35 | I | 4 | 1 | 3 | 1 / 3 | A 1-second third-party gift makes an exact-cap purchase revert `TooFarAhead`. The three characterisation tests pass. | Yes |
| F36 | L | 2 | 1 | 1 | 1 / 1 | The heir card for a vault in a look-alike "USDC" shows only amount and symbol, identical to the genuine token's card: no token address, no unverified flag. The contract-side quantifying test passes. | Yes |
| F37 | L | 3 | 2 | 1 | 2 / 1 | Against the measured `eth_getLogs` limits of Base's public RPC (2,000 blocks) and BNB dataseed (refused), the watcher never tells the owner that the estate SETTLED during an outage; zero emails under either. The uncapped control passes. | Yes |
| F38 | I | 25 | 9 | 16 | 10 / 15 | Seven NotifySubscription mutants survive the v1 shipped suite (7/7 pass on each), and the test comment claims one second costs ~385 gwei where it costs 0.386 gwei (1,000x). The proposed suites kill all nine mutants. | **No**: 9 failing / 16 passing instead of 10 / 15 |
| F39 | I | 22 | 3 | 19 | 3 / 19 | With each test 150 ms slower, the v1 shipped A-05 test fails (`HorizonTooSoon` minimum off by 11 s), the verbatim A-05 assertion fails after a 1.2 s gap, and the next block after `loadFixture` is +5 s, not +1. The 16 other Audit.ts tests, the two primes and the pinned-timestamp control pass. | Yes |
| F40 | I | 4 | 2 | 2 | 2 / 2 | The site, both at `b8baf34` and in the working tree, promises reminders and alerts (guides, security page) while no alert service runs, and discloses the silence nowhere. The two part-A tests pass. | Yes |
| F41 | M | 6 | 6 | 0 | 6 / 0 | The owner card shows the heir only as `0x3C44...93BC`, identical for an 8-hex look-alike; Change heir and Create vault accept the look-alike; the attacker takes 995 tokens, and a lowercase near-miss freezes 1,000 forever. | Yes |
| F42 | L | 7 | 6 | 1 | 6 / 1 | `_pull` credits a depositor with pool-wide changes: 529 T for a 4 T deposit that triggers a rebase, a 534 T round trip for 8 T, a 300 T reward or a hook-injected payment for 1 wei; a negative rebase panics 0x11 instead of `NothingReceived`, and an honest 500 T deposit is recorded as 100 T. The context test passes. | Yes |
| F43 | I | 9 | 5 | 4 | 5 / 4 | Past the horizon `setBeneficiary` and `setInactivityPeriod` succeed on an ACTIVE vault without restarting the clock, the new heir can claim in the next block and settles the vault, and the outcome depends on front-running. The four controls pass. | Yes |
| F44 | L | 6 | 4 | 2 | 4 / 2 | No view resolves a vault from the heir's address, the FAQ omits the owner's address and never says nobody will notify the heir, and no guide walks the heir through a claim. The feasibility and damage tests pass. | Yes |
| F45 | I | 7 | 5 | 2 | 5 / 2 | Past the horizon the watcher's owner EXPIRED alert still says "check in now" and promises the 14-day veto, the heir's claimable alert says to have the owner check in, the horizon alert says "1 days away", and the app's `warningLines` says "check in". Two tests pass. | Yes |
| F46 | I | 4 | 3 | 1 | 3 / 1 | The owner card for a CLAIM_PENDING vault never shows `finalizableAt` or `claimRecipient`, and two days before finality it gives no deadline before a third party finalizes. The control passes. | Yes |
| F47 | I | 6 | 4 | 2 | 4 / 2 | The horizon prompt signs a rolled-over date (2046-02-30 becomes 2046-03-02) and a transposed year with no echo or warning, the card never shows the current horizon, and `createVault` is signed with no pre-sign summary. The two passing tests measure the damage. | Yes |

## Notes

**F19.** App PoC (runs `site/assets/app.js` in a vm). Counts and messages match only after the DOM-stub fix described under History; run 1 failed here for the wrong reason.

**F23.** Reads the live contract through an in-process fork of Base (read-only RPC). It will keep failing until the Ledger signs `setPrice(type(uint256).max)` on Base (disposition ADMIN), and then pass.

**F24.** Doc PoC (working tree). Passes once the DOC fixes for F24 land.

**F29.** Doc PoC (working tree), with NatSpec read from `contracts/v1/InheritanceVaultV1.sol`, whose line numbers are 15 higher than in the deployed file because of its header. Passes once the DOC fixes land.

**F30.** The sandbox had 3 passing tests; the port adds the fourth, `[port] the deployed-runtime snapshot matches the compiled v1 sources`, which passes (see `../README.md`). Doc PoC: passes once the labels or values are corrected.

**F31.** Script PoC: runs the working-tree `scripts/deploy.ts` and `scripts/transfer-admin.ts`. Passes once the SCRIPT fixes for F31 land.

**F34.** By design (retired contract; moot once F23 is done). The PoC still records the behaviour.

**F36.** App PoC. Matches only after the fresh-chain hook; in run 1 its passing control failed because an earlier file had used the same signer.

**F37.** Watcher PoC: runs the working-tree `notify/watcher.js`.

**F38.** The `iv` control ("shipped suite passes 56/56") fails, and the two InheritanceVault mutants (`_payout` and `_pull` without SafeERC20) show as killed. Both are the same cause: the shipped A-05 test, which depends on wall-clock time (finding F39), fails on this machine in every InheritanceVault run, mutated or not. On this machine A-05's block landed 4 to 11 s later than the test assumes; in the sandbox 1.9 s elapsed and A-05 passed. Running both mutant trees by hand shows the only failing shipped test is A-05 (`createVault reports the minimum horizon, not the current time`), with 55 passing, exactly as on the unmutated tree. So the two SafeERC20 mutants in fact survive the shipped suite, as the finding says, and the row does not match only through F39. The NotifySubscription half, the proposed suites and the dust-comment check behave as in the sandbox.

**F39.** The sandbox recorded the three failures, not a total; the file has 22 tests (17 from `support/shipped-v1/Audit.ts` and 5 in Part 2). On this machine the shipped A-05 test also fails without the added delay: `npx hardhat test` gives 62 passing and 1 failing (A-05), the same on a clean export of HEAD `5bbad6e`. That is this finding reproducing on its own, not a regression.

**F40.** Disputed finding, kept as documentation. Doc PoC: reads the site at `b8baf34` (git) and in the working tree.

**F41.** App PoC. Matches only after the DOM-stub fix described under History.

**F44.** Doc PoC (working tree, all of `site/guides/`).

**F45.** Watcher and app PoC (working tree).

**F46.** App PoC. Matches only after the DOM-stub fix described under History.

**F47.** App PoC. Matches only after the DOM-stub fix described under History.

## History of this record

- **Run 1** (2026-09-26 04:17 UTC, same working tree): 186 failing, 86 passing, 1 skipped, 44 minutes. Two
  harness problems, both fixed in the port before run 2, which is the run recorded above:
  1. F19, F41, F46 and F47 failed every app test with `TypeError: log.setAttribute is not a function`, a
     wrong-reason failure. The `5bbad6e` redesign added `log.setAttribute("role", "status")` to `vaultCard()` (an
     ARIA attribute; `git diff b8baf34 5bbad6e -- site/assets/app.js` is 5 lines, all ARIA), and the sandbox DOM
     stubs had no `setAttribute`. Each stub now records attributes. No assertion was changed.
  2. F36's passing control failed on `getTransactionCount(dave) == 0`, because F33, run earlier in the same
     process, had already sent an `approve` from the same signer. The sandboxes ran each PoC alone on a fresh
     chain, so every PoC now resets the Hardhat network in a `before()` hook at the top of its file.
- Run 1 counts, failing / passing: F19 4 / 1, F41 6 / 0, F46 3 / 1 and F47 5 / 1, with their app tests failing on
  the `TypeError`; F36 2 / 0. Every other row, F38 included (9 / 16), had the same counts and the same failing
  assertions as run 2 (only values that depend on block time differ).
- No PoC needed a quote or regex change after the `5bbad6e` redesign: F24, F29, F40, F44 and F45 still find
  the text they check, and fail on it.
