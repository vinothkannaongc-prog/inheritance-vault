# Will & Key: remediation plan for the preliminary audit (2026-09)

The lead auditor wrote this plan and it is binding for every remediation agent. Where it conflicts with a finding's own
recommendation, the plan wins. Full finding details (description, impact, the PoC path, and both verifiers' verdicts
and better fixes) are in `digest.md` next to this file. Read the entries for your findings.

## Ground truth

- Repo: `C:/Users/Vinoth/OneDrive/Claude/claude code/inheritance-vault`, branch `agent/willandkey-hardening`,
  HEAD `5bbad6e` (site redesign on top of `b8baf34`). Contracts are unchanged since the live deploy.
- **v1** is the deployed, IMMUTABLE contract on Base: InheritanceVault `0xC821849A1D74959753450409b594b23eCE7fEe2f`,
  NotifySubscription `0x60749aF621180de1DC05DB4f3d158D09dE979dC6` (retired). The admin is the Ledger hardware wallet
  `0x883C821103B5415C53B11E584D3592205B5CdCA3`, a single key, handed over 2026-09-24. The five handover transaction
  hashes are in `deployments/base.json`.
- **v2** is the fixed source we are writing now. It is NOT deployed. Never describe it as live, and never say the live
  contract is fixed.
- The website app (`site/app.html`, `site/assets/app.js`, `site/assets/abi.js`) talks to v1 and MUST keep the v1
  ABI. Never regenerate `site/assets/abi.js` from v2 artifacts.
- The v1 source is exactly the current `contracts/InheritanceVault.sol` at `5bbad6e`. It is also Basescan-verified.

## House rules for every agent

- Do NOT commit, push, deploy, or send any mainnet transaction. Read-only RPC calls are fine. The lead commits.
- NEVER touch `site/guides/what-happens-to-your-crypto-when-you-die.html`. Another session has uncommitted edits in it.
  Treat any file that is already modified in `git status` before you start as someone else's work, and do not edit it.
- Site CSP: style-src/script-src/font-src 'self'. So there is no inline `style=""`, no `<style>`, no inline `<script>`,
  and no external fonts or images. Every CSS rule lives in `site/assets/style.css`. The site was just redesigned
  ("Heirloom Deed"): cream paper #F7F3EA, ink #1B2130, text gold #7F6220, Fraunces for prose, Instrument Sans for UI,
  Geist Mono for addresses. Reuse the existing classes, and add new CSS only in the style of what is already there.
  Light theme only. `node scripts/validate-site.js` is the site gate and must pass.
- Windows + Git Bash. `npx hardhat test` works from bash. The local hardhat node, if needed, uses port 8547.
- The memory lessons that apply here: a fix needs its own adversarial check; do not write self-confirming tests (a
  test must fail on the defect for the right reason); and never let a size utility class set a colour.

## Final severities (47 findings)

- **Medium (5):** F01, F02, F03, F04, F41
- **Low (21):** F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15, F17, F18, F19, F20, F22, F23, F36, F37, F42, F44
- **Informational (21):** F16, F21, F24, F25, F26, F27, F28, F29, F30, F31, F32 (by design), F33, F34 (by design), F35,
  F38, F39, F40 (disputed; kept as a documentation finding), F43, F45, F46, F47

## Dispositions

"V2" = contract change in `contracts/InheritanceVault.sol`. "APP" = change to the live v1 app. "DOC" = change to
site copy, README, docs or watcher text. "ADMIN" = needs a Ledger transaction, which the user signs; we only prepare
instructions. "ACK" = acknowledged; disclosed, not changed.

| ID | Sev | Disposition |
|---|---|---|
| F01 | M | V2: immutable supported-token allowlist set in the constructor (no admin add); sweepSurplus only for NATIVE or a supported token. DOC: scope "cannot touch a wei" to supported single-address tokens; replace "any ERC-20" and "Anything Cancun-compatible works". APP: per-chain known-token list; unknown tokens get a blocking warning that must be acknowledged. |
| F02 | M | V2: domain-separated chain step `keccak256(abi.encode(HB_DOMAIN, block.chainid, address(this), owner, vaultId, hbEpoch, preimage)) == hbAnchor`, hbEpoch incremented on every setCheckInChain, exposed in getVault. SCRIPT: a reference generator `scripts/checkin-chain.ts` with a v1 mode (the tip is derived from keccak(domain tuple, seed) and then plain keccak chained, as v1 checks) and a v2 mode. DOC: spec + "use a fresh seed per vault/chain". |
| F03 | M | APP: while a claim is pending, the per-card Check in is replaced by Veto, and Check in (all) pre-filters and lists skipped vaults with the remedy. DOC: list the exact actions that cancel a claim (before the horizon: Veto/abortClaim, change heir, change period, set chain, extend horizon, any withdrawal; a check-in or top-up does NOT; at or after the horizon: only extendHorizon to >= now + inactivityPeriod, or withdraw everything). Fix watcher.js veto text. V2: no semantic change (keep liveness/veto separation). |
| F04 | M | V2: `withdrawCredit(address token, address to, uint256 amount)` overload, 0 < amount <= credit. DOC: capped/max-wallet/cooldown tokens are unsupported. |
| F05 | L | V2: initiateClaim locks `feeRecipient == 0 ? 0 : min(claimFeeBps, v.feeBps)`. DOC: disclose the v1 behaviour. |
| F06 | L | V2: timelock fee RAISES (FEE_RAISE_DELAY = 30 days, pending value + effective time, permissionless apply after the delay, events); cuts apply immediately and cancel any pending raise above the new rate. APP: show the current and any pending rate before signing. DOC: disclose v1. |
| F07 | L | DOC: correct the "locked rate can never go up" copy (ceiling semantics). |
| F08 | L | V2: third-party pushCredit only after PUSH_GRACE = 30 days from when the credit first became nonzero (creditedSince); the account itself may push at any time. DOC: NatSpec. |
| F09 | L | V2: reject payout destinations equal to address(this), the immutable `wrappedNative`, or any supported-token address, for withdraw `to`, withdrawCredit `to` and initiateClaim `recipient`. APP: refuse known wrapped-native and token addresses as payout; warn on addresses with code. |
| F10 | L | V2: measured ERC20 payouts; revert if the vault's balance fell by more than `amount`. DOC: unsupported token classes. APP: covered by the F01 allowlist warning. |
| F11 | L | Covered by the F01 V2 allowlist and sweep restriction. DOC + APP as F01. |
| F12 | L | ACK + DOC: pooled-custody issuer-action risk in "failure modes", the security page and the README trust table. |
| F13 | L | ACK (keep the late veto, consistent with the trust model) + DOC/APP: "finalizable" is not "final"; the owner can still cancel until finalizeClaim is mined; heirs should finalize promptly. Fix watcher.js texts. |
| F14 | L | V2: emit ClaimSuperseded(owner, id, ACT_CLOSE = 6) when a full withdrawal closes a CLAIM_PENDING vault. |
| F15 | L | V2: emit CheckInSkipped(owner, vaultId, reason) for every skipped id; count only vaults whose deadline actually moved (no duplicates, no pinned). APP: the Check-in-all toast lists skipped vaults and reasons. |
| F16 | I | ACK + DOC: a chain check-in counts only if mined strictly before the deadline; submit at least a day early. |
| F17 | L | ACK + DOC: chain values are bearer credentials that can postpone the heir up to the horizon; size `count` sensibly. Replace "liveness only, never authority" with the accurate wording. |
| F18 | L | V2: checkIn and checkInByChain revert `DeadlinePinnedAtHorizon` when the deadline cannot move (do not consume a chain link); checkInMany skips pinned vaults with CheckInSkipped. APP/DOC: say that check-ins cannot extend past the horizon. |
| F19 | L | APP: when horizonReached, hide Check in / Veto / Change heir and show "Stop this claim: extend horizon" pre-filled with the minimum valid date (and "withdraw everything"). |
| F20 | L | V2: `beneficiaryCancelClaim(vaultOwner, vaultId)`, callable only by the current beneficiary while CLAIM_PENDING; returns the vault to ACTIVE without moving the deadline, and emits an event. APP: the recipient defaults to the connected wallet; a different address needs a confirmation step. DOC: warn heirs that the payout address is fixed at claim start (v1). |
| F21 | I | APP + DOC: relabel "guaranteed inheritance date" as horizon/long-stop; during a claim the heir card shows finalizableAt. |
| F22 | L | V2: `withdraw(id, type(uint256).max, to)` withdraws the full balance and closes. |
| F23 | L | ADMIN — DONE 2026-09-26: the Ledger signed NotifySubscription.setPrice(type(uint256).max) on Base, tx 0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca (block 51823544). Every subscribe() now reverts ZeroAmount (verified by eth_call on three RPCs). Recorded in deployments/base.json as subscriptionSalesDisabled. DOC: say reminder sales are disabled ON CHAIN (price set to the maximum, only the admin could reverse it) and cite the tx; never say the contract "cannot be switched off"; status = Resolved (admin action). |
| F24 | I | DOC: fix the index FAQ ("five independent passes", "twelve defects") and the AUDIT-2026-08-09.md headline so they match its itemised list; say it was not independent. |
| F25 | I | V2: expose lockedFeeBps (and hbEpoch) in VaultView; ClaimInitiated carries the locked fee bps. APP: label getVault().feeBps as "fee ceiling" and show the effective current fee separately. |
| F26 | I | V2: emit CreditPaid after the transfer; add NatSpec on each value event saying whether it records a credit or a transfer. |
| F27 | I | V2: a DeadlineReset(owner, vaultId, newDeadline, absoluteDeadline) event inside _resetClock; VaultCreated adds inactivityPeriod; BeneficiaryChanged indexes the old beneficiary (respect the 3-indexed limit). |
| F28 | I | V2: setCheckInChain(id, 0, 0) disarms the chain. SCRIPT: the generator (F02). DOC: publish the spec; mark the feature "advanced, no app support". |
| F29 | I | DOC: admin = a single Ledger key since 2026-09-24 (tx hashes), the full list of admin functions everywhere the admin is described, scoped guarantees, the supported-token statement. |
| F30 | I | DOC: relabel the published hashes as keccak-256 (EXTCODEHASH) with the reproduce command; also publish the true SHA-256 values (compute them yourself from `eth_getCode`). |
| F31 | I | SCRIPT: deploy.ts no longer deploys NotifySubscription; on mainnets it requires explicit ADMIN_ADDRESS and FEE_RECIPIENT (refusing the deployer as default); per-network supported-token lists and wrappedNative; transfer-admin.ts handles an absent subscription. DOC: notify/README marked retired. |
| F32 | I | ACK (by design): the pause covers creation only. DOC: state the pause scope accurately. |
| F33 | I | V2: a view reentrancy guard (OZ `nonReentrantView` if the installed OZ version has it; otherwise an equivalent using `_reentrancyGuardEntered()`) on surplus/getVault/getOpenVaults/creditOf, with an internal `_surplus` for sweepSurplus. |
| F34 | I | ACK (by design; moot once F23 is done). |
| F35 | I | ACK (retired contract; moot once F23 is done). |
| F36 | L | APP: always show the token address with an explorer link, and flag tokens that are not on the known list. V2: the allowlist reduces the spam surface. DOC: heirs should only trust vaults from a known owner address. |
| F37 | L | DOC: veto inclusion depends on the sequencer/validators (Base forced inclusion takes ~12 h); recommend challenge windows >= 14 days; the watcher paging must be revalidated per chain before BNB. |
| F38 | I | TESTS: add hostile-token regression tests (v2) and the PoC evidence suite (v1). |
| F39 | I | TESTS: pin the block timestamp in the A-05 regression test. |
| F40 | I | DOC + APP: "Will & Key sends no alerts; nobody will notify you if your timer expires or a claim is filed". APP: a required acknowledgement checkbox before createVault. |
| F41 | M | APP: show the full checksummed heir address (monospace groups of 4, copy button, explorer link) everywhere; replace prompt() for change-heir with a confirm step that shows the current and new heir in full and requires entering the address twice; a lookalike check (same first/last 4-6 hex as an existing heir but a different address = hard block); a picker of existing heirs. |
| F42 | L | V2: `_pull` caps the credited amount at `amount` (`if (after <= before) revert NothingReceived(); received = min(after - before, amount)`). |
| F43 | I | ACK (keep the capability) + APP: past the horizon, route Change heir through extend-horizon guidance. |
| F44 | L | DOC: rewrite the heir FAQ (what the heir really needs: chain, vault contract, owner address, vault id, app URL, earliest date, and that nobody notifies them). APP: a "find vaults naming my wallet" lookup (log scan of VaultCreated/BeneficiaryChanged by beneficiary topic, chunked to fit public-RPC limits from the v1 deploy block; confirm each hit with getVault; show only vaults whose current beneficiary is the connected account). If the RPC cannot serve it reliably, ship the FAQ fix and document the limitation instead. |
| F45 | I | DOC: fix the watcher.js expired/claimable texts past the horizon (one remedy helper). |
| F46 | I | APP: while a claim is pending, the owner card shows a danger block: filed at, by (full heir), paying (full recipient, flagged if it is not the heir), finalizable from (local time + countdown). |
| F47 | I | APP: `<input type=date>` for the horizon with round-trip validation; show current vs new; a pre-sign summary for createVault (full heir, period, window marked immutable, horizon marked raise-only, fee ceiling + current rate). |

## v2 contract constraints

- The runtime size must stay under 24,576 bytes (EIP-170). v1 is 16,163. Measure after each change. If it is tight,
  reduce optimizer runs before cutting features, and record the setting.
- Keep every existing guarantee and every fixed prior-audit property (A-01..A-05, B-01..B-05). The existing tests must
  still pass, adapted to the new ABI where signatures changed. Do not weaken an assertion to make it pass.
- Constructor: `(address initialAdmin, uint16 initialFeeBps, address initialFeeRecipient, address[] memory supported, address wrappedNative_)`.
  Reject zero or duplicate supported entries, NATIVE/address(0) in the list, and address(this).
- Add regression tests in `test/AuditPrelim2026-09.ts`, one describe block per V2 finding. Each must fail on v1
  semantics and pass on v2, for the right reason.
