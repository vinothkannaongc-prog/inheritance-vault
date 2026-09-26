export const meta = {
  name: 'willandkey-prelim-audit',
  description: 'Preliminary independent-style audit of Will & Key contracts: 10 lens finders, dedupe, PoC + 2 refuters per finding, completeness critic loop',
  phases: [
    { title: 'Find', detail: '10 independent auditors, one lens each' },
    { title: 'Dedupe', detail: 'merge overlapping findings, assign IDs' },
    { title: 'Verify', detail: 'PoC test in isolated sandbox + reachability and severity skeptics' },
    { title: 'Critic', detail: 'completeness critic proposes uncovered areas; extra hunt rounds until dry' },
  ],
}

const REPO = 'C:/Users/Vinoth/OneDrive/Claude/claude code/inheritance-vault'
const POC = 'C:/Users/Vinoth/AppData/Local/Temp/claude/C--Users-Vinoth-OneDrive-Claude-claude-code/005aaa32-3c49-4f96-8428-bacda0a96f78/scratchpad/poc'

const CONTEXT = `You are part of an audit team doing a PRELIMINARY security audit of the Will & Key smart contracts, working to the standard of an independent auditing firm. Repo (git, branch agent/willandkey-hardening, commit b8baf34): ${REPO}

In scope:
- contracts/InheritanceVault.sol (846 lines): self-custody dead-man's-switch inheritance vault. Owner deposits native coin or one ERC20 per vault, names a beneficiary (heir), checks in periodically; if the inactivity deadline passes the heir may initiate a claim, a challenge window follows in which the owner can veto, then anyone can finalize and the heir is credited (pull-payment credit lane). Absolute horizon, optional S/KEY hash-chain check-in, claim fee in bps (hard cap 100, per-vault ceiling snapshot, lock at claim initiation). LIVE and IMMUTABLE on Base mainnet at 0xC821849A1D74959753450409b594b23eCE7fEe2f (currently holds no user funds). Planned for BNB Chain too. Solidity 0.8.28, optimizer 200 runs, evmVersion cancun, OpenZeppelin v5 (Ownable2Step, ReentrancyGuard, SafeERC20). Admin is now a hardware wallet.
- contracts/NotifySubscription.sol (105 lines): retired pay-for-reminders billing contract, live at 0x60749aF621180de1DC05DB4f3d158D09dE979dC6, immutable, still callable, sales disabled on the website.
- contracts/test/TestHelpers.sol: mock tokens used by tests (not deployed).
Context files: README.md (trust model table), AUDIT-2026-08-09.md (a previous INTERNAL review by the same system that wrote the code: A-01..A-05 and B-01..B-05 were "fixed"; it lists rejected claims and open design questions OQ-1..OQ-3), AUDIT_SCOPE.md (priority review questions), test/*.ts (63 passing tests), site/how-it-works.html, site/index.html and site/security.html (public claims to users).

Ground rules:
- READ-ONLY on the repo. Do not edit, create or delete any file under the repo. Do not run state-changing git commands.
- Do not trust comments, NatSpec, README or the prior audit: verify every claim against the code. A previous fix being listed as done is not evidence it is complete or correct.
- No mainnet transactions.
- Severity rubric: CRITICAL = theft or permanent freezing of user funds by an unprivileged party with no unusual preconditions. HIGH = theft/freezing under plausible conditions, the admin able to reach user funds, or an unprivileged party able to deny or hijack an inheritance. MEDIUM = conditional loss, griefing with strong cost asymmetry, a core guarantee broken under specific conditions, or accounting corruption without direct loss. LOW = bounded edge cases, minor griefing, events/return values that mislead integrators. INFORMATIONAL = best practice, gas, clarity, code-vs-documentation mismatch with no fund impact.
- Be concrete: cite file:line and function names; give a step-by-step exploit scenario naming the actors (owner, beneficiary/heir, admin, arbitrary third party, token contract, sequencer/MEV searcher).
- Only report what you believe is real after tracing the code path end to end. Do not pad. But do not drop a real issue because it looks minor.`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
          category: { type: 'string' },
          location: { type: 'string', description: 'file:line(s) and function name(s)' },
          description: { type: 'string' },
          impact: { type: 'string' },
          preconditions: { type: 'string' },
          exploit_scenario: { type: 'string', description: 'numbered steps with actors' },
          recommendation: { type: 'string' },
          poc_plan: { type: 'string', description: 'how a Hardhat test would demonstrate it' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'severity', 'category', 'location', 'description', 'impact', 'exploit_scenario', 'recommendation', 'poc_plan', 'confidence'],
      },
    },
    verified_sound: {
      type: 'array',
      description: 'properties within your lens you checked and found sound',
      items: {
        type: 'object',
        properties: { property: { type: 'string' }, reasoning: { type: 'string' } },
        required: ['property', 'reasoning'],
      },
    },
  },
  required: ['findings', 'verified_sound'],
}

const LENSES = [
  { key: 'accounting', prompt: `Lens: ACCOUNTING AND SOLVENCY. Enumerate every function that changes a vault balance, totalLocked, totalCredited or _credits, and every path that moves value in or out (createVault, topUp, withdraw, finalizeClaim, withdrawCredit/push-credit functions, sweepSurplus, _payout). For each, prove or break: (1) sum of live vault balances per token == totalLocked[token]; (2) sum of credits == totalCredited[token]; (3) contract balance >= totalLocked + totalCredited at all times; (4) surplus() can never include user value; (5) no path lets value be stranded (in a closed/settled vault, in credits of address(0) or the contract itself, or in fees when feeRecipient is unset or changed mid-claim). Consider fee rounding, zero-amount edge cases, partial withdrawals, the same token used in many vaults, native vs ERC20 (NATIVE = address(0)) confusion, msg.value supplied on an ERC20 createVault/topUp, and msg.value mismatch on native.` },
  { key: 'state-machine', prompt: `Lens: STATE MACHINE, CLAIM FINALITY AND DENIAL OF INHERITANCE. Map the states (Active, ClaimPending, Settled, Closed) and every transition and guard. Attack from two sides: (a) a HOSTILE OR COMPROMISED OWNER KEY / runaway automation trying to deny the heir forever despite the absolute horizon (which is documented as the guaranteed inheritance date against a lost owner key and runaway check-in automation) — look for any action that keeps pushing the deadline, displacing claims, or resetting the clock past the horizon, including combinations of withdraw, topUp, setBeneficiary, setInactivityPeriod, extendHorizon, setCheckInChain, checkIn, checkInMany, checkInByChain, abortClaim, and any 'soft' action that calls _clearPending; re-check the prior fixes A-02, B-01, B-02 for completeness. (b) A HOSTILE HEIR or THIRD PARTY trying to take funds early, block the owner's veto, block finalization, or grief the owner. Also: can finalizeClaim be called by anyone at the right time and can anyone block it; what happens when the beneficiary is changed while a claim is pending; what if the owner and beneficiary are the same address; what if a claim was initiated just before the horizon; exact boundary comparisons (< vs <=) at deadline, finalizableAt, absoluteDeadline, and absoluteDeadline + challengeWindow.` },
  { key: 'admin-fees', prompt: `Lens: ADMINISTRATOR POWERS AND FEES. Verify the claims "the admin cannot withdraw a user's locked balance or payout credit, change a beneficiary, cancel an owner withdrawal or block a valid claim settlement" and "existing vaults retain their creation-time fee ceiling; a lower global rate at settlement wins; the rate is locked at claim initiation and can only fall thereafter; no fee recipient means no fee". Check setClaimFee, setFeeRecipient, setCreationPaused, sweepSurplus, renounceOwnership override, Ownable2Step handover, constructor validation (fee > cap? recipient == this?). Look for: fee computed on the wrong base, rounding that lets a fee exceed its bps, a fee recipient that can block settlement (e.g., a recipient that reverts, is blocklisted by the token, or is the beneficiary itself), fee credited to a recipient changed between initiate and finalize, pause blocking actions it should not (topUp? claims?), sweepSurplus able to reach user value via any token quirk (e.g., a token whose balanceOf lies, a rebasing token, a token address equal to NATIVE), OQ-3 (fee ceiling slippage at createVault) — is there really no bound users can set?` },
  { key: 'tokens', prompt: `Lens: ERC20 INTEGRATION AND HOSTILE TOKENS. The contract claims support for "ERC20" but excludes rebasing tokens. For each token behavior, trace createVault, topUp, withdraw, finalizeClaim, credit withdrawal and sweepSurplus: fee-on-transfer (inbound and outbound), positive and negative rebasing, ERC777 / ERC1363 hooks and reentrancy, tokens returning no bool or false, tokens that revert on zero-amount transfers, blocklisting tokens (USDC/USDT style) where the heir, owner, fee recipient or vault gets blocklisted, pausable tokens, upgradeable tokens, tokens with transfer caps, tokens with 2 addresses (double-entry), a token address with no code (does SafeERC20 treat an EOA as a token that silently succeeds? what then?), token == vault contract address, native coin (address(0)) sent alongside ERC20 calls. For each, say whether the result is (i) handled, (ii) user-only self-harm that is documented, or (iii) a defect affecting OTHER users' vaults (cross-vault contamination is the key question: can one user's weird token break accounting for others?). Look at contracts/test/TestHelpers.sol for existing mocks.` },
  { key: 'hashchain', prompt: `Lens: S/KEY HASH-CHAIN CHECK-IN (lost-wallet liveness). Read setCheckInChain, checkInByChain and any helpers. Check: hash function and domain separation (is the preimage bound to chainId, contract address, vault owner and vault id, or can a revealed preimage be replayed on another vault, another chain deployment (Base vs BNB) or a re-set chain?); counter/anchor updates and off-by-one on the chain length; whether an observer of the mempool/sequencer can front-run and consume a check-in; whether the chain can extend the deadline past the horizon; whether a revealed value can be reused after setCheckInChain resets; whether the chain can cancel a claim (documented: liveness only, never authority) and the OQ-1 sniping race (re-evaluate: is it really unfixable without granting veto authority? e.g., could a chain check-in be allowed only while no claim is pending but the heir be prevented from initiating in the same block?); gas/DoS on long chains; what happens if count is 0 or anchor is 0.` },
  { key: 'reentrancy-payouts', prompt: `Lens: EXTERNAL CALLS, REENTRANCY AND PAYOUTS. List every external call (token transfers, native sends, any call to a user-supplied address) and the state written before/after it. Verify nonReentrant coverage on every state-changing external function (the prior fix A-01 added it widely — find any function it missed, and any view function that can be read mid-state by a reentrant callee to mislead a third-party integrator: read-only reentrancy). Examine _payout and the pull-payment credit lane: can a hostile recipient (contract heir with reverting receive, a return-bomb, gas-guzzling fallback, or 63/64 gas griefing) jam finalizeClaim, withdraw, sweepSurplus or another user's payout? Can someone push a credit to an address that can never pull it (address(0), the contract itself, a contract with no withdraw ability) and is that stranded forever? Are credits ever paid to a different address than intended ('to' parameter semantics)? Check the permissionless push function noted near line 724 for abuse (e.g., forcing value onto a recipient at a bad time, or griefing via failed pushes).` },
  { key: 'arithmetic-time', prompt: `Lens: ARITHMETIC, TYPES AND TIME. Check every narrowing cast (uint256 -> uint64/uint32/uint16/uint8) for silent truncation, especially timestamps, periods, windows, horizons, counts and fee bps; overflow of additions like block.timestamp + period, deadline + challengeWindow, absoluteDeadline + challengeWindow with user-chosen extreme values (e.g., type(uint64).max horizon or period); minimum/maximum bounds on inactivity period, challenge window and horizon and whether extreme-but-allowed values lock funds or make claims impossible; fee math rounding (amount * bps / 10000) with tiny and huge amounts; zero-value vaults; timestamp manipulation tolerance on Base (sequencer-set timestamps) and BNB Chain (fast blocks); behavior exactly at boundaries. Also check struct packing for storage collisions or stale fields when a vault is closed and its id reused (ids are said never to be reused — verify).` },
  { key: 'subscription', prompt: `Lens: NotifySubscription.sol (retired but live and callable). Audit it fully: pro-rata time purchase math and rounding, the 10-year cap, sub-second dust rule, the slippage floor, giftable purchases, price changes, admin revenue withdrawal, renounce disabled, overflow of paidUntil, refund behavior (none?), whether ETH can be stuck, whether anyone other than the admin can extract value, and whether its retired status creates user-facing risk (people paying for a service that no longer runs). Also compare it with its tests in test/NotifySubscription.ts and its description in the README and site.` },
  { key: 'spec-vs-code', prompt: `Lens: PUBLIC CLAIMS VS ACTUAL BEHAVIOR. Extract every factual claim about contract behavior from README.md (especially the trust-model table and Revenue section), the NatSpec/header comments in InheritanceVault.sol, site/how-it-works.html, site/index.html, site/security.html and site/terms.html. For each claim, check it against the code and report every claim that is false, overstated or missing a material caveat (e.g., "cannot touch a wei", "guaranteed inheritance date", "any action from your key cancels the claim", "check-ins stop working at the horizon", fee statements, minimum 7-day windows, what the admin can and cannot do, S/KEY "liveness only, never authority"). Note security.html still says admin has not been transferred to a cold wallet; that is known and will be updated, do not report it. A materially false safety claim to users is at least LOW; one that could cause users to lose funds by relying on it is MEDIUM or higher.` },
  { key: 'griefing-mev-chains', prompt: `Lens: GRIEFING, MEV, EVENTS AND MULTI-CHAIN DEPLOYMENT. (1) Front-running and ordering on an L2 with a centralized sequencer and on BNB Chain with public mempool: createVault front-run, claim initiation racing an owner check-in at the deadline, beneficiary racing a setBeneficiary change, the OQ-1 chain race. (2) Unbounded loops / gas: checkInMany with large arrays, per-owner vault counts, any function whose cost grows with history. (3) Spam: can a third party create or top up vaults that affect someone else (e.g., naming a victim as owner or beneficiary, making the victim's heir receive junk, polluting an owner's vault id space, or blocking the app's enumeration)? (4) Events: are all state changes observable off-chain with enough data for the watcher and the heir to act (OQ-2 checkInMany skips; claim supersession; fee lock; beneficiary change during a pending claim)? Is any event emitted with wrong/stale values? (5) Deploying the same bytecode to BNB Chain (chainId 56): PUSH0/Cancun opcode support, block.timestamp semantics with sub-second blocks, any chain-specific assumption (e.g., the S/KEY hash lacking chainid enabling cross-chain replay if a user uses the same chain on both).` },
]

const POC_SCHEMA = {
  type: 'object',
  properties: {
    reproduced: { type: 'boolean' },
    method: { type: 'string', enum: ['test', 'citation', 'not_reproducible'] },
    test_path: { type: 'string' },
    test_names: { type: 'array', items: { type: 'string' } },
    output_excerpt: { type: 'string', description: 'the relevant failing assertion / test output, trimmed' },
    explanation: { type: 'string', description: 'what the test/citation shows and why it fails for the right reason, or why the scenario could not be made to happen' },
    severity_observation: { type: 'string', description: 'anything the PoC revealed about real impact (bigger or smaller than claimed)' },
  },
  required: ['reproduced', 'method', 'explanation'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    proposed_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
    by_design_and_disclosed: { type: 'boolean' },
    better_fix: { type: 'string', description: 'optional: a better or safer remediation than the one recommended' },
  },
  required: ['refuted', 'reasoning', 'proposed_severity', 'by_design_and_disclosed'],
}

const DEDUPED_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
          category: { type: 'string' },
          location: { type: 'string' },
          description: { type: 'string' },
          impact: { type: 'string' },
          preconditions: { type: 'string' },
          exploit_scenario: { type: 'string' },
          recommendation: { type: 'string' },
          poc_plan: { type: 'string' },
          lenses: { type: 'array', items: { type: 'string' } },
          relation_to_prior_audit: { type: 'string' },
        },
        required: ['id', 'title', 'severity', 'category', 'location', 'description', 'impact', 'exploit_scenario', 'recommendation', 'poc_plan', 'lenses'],
      },
    },
    dropped: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] },
    },
  },
  required: ['findings', 'dropped'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { area: { type: 'string' }, question: { type: 'string' }, why_uncovered: { type: 'string' } },
        required: ['area', 'question', 'why_uncovered'],
      },
    },
  },
  required: ['leads'],
}

const brief = (f) => `${f.id} [${f.severity}] ${f.title} @ ${f.location}`

// A dead agent (network drop, API error) returns null. Retry twice before giving up, and never
// let a missing verdict count as "not refuted".
async function agentRetry(prompt, opts) {
  for (let i = 0; i < 3; i++) {
    const r = await agent(prompt, i === 0 ? opts : { ...opts, label: `${opts.label}~retry${i}` })
    if (r != null) return r
  }
  return null
}

async function verify(f) {
  const poc = await agentRetry(`${CONTEXT}

You are the PoC ENGINEER for finding ${f.id}. Demonstrate it with an executable Hardhat test, or establish that it cannot be demonstrated.

Finding:
${JSON.stringify(f, null, 2)}

Sandbox: run  bash "${POC}/make-sandbox.sh" ${f.id}  — it creates ${POC}/${f.id}/ holding COPIES of contracts/ and test/ plus config, and a node_modules junction. Work ONLY inside that directory (the repo itself stays untouched). Write your test to test/poc-${f.id}.ts (TypeScript, mocha/chai, ethers v6, @nomicfoundation/hardhat-network-helpers; copy the fixture style of test/Audit.ts). If you need a hostile token or recipient contract, add a NEW Solidity file under contracts/test/ in the sandbox; never edit InheritanceVault.sol or NotifySubscription.sol. Run:  cd "${POC}/${f.id}" && npx hardhat test test/poc-${f.id}.ts
NEVER delete the sandbox directory or its node_modules: it is a junction to the real repo's node_modules and rm -rf would destroy the real dependencies.

Test-writing rules:
1. Assert the SAFE / INTENDED property so the test FAILS against the current code because of the defect. It will later become a regression test that must pass once fixed.
2. It must fail for the RIGHT reason: the failing assertion is the defect itself, not a fixture revert, wrong argument, or setup error. Read the failure output and confirm. Do not write self-confirming tests (e.g., searching an output for the input you put in).
3. Where useful add a second test that quantifies the damage (balances stranded, deadline pushed past horizon, etc.).
4. For documentation/design findings with no executable behavior, use method "citation": quote the claim (file:line) and the code (file:line) exactly.
If the scenario cannot be made to happen, reproduced=false and explain precisely what blocked it (which require/guard).`, { label: `poc:${f.id}`, phase: 'Verify', schema: POC_SCHEMA })

  const pocText = poc ? JSON.stringify(poc, null, 2) : '(PoC agent failed to return)'
  const [reach, sev] = await parallel([
    () => agentRetry(`${CONTEXT}

You are a REACHABILITY AND CORRECTNESS SKEPTIC. Your job is to REFUTE finding ${f.id}. Default to refuted=true if the evidence does not hold up.

Finding:
${JSON.stringify(f, null, 2)}

PoC engineer's result:
${pocText}

Check independently against the code: is every precondition actually reachable given all require/guard checks (including modifiers and checks in called internal functions)? If a test was written, open it (${POC}/${f.id}/test/poc-${f.id}.ts) and judge whether it demonstrates the defect or is self-confirming / fails for a setup reason / relies on an impossible state (e.g., hardhat_setStorageAt, impersonating the contract). You may run it: cd "${POC}/${f.id}" && npx hardhat test test/poc-${f.id}.ts (read-only use; do not delete the sandbox). Refute only with a concrete reason. Also propose the correct severity per the rubric.`, { label: `refute-reach:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }),
    () => agentRetry(`${CONTEXT}

You are a SEVERITY AND DESIGN SKEPTIC for finding ${f.id}. Assume the behavior is real. Decide whether it is actually a defect and how severe.

Finding:
${JSON.stringify(f, null, 2)}

PoC engineer's result:
${pocText}

Is this behavior intended AND disclosed to users (README trust-model table, contract header, the prior audit's open questions OQ-1..OQ-3, site/security.html, site/how-it-works.html)? If intended, disclosed and harmless relative to the documented model, set refuted=true and by_design_and_disclosed=true. If intended but NOT disclosed, or disclosed but the disclosure understates the risk, it is not refuted (a documentation finding at least). Apply the severity rubric strictly: who can trigger it, what it costs them, what the victim loses, how likely. Suggest a better or safer fix if the recommended one is weak or would break another guarantee (e.g., fixing OQ-1 by granting the paper seed veto authority changes the trust model).`, { label: `refute-sev:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }),
  ])

  const reproduced = !!(poc && poc.reproduced)
  const reachRefuted = !!(reach && reach.refuted)
  const sevRefuted = !!(sev && sev.refuted)
  let status
  if (!poc || !reach || !sev) status = 'incomplete'
  else if (reproduced && !reachRefuted && !sevRefuted) status = 'confirmed'
  else if (reproduced && !reachRefuted && sevRefuted) status = 'by-design'
  else if (!reproduced && reachRefuted) status = 'rejected'
  else status = 'disputed'
  return { ...f, status, poc, reach, sev }
}

// ---------------- Round 1
phase('Find')
const found = (await parallel(LENSES.map((l) => () =>
  agent(`${CONTEXT}\n\n${l.prompt}\n\nReturn every real finding within (or incidentally outside) your lens, plus the properties within your lens that you verified as SOUND (these become the public report's "what was checked" section), each with one line of reasoning.`,
    { label: `find:${l.key}`, phase: 'Find', schema: FINDINGS_SCHEMA })
    .then((r) => r ? { lens: l.key, ...r } : null)
))).filter(Boolean)

const allSound = found.flatMap((r) => r.verified_sound.map((s) => ({ lens: r.lens, ...s })))
const raw = found.flatMap((r) => r.findings.map((f) => ({ lens: r.lens, ...f })))
log(`Round 1: ${raw.length} raw findings from ${found.length}/${LENSES.length} auditors`)

phase('Dedupe')
const dd = await agent(`${CONTEXT}

You are the LEAD AUDITOR merging raw findings from ten auditors into one list. Merge findings that describe the same root cause (keep the clearest description, the strongest exploit scenario, the highest justified severity, and list all contributing lenses). Keep findings with different root causes separate even if they touch the same function. Assign ids F01, F02, ... ordered by severity (critical first). Drop a raw finding only if it (a) exactly restates a prior-audit item that is genuinely fixed in the current code (then say so; if the claim is that the prior fix is incomplete, KEEP it and set relation_to_prior_audit), or (b) is plainly not a defect on reading the code; list every drop with a reason. Open design questions OQ-1..OQ-3 re-raised by auditors should be KEPT as findings (they will be judged again). Verify quickly against the code when merging.

Raw findings:
${JSON.stringify(raw, null, 2)}`, { label: 'dedupe:r1', phase: 'Dedupe', schema: DEDUPED_SCHEMA })

let findings = dd ? dd.findings : []
const dropped = dd ? dd.dropped.map((d) => ({ round: 1, ...d })) : []
log(`Round 1 after dedupe: ${findings.length} findings (${dropped.length} dropped): ${findings.map((f) => f.id).join(', ')}`)

const results = await pipeline(findings, (f) => verify(f))
const verified = results.filter(Boolean)
log(`Round 1 verified: ${verified.filter((v) => v.status === 'confirmed').length} confirmed, ${verified.filter((v) => v.status === 'by-design').length} by-design, ${verified.filter((v) => v.status === 'disputed').length} disputed, ${verified.filter((v) => v.status === 'rejected').length} rejected`)

// ---------------- Critic loop (until a round adds nothing new, max 2 extra rounds)
let nextId = findings.length + 1
for (let round = 2; round <= 3; round++) {
  phase('Critic')
  const critic = await agentRetry(`${CONTEXT}

You are the COMPLETENESS CRITIC. Ten auditors looked through these lenses: ${LENSES.map((l) => l.key).join(', ')}. They produced the findings below and marked the listed properties as sound. Read the contracts yourself and ask: which functions, branches, state combinations, token behaviors, boundary values or documented guarantees did NOBODY examine closely, or examine only superficially? Which "verified sound" claims look under-justified? Propose at most 6 concrete, high-yield leads for another hunting round (each a specific question about specific code). Return an empty list if coverage is genuinely complete.

Findings so far:
${verified.map(brief).join('\n')}

Properties marked sound:
${allSound.map((s) => `- [${s.lens}] ${s.property}`).join('\n')}`, { label: `critic:r${round}`, phase: 'Critic', schema: CRITIC_SCHEMA })

  const leads = critic ? critic.leads.slice(0, 6) : []
  if (!leads.length) { log(`Critic round ${round}: no leads, coverage judged complete`); break }
  log(`Critic round ${round}: ${leads.length} leads`)

  const extra = (await parallel(leads.map((ld, i) => () =>
    agentRetry(`${CONTEXT}\n\nTargeted hunt (round ${round}, lead ${i + 1}). Area: ${ld.area}\nQuestion: ${ld.question}\nWhy it may have been missed: ${ld.why_uncovered}\n\nAlready-known findings (do not re-report these unless you have a materially different root cause):\n${verified.map(brief).join('\n')}\n\nInvestigate deeply. Return findings (possibly none) and the properties you verified sound.`,
      { label: `hunt:r${round}.${i + 1}`, phase: 'Critic', schema: FINDINGS_SCHEMA })
      .then((r) => r ? { lens: `r${round}-${ld.area}`, ...r } : null)
  ))).filter(Boolean)
  allSound.push(...extra.flatMap((r) => r.verified_sound.map((s) => ({ lens: r.lens, ...s }))))
  const rawNew = extra.flatMap((r) => r.findings.map((f) => ({ lens: r.lens, ...f })))
  if (!rawNew.length) { log(`Round ${round}: hunters found nothing new`); break }

  const dd2 = await agentRetry(`${CONTEXT}

You are the LEAD AUDITOR. Below are NEW raw findings from a targeted hunting round, and the list of findings ALREADY known. Return only findings with a genuinely new root cause (merge duplicates among the new ones). Assign ids starting at F${String(nextId).padStart(2, '0')}. List dropped items with reasons.

Already known:
${verified.map(brief).join('\n')}

New raw findings:
${JSON.stringify(rawNew, null, 2)}`, { label: `dedupe:r${round}`, phase: 'Critic', schema: DEDUPED_SCHEMA })
  const fresh = dd2 ? dd2.findings : []
  if (dd2) dropped.push(...dd2.dropped.map((d) => ({ round, ...d })))
  if (!fresh.length) { log(`Round ${round}: nothing new after dedupe`); break }
  nextId += fresh.length
  log(`Round ${round}: ${fresh.length} new findings: ${fresh.map((f) => f.id).join(', ')}`)
  const r2 = (await pipeline(fresh, (f) => verify(f))).filter(Boolean)
  verified.push(...r2)
}

const by = (s) => verified.filter((v) => v.status === s)
log(`FINAL: ${by('confirmed').length} confirmed, ${by('by-design').length} by-design, ${by('disputed').length} disputed, ${by('rejected').length} rejected, ${by('incomplete').length} incomplete`)
return { confirmed: by('confirmed'), byDesign: by('by-design'), disputed: by('disputed'), rejected: by('rejected'), incomplete: by('incomplete'), dropped, verifiedSound: allSound }
