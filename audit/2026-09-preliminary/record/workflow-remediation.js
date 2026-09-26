export const meta = {
  name: 'willandkey-audit-remediation',
  description: 'Remediate the Will & Key prelim audit: v1 evidence suite, v2 contract fixes (4 passes), live-app + docs mitigations, adversarial review loops, transparent report for repo + website',
  phases: [
    { title: 'Evidence', detail: 'freeze v1 source copy, import 47 PoCs as the v1 evidence suite, record results' },
    { title: 'Implement', detail: 'v2 contract (4 sequential passes) in parallel with live-app and docs tracks' },
    { title: 'Review', detail: 'adversarial review of every fix, fixer, repeat until a round is clean' },
    { title: 'Report', detail: 'write REPORT.md + /audit page, verify every claim, fix' },
  ],
}

const REPO = 'C:/Users/Vinoth/OneDrive/Claude/claude code/inheritance-vault'
const SP = 'C:/Users/Vinoth/AppData/Local/Temp/claude/C--Users-Vinoth-OneDrive-Claude-claude-code/005aaa32-3c49-4f96-8428-bacda0a96f78/scratchpad'
const POC = `${SP}/poc`
const PLAN = `${SP}/remediation-plan.md`
const DIGEST = `${SP}/digest.md`
const FULL = `${SP}/audit-final.json`

const BASE = `You are part of the remediation team for the preliminary security audit of Will & Key (a self-custody crypto inheritance vault). Repo: ${REPO} (git, branch agent/willandkey-hardening).
READ FIRST: the binding remediation plan at ${PLAN} (ground truth, house rules, final severities, per-finding dispositions, v2 constraints). Full finding details (description, impact, recommendation, both verifiers' verdicts and better fixes, PoC path) are in ${DIGEST}; the complete machine-readable audit result is ${FULL}. The original PoC sandboxes are under ${POC}/FXX/ (test/poc-FXX.ts plus any mocks in contracts/test/).
Hard rules: do not commit, push, deploy or send mainnet transactions. Never touch site/guides/what-happens-to-your-crypto-when-you-die.html. Do not edit files outside your assigned scope; other agents are editing other files in the same working tree right now. When you finish, return a concise account of exactly what you changed (files, functions), what you verified (commands run and their results), and anything you could not do.`

const ISSUES_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string', description: 'failing test path + output, or exact quotes with file:line' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'location', 'problem', 'evidence', 'fix'],
      },
    },
    checked_ok: { type: 'array', items: { type: 'string' } },
  },
  required: ['issues', 'checked_ok'],
}

async function run(prompt, opts) {
  for (let i = 0; i < 3; i++) {
    const r = await agent(prompt, i === 0 ? opts : { ...opts, label: `${opts.label}~retry${i}` })
    if (r != null) return r
  }
  return null
}

// ------------------------------------------------------------------ Evidence
phase('Evidence')
const evidence = await run(`${BASE}

YOUR TASK: build the v1 EVIDENCE SUITE, before anyone changes the contract. You own: contracts/v1/, contracts/audit/, audit/2026-09-preliminary/, and the "scripts" block of package.json (add one script).
1. Confirm contracts/InheritanceVault.sol is unmodified (git diff --quiet). Create contracts/v1/InheritanceVaultV1.sol as a verbatim copy with ONLY the contract name changed to InheritanceVaultV1 (and error/event names unchanged) plus a header comment: this is the v1 source deployed at 0xC821849A1D74959753450409b594b23eCE7fEe2f on Base (Basescan-verified; byte-exact source at git tag v1-base / commit b8baf34), renamed for side-by-side compilation, do not edit. Make sure imports still resolve.
2. Import each PoC test ${POC}/FXX/test/poc-FXX.ts into audit/2026-09-preliminary/poc/FXX.ts, and each PoC's extra mocks (${POC}/FXX/contracts/test/*.sol except TestHelpers.sol) into contracts/audit/FXX_<name>.sol. Rename every contract declared in those mock files to FXX_<Name> (and update the tests) so no two artifacts share a name. SKIP mock files that are patched copies of the vault or subscription (names containing Fixed, Fix, Patched, DomainSep, FloorFix, FixBound, FixTimelock, or any file that re-declares the vault's logic) and delete or rewrite the tests that depended on them: those were fix sketches, and v2 regression tests replace them. Point every getContractFactory("InheritanceVault") at "InheritanceVaultV1". Leave NotifySubscription as is (it is unchanged v1). PoCs that read site/ or README/notify files: point them at the repo paths (the site was redesigned in commit 5bbad6e after the audit; a copy PoC may no longer find its quote; record that honestly rather than editing the PoC to pass).
3. Add the npm script "audit:v1" that runs exactly the files in audit/2026-09-preliminary/poc/ with hardhat test (list them explicitly if a glob does not work on Windows).
4. Run it. Write audit/2026-09-preliminary/poc/RESULTS-v1.md: a table with one row per finding (ID, tests, failing, passing, a one-line summary of what the failing assertion shows). The EXPECTED outcome is that each finding's safe-property assertion FAILS on v1: that failure is the evidence. Say for each row whether it matches that expectation, and explain any row that does not.
5. Write audit/2026-09-preliminary/README.md explaining the layout, how to reproduce (npm ci, npm run audit:v1), that failures are the evidence, and that the deployed-source reference is the v1-base tag.
6. Confirm \`npx hardhat test\` (the normal suite) still passes 63 tests and everything compiles. Do NOT modify contracts/InheritanceVault.sol or anything in test/.`, { label: 'evidence:v1-suite', phase: 'Evidence' })
log('Evidence suite done')

// ------------------------------------------------------------------ Implement
phase('Implement')
const V2_COMMON = `${BASE}

You are one of four SEQUENTIAL v2 contract engineers. You own contracts/InheritanceVault.sol, test/*.ts (including test/AuditPrelim2026-09.ts), contracts/test/TestHelpers.sol (you may add hostile-token mocks there), scripts/deploy.ts, scripts/transfer-admin.ts, scripts/checkin-chain.ts (new), docs/CHECKIN-CHAIN.md (new), and CHANGELOG-v2.md (new). Do NOT touch contracts/v1/, contracts/audit/, audit/, site/, notify/, README or other docs.
Rules for every change: follow the plan's v2 disposition exactly (or document a strictly-better deviation in CHANGELOG-v2.md with the reason); keep every existing guarantee and every fixed prior-audit property; adapt the existing tests to ABI changes without weakening any assertion; for EACH finding you fix, add a describe block to test/AuditPrelim2026-09.ts with tests that would fail on v1 semantics and pass on v2, failing for the right reason (you can check a test really fails on v1 by pointing it at InheritanceVaultV1 temporarily). Run the FULL \`npx hardhat test\` at the end and report the pass count. Measure the runtime size of InheritanceVault (deployedBytecode length / 2 - 1 from artifacts) and report it; it must stay under 24,576 bytes. Append your changes to CHANGELOG-v2.md under a heading per finding ID.`

const contractTrack = async () => {
  const a = await run(`${V2_COMMON}

PASS 1 of 4: CUSTODY AND TOKENS. Implement F01 (immutable supported-token allowlist set in the constructor; createVault/topUp only for NATIVE or supported tokens; sweepSurplus only for NATIVE or a supported token), the new constructor (address initialAdmin, uint16 initialFeeBps, address initialFeeRecipient, address[] memory supported, address wrappedNative_) with validation, a view listing the supported tokens, F09 (reject payout destinations = address(this), wrappedNative, or any supported token, for withdraw 'to', withdrawCredit/pushCredit destination where applicable, and initiateClaim 'recipient'), F10 (measured ERC20 payouts; revert when the balance fell by more than 'amount'), F42 (_pull caps received at 'amount'; 'if (after <= before) revert NothingReceived()'), and F33 (nonReentrantView on surplus/getVault/getOpenVaults/creditOf; sweepSurplus uses an internal _surplus). Introduce a shared test helper (e.g. test/helpers/deploy.ts) so all tests deploy the vault through one function, and update the existing tests to use it. Start CHANGELOG-v2.md with a short header saying v2 is undeployed source and v1 at 0xC821... on Base is immutable.`, { label: 'v2:custody-tokens', phase: 'Implement' })

  const b = await run(`${V2_COMMON}

PASS 2 of 4 (pass 1, custody and tokens, is done; read CHANGELOG-v2.md and the current contract first). CREDITS, CLAIMS AND FEES. Implement F04 (withdrawCredit(token, to, amount) overload), F05 (fee lock respects the zero fee recipient), F06 (timelocked fee raises: FEE_RAISE_DELAY = 30 days, pending bps + effective time, permissionless apply after the delay, events; cuts are immediate and cancel a pending raise above the new rate; think through how createVault's snapshot and initiateClaim's lock interact with a pending raise so neither can be sandwiched), F08 (third-party pushCredit only after PUSH_GRACE = 30 days from when the credit first became nonzero; the account itself may push at any time; think through the fee recipient accumulating credits), F14 (ClaimSuperseded with ACT_CLOSE = 6 when a full withdrawal closes a pending claim), F20 (beneficiaryCancelClaim: current beneficiary only, CLAIM_PENDING only, back to ACTIVE, deadline unchanged, event; check this does not reopen any veto loop or let a hostile heir grief the owner), F22 (withdraw with amount == type(uint256).max withdraws the full balance and closes), F25 (VaultView exposes lockedFeeBps; ClaimInitiated carries the locked fee bps), F26 (CreditPaid emitted after the transfer; NatSpec on value events saying credit vs transfer).`, { label: 'v2:credits-claims-fees', phase: 'Implement' })

  const c = await run(`${V2_COMMON}

PASS 3 of 4 (passes 1-2 are done; read CHANGELOG-v2.md and the current contract first). CHECK-INS, HASH CHAIN AND EVENTS. Implement F02 (domain-separated chain step: accept a preimage only if keccak256(abi.encode(HB_DOMAIN, block.chainid, address(this), owner, vaultId, hbEpoch, preimage)) == hbAnchor; hbEpoch per vault incremented on every setCheckInChain; exposed in getVault), F28 (setCheckInChain(id, 0, 0) disarms), F18 (checkIn and checkInByChain revert DeadlinePinnedAtHorizon when the deadline cannot move, without consuming a chain link; the first clamped partial extension still succeeds), F15 (CheckInSkipped(owner, vaultId, reason) for every skipped id in checkInMany; 'refreshed' counts only vaults whose deadline actually moved, so duplicates and pinned vaults are not counted; NothingCheckedIn only when nothing moved), F27 (a DeadlineReset(owner, vaultId, newDeadline, absoluteDeadline) event emitted from _resetClock; VaultCreated adds inactivityPeriod; BeneficiaryChanged indexes the old beneficiary within the 3-indexed limit). Re-verify that the A-02/B-01/B-02 horizon and veto-loop properties still hold with every new path.`, { label: 'v2:checkins-chain-events', phase: 'Implement' })

  const d = await run(`${V2_COMMON}

PASS 4 of 4 (passes 1-3 are done; read CHANGELOG-v2.md and the current contract first). TOOLING, TESTS AND CLOSE-OUT.
(a) F31: scripts/deploy.ts deploys only InheritanceVault (no NotifySubscription); on mainnets it requires explicit ADMIN_ADDRESS and FEE_RECIPIENT (refuse if unset or equal to the deployer unless an explicit override env is set); per-network supported-token lists and wrappedNative (Base: USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, WETH 0x4200000000000000000000000000000000000006, cbBTC 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, EURC 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42; BNB: USDT 0x55d398326f99059fF775485246999027B3197955, USDC 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d, WBNB 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c, BTCB 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c, ETH 0x2170Ed0880ac9A755fd29B2688956BD959F933F8; verify each address has code and returns a sane symbol/decimals with a read-only eth_call, and flag any that do not; note that BNB-USDT/USDC are 18-decimals); the post-deploy read-back checks cover the new state. scripts/transfer-admin.ts copes with a deployment record that has no NotifySubscription.
(b) F02/F28: scripts/checkin-chain.ts, a reference generator with a v1 mode (the tip derived from keccak256(abi.encode("WillAndKey/hb/v1", chainid, vaultContract, owner, vaultId, installIndex, seed)) and then chained with plain keccak256(bytes32), which is what v1 checks) and a v2 mode (matching v2's domain-separated step); it prints the anchor, the count and the preimages in the order they must be revealed. Add tests proving the generator's output is accepted by InheritanceVaultV1 (v1 mode) and by v2 (v2 mode), and rejected across vaults/chains in v2. Write docs/CHECKIN-CHAIN.md: the exact spec for both versions, operational rules (a fresh seed per vault/chain, submit at least a day before the deadline, chain values are bearer credentials that can postpone the heir up to the horizon, size count sensibly).
(c) F38: hostile-token regression tests for v2 (fee-on-transfer, over-debit/fee-on-top, positive rebase, a double-entry token, an ERC777-style hook, a false-returning token, a blocklisting token, a transfer-capped token), asserting the v2 behaviour (e.g. unsupported tokens rejected at creation, the sweep restricted, measured payouts revert on over-debit, partial credit withdrawal works under a cap).
(d) F39: pin the block timestamp in the A-05 regression test (keep an exact equality that still catches the original bug).
(e) Close-out: the full \`npx hardhat test\` green; the runtime size; review CHANGELOG-v2.md for completeness against the plan's V2 dispositions (every V2 item implemented or explicitly deviated with a reason); list any plan item NOT implemented.`, { label: 'v2:tooling-tests-closeout', phase: 'Implement' })
  return { a, b, c, d }
}

const appTrack = async () => {
  const APP_COMMON = `${BASE}

You are a LIVE-APP engineer. The app at site/app.html + site/assets/app.js talks to the DEPLOYED v1 contract through site/assets/abi.js (the v1 ABI; never regenerate or edit abi.js; call only functions that exist in it). You own site/app.html, site/assets/app.js, and ADDITIONS to site/assets/style.css (new rules in the redesign's style; do not restyle existing components). Respect the CSP rules in the plan: no inline styles or scripts; render every chain-derived or user-typed value with textContent, never innerHTML. Keep the existing structure and coding style of app.js. Verify with \`node --check site/assets/app.js\` and \`node scripts/validate-site.js\`; if you can, load the page through \`node scripts/serve-site.js\` (port 8123, production headers) in a headless browser to catch CSP violations and runtime errors, and exercise pure helper functions in node.`
  const a = await run(`${APP_COMMON}

PASS 1 of 2: ADDRESS SAFETY, CREATION AND FEES. Implement the APP dispositions for F41 (full checksummed addresses in monospace groups of four with copy and explorer link everywhere an heir, recipient, claimant or owner is shown; replace prompt() for change-heir with an in-page confirm step that shows the current and new heir in full and requires entering the new address twice; a lookalike check against existing heirs (same leading/trailing 4-6 hex, different address = hard block); a picker of the owner's existing heirs), F20 (the claim recipient defaults to the connected wallet; a different address needs explicit confirmation), F09 (refuse the chain's wrapped-native address and known token addresses as payout destinations; warn when the destination has contract code), F01/F10/F11/F36 (a per-chain known-token list: Base USDC/WETH/cbBTC/EURC; BNB USDT/USDC/WBNB/BTCB/ETH (see the plan and verify addresses read-only); any other token needs a blocking warning that names rebasing, fee-on-transfer, reflection, interest-bearing and double-entry tokens and must be explicitly acknowledged; always show the token address with an explorer link), F47 (\`<input type=date>\` for horizon changes with round-trip validation, showing current vs new and that the horizon can never be lowered; a pre-sign summary for createVault: full heir, inactivity period, challenge window marked immutable, horizon marked raise-only, fee ceiling and current rate), F06/F25 (show the current global fee and label getVault().feeBps as "fee ceiling"; show the effective fee as min(ceiling, current) and say it is 0 only while no fee recipient is set, and that this can change before settlement on v1), F40 (a required acknowledgement checkbox on the create form: "Will & Key sends no alerts. Nobody will notify me if my timer expires or a claim is filed."). Recommend challenge windows of at least 14 days in the form hint (F37).`, { label: 'app:address-creation-fees', phase: 'Implement' })
  const b = await run(`${APP_COMMON}

PASS 2 of 2 (pass 1 is done; read the current app.js first). VAULT STATES AND HEIR FLOWS. Implement the APP dispositions for F03 and F15 (while a claim is pending, replace the per-card Check in with Veto and explain why; "Check in (all vaults)" pre-filters by state and horizon, then diffs the receipt's CheckedIn logs against the ids sent and lists each skipped vault with its reason and remedy), F19 and F43 (when horizonReached: hide Check in, Veto and Change heir; show "Stop this claim: extend horizon" pre-filled with the next UTC midnight at or after now + inactivityPeriod, plus "Withdraw everything"; explain why), F46 (while a claim is pending, the owner card shows a danger block: filed at, filed by (full heir), paying (full recipient, flagged when it is not the heir), finalizable from (local time + countdown from chain time), and that the veto must be MINED before someone finalizes), F13 (wording: after finalizableAt anyone can finalize; until then the owner key can still cancel, so heirs should finalize promptly), F21 (relabel "guaranteed inheritance date": the horizon is a long-stop; during a claim the heir card shows finalizableAt), and F44 (a "find vaults naming my wallet" lookup in the heir tab: scan VaultCreated and BeneficiaryChanged logs whose beneficiary topic equals the connected address, chunked to fit the public Base RPC's getLogs limits (test them read-only against https://mainnet.base.org; the v1 deploy block is about 49.5M, find it exactly), confirm every hit with getVault, and show only vaults whose CURRENT beneficiary is the connected account; handle RPC errors gracefully; if the public RPC cannot serve it reliably, implement it with a clear 'may be incomplete' notice and say so in your report).`, { label: 'app:states-heir-flows', phase: 'Implement' })
  return { a, b }
}

const docsTrack = async () => run(`${BASE}

You are the DOCUMENTATION engineer. You own: site/index.html, site/how-it-works.html, site/security.html, site/terms.html, site/privacy.html, site/guides/dead-mans-switch-crypto.html, site/guides/crypto-inheritance-planning.html, site/guides/never-put-seed-phrase-in-will.html (only if the plan's findings touch them and the file is unmodified in git status), README.md, SECURITY.md, AUDIT_SCOPE.md, AUDIT-2026-08-09.md (only the F24 headline/method corrections, clearly marked as a correction dated 2026-09), notify/watcher.js (user-facing TEXT only, no logic changes), notify/README.md. Do NOT touch the app files, the style.css structure, contracts, tests or scripts.
Implement every DOC disposition in the plan: F01/F10/F11 (scope "cannot touch a wei" to supported single-address tokens; replace "any ERC-20" / "Anything Cancun-compatible works" with a supported-token statement and a list of unsupported behaviours), F03 (list exactly which actions cancel a claim before and after the horizon; a check-in and a top-up do NOT; fix the watcher veto text), F05/F06/F07 (the accurate fee semantics of the live v1: a creation-time ceiling, lower global rates apply while in force, the rate is locked at claim start, the zero-recipient caveat), F12 (issuer action on pooled custody), F13 (the late-veto wording), F16/F17/F28 (the chain check-in: mined strictly before the deadline, bearer credentials, advanced with no app support, link docs/CHECKIN-CHAIN.md which another agent is writing), F21 (horizon = long-stop, not a guaranteed date), F23 (paid reminders are disabled on the website, but the retired contract still accepts payments until the admin disables it on chain; do not pay it; never say it "cannot be switched off"), F24 (the FAQ and report-headline corrections; the internal review was NOT independent), F29 (admin = a single Ledger hardware-wallet key since 2026-09-24 with the handover tx hashes from deployments/base.json; the full list of admin functions (pause creation, setClaimFee, setFeeRecipient, sweepSurplus) wherever the admin is described; drop "planned multisig" unless you phrase it as a recommendation), F30 (relabel the published hashes as keccak-256 of the runtime bytecode (EXTCODEHASH) with a reproduce command; compute and add the true SHA-256 values yourself from eth_getCode on https://mainnet.base.org for both addresses), F31 (notify/README: retired), F32 (the pause scope), F37 (veto inclusion depends on the sequencer/validators; recommend windows >= 14 days), F40 (Will & Key sends no alerts of any kind), F44 (the heir FAQ lists what an heir actually needs), F45 (the watcher texts past the horizon). Wherever the site mentions audits or security status, say there is now a PRELIMINARY audit at /audit (a page another agent will create), performed by AI auditing agents at the project's request, NOT independent, with an independent third-party audit still pending; the live contract is immutable and its fixes exist only as undeployed v2 source. Keep the redesign's markup patterns and classes. Run node scripts/validate-site.js at the end. Do not invent facts: every claim you write must be checkable against the code or the plan.`, { label: 'docs:all', phase: 'Implement' })

const [contractRes, appRes, docsRes] = await parallel([contractTrack, appTrack, docsTrack])
log('Implementation tracks finished')

// ------------------------------------------------------------------ Review
phase('Review')
const contractLenses = [
  { key: 'regression', prompt: `LENS: SECURITY REGRESSION. Diff contracts/InheritanceVault.sol against contracts/v1/InheritanceVaultV1.sol. Hunt for NEW defects the v2 changes introduced: accounting (totalLocked/totalCredited/surplus invariants under every new path: partial credit withdrawal, capped _pull, measured payouts, max-amount withdraw, beneficiaryCancelClaim), reentrancy (nonReentrant/nonReentrantView interplay, deadlocks), the state machine (can any new function reopen the A-02/B-01/B-02 veto loops or deny inheritance past the horizon? can beneficiaryCancelClaim or the fee timelock be abused?), access control, fee monotonicity (can the fee a heir pays ever exceed what was visible at claim start or at creation?), the allowlist/sweep (can the admin still reach user value by ANY path?), and griefing via the push grace.` },
  { key: 'closure', prompt: `LENS: FINDING CLOSURE. For every finding with a V2 disposition in the plan (F01, F02, F04, F05, F06, F08, F09, F10, F14, F15, F18, F20, F22, F25, F26, F27, F28, F33, F42), try to BYPASS the fix: re-run the finding's original exploit idea against v2 and look for variants (e.g. F02 replay across epochs/chains/vaults; F09 other wrap-on-receive destinations; F10 tokens that under-report; F06 raise+apply sandwiches around createVault/initiateClaim; F08 the fee recipient; F18 partial clamp edge cases). Say for each finding: closed, partially closed (how), or open.` },
  { key: 'tests', prompt: `LENS: TEST QUALITY. Read test/AuditPrelim2026-09.ts and every test changed since commit 5bbad6e (git diff 5bbad6e -- test/). Look for self-confirming tests, assertions weakened to make old tests pass, tests that pass on v1 too (so prove nothing), missing negative cases, and untested new code paths (list the new functions/branches without a test). Actually run a sample of the new tests against InheritanceVaultV1 (in a sandbox) to confirm they fail on v1 for the right reason.` },
]
const reviewLog = []
for (let round = 1; round <= 3; round++) {
  const reviews = (await parallel(contractLenses.map((l) => () => run(`${BASE}

You are an ADVERSARIAL REVIEWER of the v2 contract remediation (round ${round}). ${l.prompt}
Do not edit the repo. To prove a bug, create a sandbox with  bash "${POC}/make-sandbox.sh" REV${round}-${l.key}  (it copies the CURRENT repo contracts/ and test/; never delete a sandbox, its node_modules is a junction to the real one), write a failing test there, and cite it. Report only real issues with evidence; list what you checked and found OK.${round > 1 ? ' Earlier rounds found and fixed issues listed in CHANGELOG-v2.md under "Review round" headings; verify those fixes too, since fixes need their own adversarial check.' : ''}`, { label: `review:r${round}:${l.key}`, phase: 'Review', schema: ISSUES_SCHEMA })))).filter(Boolean)
  const issues = reviews.flatMap((r, i) => r.issues.map((x) => ({ lens: contractLenses[i] ? contractLenses[i].key : '?', ...x })))
  const material = issues.filter((x) => x.severity !== 'informational')
  reviewLog.push({ round, issues })
  log(`Contract review round ${round}: ${issues.length} issues (${material.length} low or above)`)
  if (!material.length && round > 1) break
  if (!issues.length) break
  await run(`${BASE}

You are the v2 contract FIXER for review round ${round}. You own the same files as the v2 contract engineers (contracts/InheritanceVault.sol, test/*.ts, contracts/test/TestHelpers.sol, scripts/deploy.ts, scripts/transfer-admin.ts, scripts/checkin-chain.ts, docs/CHECKIN-CHAIN.md, CHANGELOG-v2.md). Below are the reviewers' issues. For each one, first confirm it independently (reviewers can be wrong); fix every confirmed issue with a regression test that fails before the fix; reject unconfirmed ones with a reason. Record every issue under a "Review round ${round}" heading in CHANGELOG-v2.md (fixed or rejected, and why). Finish with the full test suite green and the runtime size.

Issues:
${JSON.stringify(issues, null, 2)}`, { label: `fix:contract:r${round}`, phase: 'Review' })
}

const appReview = await run(`${BASE}

You are an ADVERSARIAL REVIEWER of the LIVE-APP changes (git diff 5bbad6e -- site/app.html site/assets/app.js site/assets/style.css). Check: every contract call and event/log decode matches the v1 ABI in site/assets/abi.js (function names, argument order and types; the app must not call any v2-only function); no innerHTML with chain-derived or user-typed data; CSP compliance (no inline styles/scripts, no new external origins; the connect-src list in site/_headers limits RPC hosts); every state branch (active, claim pending before and after the horizon, settled, closed, horizon reached with no claim) shows the right actions and none that revert; the address-poisoning defences cannot be bypassed trivially (e.g. a picker entry must still pass the lookalike check; the two entries must be compared after checksum normalisation); the date round trip; the known-token list addresses are right (verify read-only on chain); the heir log-scan respects RPC limits and never shows a vault whose current beneficiary is not the connected account; no regressions in flows that worked before. Run node --check and scripts/validate-site.js; load the page via scripts/serve-site.js if you can. Report issues with evidence.`, { label: 'review:app', phase: 'Review', schema: ISSUES_SCHEMA })
if (appReview && appReview.issues.length) {
  await run(`${BASE}

You are the LIVE-APP FIXER. You own site/app.html, site/assets/app.js and additions to site/assets/style.css. Confirm each reviewer issue independently, fix the confirmed ones, reject the others with a reason, then re-run node --check and scripts/validate-site.js. Return what you fixed and what you rejected.

Issues:
${JSON.stringify(appReview.issues, null, 2)}`, { label: 'fix:app', phase: 'Review' })
}

const docsReview = await run(`${BASE}

You are an ADVERSARIAL REVIEWER of the DOCUMENTATION changes (git diff 5bbad6e -- site/*.html site/guides README.md SECURITY.md AUDIT_SCOPE.md AUDIT-2026-08-09.md notify/). Excluding site/app.html, check every changed or added factual claim against the v1 code (contracts/v1/InheritanceVaultV1.sol = the live contract), the v2 code where the text is about v2, deployments/base.json and the plan. Flag: anything that describes v2 behaviour as live; any overclaim ("independent", "guaranteed", "cannot", "any") the code does not support; a missing caveat the plan requires; inconsistency between pages; wrong tx hashes, addresses or hash values (recompute the SHA-256 and keccak values of the deployed code yourself from eth_getCode on https://mainnet.base.org); broken internal links; and a CSP or validate-site failure. Report issues with exact quotes and file:line.`, { label: 'review:docs', phase: 'Review', schema: ISSUES_SCHEMA })
if (docsReview && docsReview.issues.length) {
  await run(`${BASE}

You are the DOCUMENTATION FIXER. You own the documentation files listed for the docs engineer in the plan (not app.html/app.js). Confirm each reviewer issue independently, fix the confirmed ones, reject the others with a reason, and re-run scripts/validate-site.js. Return what you fixed and what you rejected.

Issues:
${JSON.stringify(docsReview.issues, null, 2)}`, { label: 'fix:docs', phase: 'Review' })
}

// ------------------------------------------------------------------ Report
phase('Report')
const REPORT_TASK = `${BASE}

You are the REPORT AUTHOR. Produce the transparent preliminary audit report in two forms.
(1) audit/2026-09-preliminary/REPORT.md, the canonical report in the repo.
(2) site/audit.html, the public page at https://willandkey.com/audit. Add a _redirects entry (/audit.html -> /audit 301, matching the existing pattern), a sitemap.xml entry, and links from site/security.html (a prominent "Read the preliminary audit" link) and from the footer or wherever the site already links to security. Match the redesigned site's HTML skeleton exactly (copy the head, header and footer from site/security.html, including the meta, OG, canonical and JSON-LD patterns) and its CSS system. Add new CSS only to site/assets/style.css, in the redesign's idiom (severity pills in Geist Mono, a findings index table, <details> per finding). The CSP forbids inline style and script, so this is a static page with no JS unless you put it in a new file under site/assets/, which is best avoided.
Sources you must use: ${FULL} (all 47 findings with PoC and verifier verdicts, plus 'verifiedSound' (~200 properties checked and found sound) and 'dropped'), ${PLAN} (final severities and dispositions), audit/2026-09-preliminary/poc/RESULTS-v1.md, CHANGELOG-v2.md (what v2 actually implements, including review-round fixes), and the current code.
Required content:
- Status box at the top: PRELIMINARY; performed 24-26 Sept 2026 by AI auditing agents (Anthropic's Claude, orchestrated as a multi-agent review) at the project owner's request; NOT an independent third-party audit (the code was also written with AI assistance, so the reviewer is not independent of the author); an independent audit is still pending; the live contract is immutable, and its fixes exist only as UNDEPLOYED v2 source; do not use material value until an independent audit is complete.
- Scope: the contracts, their addresses and the commit (the v1-base tag / b8baf34 for the deployed source; HEAD for the v2 source), the compiler settings and the bytecode hashes (the labels corrected per F30); what is out of scope.
- Methodology, stated honestly: 10 lens-specific auditors, merge, an executable PoC per finding, two independent skeptics per finding (reachability and severity), a completeness critic and a second hunt round; the numbers (80 raw findings, 47 after the merge, 44 confirmed, 2 by design, 1 disputed, 0 rejected); a note that one network outage and one session limit interrupted the run and were resumed; the fix-review rounds.
- The severity rubric.
- Summary counts by severity and by status (Fixed in v2 source / Mitigated on the live site / Acknowledged / Needs an admin transaction / Open), and a findings index table (ID, title, severity, status).
- One <details> section per finding: plain-language summary, impact, affected code (file:line at v1), evidence (a link to its PoC file on GitHub; use URLs of the form https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/FXX.ts, where audit-2026-09-prelim is a tag the lead will create), what we changed (v2 and/or the live site), and the residual risk on the live v1. For F32/F34 say why they are by design; for F40 give the dispute and the resolution.
- What was checked and found sound: a curated, de-duplicated list grouped by area (from verifiedSound). Do not dump 200 lines; cover every area.
- Recommendations to the project owner, and the admin actions pending: F23 (the Ledger signs setPrice(max) on the retired contract), whether to deploy v2 (and migrate) or keep v1, and a fee commitment for v1.
- Limitations of this review.
- Reproduce: npm ci; npm run audit:v1 (the v1 evidence, where failures are the proof); npx hardhat test (the v2 regression tests).
Write for a non-expert crypto user first (short plain sentences), with technical detail inside each finding. Do not overclaim anything. Every number and status must be checkable. Run node scripts/validate-site.js at the end.`
await run(REPORT_TASK, { label: 'report:write', phase: 'Report' })

const reportChecks = (await parallel([
  () => run(`${BASE}

You are the REPORT ACCURACY VERIFIER. Check audit/2026-09-preliminary/REPORT.md and site/audit.html line by line against the sources (${FULL}, ${PLAN}, RESULTS-v1.md, CHANGELOG-v2.md, the v1 and v2 code). Every count, severity, status, address, hash, file:line and link path must be right; every "fixed in v2" must be true in contracts/InheritanceVault.sol with a test; every "mitigated on the live site" must be visible in the current site/app code; nothing may claim the live contract is fixed; the two documents must agree. Recount the severities and statuses yourself. Report issues with exact quotes.`, { label: 'report:verify-accuracy', phase: 'Report', schema: ISSUES_SCHEMA }),
  () => run(`${BASE}

You are the REPORT HONESTY AND PRESENTATION VERIFIER. Read site/audit.html as a skeptical user, a journalist and a professional auditor would. Flag any wording that could mislead: implying independence or a third-party audit, implying the live contract is safe or fixed, burying the "preliminary" status or the fact that v2 is undeployed, severity euphemisms, marketing tone, missing limitations. Check the page technically: the skeleton matches the other pages; CSP compliance (no inline style/script); validate-site passes; the headings are ordered; the <details> work without JS; the tables do not overflow at 390px width (read the CSS); the links resolve (internal paths exist; the GitHub URLs follow the stated tag pattern); the _redirects and sitemap entries are present; security.html links to it. Report issues with exact quotes.`, { label: 'report:verify-honesty', phase: 'Report', schema: ISSUES_SCHEMA }),
])).filter(Boolean)
const reportIssues = reportChecks.flatMap((r) => r.issues)
log(`Report verification: ${reportIssues.length} issues`)
if (reportIssues.length) {
  await run(`${BASE}

You are the REPORT FIXER. You own audit/2026-09-preliminary/REPORT.md, site/audit.html, the audit-related additions to site/assets/style.css, site/_redirects, site/sitemap.xml, and the audit link in site/security.html. Confirm each issue independently, fix the confirmed ones, reject the others with a reason, keep the two documents consistent, and run scripts/validate-site.js. Return what you fixed and what you rejected.

Issues:
${JSON.stringify(reportIssues, null, 2)}`, { label: 'report:fix', phase: 'Report' })
}

return { evidence, contractRes, appRes, docsRes, reviewLog, appReview, docsReview, reportIssues }
