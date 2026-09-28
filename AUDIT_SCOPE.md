# Independent audit scope

Prepared: 2026-08-10. Updated: 2026-09-28 (v2 deployed on Base; v1 retired).

## Objective

Independently review the **InheritanceVault v2** deployed on Base at `0xA07b59d9249A996604A5fF482f1E564EdeE3A774`, the v2 web
app, and the operational tooling. The contract has no upgrade mechanism, so a serious finding
requires a new deployment and a migration. v2 has never had an independent review; everything
listed below was done by AI agents of the same kind that wrote the code.

## Reviews so far (none independent)

- `AUDIT-2026-08-09.md`: internal adversarial review of v1, produced by the same system involved in
  implementation.
- Preliminary audit, 2026-09, of v1: performed by AI auditing agents at the project's request, not
  independent. 47 findings (5 medium, 21 low, 21 informational), published at
  <https://willandkey.com/audit> and as `audit/2026-09-preliminary/REPORT.md`. The executable v1
  evidence suite is in `audit/2026-09-preliminary/` (`npm run audit:v1`, expected to fail on v1 by
  design), and the full audit record in `audit/2026-09-preliminary/record/`.
- The v2 fix reviews, recorded in `CHANGELOG-v2.md`, all by AI agents: four fix passes, five
  fix-review rounds (14, 10, 10, 8 and 6 issues), a pre-launch finalization that resolved round 5,
  and a pre-launch review by three fresh reviewers (16 issues, none a defect in the v2 contract;
  items 1 to 9 concern `scripts/deploy.ts` and `DEPLOY.md`).

## Exact on-chain targets

| Contract | Base address | Status | Runtime size | Runtime bytecode keccak-256 (EXTCODEHASH) | Runtime bytecode SHA-256 (raw bytes) |
|---|---|---|---:|---|---|
| `InheritanceVault` v2 | `0xA07b59d9249A996604A5fF482f1E564EdeE3A774` | live since 2026-09-28 (tx `0x4bbd4b1d74924f64e0c817ff1815ade20a0141094c091003ec1f527b86413e8e`, block 51900754) | 21,119 bytes | `1b3c172193ad01100daefcbd31e16682210462a7455a50908e65c72b2d077f1b` | `959da8425b7446a5a50748fd193c930722e0b2786ce500f0c529a59dd6c89f32` |
| `InheritanceVault` v1 | `0xC821849A1D74959753450409b594b23eCE7fEe2f` | retired; creation paused (tx `0x195ddeb6ec795a327c430e772ab5239a10b4a682f172b10fefd41cfb2af647c7`) | 16,163 bytes | `26a231771f3b5e7de6a09b3cd5a3e0d03fb5985d69b9bc4973db5f1e41af9733` | `89ca53b6aaea87fba5e3e0df7019b316f8a44304ef64569ea5a4978c4f9e4d60` |
| `NotifySubscription` (retired) | `0x60749aF621180de1DC05DB4f3d158D09dE979dC6` | retired; every payment reverts | 2,108 bytes | `67f23ec7a57f27c4c024c82ac45ef0e3a76e535b4f8224f2ce1de21c8029aec1` | `f2c577fd64b9038127473e87bb1c9981497962e36fde0b82f67465bf92e4bb61` |

v2's constructor arguments (the launch plan; the deployment record in `deployments/` holds the
values actually sent): admin `0x883C821103B5415C53B11E584D3592205B5CdCA3` (a Ledger), claim fee
50 bps, fee recipient the same Ledger, supported tokens USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH `0x4200000000000000000000000000000000000006`,
cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` and EURC
`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` (in that order), and `wrappedNative` WETH. The
deployment (transaction `0x4bbd4b1d74924f64e0c817ff1815ade20a0141094c091003ec1f527b86413e8e`) was sent by the former hot key
`0x4306a8875a04c0FbaC76CE2FC860E0b3c7aAd986`, which holds no v2 role.

v2 has one immutable variable, `wrappedNative`. The code on chain is therefore the compiled runtime
with WETH's address written into one 32-byte slot, at the offset given by the compiler output's
`immutableReferences`; Basescan's source verification allows for it. The v2 size above is the
compiled runtime of the final source (optimizer on, 200 runs). v1 and `NotifySubscription` have no
immutable variables: their compiled runtimes were compared byte-for-byte with the on-chain code on
2026-08-10 and matched exactly, and both are source-verified on Basescan. The deployment records are
in `deployments/`.

Reproduce the fingerprints (hashing the hex string instead of the raw bytes gives a different
SHA-256):

```bash
cast keccak $(cast code <address> --rpc-url https://mainnet.base.org)
cast code <address> --rpc-url https://mainnet.base.org | sed 's/^0x//' | xxd -r -p | sha256sum
```

Correction (2026-09): an earlier version of this table labelled the v1 and `NotifySubscription`
keccak-256 values as SHA-256. The values were always keccak-256 of the runtime bytecode (what
`EXTCODEHASH` returns); the true SHA-256 values were added from `eth_getCode` on
`https://mainnet.base.org` on 2026-09-26.

The owner of all three contracts is a single Ledger hardware-wallet key,
`0x883C821103B5415C53B11E584D3592205B5CdCA3` (not a multisig), which also receives the claim fees of
both vaults. Admin functions on v2: `setCreationPaused` (new vault creation only), `setClaimFee`
(a cut at once; a raise scheduled `FEE_RAISE_DELAY` = 30 days ahead; ≤ 100 bps), `setFeeRecipient`
(at once; switching fees back on after a period with none waits 30 days), `sweepSurplus` (native
coin and listed tokens only), and two-step ownership transfer (`renounceOwnership` disabled).
`applyClaimFee` is permissionless housekeeping. On v1: `setCreationPaused`, `setClaimFee` (at
once), `setFeeRecipient` (at once, may be `address(0)`), `sweepSurplus` (any token) and two-step
ownership transfer. On `NotifySubscription`: `setPrice`, `withdraw`, and two-step ownership
transfer.

## Source and configuration in scope

- `contracts/InheritanceVault.sol`: the v2 source. Confirm that the reviewed commit compiles to the
  runtime at `0xA07b59d9249A996604A5fF482f1E564EdeE3A774` (with the immutable filled) before relying on the review.
- `contracts/test/TestHelpers.sol`: test mocks, not deployed.
- `test/`, in particular `test/AuditPrelim2026-09.ts` (regression tests for 23 of the preliminary
  audit's 47 findings, including every contract fix) and `test/InheritanceVault.ts`.
- `scripts/deploy.ts` (the v2 deployment, with its read-back), `scripts/checkin-chain.ts` (the
  reference check-in-chain generator), `docs/CHECKIN-CHAIN.md`.
- `hardhat.config.ts`, compiler settings, constructor arguments, and the deployment records in
  `deployments/`.
- The v2 app: `site/app.html`, `site/assets/app.js`, `site/assets/abi.js`, `site/_headers`, the
  privacy and terms disclosures, and wallet/RPC trust boundaries.
- Historical, only as far as users of v1 are concerned: `contracts/v1/InheritanceVaultV1.sol` (the
  v1 source renamed; the byte-exact deployed source is `contracts/InheritanceVault.sol` at the tag
  `v1-base`, commit `b8baf34`), `contracts/NotifySubscription.sol`, `notify/watcher.js` (retired),
  `scripts/transfer-admin.ts`.

Solidity build target: compiler `0.8.28`, optimizer enabled with 200 runs, EVM target `cancun`.
Dependencies are locked by `package-lock.json`.

## Verification baseline

Run from a clean checkout:

```bash
npm ci
npm run build
npm test
VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts
npm run audit:v1
```

On 2026-09-27, with the final v2 source: `npm test` gave **263 passing, 0 failing**; the regression
file run against v1 gave **57 passing and 129 failing**, where every passing test is a "(control)",
"(guard)" or "(pin)" and the failures are the evidence; and `npm run audit:v1` is expected to exit
non-zero (its recorded run is in `audit/2026-09-preliminary/poc/RESULTS-v1.md`). At the deployed v1
source (tag `v1-base`) the v1 unit suite gives **63 passing** (the wall-clock-sensitive A-05 test can
fail on a loaded machine; preliminary-audit finding F39). The retired watcher's 14-step scenario
(`npm run node`, then `npm run scenario`) exercises v1 only.

## Priority review questions

1. Lane accounting: `totalLocked`, `totalCredited` and `surplus()` per token under every state
   transition, the four listed tokens, forced ETH, reentrancy, and the guarded views
   (`nonReentrantView`).
2. The claim state machine: claim finality, horizon behaviour and pinning, owner vetoes and the
   actions that supersede a claim, partial and full withdrawals past the horizon, and every
   denial-of-inheritance path.
3. The heir's cancel (`beneficiaryCancelClaim`): its kept design (no grace after `finalizableAt`, no
   atomic re-point), the redirect by a stolen beneficiary key, and the gap it opens.
4. Fees: the creation-time ceiling, the 30-day raise timelock, immediate cuts, the lock at claim
   start, the fee-recipient switch-on delay, and a cut reversed before settlement (the optional
   `ratchetLockedFee` was not added).
5. Payouts: the payee refusals in `_checkPayee`, the measurement of native payouts to addresses with
   code (`_holdings`, with its bounded gas), exact-debit ERC-20 payouts, partial `withdrawCredit`,
   and the `pushCredit` grace (`creditedSince`).
6. Administrator powers: the complete list, two-step ownership, disabled renounce, and the guarantee
   that the admin cannot reach locked or credited value.
7. The check-in chain: domain separation (`HB_DOMAIN`, chain id, contract, owner, vault, epoch),
   disarm, spending only on a moved deadline, and the known post-deadline sniping race.
8. The listed tokens' assumptions: USDC, EURC and cbBTC are upgradeable proxies with pause and
   blocklist roles; WETH has no admin.
9. The v2 app: injection resistance for all chain-derived values, dependency integrity, CSP,
   wallet-provider trust boundaries, parity of its payee refusals with `_checkPayee`, and its error
   decoding.
10. `scripts/deploy.ts`, including how the pre-launch review's items 1 to 9 were handled.

## Known design decisions and open questions

Recorded in `CHANGELOG-v2.md`, disclosed, and not represented as fixed:

- F20: `beneficiaryCancelClaim` is kept as implemented. The last safe moment to correct a recipient
  is `finalizableAt`, from which anyone may finalize.
- F33: `nonReentrantView` stays on the six guarded views, with its cost (a recipient whose
  `receive()` reads one cannot be paid by `pushCredit`).
- F08: the push grace runs per account balance, not per credit.
- A cut helps a claim only if it is still in force at settlement; no ratchet of the locked fee.
- A payout to a contract that books value to its sender is lost to whoever named it, and returns as
  sweepable surplus if that contract lets anyone release the booking (R5-1).

The three design questions of `AUDIT-2026-08-09.md` were re-examined by the preliminary audit as F16
(the check-in-chain sniping race, kept and disclosed), F15 (invisible skips in `checkInMany`, fixed in
v2 by `CheckInSkipped`) and F06 (create-time fee slippage, fixed in v2 by the raise timelock).

## Operational status and exclusions

- Paid reminder subscriptions are disabled in the website and the production watcher is not
  running; Will & Key sends no alerts of any kind. Sales on the retired billing contract are also
  disabled on chain since 2026-09-26: the admin called `setPrice(type(uint256).max)` in tx
  `0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca` (block 51823544; recorded
  in `deployments/base.json` as `subscriptionSalesDisabled`), so every `subscribe` now reverts
  (`ZeroAmount`). Only the admin could reverse it (preliminary-audit finding F23, resolved by this
  admin action). Users are still instructed not to send the contract funds.
- v1 is retired: its new-vault creation is paused (tx `0x195ddeb6ec795a327c430e772ab5239a10b4a682f172b10fefd41cfb2af647c7`). On 2026-09-27 it held no
  user funds (one vault ever, the project's own test, closed; a 0.00002 ETH credit owed to the former
  deploy key).
- A full-duration Base Sepolia lifecycle test of v2 (create, check in, claim, veto, cancel, settle,
  withdraw and push, at least 14 days of real time for the contract's 7-day minimum inactivity plus
  7-day minimum challenge window) has not been completed.
- No independent audit has been completed. `AUDIT-2026-08-09.md` was produced by the same system
  involved in implementation and must not be described as independent. The 2026-09 preliminary
  audit and the v2 fix reviews were performed by AI agents at the project's request and must not be
  described as independent either.
- Legal, tax, estate-planning, and jurisdiction-specific regulatory conclusions are outside the
  technical audit scope.

## Deliverables requested from the independent reviewer

- report tied to a repository commit and to the v2 runtime bytecode hashes above;
- severity-ranked findings with reproducible tests or transactions;
- explicit review of the known design decisions and threat-model assumptions;
- verification of fixes in a separate remediation pass;
- a public final report or a public attestation identifying any redactions and residual risks.
