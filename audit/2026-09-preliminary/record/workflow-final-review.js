export const meta = {
  name: 'willandkey-v2-final-review',
  description: 'Round-4 adversarial review of the v2 contract remediation (fresh eyes, round-3 changes first), fixer and confirmation round only if needed',
  phases: [
    { title: 'Review', detail: '3 fresh reviewers: regression, finding closure, tests' },
    { title: 'Fix', detail: 'only if a reviewer proves an issue' },
    { title: 'Confirm', detail: 'one more round on the fixes' },
  ],
}

const REPO = 'C:/Users/Vinoth/OneDrive/Claude/claude code/inheritance-vault'
const SP = 'C:/Users/Vinoth/AppData/Local/Temp/claude/C--Users-Vinoth-OneDrive-Claude-claude-code/005aaa32-3c49-4f96-8428-bacda0a96f78/scratchpad'
const POC = `${SP}/poc`

const BASE = `Context: Will & Key, a self-custody crypto inheritance vault. Repo ${REPO} (git; branch agent/willandkey-hardening). contracts/v1/InheritanceVaultV1.sol is the LIVE immutable v1 (Base 0xC821849A1D74959753450409b594b23eCE7fEe2f). contracts/InheritanceVault.sol is the UNDEPLOYED v2 source, written to remediate a 47-finding preliminary audit. The plan is ${SP}/remediation-plan.md; CHANGELOG-v2.md records every v2 change and three prior review rounds (under "Review round 1/2/3" headings). Round 3 changed checkIn past the horizon (HorizonReached instead of ClaimPendingUseAbort), added SKIP_CLAIM_PENDING_PAST_HORIZON = 7 to checkInMany, and made _payout require exact debits (PayoutShortfall/PayoutOverdebited), plus NatSpec, generator and test changes.
Rules: do NOT edit the repo. To prove an issue, create a sandbox with  bash "${POC}/make-sandbox.sh" <ID>  (it copies the current contracts/ and test/; NEVER delete a sandbox, its node_modules is a junction to the real one), write a failing test there, and cite it. Report only real issues with evidence; list what you checked and found OK. Severity rubric: critical = theft/permanent freeze by an unprivileged party; high = theft/freeze under plausible conditions, admin reach to user funds, or unprivileged denial/hijack of inheritance; medium = conditional loss, strong-asymmetry griefing, core guarantee broken in specific conditions; low = bounded edge case; informational = no fund impact.`

const SCHEMA = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
      location: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' },
    }, required: ['title', 'severity', 'location', 'problem', 'evidence', 'fix'] } },
    checked_ok: { type: 'array', items: { type: 'string' } },
  },
  required: ['issues', 'checked_ok'],
}

const LENSES = [
  { key: 'regression', prompt: 'LENS: SECURITY REGRESSION, fresh eyes. Read the whole v2 contract, not just the diff. Start with the round-3 changes (exact-debit payouts: can a listed token or a native payee make a legitimate payout, finalize or credit withdrawal revert forever and strand funds? can the new HorizonReached branch in checkIn or skip reason 7 change any state transition?). Then re-derive the core invariants yourself: totalLocked/totalCredited/surplus accounting on every path; no admin path to user value (allowlist, sweep, fee timelock, payee checks); no veto loop past the horizon (A-02/B-01/B-02); beneficiaryCancelClaim cannot be abused by either side; push grace; nonReentrant/nonReentrantView interplay (no deadlock on any legitimate path, including a callback-free payout).' },
  { key: 'closure', prompt: 'LENS: FINDING CLOSURE, fresh eyes. For each V2 finding in the plan (F01, F02, F04, F05, F06, F08, F09, F10, F14, F15, F18, F20, F22, F25, F26, F27, F28, F33, F42), re-attack the fix with a variant the previous reviewers did not try (read CHANGELOG-v2.md to see what they tried). Also check that the fix of one finding did not re-open another (e.g. the F10 exact-debit rule against F04 partial withdrawals under a transfer cap; F09 payee checks against the fee recipient; F18 pinning against F15 counting).' },
  { key: 'tests', prompt: 'LENS: TESTS AND BUILD, fresh eyes. Run the full `npx hardhat test` in a sandbox and report the count; run test/AuditPrelim2026-09.ts with VAULT_IMPL=v1 and confirm every failing test fails for its own finding and every passing one is labelled control/guard/pin. Check the runtime size is under 24,576 bytes. Look for tests weakened since commit 5bbad6e (git diff 5bbad6e -- test/), self-confirming tests, and new code paths from round 3 without a test. Mutation-test a few round-3 lines (exact-debit checks, skip reason 7, HorizonReached branch) to confirm tests kill them.' },
]

async function reviewRound(tag) {
  const rs = await parallel(LENSES.map((l) => () => agent(`${BASE}\n\nROUND ${tag}. ${l.prompt}`, { label: `review:${tag}:${l.key}`, phase: tag === 'r4' ? 'Review' : 'Confirm', schema: SCHEMA })))
  return rs.filter(Boolean).flatMap((r, i) => r.issues.map((x) => ({ lens: LENSES[i] ? LENSES[i].key : '?', ...x })))
}

phase('Review')
const r4 = await reviewRound('r4')
const material4 = r4.filter((x) => x.severity !== 'informational')
log(`Round 4: ${r4.length} issues, ${material4.length} low or above`)
let fix = null, r5 = []
if (r4.length) {
  phase('Fix')
  fix = await agent(`${BASE}\n\nYou are the v2 FIXER for review round 4. You MAY edit: contracts/InheritanceVault.sol, test/*.ts, contracts/test/TestHelpers.sol, scripts/deploy.ts, scripts/transfer-admin.ts, scripts/checkin-chain.ts, docs/CHECKIN-CHAIN.md, CHANGELOG-v2.md. Do not commit/push/deploy. Confirm each issue independently (reviewers can be wrong); fix confirmed ones with a regression test that fails before the fix; reject others with a reason; record all under "Review round 4" in CHANGELOG-v2.md. Finish with the full suite green, the runtime size, and the VAULT_IMPL=v1 count for test/AuditPrelim2026-09.ts.\n\nIssues:\n${JSON.stringify(r4, null, 2)}`, { label: 'fix:r4', phase: 'Fix' })
  if (material4.length) {
    phase('Confirm')
    r5 = await reviewRound('r5')
    log(`Round 5: ${r5.length} issues, ${r5.filter((x) => x.severity !== 'informational').length} low or above`)
  }
}
return { r4, fix, r5 }
