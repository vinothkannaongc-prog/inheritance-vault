# Preliminary security audit of Will & Key (September 2026)

Published 27 September 2026. Audit performed 24–26 September 2026. Not independent. Public page: <https://willandkey.com/audit>.
The same content is published there; this file is the canonical copy in the repository.

> **Since this report (added V2_DATE_TBD).** The report below is unchanged. It describes the contracts, the app and the documentation as they were when it was published on 27 September 2026, while v2 was still undeployed source.
>
> - **v2 is live.** It was deployed on Base on V2_DATE_TBD at [V2_ADDRESS_TBD](https://basescan.org/address/V2_ADDRESS_TBD) ([transaction](https://basescan.org/tx/V2_TX_TBD)). It contains the fixes this report marks "Fixed in v2 source" and the changes made after it, which [`CHANGELOG-v2.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/main/CHANGELOG-v2.md) records: among them, v2 also refuses Venus vBNB as a payout address, and the v2 comments that [F21](#f21) and [F29](#f29) quote were corrected. The app now uses v2.
> - **v2 has not been independently audited.** Only AI agents of the same kind that wrote it have reviewed it: this audit's five fix-review rounds and a pre-launch review. Do not use material value until an independent audit is complete.
> - **v1 is retired.** New-vault creation on v1 ([0xC821849A1D74959753450409b594b23eCE7fEe2f](https://basescan.org/address/0xC821849A1D74959753450409b594b23eCE7fEe2f)) is paused ([transaction](https://basescan.org/tx/V1_PAUSE_TX_TBD)). v1 cannot change, so every v1 behaviour described below is still present in it. On 27 September 2026 it held no user funds.

> **Status: PRELIMINARY. Not an independent audit.**
>
> - Run 24–26 September 2026 by the project owner, using AI agents (Anthropic's Claude models, orchestrated as a multi-agent review). Anthropic did not perform, review or endorse this audit.
> - It is **not an independent third-party audit**. The code was written by the same kind of AI system (Anthropic's Claude) that performed this audit, so the reviewer is not independent of the author.
> - No human security auditor has reviewed the code, the findings or this report, and no independent third-party audit has been completed.
> - The live contract on Base is immutable. Its fixes exist only as **undeployed v2 source code**; the live contract still behaves as each finding describes.
> - **Do not use material value until an independent audit is complete.**

**Contents:** [In short](#summary) · [Scope](#scope) · [How the audit was done](#method) · [Severity and status](#rubric) · [Results in numbers](#results) · [The 47 findings](#findings) · [What was checked and found sound](#sound) · [Recommendations to the project owner](#recommendations) · [Limitations of this review](#limitations) · [Reproduce the evidence](#reproduce)

<a id="summary"></a>

## In short

Will & Key is a smart contract on the Base network that passes crypto to a named heir if the owner stops checking in. In September 2026 AI auditing agents reviewed the live contract and the retired reminder-billing contract, and checked the public claims about them. They examined the web app, the retired reminder watcher and the scripts only where a line of inquiry led there; the app did not get a frontend security review.

- The audit reported **47 findings: 5 medium, 21 low and 21 informational**. None was rated critical or high. One medium finding, [F01](#f01), meets the letter of the high definition (the admin can reach user funds) but was rated medium because it needs a kind of token not known on the target chains; its verification says when it would be high.
- It found no way for a stranger to take funds from a vault that holds ETH or a token on the app's known list, unless the owner or heir first makes a mistake, such as pasting a look-alike address ([F41](#f41)). A stranger holding a leaked check-in-chain value can delay an heir by years, up to the horizon ([F02](#f02); only chains built by hand are exposed). Strangers can also cause nuisance ([F22](#f22), [F36](#f36)) and, in narrower cases, freeze a payout ([F04](#f04), [F08](#f08)). This describes what the review found; it is not a guarantee that nothing else exists.
- The live contract cannot be changed. **Apart from the reminder sales switched off below, every contract behaviour described in these findings is still present in it** ([30 findings](#results)). The fixes exist only in a new version, v2, which has not been deployed and has not been independently audited.
- For the live contract, the app and the documentation were changed to steer users around the problems: the app shows full addresses, offers only known tokens by name, explains what cancels a claim, and warns that no alerts are sent. These protections work only in this app.
- Sales on the retired reminder-billing contract were switched off on chain on 26 September 2026 ([F23](#f23)).

### The five medium findings

- [F01](#f01): the admin's surplus sweep can take deposits in the rare tokens that can be moved through two addresses. Use ETH or a listed token.
- [F02](#f02): values from a paper check-in chain can be reused across vaults, chains and re-installs to delay an heir. The app never offered this feature; a chain built by hand should be rebuilt with the reference generator.
- [F03](#f03): a check-in does not cancel an heir's claim, although the site and emails said it did. Use Veto; the app now shows this.
- [F04](#f04): payouts are all-or-nothing, so tokens with transfer limits can freeze an inheritance. Do not use such tokens.
- [F41](#f41): the app showed heirs in the shortened form that address poisoners imitate. The app now shows full addresses and blocks addresses that imitate your own wallet or an heir you already use. It cannot recognise a look-alike of a new heir, so confirm the full address with your heir.

### If you use Will & Key today

- Use ETH, or a token the app lists by name (on Base: USDC, WETH, cbBTC, EURC). Do not use other tokens. An issuer such as Circle (USDC, EURC) can freeze its token for every vault at once ([F12](#f12)); consider ETH, or split an estate across assets.
- Confirm your heir's full address with them directly, and ask them to find the vault in the app's "I'm an heir" tab.
- Nobody will alert you. Open the app regularly. To cancel a claim, use Veto, not Check in. Past the horizon, only extending the horizon or withdrawing everything stops a claim.
- Heirs: the payout address cannot be changed once a claim starts, and a claim is not final until someone finalizes it. Finalize promptly.

<a id="scope"></a>

## Scope

The audit reviewed the code that is deployed and the public claims made about it.

| Deployed contract (Base, chain id 8453) | Address | Source | Runtime size |
|---|---|---|---|
| InheritanceVault | [0xC821849A1D74959753450409b594b23eCE7fEe2f](https://basescan.org/address/0xC821849A1D74959753450409b594b23eCE7fEe2f) | `contracts/InheritanceVault.sol` at commit [`b8baf34`](https://github.com/vinothkannaongc-prog/inheritance-vault/tree/b8baf34), 846 lines; source-verified on Basescan | 16,163 bytes |
| NotifySubscription (retired reminder billing) | [0x60749aF621180de1DC05DB4f3d158D09dE979dC6](https://basescan.org/address/0x60749aF621180de1DC05DB4f3d158D09dE979dC6) | `contracts/NotifySubscription.sol` at the same commit, 105 lines | 2,108 bytes |

The primary scope was these two contracts, with the test token mocks in `contracts/test/TestHelpers.sol` (not deployed). One of the ten lenses checked the public claims about contract behaviour against the code: those in `README.md`, in the contracts' own comments, and on the website's home, How it works, security and terms pages. Items the earlier internal review listed as fixed were re-checked, not trusted.

Examined only where a lens or a second-round hunt led there, and not reviewed systematically: the web app (`site/app.html`, `site/assets/app.js`), the retired reminder watcher (`notify/watcher.js`), the deploy and admin-transfer scripts, and the other public documents (`SECURITY.md`, `AUDIT_SCOPE.md`, `AUDIT-2026-08-09.md` and the guides), all at the same commit.

The audit read commit `b8baf34`. The site redesign (commit `5bbad6e`, live since 26 September 2026) and a guide refresh (`90a7b83`) came after it and were not audited, except where the evidence suite reads those files.

Compiler settings: Solidity 0.8.28, optimizer on with 200 runs, EVM version cancun; OpenZeppelin Contracts 5.6.1; Hardhat 2.29.0. Neither contract has immutable variables, so the compiled runtime and the code on chain are the same bytes.

### Bytecode fingerprints

Re-read from Base on 27 September 2026 (block 51,829,749). Earlier versions of the security page and `AUDIT_SCOPE.md` labelled the keccak-256 values as SHA-256 ([F30](#f30)); the labels below are correct.

| Contract | keccak-256 of the runtime (EXTCODEHASH) | SHA-256 of the raw runtime bytes |
|---|---|---|
| InheritanceVault | `26a231771f3b5e7de6a09b3cd5a3e0d03fb5985d69b9bc4973db5f1e41af9733` | `89ca53b6aaea87fba5e3e0df7019b316f8a44304ef64569ea5a4978c4f9e4d60` |
| NotifySubscription | `67f23ec7a57f27c4c024c82ac45ef0e3a76e535b4f8224f2ce1de21c8029aec1` | `f2c577fd64b9038127473e87bb1c9981497962e36fde0b82f67465bf92e4bb61` |

To reproduce with Foundry's `cast`, replacing `ADDR` with a contract address (hashing the hex text instead of the raw bytes gives a different SHA-256):

```sh
cast keccak $(cast code ADDR --rpc-url https://mainnet.base.org)
cast code ADDR --rpc-url https://mainnet.base.org | sed 's/^0x//' | xxd -r -p | sha256sum
```

State at the time of writing, from read-only calls on 27 September 2026: the vault's admin (owner) and fee recipient is the single Ledger hardware-wallet key [0x883C821103B5415C53B11E584D3592205B5CdCA3](https://basescan.org/address/0x883C821103B5415C53B11E584D3592205B5CdCA3), with no transfer pending; the claim fee is 0.5% (50 basis points); new-vault creation is not paused; the vault contract's ETH balance was 0.00002 ETH.

### The undeployed v2

- v2 is [`contracts/InheritanceVault.sol`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/contracts/InheritanceVault.sol) at the tag `audit-2026-09-prelim`: 1,573 lines, 21,080 bytes of runtime code (the EIP-170 limit is 24,576), with the same compiler settings. Its constructor also takes a fixed list of supported tokens and the chain's wrapped-native token.
- v2 was written after the audit, in response to it. It was not part of the audit itself; it was reviewed only in the fix-review rounds described below. It has run only on local test networks and read-only forks.
- The live app talks only to v1 and keeps v1's interface. Every change is listed in [`CHANGELOG-v2.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/CHANGELOG-v2.md).

### Out of scope

- The website's hosting and infrastructure (Cloudflare Pages, DNS, TLS, HTTP headers). They were not tested.
- A frontend security review of the app. The integrity of its scripts (including the bundled ethers.js library), injection into the page, trust in responses from network endpoints, and its interaction with wallets were not examined.
- Wallet software, the Ledger device, and how the admin key is kept.
- The Solidity compiler, the OpenZeppelin library beyond how the contracts use it, and the Base and BNB Chain networks themselves (their inclusion behaviour is noted in [F37](#f37)).
- Token contracts and their issuers.
- Economic, legal, tax and estate-planning questions.

<a id="method"></a>

## How the audit was done

The audit ran as a workflow of AI agents, all Claude Opus 5.5, with 161 agent runs in total. The agents read the repository at commit `b8baf34` without changing it (proofs of concept ran in isolated copies), sent no mainnet transactions, and were told to check every claim against the code rather than trust comments, the README or the earlier review. Every auditor, skeptic, critic, fixer and reviewer named in this report is an AI agent, and the "lead agent" is the Claude session that ran the workflow.

1. **Find.** Ten auditor agents each took one lens: accounting; the claim state machine; admin powers and fees; token behaviour; the check-in chain; reentrancy and payouts; arithmetic and time; the billing contract; public claims against the code; and griefing, transaction ordering and multiple chains. Each reported findings and the properties it had checked and found sound. Round 1 produced **80 raw findings**.
2. **Merge.** A lead agent merged findings with the same root cause, leaving **39**. None was dropped.
3. **Prove and challenge.** Every finding then got three more agents. One wrote an executable proof of concept, a Hardhat test in an isolated copy of the repository. One skeptic tried to show it could not happen in practice (reachability). Another tried to show its severity was wrong, or that it was intended and disclosed (severity). Round 1 ended with 37 confirmed, 2 by design, 0 disputed and 0 rejected.
4. **Look for gaps.** A completeness critic read the findings and the list of sound properties and proposed four areas nobody had examined closely: the deposit measurement window, owner actions past the horizon, how an owner or heir learns that something has happened, and the app's handling of irreversible inputs. Four targeted hunts produced **8 new findings** (F40 to F47), checked in the same way. Seven overlapping items from those hunts were folded into other findings instead of being listed twice.
5. **Final severities.** The lead agent set each finding's final severity, taking both skeptics into account. Final result: **47 findings: 44 confirmed, 2 by design ([F32](#f32), [F34](#f34)), 1 disputed ([F40](#f40)), 0 rejected.**

### Interruptions

The run was interrupted twice. One of the four round-2 hunts stalled three times, twice for about 16 hours during a network outage, and completed on its fourth attempt. Later, the second and final completeness-critic pass (round 3) failed on an account session limit on all three attempts. The workflow treats a critic that returns nothing as "no new leads", so it recorded coverage as complete and finished. That pass was not run again: the completeness check rests on the first critic pass (round 2) alone.

### The evidence suite

After the audit, the 47 proofs of concept were collected into the repository as the v1 evidence suite, [`audit/2026-09-preliminary/`](https://github.com/vinothkannaongc-prog/inheritance-vault/tree/audit-2026-09-prelim/audit/2026-09-preliminary). Contract proofs run against an exact copy of the v1 source, renamed so that v1 and v2 compile side by side. App, documentation, script and watcher proofs read the current files. Every proof asserts the safe behaviour that v1 lacks, so on v1 **the failures are the evidence**. The recorded run on 26 September 2026 gave 184 failing, 88 passing and 1 skipped test, in 18 minutes; 46 of the 47 files matched their original sandbox runs exactly, and the one difference (F38) is explained in [`RESULTS-v1.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/RESULTS-v1.md).

### Fixes and their review

Further agents wrote the fixes: the v2 contract, its tests and its tooling in four passes, and separately the app and the documentation. The contract changes were then reviewed in five rounds, each with three lenses (security regressions, whether each finding is really closed, and test quality); rounds 4 and 5 used fresh agents that had not seen the earlier rounds' work. The rounds raised 14, 10, 10, 8 and 6 issues, 48 in all, with medium or above only in round 2 (two test-quality items). The 34 issues of rounds 1 to 3 were all confirmed: 31 were fixed in code, tests, comments or documentation, and in the other 3 (two about [F20](#f20), one about [F08](#f08)) the design was kept on purpose and only its documentation was corrected. The 8 issues of round 4 were all confirmed and fixed. The 6 issues of round 5 (one low, about [F20](#f20); five informational) were recorded but not fixed: the lead stopped the loop there and left them for the independent audit, and they are listed under Review round 5 in the changelog. The changelog leaves two design questions to the maintainer: [F20](#f20)'s heir cancel (raised in review rounds 1 and 2) and the cost of [F33](#f33)'s view guard (flagged when that fix was written, before the review rounds). Each contract fix was shown to be needed by running its new test against the code before the fix, and each test added for a gap was shown to catch the deliberately broken version of the code that the reviewing agent had found. Mutation checks in rounds 1 to 4 (22, 14, 27 and 28 deliberately broken versions of the contract and tools) were all caught by the tests. [`CHANGELOG-v2.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/CHANGELOG-v2.md) records every change and every review item.

The app and documentation changes were also reviewed by separate agents; the app was driven in a real browser against a local copy of v1, under the website's production security policy. Those reviews are not itemised in a published record.

### About this report

This report was compiled on 27 September 2026 by an AI agent of the same kind, from the audit's machine-readable record, the evidence suite, `CHANGELOG-v2.md` and the current code and site. Where it says "we ran" or "re-checked", that agent ran the command on that date.

The app and documentation changes this report describes are released on willandkey.com together with this page. In the repository they are at the tag `audit-2026-09-prelim`; until the repository's default branch is updated, it may still show older versions of `README.md`, `SECURITY.md` and the other documents.

<a id="rubric"></a>

## Severity and status

The auditors used this rubric. No finding was rated critical or high.

| Severity | Meaning |
|---|---|
| Critical | Theft or permanent freezing of user funds by an unprivileged party, with no unusual preconditions. |
| High | Theft or freezing under plausible conditions, the admin able to reach user funds, or an unprivileged party able to deny or hijack an inheritance. |
| Medium | Conditional loss, griefing with a strong cost asymmetry, a core guarantee broken under specific conditions, or accounting corruption without direct loss. |
| Low | Bounded edge cases, minor griefing, events or return values that mislead integrators. |
| Informational | Best practice, gas, clarity, or a mismatch between code and documentation with no fund impact. |

The ratings apply the rubric with judgement about likelihood. [F01](#f01) meets the letter of High, because the admin can reach user funds, but it was rated Medium because it needs a kind of token that is not known on the target chains; its verification gives the conditions under which it would be High.

Each finding also has one or more statuses:

| Status | Meaning |
|---|---|
| Fixed in v2 source | Changed in the repository's undeployed v2: the contract, or for tooling and test findings the deploy scripts or tests. It does nothing for the live contract. |
| Mitigated in the app and documentation | The website, the app, the public documentation or the retired watcher was changed. Where the problem was in those files, that is the fix; for a contract finding it lowers the risk, but the live contract still behaves as reported. These changes are released on willandkey.com together with this report. |
| Acknowledged | The behaviour is kept on purpose (in v2 too, where it applies) and disclosed. |
| Resolved by an admin transaction | Fixed on chain by a transaction from the admin key. |
| Needs an admin transaction | Waiting for the admin to sign a transaction. |
| Nothing changed anywhere | Nothing has been changed yet, in the contract, the app or the documentation. |
| By design | A skeptic showed that the behaviour is intended and was already disclosed, and the lead agent agreed. It is listed for completeness. |
| Disputed | The finder and a skeptic disagreed about whether it is a defect or how severe it is. The finding sets out the dispute and how it was resolved. |

<a id="results"></a>

## Results in numbers

| Severity | Findings | IDs |
|---|---|---|
| Medium | 5 | [F01](#f01), [F02](#f02), [F03](#f03), [F04](#f04), [F41](#f41) |
| Low | 21 | [F05](#f05), [F06](#f06), [F07](#f07), [F08](#f08), [F09](#f09), [F10](#f10), [F11](#f11), [F12](#f12), [F13](#f13), [F14](#f14), [F15](#f15), [F17](#f17), [F18](#f18), [F19](#f19), [F20](#f20), [F22](#f22), [F23](#f23), [F36](#f36), [F37](#f37), [F42](#f42), [F44](#f44) |
| Informational | 21 | [F16](#f16), [F21](#f21), [F24](#f24), [F25](#f25), [F26](#f26), [F27](#f27), [F28](#f28), [F29](#f29), [F30](#f30), [F31](#f31), [F32](#f32), [F33](#f33), [F34](#f34), [F35](#f35), [F38](#f38), [F39](#f39), [F40](#f40), [F43](#f43), [F45](#f45), [F46](#f46), [F47](#f47) |
| Total | 47 |  |

By status. A finding can have more than one status, so this column adds up to more than 47. The first row is not a status: it counts the findings whose reported behaviour still happens in the live vault contract, whether v2 fixes it or it is kept by design.

| Status | Findings | IDs |
|---|---|---|
| **Behaviour still present in the live vault contract** | 30 | [F01](#f01), [F02](#f02), [F03](#f03), [F04](#f04), [F05](#f05), [F06](#f06), [F07](#f07), [F08](#f08), [F09](#f09), [F10](#f10), [F11](#f11), [F12](#f12), [F13](#f13), [F14](#f14), [F15](#f15), [F16](#f16), [F17](#f17), [F18](#f18), [F20](#f20), [F21](#f21), [F22](#f22), [F25](#f25), [F26](#f26), [F27](#f27), [F28](#f28), [F32](#f32), [F33](#f33), [F36](#f36), [F42](#f42), [F43](#f43) |
| Fixed in v2 source | 23 | [F01](#f01), [F02](#f02), [F04](#f04), [F05](#f05), [F06](#f06), [F08](#f08), [F09](#f09), [F10](#f10), [F11](#f11), [F14](#f14), [F15](#f15), [F18](#f18), [F20](#f20), [F22](#f22), [F25](#f25), [F26](#f26), [F27](#f27), [F28](#f28), [F31](#f31), [F33](#f33), [F38](#f38), [F39](#f39), [F42](#f42) |
| Mitigated in the app and documentation | 36 | [F01](#f01), [F02](#f02), [F03](#f03), [F04](#f04), [F05](#f05), [F06](#f06), [F07](#f07), [F09](#f09), [F10](#f10), [F11](#f11), [F12](#f12), [F13](#f13), [F15](#f15), [F16](#f16), [F17](#f17), [F18](#f18), [F19](#f19), [F20](#f20), [F21](#f21), [F23](#f23), [F24](#f24), [F25](#f25), [F28](#f28), [F29](#f29), [F30](#f30), [F31](#f31), [F32](#f32), [F36](#f36), [F37](#f37), [F40](#f40), [F41](#f41), [F43](#f43), [F44](#f44), [F45](#f45), [F46](#f46), [F47](#f47) |
| Acknowledged | 8 | [F12](#f12), [F13](#f13), [F16](#f16), [F17](#f17), [F32](#f32), [F34](#f34), [F35](#f35), [F43](#f43) |
| Resolved by an admin transaction | 1 | [F23](#f23) |
| Needs an admin transaction | 0 | none |
| Nothing changed anywhere | 0 | none |

Contract findings whose only fix is in the undeployed v2, with nothing changed for the live contract: [F08](#f08), [F14](#f14), [F22](#f22), [F26](#f26), [F27](#f27), [F33](#f33), [F42](#f42). The admin transaction for [F23](#f23) was signed on 26 September 2026, so no finding is waiting on an admin transaction; the admin actions recommended below (a signed fee and sweep commitment, and a move to a multisig) are still pending.

<a id="index"></a>

### Findings index

| ID | Finding | Severity | Status |
|---|---|---|---|
| [F01](#f01) | The admin's surplus sweep can take deposits in a token that has two addresses | Medium | Fixed in v2 source; Mitigated in the app and documentation |
| [F02](#f02) | Check-in chain values can be reused across vaults, chains and re-installs | Medium | Fixed in v2 source; Mitigated in the app and documentation |
| [F03](#f03) | Instructions said any action cancels a claim; a check-in does not, and "Check in on all vaults" reported success | Medium | Mitigated in the app and documentation |
| [F04](#f04) | Payouts are all-or-nothing, so tokens with transfer limits can freeze an inheritance | Medium | Fixed in v2 source; Mitigated in the app and documentation |
| [F05](#f05) | A claim that started fee-free can be charged if a fee recipient is set before it settles | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F06](#f06) | Fee changes apply instantly, so they can be timed around a user's transaction | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F07](#f07) | The site said your rate "can never go up"; only a ceiling is fixed | Low | Mitigated in the app and documentation |
| [F08](#f08) | Anyone can push a payout into an address that cannot use it | Low | Fixed in v2 source |
| [F09](#f09) | A payout sent to the WETH contract comes back as surplus the admin can sweep | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F10](#f10) | Tokens that take more than they pay leave the last withdrawer short | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F11](#f11) | Growth on rebasing or interest-bearing deposits goes to the admin, not the heir | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F12](#f12) | One token-issuer action can freeze every vault in that token | Low | Acknowledged; Mitigated in the app and documentation |
| [F13](#f13) | "Finalizable" is not "final": the owner can still cancel until someone finalizes | Low | Acknowledged; Mitigated in the app and documentation |
| [F14](#f14) | Closing a vault during a claim emits no claim-ended event | Low | Fixed in v2 source |
| [F15](#f15) | Batch check-in skips vaults silently and can overcount | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F16](#f16) | A chain check-in counts only if it is mined strictly before the deadline | Informational | Acknowledged; Mitigated in the app and documentation |
| [F17](#f17) | Chain values are bearer credentials that can delay the heir up to the horizon | Low | Acknowledged; Mitigated in the app and documentation |
| [F18](#f18) | In the last period before the horizon, check-ins succeed but extend nothing | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F19](#f19) | Past the horizon the app offered Veto and Change heir, which always fail | Low | Mitigated in the app and documentation |
| [F20](#f20) | An heir cannot correct a mistyped payout address once a claim has started | Low | Fixed in v2 source; Mitigated in the app and documentation |
| [F21](#f21) | The "guaranteed inheritance date" label over-promised | Informational | Mitigated in the app and documentation |
| [F22](#f22) | A 1-wei top-up can stop an owner from closing a vault | Low | Fixed in v2 source |
| [F23](#f23) | The retired reminder contract still sold reminder time | Low | Resolved by an admin transaction; Mitigated in the app and documentation |
| [F24](#f24) | The site overstated the earlier internal review | Informational | Mitigated in the app and documentation |
| [F25](#f25) | The locked claim fee cannot be seen, and the app showed the ceiling as the fee | Informational | Fixed in v2 source; Mitigated in the app and documentation |
| [F26](#f26) | Payout events can be mistaken for transfers when they record only credits | Informational | Fixed in v2 source |
| [F27](#f27) | Events leave out the new deadline and the removed heir | Informational | Fixed in v2 source |
| [F28](#f28) | The paper check-in chain was advertised but unspecified and unsupported | Informational | Fixed in v2 source; Mitigated in the app and documentation |
| [F29](#f29) | Public documents did not match the code or the live state | Informational | Mitigated in the app and documentation |
| [F30](#f30) | Published "SHA-256" fingerprints were keccak-256 | Informational | Mitigated in the app and documentation |
| [F31](#f31) | Deploy tooling for a BNB launch would have repeated old mistakes | Informational | Fixed in v2 source; Mitigated in the app and documentation |
| [F32](#f32) | The creation pause does not stop top-ups | Informational | Acknowledged; Mitigated in the app and documentation; By design |
| [F33](#f33) | Views can show half-updated values while a deposit is in progress | Informational | Fixed in v2 source |
| [F34](#f34) | The retired billing contract's owner could reprice a payment in flight | Informational | Acknowledged; By design |
| [F35](#f35) | A 1-second gift can make an exact-cap reminder purchase fail | Informational | Acknowledged |
| [F36](#f36) | Anyone can name any address as heir of a vault holding a fake token | Low | Mitigated in the app and documentation |
| [F37](#f37) | A veto depends on the network including it in time | Low | Mitigated in the app and documentation |
| [F38](#f38) | Tests missed hostile tokens and the billing contract's boundaries | Informational | Fixed in v2 source |
| [F39](#f39) | One regression test depended on the computer's clock | Informational | Fixed in v2 source |
| [F40](#f40) | Nothing tells an owner that a claim has started | Informational | Mitigated in the app and documentation; Disputed |
| [F41](#f41) | The app showed heirs as the 8 characters that address poisoners copy | Medium | Mitigated in the app and documentation |
| [F42](#f42) | A deposit can capture pool-wide gains, or absorb pool-wide losses, from unusual tokens | Low | Fixed in v2 source |
| [F43](#f43) | Past the horizon, changing the heir restarts nothing | Informational | Acknowledged; Mitigated in the app and documentation |
| [F44](#f44) | Heirs could not find their vault from what the FAQ told them | Low | Mitigated in the app and documentation |
| [F45](#f45) | The watcher and the app told owners past the horizon to check in | Informational | Mitigated in the app and documentation |
| [F46](#f46) | During a claim, the owner's card did not say when it can be finalized or where it pays | Informational | Mitigated in the app and documentation |
| [F47](#f47) | Irreversible dates were signed without a review | Informational | Mitigated in the app and documentation |

<a id="findings"></a>

## The 47 findings

Each finding gives a plain-language summary, the impact, the affected code at the audited commit `b8baf34` (line numbers refer to that commit), the evidence, how the two skeptics judged it, what was changed, and the risk that remains on the live contract. Test counts come from the recorded run in `RESULTS-v1.md`: on v1 the tests that assert the safe behaviour fail, and that failure is the evidence; controls and measurements pass.

<a id="f01"></a>

### F01 · Medium · The admin's surplus sweep can take deposits in a token that has two addresses

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** sweepSurplus lets the admin take depositors' principal when a token's ledger can be reached through a second address (double-entry tokens, or a native coin with an ERC20 facade)

**In plain words.** The vault keeps separate books for each token address. Anything the contract holds above those books is "surplus", which the admin may sweep. A few tokens can be moved through two different contract addresses that share one balance. For such a token, the books under the second address are empty, so the whole balance of every vault looks like surplus through it, and one sweep can take all of it.

**Impact.** The admin key (today a single hardware wallet), or anyone who steals it, could take every vault balance and every unpaid payout held in such a token. Afterwards the vaults still show their balances, but payouts in that token fail. The same applies on a chain whose native coin also has a token address (Celo is an example). No such token or chain is known among Will & Key's targets (Base, BNB Chain) today. The finding breaks the promise that the admin "cannot touch a wei" of a vault.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:179-180` (the books, keyed by token address); `:768-772` `surplus()`; `:774-780` `sweepSurplus()`; `:345-356` `_pull` and `:370-401` `createVault` (any token accepted); `site/assets/app.js:360-372` (free-text token field).

**Evidence.** [`poc/F01.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F01.ts): 5 tests; on v1, 5 fail and 0 pass. The sweep through the second address priced 15 units of users' funds as surplus and took all of it; the vault was left holding 0 against 10 locked and 5 owed, and the owner's and heir's payouts reverted.

**Verification.** Initial rating Medium; the reachability skeptic did not refute it and proposed Medium; the severity skeptic did not refute it and proposed Medium. Final severity: Medium. Status: confirmed. The proof of concept reproduced it. The rubric's High covers the admin being able to reach user funds. The lead agent rated this Medium because it needs a token with a second entry point, and none is known on Base or BNB Chain today. The severity skeptic noted that it becomes High on a chain whose native coin also has a token address (such as Celo), or if a token the app promotes gains a second entry point.

**What was changed.** **In v2 source:** An allowlist of supported tokens is fixed when the contract is deployed. Deposits of any other ERC-20 revert (`UnsupportedToken`), `sweepSurplus` works only for the native coin or a listed token, and no function can add a token later (an admin who could list a token's second address could then sweep it).

**In the app and documentation:** The app offers only known single-address tokens by name (on Base: USDC, WETH, cbBTC, EURC). Any other token address needs a blocking acknowledgement that names these risks, and its address is always shown. [How it works](https://willandkey.com/how-it-works#tokens) and the security page limit the "admin cannot take" statements to ETH and supported single-address tokens.

**Residual risk on the live contract.** The live contract still accepts any token and its sweep is unchanged. Only the app and the documentation steer you away. Use ETH or a token on the app's known list.

In v2 the protection depends on the deployer listing only single-address tokens, and on no listed token later gaining a second address (upgradeable tokens can). An unlisted token sent to v2 by mistake can never be recovered.

---

<a id="f02"></a>

### F02 · Medium · Check-in chain values can be reused across vaults, chains and re-installs

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Hash-chain check-in has no domain separation: anyone can replay preimages across vaults, owners, deployments (testnet/Base/BNB) and re-installed chains, delaying a dead owner's heir until the horizon

**In plain words.** The optional paper "check-in chain" lets whoever holds a seed keep a vault alive without the wallet key. Each value is the hash of the next. The live contract checks only that the hash matches. It does not tie a value to the vault, the owner, the contract, the chain or the installation. So a value revealed anywhere (a testnet rehearsal, another vault, an earlier installation) can be reused by anyone wherever the same chain is installed. Built the obvious way, the chain's last check-in also publishes the raw seed.

**Impact.** A stranger holding a leaked value can keep checking in for an owner who has died, delaying the heir up to the horizon (up to 100 years; the app's default was 20). Or they can use up the whole chain in one block and destroy the owner's recovery path. No funds are stolen. The app has never offered this feature, so only owners who built a chain by hand are exposed.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:535-548` `checkInByChain` (`:542` compares `keccak256(abi.encodePacked(preimage))` with the anchor); `:502-515` `setCheckInChain`; NatSpec `:517-534`.

**Evidence.** [`poc/F02.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F02.ts): 7 tests; on v1, 7 fail and 0 pass. A forged check-in was accepted with a value leaked from another deployment, another vault, another owner or an earlier installation. One leaked value moved a dead owner's deadline about 700 days, to the horizon, and a 100-value chain was burned to 8 in one block.

**Verification.** Initial rating Medium; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Medium. Final severity: Medium. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** Every step is bound to its context: a value is accepted only if `keccak256(abi.encode(HB_DOMAIN, chainid, contract, owner, vaultId, hbEpoch, value))` equals the anchor. `hbEpoch` rises on every installation, an install can be pinned to an expected epoch, and a public `hbStep` view lets tools check their arithmetic. A reference generator, [`scripts/checkin-chain.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/scripts/checkin-chain.ts), and a published spec, [`docs/CHECKIN-CHAIN.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/docs/CHECKIN-CHAIN.md), cover both versions.

**In the app and documentation:** The generator's v1 mode protects users of the live contract off-chain: it derives the chain from the seed together with the chain, contract, owner, vault and an install index, so a value from one vault or chain is useless elsewhere and the last reveal is never the seed. The site labels the feature "advanced, no app support" and says to use a fresh seed for every vault and chain.

**Residual risk on the live contract.** The live contract still accepts any matching hash. A chain built by hand, or from a reused seed, stays exposed; only chains built with the generator's v1 mode are protected, and that protection is off-chain. Even v2 cannot protect someone who re-arms with a seed that is already public.

---

<a id="f03"></a>

### F03 · Medium · Instructions said any action cancels a claim; a check-in does not, and "Check in on all vaults" reported success

**Status:** Mitigated in the app and documentation  
**Audit title:** Veto instructions say 'any action from your wallet / a check-in' cancels a claim; checkIn reverts, and the app's one-click 'Check in (all vaults)' reports success while the claim keeps running

**In plain words.** When an heir starts a claim, the owner has a challenge window in which to veto it. The home page, the README, a guide and the reminder emails told owners that any action from their wallet, even a check-in, cancels a claim. It does not: a check-in is refused while a claim is pending. The app's "Check in on all vaults" button skipped the vault with the claim, still showed "confirmed", and the claim kept running.

**Impact.** A living owner who followed the instructions could believe they had vetoed a claim and lose the vault when the window ended. The funds go to the heir the owner named, not to a thief, but against the owner's wishes.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:458-468` `checkIn` (`:460` reverts `ClaimPendingUseAbort`); `:481-498` `checkInMany` (`:492` skips silently); `notify/watcher.js:154`; `site/index.html:153-154`; `README.md:22-24`; `site/assets/app.js:337-341`.

**Evidence.** [`poc/F03.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F03.ts): 5 tests; on v1, 3 fail and 2 pass. During a claim the owner's `checkIn` reverted; the app's batch check-in was confirmed while the vault stayed claim-pending; a third party then settled it to the heir (9.95 ETH).

**Verification.** Initial rating Medium; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Medium. Final severity: Medium. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change to the rule, on purpose: a check-in proves the owner is alive but is not a veto, so automation or a paper seed can never cancel an heir's claim. v2 does log every vault a batch check-in skips, with the reason (F15), and past the horizon `checkIn` now names the remedy that works there.

**In the app and documentation:** [How it works](https://willandkey.com/how-it-works#veto) lists exactly what cancels a claim. Before the horizon: Veto claim, changing the heir, changing the inactivity period, installing a check-in chain, extending the horizon, or any withdrawal. At or after the horizon: only extending the horizon by at least one inactivity period, or withdrawing everything. It also lists what does not: a check-in, a batch check-in, a chain check-in, a top-up, ordinary wallet activity. While a claim is pending, the app replaces Check in with the veto controls; "Check in on all vaults" leaves such vaults out and lists every vault it did not check in, with the reason and the remedy. The (retired) watcher's email text was corrected.

**Residual risk on the live contract.** The contract behaves as before. Anyone using another interface (a block explorer, a script) must call `abortClaim`, not `checkIn`, to veto.

---

<a id="f04"></a>

### F04 · Medium · Payouts are all-or-nothing, so tokens with transfer limits can freeze an inheritance

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** All-or-nothing credit withdrawal freezes inheritances in transfer-capped tokens, and strangers can push a credit over the cap

**In plain words.** The live contract pays each payout credit in one transfer of the whole amount. Some tokens cap the size of one transfer, cap how much a wallet may hold, or impose cooldowns. A credit bigger than the cap can never be paid. Strangers can also push a credit over the cap: anyone may top up an active vault, and any owner of a vault in the same token may withdraw to your address, which adds to your credit.

**Impact.** An heir's whole inheritance in such a token can be frozen, permanently if the cap never changes. Freezing someone else's credit costs only the gap between their credit and the cap.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:714-722` `withdrawCredit` and `:726-733` `pushCredit` (no amount); `:338-341` `_credit` (credits merged per token and account); `:441-454` `topUp` (open to anyone).

**Evidence.** [`poc/F04.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F04.ts): 5 tests; on v1, 4 fail and 1 pass. With a 100-unit transfer cap the heir recovered nothing of credits of 109.45, 100.005, 199 and 100.097, and a stranger's 10.6 donation froze 89.55. The under-cap control passed.

**Verification.** Initial rating Medium; the reachability skeptic did not refute it and proposed Medium; the severity skeptic did not refute it and proposed Medium. Final severity: Medium. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `withdrawCredit(token, to, amount)` lets the credited account take a credit in parts (`0 < amount <= credit`); the two-argument form still pays in full. Capped and max-wallet tokens are named as unsupported and must never be listed.

**In the app and documentation:** [How it works](https://willandkey.com/how-it-works#tokens) names tokens with per-transfer caps, maximum-wallet limits or cooldowns as unsupported, and the app steers users to known tokens.

**Residual risk on the live contract.** The live contract has no partial withdrawal. A credit above such a token's cap stays frozen until the token's owner lifts the cap. Do not use such tokens.

---

<a id="f05"></a>

### F05 · Low · A claim that started fee-free can be charged if a fee recipient is set before it settles

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Fee lock ignores the 'no fee recipient means no fee' state: the admin can set a recipient during the challenge window and charge a claim that was fee-free at initiation

**In plain words.** The fee rule says: with no fee recipient set, no fee is taken. The live contract locks a claim's fee rate when the claim starts, but checks for a recipient only at settlement. So if no recipient was set when the heir started a claim, and the admin sets one before settlement, the heir pays the locked rate.

**Impact.** The heir pays up to the vault's fee ceiling (0.5% today, 1% at most) on a claim that looked fee-free. This cannot happen at present: a fee recipient (the admin's hardware wallet) has been set since 24 September 2026, so it would first have to be unset.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:647-652` `initiateClaim` (locks only the rate); `:692-699` `finalizeClaim` (reads the recipient at settlement); `:750-754` `setFeeRecipient` (immediate).

**Evidence.** [`poc/F05.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F05.ts): 4 tests; on v1, 3 fail and 1 pass. A claim begun with no recipient was charged 0.5% (0.05 ETH) once a recipient was set mid-window, also in a one-block sandwich, and the full 1% on a fresh deployment. The no-recipient control passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `initiateClaim` locks 0 when no recipient is in force. Switching a recipient on after none counts as a fee raise and takes effect only after `FEE_RAISE_DELAY` (30 days); `finalizeClaim` charges nothing before then. (The first version of this fix left a same-block hole at settlement; review round 1 found and closed it.)

**In the app and documentation:** [How it works](https://willandkey.com/how-it-works#fees) and the security page disclose the live behaviour, and whenever no fee recipient is set, the app's fee text says that one could still be set before a claim settles.

**Residual risk on the live contract.** Unchanged on the live contract. It depends on the admin not unsetting and re-setting the recipient; see the recommended fee commitment below.

---

<a id="f06"></a>

### F06 · Low · Fee changes apply instantly, so they can be timed around a user's transaction

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Fee ceiling (createVault) and fee lock (initiateClaim) are both taken from a front-runnable global rate with no user-supplied bound (OQ-3 confirmed; the A-04 sandwich survives as a two-point sandwich)

**In plain words.** When you create a vault, the live contract records the global fee rate at that moment as your vault's ceiling. When an heir starts a claim, it locks the lower of the ceiling and the global rate. The admin can change the global rate instantly, and neither function lets the user set a maximum. So the admin, or whoever holds the key, could raise the rate just before a user's transaction and lower it just after.

**Impact.** Up to the 1% cap per vault at creation, and up to the vault's ceiling on a claim, while the published rate looks lower. Visible afterwards in the contract's events. An owner can escape a bad ceiling by withdrawing everything (no fee) and creating the vault again.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:370-377`, `:411` (`createVault` snapshot, no maximum); `:639`, `:651-652` (`initiateClaim` lock, no maximum); `:742-746` `setClaimFee` (immediate).

**Evidence.** [`poc/F06.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F06.ts): 4 tests; on v1, 4 fail and 0 pass. A same-block front-run gave a vault a 1% ceiling where 0.5% was quoted; a claim sandwich charged 0.5% where 0.1% was public; the combined attack took the full 1%.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** Fee raises are time-locked: a raise is announced and takes effect 30 days later, while cuts apply at once and cancel a pending raise. The rate in force is computed from the announcement, so no admin transaction can raise it within a block. The locked claim rate is visible (F25).

**In the app and documentation:** The app shows the current rate before you sign. After a vault is created it compares the recorded ceiling with the quote and, if they differ, says so and explains how to withdraw and re-create. [How it works](https://willandkey.com/how-it-works#fees) explains the ceiling.

**Residual risk on the live contract.** Instant rate changes remain possible on the live contract, within the 1% cap. See the recommended fee commitment below.

---

<a id="f07"></a>

### F07 · Low · The site said your rate "can never go up"; only a ceiling is fixed

**Status:** Mitigated in the app and documentation  
**Audit title:** 'Your rate is locked when you create the vault ... it can never go up' is false: only a ceiling is locked, so a fee cut can be reversed back up to it

**In plain words.** The home page said a vault's fee rate is locked at creation and can go down but never up. In fact only a ceiling is fixed. If fees are cut and later restored before the heir claims, the heir pays the restored rate, up to the ceiling.

**Impact.** Heirs could pay more than owners were told their rate had fallen to, but never above the ceiling (1% at most). A disclosure problem.

**Affected code (v1, commit b8baf34).** `site/index.html:129-134`, `:116-117`; `contracts/InheritanceVault.sol:411`, `:651-652`, `:695-697`, `:742-746`.

**Evidence.** [`poc/F07.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F07.ts): 2 tests; on v1, 2 fail and 0 pass. After the rate was cut to 0 and restored, the heir still paid 0.05 ETH (0.5%).

**Verification.** Initial rating Low; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change: v2 keeps the ceiling rule.

**In the app and documentation:** The fee text now says that only a ceiling is fixed at creation, that cuts apply only while they are in force, that a claim's rate is capped (not fixed) when it starts, and that a cut helps the heir only if it is still in force when the claim settles, because on the live contract the admin can reverse a cut at any moment.

**Residual risk on the live contract.** None beyond the disclosed behaviour.

---

<a id="f08"></a>

### F08 · Low · Anyone can push a payout into an address that cannot use it

**Status:** Fixed in v2 source  
**Audit title:** Permissionless pushCredit lets anyone override the credited account's routing choice, forcing a credit into a blocklisted address or a contract that cannot move the asset

**In plain words.** A settled inheritance becomes a credit. The credited address can pull it to any address it chooses. But anyone may also "push" it to the credited address itself. If that address is blocklisted by a token that checks only the sender (Tether-style), or is a contract that can pull but cannot move the token, a stranger can push the credit there before its owner routes it elsewhere. Settlement and push can even happen in one transaction.

**Impact.** One heir's or one withdrawer's credit can be frozen, or made burnable by the token's issuer. The attacker gains nothing. It needs a token whose blocklist checks only the sender and a blocklisted recipient, or a narrow kind of contract.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:724-733` `pushCredit` (anyone; pays the credited account); `:714-722` `withdrawCredit`; `:682-710` `finalizeClaim` (anyone); NatSpec `:67-72`.

**Evidence.** [`poc/F08.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F08.ts): 5 tests; on v1, 3 fail and 2 pass. A stranger's settle-and-push moved a blocklisted heir's 995-token credit into his frozen address, and front-running a forwarder's pull stranded it. Both routing controls passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** A third party may push a credit only 30 days (`PUSH_GRACE`) after it was first owed; the credited account may push its own at any time. The clock restarts when a new credit at least as large arrives, which stops a 1-wei credit from being planted early to start it. Disclosed costs: a recipient that cannot make calls (an exchange deposit address) is paid 30 days late, and a smaller second credit joins the older clock.

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract and not otherwise described on the site, so this report is the disclosure. An heir who might be blocklisted by a token that checks senders should name a fresh payout address when starting the claim. Circle's USDC checks both sides of a transfer, so a push into a blocklisted address reverts instead.

---

<a id="f09"></a>

### F09 · Low · A payout sent to the WETH contract comes back as surplus the admin can sweep

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** A credit owed to a wrapped-native contract (WETH9/WBNB) becomes vault-owned WETH after a push, and the admin can then sweep it

**In plain words.** If an heir or owner names the wrapped-ETH (WETH) contract as the payout address, the credit can never be pulled, because WETH cannot call the vault. But anyone can push it. WETH then wraps the ETH for the sender, which is the vault, so the vault ends up holding WETH that no vault owns. The admin's surplus sweep can take it.

**Impact.** The user loses what the mistake already cost, but value that was owed to a user becomes reachable by the admin, contrary to the published guarantee.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:639-640` `initiateClaim` (recipient checked only against zero and the vault); `:552-554` `withdraw`; `:726-733` `pushCredit`; `:358-366` `_payout`; `:768-780` surplus and sweep.

**Evidence.** [`poc/F09.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F09.ts): 3 tests; on v1, 3 fail and 0 pass. The admin swept 9.95 of an heir's credit, 4 of an owner's withdrawal, or all of it with no accomplice.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** Payouts to the vault itself, to the wrapped-native token, to any listed token, to Base's system-contract range (`0x4200…0000` to `0x4200…07FF`), and to the four ERC-4337 EntryPoints (review round 4) are refused on every payout path, for the claim recipient, the fee recipient and the sweep target. A native payout to an address with code is measured, and reverts if the value comes back in any asset the admin could sweep. Review rounds 1 and 2 widened the fix after finding wrap-and-return and SELFDESTRUCT variants, and a payout to Base's L2-to-L1 message passer, which would start a withdrawal to the vault's own address on Ethereum, where only code deployed at that address could collect it, and only the key that deployed the vault could deploy code there.

**In the app and documentation:** The app refuses the wrapped-native contract, the listed tokens, the vault itself, Base's system-contract range (which includes the message passer), the four ERC-4337 EntryPoints and, on BNB Chain, the Venus vBNB market as a payout address or heir: each would keep a payment or book it to the vault. It asks for an explicit confirmation for a payout address that has code, and warns when an heir's address has code.

**Residual risk on the live contract.** The live contract accepts these addresses; only the app refuses them, and no list can name every contract that keeps or re-books what it is sent. Use a wallet you control as the payout address.

---

<a id="f10"></a>

### F10 · Low · Tokens that take more than they pay leave the last withdrawer short

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Tokens that debit the vault by more than the recorded amount (fee on top, issuer wipe, negative rebase) make the shared pool insolvent, and the whole loss falls on whoever withdraws last

**In plain words.** The live contract measures what arrives on a deposit but assumes a payout lowers its balance by exactly the amount paid. Some tokens take more (a fee charged on top), some issuers can wipe balances, and some tokens shrink balances. All vaults in one token share one balance, so the shortfall lands on whoever withdraws last, who may get nothing.

**Impact.** Value moves between unrelated vaults in the same token. Other tokens and ETH are unaffected.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:358-366` `_payout` (no measurement); `:714-733` payouts; `:774-780` `sweepSurplus`; `:345-356` `_pull` (measures deposits only).

**Evidence.** [`poc/F10.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F10.ts): 5 tests; on v1, 4 fail and 1 pass. One exit left 99 for the next owner's 100; a sweep dipped into locked funds; an unrelated heir got nothing; a later depositor funded the shortfall. The calibration test passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** Every token payout and sweep must lower the vault's balance by exactly the amount paid: more reverts `PayoutOverdebited`, less reverts `PayoutShortfall` (added in the fourth pass, for a token that reports success but moves nothing), and the credit is kept. The allowlist keeps such tokens out.

**In the app and documentation:** [How it works](https://willandkey.com/how-it-works#tokens) lists these token types as unsupported, and the app steers users to known tokens.

**Residual risk on the live contract.** Unchanged on the live contract for unsupported tokens. In v2 an issuer's wipe of a listed token still leaves that token's pool short, first come first served (disclosed in its NatSpec).

---

<a id="f11"></a>

### F11 · Low · Growth on rebasing or interest-bearing deposits goes to the admin, not the heir

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Yield on positive-rebase, reflection or aToken-style deposits accrues to surplus and is sweepable by the admin; the app and site accept such tokens without warning

**In plain words.** For tokens whose balance grows by itself (interest-bearing tokens such as Aave aTokens, rebasing tokens, reflection tokens), the growth is counted as surplus, which the admin may sweep. The heir inherits only the amount deposited. Only the contract's source comments said so; the app and site accepted such tokens without a warning.

**Impact.** Over a long horizon the admin could take all the growth (about 63% of the deposit over 10 years at 5% a year). The deposit itself is not reachable this way.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:768-780` surplus and sweep; NatSpec `:60-65`; `site/assets/app.js:355-375`; `site/index.html:75`, `:116`.

**Evidence.** [`poc/F11.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F11.ts): 3 tests; on v1, 3 fail and 0 pass. The admin swept the growth on a rebasing deposit (6,288.95 units) and on reflections (4,807.73 units).

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** Covered by the F01 allowlist: such tokens cannot be deposited.

**In the app and documentation:** The app's warning for unknown tokens names these types and says the growth is not inherited and can be swept by the admin. [How it works](https://willandkey.com/how-it-works#tokens) lists them as unsupported.

**Residual risk on the live contract.** Unchanged on the live contract. Do not deposit such tokens. See also the recommended sweep commitment.

---

<a id="f12"></a>

### F12 · Low · One token-issuer action can freeze every vault in that token

**Status:** Acknowledged · Mitigated in the app and documentation  
**Audit title:** Pooled custody: one issuer action against the single vault address freezes every user of that token, and the blocklist-routing feature invites it

**In plain words.** All vaults holding a token share one balance at the vault contract's address. If the token's issuer (Circle, for USDC) pauses, blocklists or wipes that address, every user of that token is frozen, and a wipe is permanent. The contract also lets an owner or heir who has been blocklisted route a payout to a clean address, which is the kind of use that could prompt an issuer to act against the whole contract.

**Impact.** A third party can freeze everyone's balance in its token. It depends on the issuer's discretion and is common across decentralised finance, but stablecoins are the most likely asset for an inheritance, so it needs to be disclosed.

**Affected code (v1, commit b8baf34).** Architecture: every vault's tokens are held at the one contract address; `contracts/InheritanceVault.sol:345-366` `_pull` and `_payout`; NatSpec `:67-72`.

**Evidence.** [`poc/F12.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F12.ts): 4 tests; on v1, 1 fail and 3 pass. Blocklisting the vault address, because of one owner's deposit, froze unrelated users' withdrawals and payouts. Three characterisation tests passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change, on purpose: shared custody is kept. Separate custody per owner would only make each target smaller; an issuer can freeze each one.

**In the app and documentation:** Token-issuer action is listed in the [failure modes](https://willandkey.com/how-it-works), on the security page and in the README's trust table: claims still settle on schedule, payouts wait until a freeze lifts, and a wipe is a permanent loss the contract cannot prevent.

**Residual risk on the live contract.** Inherent to holding tokens whose issuer has these powers, in v1 and v2. Prefer assets without them, or split an estate across assets.

---

<a id="f13"></a>

### F13 · Low · "Finalizable" is not "final": the owner can still cancel until someone finalizes

**Status:** Acknowledged · Mitigated in the app and documentation  
**Audit title:** The challenge window is not a veto deadline: the owner key can cancel a matured claim until finalizeClaim is mined, while the view, alerts and site call it closed, automatic and final

**In plain words.** After the challenge window, anyone can finalize a claim. But until a finalize transaction is actually mined, the owner's key can still cancel it. The app, the reminder emails and several pages described the end of the window as closed, automatic or final.

**Impact.** An heir told the payout was "automatic and final" might wait, and then lose the claim to a late veto, which costs them a new inactivity period plus a new window. Bounded: the owner's key outranks the heir by design.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:663-677` `abortClaim` (no window check); `:312-322` `_clearPending`; `:682-686` `finalizeClaim`; `:829` `getVault().finalizable`; `notify/watcher.js:161`, `:233`; `site/index.html:54`.

**Evidence.** [`poc/F13.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F13.ts): 11 tests; on v1, 11 fail and 0 pass. After the window closed, a veto, a heir change, a period change, a chain install, a 1-wei withdrawal, a horizon extension and a full withdrawal all still succeeded against the matured claim; a veto ordered ahead of the heir's finalize cost the heir 44 days.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change, on purpose: the late veto is kept, because the owner's key outranks the heir.

**In the app and documentation:** [How it works](https://willandkey.com/how-it-works) and the security page now say that finalizing is not automatic and that the owner's key can cancel until a finalize is mined, so heirs should finalize promptly. The app's claim review says the same, and the watcher's texts were corrected.

**Residual risk on the live contract.** The behaviour remains, by design. Heirs should finalize as soon as they can.

---

<a id="f14"></a>

### F14 · Low · Closing a vault during a claim emits no claim-ended event

**Status:** Fixed in v2 source  
**Audit title:** A full withdrawal during a pending claim ends the claim without ClaimSuperseded or any other claim-lifecycle event

**In plain words.** When an owner withdraws everything while a claim is pending, the vault closes and the claim ends. The live contract then emits only a Withdrawn event, not the claim event it emits when a claim ends any other way. Tools that follow claims through events keep showing a claim that no longer exists.

**Impact.** Misleads dashboards and integrators; an heir could be told to finalize a claim that will revert. No funds at risk.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:566-573` (the closing branch of `withdraw`); `:579`; compare `_clearPending` at `:312-322`.

**Evidence.** [`poc/F14.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F14.ts): 5 tests; on v1, 4 fail and 1 pass. A full withdrawal that ended a pending claim emitted only `Withdrawn`, so an event-based tracker kept a finalizable claim that reverted `NoClaimPending`. The control passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** A full withdrawal that ends a pending claim emits `ClaimSuperseded(owner, id, ACT_CLOSE)` first (a new tag, 6).

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract. Integrators must treat `Withdrawn` with `closed = true` as ending any pending claim, or read `getVault`.

---

<a id="f15"></a>

### F15 · Low · Batch check-in skips vaults silently and can overcount

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** checkInMany skips a claim-pending or horizon-reached vault with no event, the count is unreadable from a mined receipt, and duplicates inflate it (OQ-2 confirmed)

**In plain words.** `checkInMany` checks in several vaults at once. It skips a vault with a pending claim, or past its horizon, without leaving any trace in the transaction. The number of vaults it reports is not in the transaction receipt, and it counts a repeated vault twice.

**Impact.** An owner relying on a batch keeper could miss a live claim for the whole challenge window.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:481-498` `checkInMany` (`:490`, `:492` skip); `site/assets/app.js:337-340`.

**Evidence.** [`poc/F15.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F15.ts): 4 tests; on v1, 4 fail and 0 pass. Receipts mentioned only the vault that was checked in, and a repeated id was counted twice.

**Verification.** Initial rating Low; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** Every skipped vault gets a `CheckInSkipped(owner, vaultId, reason)` event, with reasons for an unknown id, a settled or closed vault, a pending claim (before or past the horizon), a passed horizon, a deadline already at the horizon, and a repeat. Only vaults whose deadline actually moved are counted, and a batch that moves nothing reverts with the reasons it met.

**In the app and documentation:** The app leaves such vaults out of "Check in on all vaults" and, after the transaction, compares the receipt with the vaults it sent and lists every vault that was not checked in, with the reason and the remedy.

**Residual risk on the live contract.** Unchanged on the live contract. Other keepers must compare the receipt's `CheckedIn` events with the vaults they sent, and watch for `ClaimInitiated` on their own address.

---

<a id="f16"></a>

### F16 · Informational · A chain check-in counts only if it is mined strictly before the deadline

**Status:** Acknowledged · Mitigated in the app and documentation  
**Audit title:** OQ-1 re-evaluated: the heir can permanently kill a keyless owner's chain recovery path whenever a chain check-in lands at or after the deadline; the 'unfixable without veto authority' rationale is overstated

**In plain words.** Once the deadline has passed, the heir's claim and a chain check-in are both valid, and whichever is ordered first wins, even within the same block. If the heir is first, the chain cannot stop the claim; only the owner's key can.

**Impact.** An owner without their key whose chain check-in lands a few seconds late loses the chain as a remedy for that claim, and the vault goes to the heir they chose.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:535-548` `checkInByChain` (`:537`); `:639-659` `initiateClaim` (`:644`); open question OQ-1 in `AUDIT-2026-08-09.md`.

**Evidence.** [`poc/F16.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F16.ts): 4 tests; on v1, 2 fail and 2 pass. A valid chain check-in in the same block as the heir's claim reverted, and the vault settled 23 months before its horizon. Two characterisation tests passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change, on purpose: letting a chain value cancel a claim would give the paper seed a veto.

**In the app and documentation:** The home page, [How it works](https://willandkey.com/how-it-works), the README and the generator say that a chain check-in counts only if mined strictly before the deadline; How it works, the README and the generator also say to submit at least a day early.

**Residual risk on the live contract.** Inherent to the design.

---

<a id="f17"></a>

### F17 · Low · Chain values are bearer credentials that can delay the heir up to the horizon

**Status:** Acknowledged · Mitigated in the app and documentation  
**Audit title:** Chain values are bearer credentials that can delay the heir up to the horizon: 'liveness only, never authority' is overstated, and a leaked but unmined preimage stays spendable indefinitely

**In plain words.** Anyone holding the paper seed, or any unused chain value, can keep checking in and postpone the heir's claim: by up to the number of values times the inactivity period, never past the horizon. The documents called the chain "liveness only, never authority". A value that was broadcast but never mined also stays usable.

**Impact.** If a seed leaks, the heir can be kept out until the horizon, possibly for decades.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:535-548`, NatSpec `:521-527`; `README.md:28-29`; `site/index.html:103-105`.

**Evidence.** [`poc/F17.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F17.ts): 3 tests; on v1, 2 fail and 1 pass. An unmined value pushed the deadline about 90 days past the owner's last real action, and someone other than the owner holding the seed kept the heir out. The quantifying test passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The contract's comments were corrected, and v2 adds a way to disarm a chain (F28).

**In the app and documentation:** "Liveness only, never authority" was replaced everywhere: chain values cannot withdraw, change the heir or veto, but whoever holds one can postpone the heir, so guard the seed like a key and size the number of values to the time you actually need.

**Residual risk on the live contract.** Inherent to any check-in that works without the key. On the live contract a chain cannot be disarmed; replace it with a new random anchor instead.

---

<a id="f18"></a>

### F18 · Low · In the last period before the horizon, check-ins succeed but extend nothing

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** In the last inactivity period before the horizon, check-ins succeed but extend nothing, and each chain check-in still uses up a link

**In plain words.** A check-in can never push the deadline past the horizon. Once the deadline sits at the horizon, the live contract still accepts check-ins, reports them as successful, and a chain check-in still uses up a value, although nothing moves. Nothing warns the owner.

**Impact.** An owner may keep checking in, see success, and be surprised when the heir claims at the horizon, when only extending the horizon or withdrawing everything stops a claim.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:287-291` `_resetClock`; `:458-468` `checkIn`; `:481-498` `checkInMany`; `:535-548` `checkInByChain`; `:800-807` `warningsOf`; `:388` `createVault`.

**Evidence.** [`poc/F18.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F18.ts): 7 tests; on v1, 7 fail and 0 pass. In the final period, all three check-in paths succeeded and were counted while the deadline could not move; a chain value was spent and no warning appeared.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `checkIn` and `checkInByChain` revert `DeadlinePinnedAtHorizon` when the deadline cannot move, and no chain value is spent; batch check-ins skip such vaults; a new warning bit (4) marks the state.

**In the app and documentation:** The app warns when a check-in leaves the deadline at the horizon and tells the owner to extend the horizon; the documents say check-ins cannot extend past the horizon.

**Residual risk on the live contract.** Unchanged on the live contract. Extend the horizon before its last inactivity period begins.

---

<a id="f19"></a>

### F19 · Low · Past the horizon the app offered Veto and Change heir, which always fail

**Status:** Mitigated in the app and documentation  
**Audit title:** Past the horizon the app still offers 'Veto claim' (and 'Change heir'), which always revert, and never points the owner to the only remaining veto

**In plain words.** Past the horizon the live contract refuses the ordinary veto. The app still showed "Veto claim" and "Change heir", never named the two remedies that still work, and its date prompt accepted dates below the contract's minimum.

**Impact.** A living owner trying to stop a claim past the horizon could hit one failure after another until the window ran out.

**Affected code (v1, commit b8baf34).** `site/assets/app.js:300-302`, `:200-202`, `:187`, `:233-242`; `contracts/InheritanceVault.sol:670`, `:314`, `:611-631`.

**Evidence.** [`poc/F19.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F19.ts): 5 tests; on v1, 4 fail and 1 pass. Past the horizon the app's Veto and Change heir reverted `HorizonReached`, it never stated the minimum horizon, and it submitted a horizon below the contract's floor; the vault settled although the owner objected. The contract ground-truth test passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change, on purpose: allowing a plain veto past the horizon would bring back an endless veto loop that an earlier review fixed (A-02, B-01).

**In the app and documentation:** Past the horizon the owner's card no longer offers Check in or Veto. With a claim pending it offers "Stop this claim: extend horizon", pre-filled with the earliest date that works, and "Withdraw everything". On an active vault it leads with "Extend horizon" and offers the heir change only as "Change heir without extending", with a warning ([F43](#f43)). Dates are checked against the contract's minimum, and contract errors are translated into plain guidance.

**Residual risk on the live contract.** None known in the app (checked in a browser review against a local copy of v1, not by the proof of concept; see [Limitations](#limitations)). Other interfaces must use `extendHorizon` (to at least now plus the inactivity period) or a full withdrawal.

---

<a id="f20"></a>

### F20 · Low · An heir cannot correct a mistyped payout address once a claim has started

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** The heir cannot cancel or correct their own pending claim, so a mistyped payout address is irreversible once the owner is gone

**In plain words.** The live contract fixes the payout address when the heir starts a claim, and only the owner can end a pending claim. If the owner is gone and the heir mistyped the address, nobody can correct it, and after settlement anyone can push the funds to that address.

**Impact.** One typo in the only transaction an heir ever sends can lose the whole estate.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:639-659` `initiateClaim`; (no function lets the heir cancel); `:726-733` `pushCredit`; `site/assets/app.js:245`.

**Evidence.** [`poc/F20.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F20.ts): 4 tests; on v1, 3 fail and 1 pass. The heir could not re-point a claim from a mistyped address (it stayed `0x…dEaD`); a third party pushed 9.95 ETH to it, or a recipient contract without `receive()` froze it. The control passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `beneficiaryCancelClaim(owner, vaultId)` lets the heir withdraw their own pending claim and start again with a new address and a new window. The fix reviews found and disclosed its costs: until finalization a stolen heir key could redirect the payout (at the price of a new window the owner can veto); after a cancel, a chain relayer can check in and push the heir back a full period, and past the horizon the owner may name a new heir; a hostile heir can make one veto attempt fail by cancelling and re-filing around it. Two alternatives, a cancel limited to a grace period or an atomic change of payout address, await the maintainer's decision (recorded in [CHANGELOG-v2.md](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/CHANGELOG-v2.md)). Review round 5 (recorded, not fixed) found one more limit: anyone may finalize from `finalizableAt`, so the last safe moment to correct a recipient is `finalizableAt`, not ‘until finalization’ as v2's comment says.

**In the app and documentation:** The app pays to the heir's connected wallet by default. Any other address must be typed twice; token and wrapped-native contracts are refused; a contract address needs an extra confirmation; and the heir must confirm that the address cannot be changed once the claim starts.

**Residual risk on the live contract.** No correction is possible on the live contract. Check the payout address before signing, or use the connected wallet.

---

<a id="f21"></a>

### F21 · Informational · The "guaranteed inheritance date" label over-promised

**Status:** Mitigated in the app and documentation  
**Audit title:** 'Guaranteed inheritance date' and trust-model T3 over-promise: the label points at the horizon, not the finalization date; the owner key can still defeat it; and one override can cost only 7 days and move the horizon 100 years

**In plain words.** The create form called the horizon the "guaranteed inheritance date". In fact the heir can finalize no earlier than the horizon plus the challenge window, only if they start a claim, and a living owner can still stop it by extending the horizon or withdrawing everything. The contract's comment (T3) also overstated how hard the date is to move: it left out the full withdrawal, and it priced an extension at a full inactivity period, although the owner can first cut the period to 7 days.

**Impact.** A planning error for owners and heirs; nothing can be stolen through it.

**Affected code (v1, commit b8baf34).** `site/app.html:81`; `site/assets/app.js:285`, `:187`; `contracts/InheritanceVault.sol:34-41` (T3), `:821`, `:596-604`, `:611-631`.

**Evidence.** [`poc/F21.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F21.ts): 6 tests; on v1, 2 fail and 4 pass. `getVault` reported a guaranteed date that had passed while the heir still could not finalize, and past the horizon a cheap override cost the heir 7 days instead of the vault's 365-day period.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No behaviour change, and v2's T3 comment still overstates how hard the date is to move: it names `extendHorizon` as the only way past the date, although a full withdrawal also ends a claim; it prices each override at "one full inactivity period", although the owner can first cut the period to 7 days; and it says nothing can move the date "without bound", although one call can move the horizon up to 100 years ahead. The README and [How it works](https://willandkey.com/how-it-works#horizon) describe the horizon without these overstatements.

**In the app and documentation:** The field is now labelled "Horizon (UTC date) - the long-stop after which check-ins stop working", with a note that it is not a payout date. Cards show the long-stop and, during a claim, the real finalizable date. [How it works](https://willandkey.com/how-it-works#horizon) explains the difference.

**Residual risk on the live contract.** None known in our interfaces (checked in a browser review against a local copy of v1, not by the proof of concept; see [Limitations](#limitations)). On the live contract, `getVault` still names the field `guaranteedInheritanceAt`, and the comment behind it cannot change.

---

<a id="f22"></a>

### F22 · Low · A 1-wei top-up can stop an owner from closing a vault

**Status:** Fixed in v2 source  
**Audit title:** A third party can front-run an owner's exact-balance 'close' with a 1-wei topUp and keep the vault open

**In plain words.** The live contract has no "withdraw everything" option. An owner closes a vault by withdrawing its exact balance. Anyone can top up an active vault, so a griefer can add 1 wei just before, and the vault stays open.

**Impact.** Minor griefing; nothing is lost, but the owner must try again.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:441-454` `topUp`; `:552-580` `withdraw`; `site/assets/app.js:215-224`.

**Evidence.** [`poc/F22.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F22.ts): 2 tests; on v1, 1 fail and 1 pass. A 1-wei front-run top-up left the vault active after the owner's exact-balance close. The damage test passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `withdraw(id, type(uint256).max, to)` withdraws the whole balance at the moment it is mined and closes the vault.

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract. The app's "Withdraw everything" re-reads the balance before signing but cannot stop a front-run. If the vault still shows after a close, withdraw again.

---

<a id="f23"></a>

### F23 · Low · The retired reminder contract still sold reminder time

**Status:** Resolved by an admin transaction · Mitigated in the app and documentation  
**Audit title:** Retired NotifySubscription still sells reminder time on-chain for a service that no longer runs, and the docs wrongly say it cannot be switched off (setPrice(type(uint256).max) is a working kill switch)

**In plain words.** The paid reminder service was retired, but its billing contract still accepted payments that bought nothing. The documents said it could not be switched off. It could: setting its price to the maximum makes every payment revert.

**Impact.** Anyone paying it would have lost the payment. None did: a scan of its logs from its deployment (block 49,728,662, 9 August 2026), run on 24 September 2026, found no payment, and we repeated the scan from there to block 51,831,415 on 27 September 2026, which found only the price change below.

**Affected code (v1, commit b8baf34).** `contracts/NotifySubscription.sol:60-76` `subscribe` (`:64-65` reverts `ZeroAmount`); `:84-88` `setPrice`; `site/security.html:39`; `README.md:85-86`; `AUDIT_SCOPE.md:87-89`.

**Evidence.** [`poc/F23.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F23.ts): 4 tests; on v1, 2 fail and 2 pass. In the recorded run, on a read-only fork of Base, the live contract accepted a 0.012 ETH payment; the local kill-switch test and the fork check of `setPrice(max)` passed. After the admin transaction below we ran the file again, on 27 September 2026: all 4 tests pass.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The deploy script no longer deploys this contract (F31).

**On chain and on the site:** Resolved by an admin transaction on 26 September 2026: the Ledger admin called `setPrice(type(uint256).max)`, transaction [0xf3485b1b…3a56cca](https://basescan.org/tx/0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca) in Base block 51,823,544. We re-checked on 27 September 2026 with read-only calls: the price reads 2^256 − 1 and a 1-wei payment reverts with `ZeroAmount` (selector `0x1f2a2005`). The documents now say sales are disabled on chain and only the admin could reverse it.

**Residual risk on the live contract.** The admin key could lower the price again; we recommend a public commitment not to. Never send funds to this contract.

---

<a id="f24"></a>

### F24 · Informational · The site overstated the earlier internal review

**Status:** Mitigated in the app and documentation  
**Audit title:** The index FAQ overstates the internal review: 'five independent passes' and 'twelve defects' do not match the report it cites

**In plain words.** The home page described the August 2026 review as "five independent passes" that found "twelve defects". It was run by the same system that wrote the code, so it was not independent, and its itemised list has ten on-chain defects (3 high, 3 medium, 4 low). The report's own headline did not match its list either.

**Impact.** Users were given more assurance than existed, on the page they use to decide whether to trust the contract.

**Affected code (v1, commit b8baf34).** `site/index.html:176-185`; `AUDIT-2026-08-09.md:11-12`.

**Evidence.** [`poc/F24.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F24.ts): 4 tests; on v1, 4 fail and 0 pass. The report's headline tallies and the FAQ's counts did not match the itemised findings, and the FAQ called the review independent.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** The FAQ and [the report's headline](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/AUDIT-2026-08-09.md) now match the itemised list and say the review was not independent; the report carries a dated correction note.

**Residual risk on the live contract.** None.

---

<a id="f25"></a>

### F25 · Informational · The locked claim fee cannot be seen, and the app showed the ceiling as the fee

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Views hide the effective (locked) claim fee, the app labels the ceiling as 'fee', and getVault returns stale timing fields for closed or settled vaults

**In plain words.** The live contract stores the fee rate locked when a claim starts, but no view or event shows it. The app showed the creation ceiling as the "fee". Views also report timing fields for closed or settled vaults as if they were still running.

**Impact.** Heirs cannot verify the rate they will pay, and dashboards may misread closed vaults. No direct loss.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:142` `lockedFeeBps` (private); `:147-170` `VaultView`; `:212`, `:658` `ClaimInitiated`; `:809-833` `getVault`; `site/assets/app.js:278-287`.

**Evidence.** [`poc/F25.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F25.ts): 6 tests; on v1, 6 fail and 0 pass. No view or event carried the locked fee (the view overstated the fee taken, 0.05 against 0.02 ETH), and closed and settled vaults still reported `expired == true`.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `getVault` returns `lockedFeeBps` while a claim is pending (zero otherwise), and `ClaimInitiated` carries it. Warning bit 7 remains the authoritative sign of a finished vault.

**In the app and documentation:** The app shows the ceiling (fixed at creation), the current rate and the effective rate separately, and during a claim says the locked rate cannot be read on this contract.

**Residual risk on the live contract.** On the live contract the locked rate is still unreadable; the app explains the rule instead.

---

<a id="f26"></a>

### F26 · Informational · Payout events can be mistaken for transfers when they record only credits

**Status:** Fixed in v2 source  
**Audit title:** Value-movement events mislead integrators: Withdrawn and ClaimSettled record credits rather than transfers; CreditPaid is emitted before the transfer and reports the amount sent

**In plain words.** `Withdrawn` and `ClaimSettled` record a credit, not a transfer; value leaves the contract only when `CreditPaid` is emitted. The live contract emits `CreditPaid` just before the transfer and reports the gross amount sent.

**Impact.** Off-chain accounting and alerts can drift from what really happened. No funds at risk.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:579` `Withdrawn`; `:709` `ClaimSettled`; `:720`, `:731` `CreditPaid`.

**Evidence.** [`poc/F26.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F26.ts): 7 tests; on v1, 5 fail and 2 pass. `Withdrawn` and `ClaimSettled` named payees that had received nothing yet, and `CreditPaid` reported 99 where the payee received 98.01 of a fee-on-transfer token. The two boundary tests passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `CreditPaid` and `SurplusSwept` are emitted after their transfers, and every value event's comment says whether it records a deposit, a credit or a transfer out.

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract. Integrators should treat only `CreditPaid` as value leaving the contract, and read the token's own Transfer event for the net amount.

---

<a id="f27"></a>

### F27 · Informational · Events leave out the new deadline and the removed heir

**Status:** Fixed in v2 source  
**Audit title:** Event schema gaps: clock resets without the new deadline, VaultCreated without inactivityPeriod, and the removed heir not indexed

**In plain words.** Several owner actions reset the deadline without saying the new deadline in their event, `VaultCreated` leaves out the inactivity period, and a removed heir cannot find their removal by searching the logs for their own address.

**Impact.** Event-based tools must recompute the deadline or poll. No funds at risk.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:192-211` (event declarations); deadline resets at `:564`, `:591`, `:601`, `:628`, `:512`.

**Evidence.** [`poc/F27.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F27.ts): 11 tests; on v1, 9 fail and 2 pass. An indexer that used only events was 20 days early, and an heir acting on it got `NotYetExpired`. The two controls passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** A `DeadlineReset(owner, vaultId, newDeadline, absoluteDeadline)` event is emitted by the one function that writes the deadline; `VaultCreated` gains the inactivity period; `BeneficiaryChanged` indexes both the old and the new heir. Several event signatures change as a result, so v1 and v2 tools are not interchangeable.

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract: `getVault` is the source of truth for deadlines, and a shorter inactivity period can move a deadline earlier.

---

<a id="f28"></a>

### F28 · Informational · The paper check-in chain was advertised but unspecified and unsupported

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** The lost-wallet check-in chain is advertised but unspecified and unsupported: no generator or app UI, count is unverified, a zero value hides the chain, the raw seed is published on the last step, a chain cannot be disarmed, and the NatSpec is wrong

**In plain words.** The site and README advertised "lost wallet insurance" through a paper seed, but no tool, specification or app screen existed to set one up. On the live contract, the declared number of values is not checked, a zero value can hide an armed chain, the last step can reveal the raw seed, a chain cannot be switched off, and a source comment was wrong.

**Impact.** Owners could believe a recovery path was armed when it was not.

**Affected code (v1, commit b8baf34).** `README.md:28-29`; `site/index.html:103-105`; `notify/watcher.js:166-169`; `contracts/InheritanceVault.sol:503`, `:522-523`, `:541`, `:544-545`, `:806`.

**Evidence.** [`poc/F28.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F28.ts): 5 tests; on v1, 5 fail and 0 pass. A used-up chain raised no warning, an overstated count hid exhaustion, and a chain could not be disarmed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** `setCheckInChain(id, 0, 0)` disarms a chain (past the horizon it reverts, so it cannot act as a veto), a zero value is refused, and installations carry an epoch (F02).

**In the app and documentation:** A specification and a reference generator are published (see F02). The site labels the feature "advanced, no app support", and the watcher's text no longer points to an app screen that does not exist.

**Residual risk on the live contract.** On the live contract the declared count still cannot be verified; build chains with the generator. To switch one off, install a new random anchor whose values nobody knows.

---

<a id="f29"></a>

### F29 · Informational · Public documents did not match the code or the live state

**Status:** Mitigated in the app and documentation  
**Audit title:** Public documentation does not match the code or live state: stale admin status, single-key admin, incomplete admin-power lists, 'exactly two addresses', T1/T2 wording, 'any ERC-20', BNB 'supported', and a stale code comment

**In plain words.** Several statements were stale or too strong: that administration had not been handed over (it was, to a single Ledger key, on 24 September 2026); admin-power lists without the fee functions; "exactly two addresses" move funds; "cannot touch a wei"; "cannot raise your fee"; "any ERC-20"; "BNB Chain supported" (nothing is deployed there); and several source comments.

**Impact.** Users and reviewers were misled about the admin's powers and the guarantees. No direct fund impact.

**Affected code (v1, commit b8baf34).** `site/security.html:57`; `site/index.html:75`, `:116-117`, `:159-162`; `README.md:9`, `:41`; `SECURITY.md:12`; `contracts/InheritanceVault.sol:25-26`, `:29-32`, `:42-46`, `:294`, `:506-508`.

**Evidence.** [`poc/F29.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F29.ts): 9 tests; on v1, 7 fail and 1 pass, 1 skipped. Seven mismatches between the documents and the code or chain were found; the control passed, and an opt-in live check was skipped.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** T4 was rewritten to limit the admin guarantee to the native coin and the supported tokens. These comments still carry the audited wording in v2: T1 ("veto any claim"; past the horizon only extending it or withdrawing everything stops a claim); T2 (a lost heir key leaves the funds "stuck until the horizon"; they are stuck permanently); the `_clearPending` comment ("Any owner action supersedes a running claim"; a check-in, a batch check-in or a top-up does not); the `setCheckInChain` comment (installing a chain past the horizon "would take a fee"; the contract charges no fee there).

**In the app and documentation:** The site, README, SECURITY.md and AUDIT_SCOPE.md describe the admin as one Ledger key since 24 September 2026, with the five handover transactions, list every admin function, limit the guarantees to ETH and supported single-address tokens, and call BNB Chain "planned, not deployed".

**Residual risk on the live contract.** The live contract's source comments, shown on Basescan, cannot change and still carry the old wording. The site and this report replace them.

---

<a id="f30"></a>

### F30 · Informational · Published "SHA-256" fingerprints were keccak-256

**Status:** Mitigated in the app and documentation  
**Audit title:** Published 'SHA-256' bytecode fingerprints are actually keccak-256 code hashes (EXTCODEHASH)

**In plain words.** The two bytecode fingerprints on the security page and in AUDIT_SCOPE.md were labelled SHA-256, but they were keccak-256 hashes (what `EXTCODEHASH` returns). The values were right and the label was wrong. The claim that the deployed code matches the source is true.

**Impact.** Someone checking with `sha256sum` would see a mismatch and could wrongly conclude the deployment differs from the source.

**Affected code (v1, commit b8baf34).** `site/security.html:46-47`; `AUDIT_SCOPE.md:12-15`.

**Evidence.** [`poc/F30.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F30.ts): 5 tests; on v1, 1 fail and 4 pass. The published values were keccak-256 of the runtime bytecode, not SHA-256. The sanity, diagnostic, snapshot and live checks passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** The labels were corrected and the true SHA-256 values of the raw bytes were added, with the commands to reproduce both (see [Scope](#scope)).

**Residual risk on the live contract.** None.

---

<a id="f31"></a>

### F31 · Informational · Deploy tooling for a BNB launch would have repeated old mistakes

**Status:** Fixed in v2 source · Mitigated in the app and documentation  
**Audit title:** Deploy tooling for the planned BNB launch would redeploy the retired billing contract and default admin and fees to the hot deployer key; repo docs still treat the reminder product as live

**In plain words.** The deploy script would have deployed the retired billing contract again on BNB Chain, and made the deploying computer's key the admin and fee recipient unless told otherwise. The admin-transfer script could not run without the billing contract, and some documents still treated paid reminders as live.

**Impact.** Operational: a new contract that takes payments for nothing, and a period in which an online key holds admin power.

**Affected code (v1, commit b8baf34).** `scripts/deploy.ts:18`, `:39-45`, `:67-73`, `:122-124`; `scripts/transfer-admin.ts:35`, `:56`, `:80-82`; `notify/README.md:4`, `:55-59`; `notify/watcher.js:406-413`.

**Evidence.** [`poc/F31.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F31.ts): 5 tests; on v1, 5 fail and 0 pass. A rehearsed BNB deploy, running the real scripts on a local chain, made the deploying key the admin and fee recipient, deployed the billing contract (which then accepted 0.001), and `transfer-admin.ts` could not even dry-run.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The deploy script deploys only the vault. On a mainnet it requires an explicit admin and fee recipient and refuses the deploying key for either; it checks the per-chain token lists (proposals, to be confirmed before use) and reads the result back; it never overwrites a deployment record. `transfer-admin.ts` works without a billing contract. The changelog records this PoC passing 5 of 5 after the change.

**In the app and documentation:** `notify/README.md` is marked retired and says the billing contract must not be paid.

**Residual risk on the live contract.** The token lists are permanent once v2 is deployed, so they must be confirmed first.

---

<a id="f32"></a>

### F32 · Informational · The creation pause does not stop top-ups

**Status:** Acknowledged · Mitigated in the app and documentation · By design  
**Audit title:** setCreationPaused is not an emergency stop: top-ups keep adding new value to a paused contract

**In plain words.** The admin's pause blocks only new vault creation. Top-ups, check-ins, withdrawals, claims and payouts keep working, so during a migration new money can still enter existing vaults.

**Impact.** None directly. In an incident, deposits into existing vaults cannot be stopped on chain.

**Why it is by design.** The narrow pause is deliberate: it means the admin can never block an exit or a deposit into an existing vault, and the site already described it as pausing only new vaults. The severity skeptic refuted it as a defect, because nobody gains and nobody loses: whoever tops up exposes only their own new money to risks the vault already carries.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:378` (the only pause check); `:441-454` `topUp`; `:756-759` `setCreationPaused`.

**Evidence.** [`poc/F32.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F32.ts): 3 tests; on v1, 2 fail and 1 pass. The auditor's proposed property (a paused contract refuses top-ups) fails; the guard test showing every exit stays open passes.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic refuted it as a defect: by design and disclosed. Final severity: Informational. Status: by design. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change.

**In the app and documentation:** The security page and [How it works](https://willandkey.com/how-it-works) state the pause's exact scope and that a migration would ask owners to withdraw in full, which closes the vault.

**Residual risk on the live contract.** As designed.

---

<a id="f33"></a>

### F33 · Informational · Views can show half-updated values while a deposit is in progress

**Status:** Fixed in v2 source  
**Audit title:** Read-only reentrancy: surplus() and getVault() report inconsistent values while a deposit is in flight, with no view guard

**In plain words.** During a deposit the live contract calls the token before updating its books. If the token runs other code at that moment, anything reading the vault's views then sees the incoming deposit counted as surplus.

**Impact.** Can mislead third-party dashboards or contracts that read the views from inside such a call. No funds lost: the admin's sweep cannot run at that moment.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:345-356` `_pull`; `:768-772` `surplus`; `:809-833` `getVault`.

**Evidence.** [`poc/F33.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F33.ts): 4 tests; on v1, 3 fail and 1 pass. `surplus()` reported the whole in-flight amount (1,000, 50 or 400) as surplus during a deposit, top-up or payout. The bounding test passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The views `surplus`, `getVault`, `getOpenVaults`, `creditOf`, `totalLocked` and `totalCredited` refuse to answer while one of the vault's own transactions is still running. Disclosed cost: a native payout cannot be pushed to a contract whose receive function reads one of these views.

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract: read its views only outside its own transactions. Tokens with transfer hooks are unsupported.

---

<a id="f34"></a>

### F34 · Informational · The retired billing contract's owner could reprice a payment in flight

**Status:** Acknowledged · By design  
**Audit title:** NotifySubscription: the owner can reprice a purchase already in flight; the slippage floor is opt-in and naturally 0 from a block explorer

**In plain words.** The billing contract's price changes immediately, so a payer who set no minimum got whatever the price was when their payment was mined.

**Impact.** None while sales stay disabled.

**Why it is by design.** The contract's own comments describe this, its tests assert it, a payer can set a minimum, and the operator who could reprice is the same party that receives the payment. The service is retired, and since F23's admin transaction every payment reverts, so the point is moot.

**Affected code (v1, commit b8baf34).** `contracts/NotifySubscription.sol:84-88` `setPrice`; `:60-66` `subscribe`.

**Evidence.** [`poc/F34.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F34.ts): 2 tests; on v1, 2 fail and 0 pass. An owner's price change ordered ahead of a payment turned a 12-month purchase into 311,040 seconds, or 1 second. The file records the behaviour.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic refuted it as a defect: by design and disclosed. Final severity: Informational. Status: by design. The proof of concept reproduced it.

**What was changed.** Nothing: acknowledged.

**Residual risk on the live contract.** None while the price stays at the maximum.

---

<a id="f35"></a>

### F35 · Informational · A 1-second gift can make an exact-cap reminder purchase fail

**Status:** Acknowledged  
**Audit title:** NotifySubscription: anyone can make a purchase that lands exactly on the 10-year cap revert by first gifting one second

**In plain words.** The billing contract caps prepaid time at 10 years, and anyone may gift time to anyone. So a griefer can make a purchase that lands exactly on the cap revert by gifting one second first.

**Impact.** The victim loses only gas.

**Affected code (v1, commit b8baf34).** `contracts/NotifySubscription.sol:68-72`.

**Evidence.** [`poc/F35.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F35.ts): 4 tests; on v1, 1 fail and 3 pass. A 1-second gift made an exact-cap purchase revert `TooFarAhead`. Three characterisation tests passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** Nothing: acknowledged.

**Residual risk on the live contract.** None: the contract is retired and every payment now reverts (F23).

---

<a id="f36"></a>

### F36 · Low · Anyone can name any address as heir of a vault holding a fake token

**Status:** Mitigated in the app and documentation  
**Audit title:** Anyone can name any address as beneficiary of a vault holding an arbitrary token, creating a spam and phishing surface for beneficiary-indexed discovery

**In plain words.** Creating a vault needs no consent from the heir, and the live contract accepts any token. A spammer can create vaults naming you as heir that hold a fake token called "USDC".

**Impact.** Phishing and confusion for heirs ("you have inherited 1,000,000 USDC, click here"). Nothing can be taken on chain.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:370-435` `createVault`; `:192-202` `VaultCreated` (heir indexed); `site/assets/app.js:79-86`.

**Evidence.** [`poc/F36.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F36.ts): 2 tests; on v1, 1 fail and 1 pass. The heir's card for a vault in a look-alike "USDC" looked identical to the real token's: no token address and no warning. The quantifying test passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The allowlist stops vaults in fake tokens; anyone can still name any heir.

**In the app and documentation:** The app shows every token with its full address and an explorer link, marks tokens that are not on its known list as unverified, and never shows such a token by its bare symbol. The heir FAQ says to trust only a vault whose owner address you recognise.

**Residual risk on the live contract.** Anyone can still create a vault naming you, on the live contract with any token.

---

<a id="f37"></a>

### F37 · Low · A veto depends on the network including it in time

**Status:** Mitigated in the app and documentation  
**Audit title:** Chain-specific environment notes: veto inclusion depends on the Base sequencer and BNB validators, and the watcher's paging is sized for Base

**In plain words.** A veto counts only once it is in a block. On Base, if the sequencer is down or ignores a transaction, it can still be forced in through Ethereum, but that can take up to about 12 hours. On BNB Chain, inclusion depends on its validators. Separately, the retired watcher's log scanning was sized for Base's public endpoint and never checked elsewhere.

**Impact.** A veto near the end of a short window could miss. Unlikely with the 7-day minimum window.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:101` `MIN_CHALLENGE`; `notify/watcher.js` (log page size and first-run lookback).

**Evidence.** [`poc/F37.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F37.ts): 3 tests; on v1, 2 fail and 1 pass. Under the log limits measured on Base's public endpoint (2,000 blocks) and a BNB endpoint (refused), the watcher never told the owner that an estate had settled during an outage. The uncapped control passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No contract change is possible: this is a property of the chains.

**In the app and documentation:** [How it works](https://willandkey.com/how-it-works#veto), the security page and the watcher's text explain forced inclusion and recommend challenge windows of at least 14 days; the app warns about shorter windows. AUDIT_SCOPE.md and `notify/README.md` require the watcher's log paging to be re-checked on each chain before any restart. The watcher's code was not changed for this.

**Residual risk on the live contract.** Inherent. Do not leave a veto to the last day.

---

<a id="f38"></a>

### F38 · Informational · Tests missed hostile tokens and the billing contract's boundaries

**Status:** Fixed in v2 source  
**Audit title:** Test coverage gaps: one fee-on-transfer and one hook token only, no hostile-token classes, and weak NotifySubscription boundary tests with a comment wrong by 1000x

**In plain words.** The shipped tests used one fee-on-transfer token and one hook token, and the billing contract's boundary tests were loose (one comment was wrong by a factor of 1,000). Seven deliberately broken versions of the billing contract, and two of the vault, still passed the shipped tests.

**Impact.** A future change could break something without any test noticing. No effect on the deployed contract.

**Affected code (v1, commit b8baf34).** `contracts/test/TestHelpers.sol`; `test/InheritanceVault.ts:89-99`; `test/Audit.ts:37-80`; `test/NotifySubscription.ts:52-56`.

**Evidence.** [`poc/F38.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F38.ts): 25 tests; on v1, 9 fail and 16 pass. Seven billing-contract mutants survived the shipped suite and the cost comment was 1,000× off; the proposed suites killed all nine mutants. The audit sandbox recorded 10 failing and 15 passing; the one difference comes from F39's timing problem on the recording machine and is explained in [RESULTS-v1.md](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/RESULTS-v1.md).

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The v2 tests add a hostile-token matrix (rebasing, hook, double-entry, fee-on-transfer, fee-on-top, false-return, no-return-value and pausable, two kinds of blocklist, transfer cap), checking after each step that the vault still holds what it owes; exact boundary tests for the billing contract; and the corrected comment. The fix-review rounds ran mutation checks: 22, 14 and 27 mutants, all killed.

**Residual risk on the live contract.** The repository still has no fuzz or invariant tests (the randomized accounting test cited under the sound properties was an auditor's scratch test, not part of the suite) and no mutation-testing gate in continuous integration (recommended below).

---

<a id="f39"></a>

### F39 · Informational · One regression test depended on the computer's clock

**Status:** Fixed in v2 source  
**Audit title:** The A-05 regression test depends on wall-clock time, so the published '63 passing' baseline is not reliably reproducible

**In plain words.** The A-05 test assumed each block comes exactly one second after the previous one. On a slow or busy machine it fails, so the published "63 passing" result was not reliably reproducible.

**Impact.** A spurious failure for anyone re-running the tests. No effect on the contract.

**Affected code (v1, commit b8baf34).** `test/Audit.ts:304-315`.

**Evidence.** [`poc/F39.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F39.ts): 22 tests; on v1, 3 fail and 19 pass. With each test slowed by 150 ms, the shipped A-05 test failed by 11 seconds; the next block after a fixture reload came 5 seconds later, not 1.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The test now fixes each block's timestamp and checks both sides of the boundary. The copy of the v1 tests kept in the evidence suite deliberately keeps the old test.

**Residual risk on the live contract.** Re-running the v1 test suite at the audited commit can still show 62 passing and 1 failing (A-05) on a loaded machine.

---

<a id="f40"></a>

### F40 · Informational · Nothing tells an owner that a claim has started

**Status:** Mitigated in the app and documentation · Disputed  
**Audit title:** The veto window only protects an owner who learns a claim is running, and nothing tells them any more: the watcher is retired and there is no other alert path, yet the site still sells the veto as the safeguard and still refers to reminders

**In plain words.** The veto window only protects an owner who notices a claim. A claim does not appear in the owner's wallet activity, the reminder service has been retired, and the app shows warnings only when it is opened. Some pages still referred to reminders.

**Impact.** An owner who does not open the app during the window loses the vault to the heir they named, which is the defined behaviour; the problem was the wording around it.

**The dispute and its resolution.** The finder rated this Medium: the site sold the veto as the safeguard for a forgetful or hospitalised owner while no alert of any kind was running.

The reachability skeptic refuted that rating: no page promised an alert, the app never collected an email address, the retirement notice covered new sign-ups, and losing the vault after the inactivity period plus the window is exactly the product's stated trigger. The owner can also lengthen the inactivity period at any time. The skeptic also noted that the PoC's list of promises, and its test for a disclosure, were chosen by the PoC's author. The severity skeptic proposed Low.

Resolution: the lead agent kept it as an Informational documentation finding. Pages did still mention reminders, and none said plainly that no alerts are sent.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:639-659` `initiateClaim` (the only trace is the `ClaimInitiated` event); `AUDIT_SCOPE.md:87-88`; `site/index.html:83-84`, `:151-156`; `site/guides/dead-mans-switch-crypto.html:98`, `:134`, `:177`; `site/guides/crypto-inheritance-planning.html:167`.

**Evidence.** [`poc/F40.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F40.ts): 4 tests; on v1, 2 fail and 2 pass. At the audited commit, and in the working tree at the time, pages referred to reminders and none disclosed that no alerts are sent. The two on-chain tests passed: the contract behaves as specified.

**Verification.** Initial rating Medium; the reachability skeptic refuted it and judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Informational. Status: disputed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** "Will & Key sends no alerts of any kind" now appears in the app's banner, in a required acknowledgement before creating a vault, on the home page, [How it works](https://willandkey.com/how-it-works), the security page and the terms, and in the two guides this finding named; the reminder references in the pages this finding named were removed.

**Residual risk on the live contract.** No alerts exist. Open the app regularly, or watch for the `ClaimInitiated` event with your address as the owner topic using your own monitoring.

---

<a id="f41"></a>

### F41 · Medium · The app showed heirs as the 8 characters that address poisoners copy

**Status:** Mitigated in the app and documentation  
**Audit title:** The app shows each heir only as the 8 hex characters an address poisoner matches, never the full address, with no copy action, lookalike check or confirmation, so a pasted poisoned heir address can hijack an inheritance without the owner seeing it

**In plain words.** The app showed each heir only as `0x1234…abcd`: the first and last four characters, which is exactly what address-poisoning scams imitate. Changing the heir used a bare text prompt with no full display, no confirmation and no look-alike check. If an owner pasted a poisoned look-alike from their wallet history, the app showed it as identical to the real heir.

**Impact.** An attacker could take the vault once the owner dies or stops acting. If the wrong address is a typo that nobody controls, the vault can never be claimed. The contract cannot tell a look-alike from the real heir.

**Affected code (v1, commit b8baf34).** `site/assets/app.js:41` `short()`; `:272-274`; `:226-231` `actHeir`; `:354-372` (create); `:385-389` (heir tab); `contracts/InheritanceVault.sol:582-594`, `:370-381`, `:643`.

**Evidence.** [`poc/F41.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F41.ts): 6 tests; on v1, 6 fail and 0 pass. The owner's card showed `0x3C44…93BC` for the real heir and for an 8-character look-alike; Change heir and Create vault accepted the look-alike; the attacker took 995 tokens, and a lowercase near-miss froze 1,000 for good.

**Verification.** Initial rating Medium; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Medium. Final severity: Medium. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No contract change: the contract cannot tell addresses apart in this way, in v1 or v2.

**In the app and documentation:** The app shows every heir and payout address in full (ten groups of four, a copy button and an explorer link). Creating a vault and changing an heir use an in-card review: the address is typed twice, the current and new heirs are shown in full, existing heirs can be picked instead of pasted, an address that shares its first or last four characters with a known heir or your own wallet is blocked outright (a look-alike of a new heir has nothing to be compared with, so it cannot be caught), and input without checksum capitals is flagged. Afterwards the app asks the owner to have the heir confirm the vault in the heir tab.

**Residual risk on the live contract.** These protections exist only in this app; the contract accepts any address. Confirm the heir's full address with them directly.

---

<a id="f42"></a>

### F42 · Low · A deposit can capture pool-wide gains, or absorb pool-wide losses, from unusual tokens

**Status:** Fixed in v2 source  
**Audit title:** _pull charges every in-window change in the vault's existing balance to the depositor: a depositor can take a pool-wide rebase, a lazily settled reward or a hook-injected third-party payment, and an honest depositor absorbs a pool-wide negative rebase with no minimum-received bound

**In plain words.** The live contract credits a depositor with the whole change in the vault's token balance during the deposit. With tokens that rebase or pay out rewards when a transfer touches them, or tokens with transfer hooks, a depositor can capture a gain that belongs to the whole pool. With a token that shrinks balances, an honest depositor absorbs the whole pool's loss.

**Impact.** Anyone can capture gains that the design sends to surplus; an honest depositor can lose up to their deposit. These token types are rare on the target chains.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:345-356` `_pull` (`:351-355`); `createVault` `:370-377`; `topUp` `:441-454`.

**Evidence.** [`poc/F42.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F42.ts): 7 tests; on v1, 6 fail and 1 pass. A 4-unit deposit that triggered a rebase was credited 529 units; a 1-wei deposit collected a 300-unit reward; a pool-wide loss panicked with an arithmetic error instead of `NothingReceived`. The context test passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** The amount credited is capped at the amount sent, and a deposit during which the balance did not rise reverts `NothingReceived`. The allowlist keeps these tokens out.

**In the app and documentation:** nothing changed for this finding.

**Residual risk on the live contract.** Unchanged on the live contract. The app's known-token list steers users away from these tokens.

---

<a id="f43"></a>

### F43 · Informational · Past the horizon, changing the heir restarts nothing

**Status:** Acknowledged · Mitigated in the app and documentation  
**Audit title:** Past the horizon, setBeneficiary and setInactivityPeriod still succeed on an ACTIVE vault without restarting anything: the new heir can claim at once and the owner cannot abort it, while an outgoing heir who front-runs the change keeps a claim that only extendHorizon or a full withdrawal can stop

**In plain words.** On an active vault past its horizon, the live contract lets the owner change the heir or the inactivity period, but the deadline stays in the past. The new heir can claim at once, and then only extending the horizon or withdrawing everything stops the claim. If the outgoing heir files a claim first, the change fails and they keep the claim.

**Impact.** A living owner who changes the heir past the horizon may lose control. Bounded: extending the horizon and withdrawing everything still work for at least 7 days.

**Affected code (v1, commit b8baf34).** `contracts/InheritanceVault.sol:582-594` `setBeneficiary`; `:596-604` `setInactivityPeriod`; `:287-291`, `:312-322`, `:639-659`, `:663-677`.

**Evidence.** [`poc/F43.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F43.ts): 9 tests; on v1, 5 fail and 4 pass. Past the horizon both changes succeeded without restarting the clock, the new heir claimed in the next block, and the outcome depended on transaction order. Four controls passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it but judged the behaviour intended or already disclosed, and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In v2 source:** No change, on purpose: an owner whose heir has lost their key can still redirect the inheritance without delaying it.

**In the app and documentation:** Past the horizon, the app puts "Extend horizon" first, with the earliest valid date shown, labels the other option "Change heir without extending", and warns that a change alone restarts nothing and the new heir could claim at once.

**Residual risk on the live contract.** Other interfaces must extend the horizon first, on the live contract and in v2.

---

<a id="f44"></a>

### F44 · Low · Heirs could not find their vault from what the FAQ told them

**Status:** Mitigated in the app and documentation  
**Audit title:** The heir FAQ says three facts are enough, but the app cannot find a vault without the owner's address, the promised heir walkthrough does not exist, and nothing tells the heir when to claim; an heir who never claims leaves the funds frozen forever

**In plain words.** The FAQ said an heir needs three facts. But the app needs the owner's address to find a vault, the heir walkthrough it promised did not exist, and nobody tells the heir when to claim. If the heir never claims, the funds stay locked for good.

**Impact.** An heir might never find or claim the vault, and could be drawn to "recovery help" scams.

**Affected code (v1, commit b8baf34).** `site/index.html:164-169`; `site/app.html:92-97`; `site/assets/app.js:378-400`; `contracts/InheritanceVault.sol:176`, `:836-845`, `:29-32`.

**Evidence.** [`poc/F44.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F44.ts): 6 tests; on v1, 4 fail and 2 pass. No view finds a vault from the heir's address, the FAQ left out the owner's address and never said nobody would notify the heir, and no guide walked the heir through a claim. The feasibility and damage tests passed.

**Verification.** Initial rating Low; the reachability skeptic did not refute it and proposed Low; the severity skeptic did not refute it and proposed Low. Final severity: Low. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** The FAQ now lists what the heir really needs: the chain and contract address, the owner's address and the vault number, which of their addresses was named, the app's address, the check-in period and horizon, that nobody will notify them, and never to type a seed phrase. The app's heir tab adds "Find vaults naming my wallet": it reads the contract's public logs for the connected address from the deployment block, checks every hit on chain, and shows only open vaults that name that wallet now, saying when the search may be incomplete.

**Residual risk on the live contract.** The search depends on public endpoints' log limits and may miss a vault. The owner's address remains the reliable way in.

---

<a id="f45"></a>

### F45 · Informational · The watcher and the app told owners past the horizon to check in

**Status:** Mitigated in the app and documentation  
**Audit title:** The watcher's 'expired' and 'claimable' alerts ignore the horizon: past it they tell the owner to check in, which reverts, and promise a veto window the ordinary veto no longer provides (B-06 fix is incomplete)

**In plain words.** Past the horizon a check-in no longer works, but the watcher's "expired" and "claimable" alerts still said "check in now", and the app printed "check in" next to "check-ins no longer work".

**Impact.** No effect from the watcher today, because it is not running; the app's line was live.

**Affected code (v1, commit b8baf34).** `notify/watcher.js:181-187`, `:221-228`, `:173-179`; `site/assets/app.js:184-190`.

**Evidence.** [`poc/F45.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F45.ts): 7 tests; on v1, 5 fail and 2 pass. Past the horizon the owner's expiry alert said to check in and promised the ordinary veto, the heir's alert said to have the owner check in, the horizon alert said "1 days away", and the app said "check in". Two tests passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** One helper now words every remedy in the watcher according to the vault's state and horizon, and the horizon alert says when the horizon has passed. The app's warnings no longer say "check in" past the horizon or during a claim.

**Residual risk on the live contract.** The watcher is retired; `notify/README.md` lists what must be checked before any restart.

---

<a id="f46"></a>

### F46 · Informational · During a claim, the owner's card did not say when it can be finalized or where it pays

**Status:** Mitigated in the app and documentation  
**Audit title:** The owner card never shows when a pending claim becomes final, who filed it or where it pays; only the heir's card shows 'veto window until'

**In plain words.** With a claim pending, the owner's card showed a general warning, but not the time after which anyone can finalize, who filed the claim, or where it pays.

**Impact.** An owner could misjudge how long they have, or miss that a claim pays an unexpected address.

**Affected code (v1, commit b8baf34).** `site/assets/app.js:294-302`, `:272-290`; `contracts/InheritanceVault.sol:809-833` (the data is in `getVault`).

**Evidence.** [`poc/F46.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F46.ts): 4 tests; on v1, 3 fail and 1 pass. The owner's card for a pending claim never showed `finalizableAt` or `claimRecipient`, and two days before finality it gave no deadline. The control passed.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** The owner's card now leads with a claim block: when it was filed, by whom and paying where (both in full, flagged if the payout is not the heir), and when anyone can finalize, in local time with a countdown; past the horizon it names the two remedies that still work.

**Residual risk on the live contract.** None known in the app (checked in a browser review against a local copy of v1, not by the proof of concept; see [Limitations](#limitations)).

---

<a id="f47"></a>

### F47 · Informational · Irreversible dates were signed without a review

**Status:** Mitigated in the app and documentation  
**Audit title:** Irreversible timing parameters are signed with no echo or summary: the horizon prompt silently rolls invalid dates over, never shows the current horizon or says it can never be lowered, and the create form signs the immutable challenge window unreviewed

**In plain words.** The horizon prompt took free text and silently turned impossible dates into real ones (2046-02-30 became 2046-03-02). The card never showed the current horizon. Creating a vault signed the permanent challenge window and the raise-only horizon with no summary.

**Impact.** A wrong horizon can delay an heir by years, and an oversized window delays every payout.

**Affected code (v1, commit b8baf34).** `site/assets/app.js:233-242` `actHorizon`; `:283-287`; `:354-372`; `contracts/InheritanceVault.sol:611-631` `extendHorizon`.

**Evidence.** [`poc/F47.ts`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/F47.ts): 6 tests; on v1, 4 fail and 2 pass. The prompt signed a rolled-over date and a transposed year without any echo, the card never showed the current horizon, and `createVault` was signed without a summary. Two tests measured the damage.

**Verification.** Initial rating Informational; the reachability skeptic did not refute it and proposed Informational; the severity skeptic did not refute it and proposed Informational. Final severity: Informational. Status: confirmed. The proof of concept reproduced it.

**What was changed.** **In the app and documentation:** The horizon uses a date input with a check that the date really exists. The current and new horizon are shown side by side, with the difference in years and days and the fact that it can never be lowered. Creating a vault shows a summary first: the full heir address, the inactivity period, the challenge window (marked permanent), the horizon (marked raise-only), the fee ceiling and the current rate, with a warning for windows under 14 or over 90 days.

**Residual risk on the live contract.** None known in the app (checked in a browser review against a local copy of v1, not by the proof of concept; see [Limitations](#limitations)).

<a id="sound"></a>

## What was checked and found sound

Besides the findings, the ten auditors and the second-round hunts recorded 204 properties that they had checked and found sound. They are grouped and de-duplicated below. All of them were checked against v1 (commit `b8baf34`), not v2. Where a finding limits a property, the finding is named. A property listed here is the auditors' judgement after reading the code and, where noted, testing it; it is not a proof.

### Accounting, for ETH and single-address tokens

- For each token, the sum of open vault balances always equals the contract's locked total, and the sum of payout credits equals its credited total. This was checked by reading every write, and by a randomized test (3 seeds, up to 400 operations, with ETH, a plain token and a fee-on-transfer token) that the accounting auditor wrote as a scratch test during the audit; it is not part of the repository's test suite.
- The contract's balance always covers everything it owes; `surplus()` cannot underflow; and a depositor cannot capture surplus that was already there (a gain arriving during the deposit itself is [F42](#f42)).
- Tokens that take a fee on the way in are recorded at the amount actually received.
- A finished vault holds nothing; a vault cannot be both settled and withdrawn, or settled twice; nothing can be credited to the zero address or to the vault itself.
- ETH can enter a vault only through `createVault` or `topUp`, with the value checked exactly; plain transfers are refused, and ETH forced in some other way only ever counts as surplus.
- Lanes are isolated per token for tokens with a single contract address (for other tokens, see [F01](#f01)).

### The claim state machine and timing

- The deadline never passes the horizon, and the heir can always start a claim once the horizon is reached, with no owner action (the lost-key case).
- The earlier fixes A-02, B-01 and B-02 hold: past the horizon only extending the horizon, by at least one inactivity period, or withdrawing everything ends a claim, so there is no free, endless veto loop.
- Only the named heir can start a claim, only after the deadline, and only on an active vault; neither the heir nor a third party can bring the claim date forward.
- Nobody can block the owner's veto inside the window (network inclusion aside: [F37](#f37)), and nobody can block a valid finalization.
- Settled and closed vaults stay finished; the owner and the heir cannot be the same address; vault numbers are never reused.
- Changing the heir while a claim is pending, before the horizon, cancels that claim in the same transaction; a locked fee does not survive a cancelled claim.
- The time comparisons at the deadline, the end of the window and the horizon are consistent, with no gaps or overlaps.

### Administrator powers and fees

- The list of admin functions is complete: pause creation, set the fee, set the fee recipient, sweep surplus, and a two-step ownership transfer. Renouncing ownership is disabled.
- The admin cannot change a beneficiary or any vault setting, cannot cancel or redirect a withdrawal, and cannot block a valid claim settlement.
- The fee can never exceed 1%; each vault's ceiling is fixed at creation; once a claim starts, its locked rate can only fall (the fee-recipient switch is [F05](#f05)). With no fee recipient at settlement, no fee is taken.
- The surplus sweep cannot touch ETH or ordinary single-address token balances or credits (except that a credit pushed into the wrapped-native contract comes back as sweepable surplus: [F09](#f09)).
- The creation pause never blocks existing vaults (its narrow scope is [F32](#f32)); users never depend on the admin being active.

### Tokens and payouts

- Tokens that return no value on transfer work; tokens that return false are refused; tokens that revert on zero-value transfers are safe.
- A token address with no code, a precompile, or the vault's own address is rejected; ETH sent along with a token operation is refused.
- Nobody can spend another user's standing token approval to the vault.
- A hostile token affects only its own lane; pausable and blocklisting tokens cannot stall the claim process (they can freeze payouts: [F12](#f12)).
- Under two-sided blocklists (USDC style), a blocklisted owner, heir or fee recipient can still be paid to another address.
- A failed payout never corrupts the credit records; no fee is charged on deposits or owner withdrawals.

### Reentrancy and external calls

- The earlier reentrancy fix (A-01) covers every function that changes state, and the list of external calls is complete and short.
- Token hooks (ERC777 and ERC1363 style) cannot re-enter the vault to change state.
- Payouts update the records before transferring; a hostile heir or payout address cannot block settlement, because payouts are pulled, not pushed, during the state change.
- Gas tricks and oversized return data only hurt the caller's own transaction; one user cannot jam another user's payout.
- Views are consistent while a payout is in flight (not while a deposit is: [F33](#f33)).

### Arithmetic and time

- Every narrowing conversion is safe or guarded, oversized balances revert rather than truncate, and no time addition can overflow, even with extreme inputs.
- Minimum and maximum bounds are enforced on every path that writes a timing field, and extreme allowed values neither lock funds nor make claims impossible.
- Storage packing and layout are sound, and the list of open vaults is maintained correctly.
- The contract reads only block timestamps and never relies on them being unique or strictly increasing; every window is at least 7 days, far longer than any clock drift Base or BNB Chain allow.

### The check-in chain, within one vault and one installation

- A chain check-in can never move the deadline past the horizon or bring it earlier.
- Only the owner can install or replace a chain; zero or out-of-range settings are rejected; the counter has no off-by-one error.
- A used value cannot be replayed within the same vault and installation (across vaults, chains and installations it can: [F02](#f02)).
- Copying a relayer's pending value is harmless, and the heir cannot front-run a chain check-in that lands before the deadline.
- A chain value cannot withdraw, change the heir or veto a claim (it can delay the heir: [F17](#f17)).

### Transaction ordering and other chains

- Creating a vault cannot be front-run to hurt the creator or to take their vault numbers, and third parties cannot clutter an owner's vault list.
- A top-up cannot deny or hijack an inheritance, fake a check-in, or change a claim's amount (it can keep a vault open: [F22](#f22)).
- No function's gas cost grows with history, so nobody can make one run out of gas.
- There is no signature to replay across chains: the contract uses no signatures, and every transaction is bound to its chain (the check-in chain is the exception: [F02](#f02)).
- The same bytecode deploys and runs on BNB Chain (chain id 56).
- Admin ordering cannot reach deposits or exceed a vault's fee ceiling (it can move the fee within it: [F06](#f06)).

### The retired billing contract

- Rounding favours the contract with negligible loss; there is no division by zero, overflow or truncation of paid time; the 10-year cap holds; sub-second dust is rejected at the exact boundary.
- Paid time can only grow, gifts cannot harm the recipient, and the payer's minimum works when it is used.
- Only the owner can move ETH, ownership cannot be renounced, there is no reentrancy surface, and plain transfers are refused.
- No payment was ever received (a log scan from its deployment block, 49,728,662 on 9 August 2026, run on 24 September 2026 and repeated to 27 September 2026 for this report), and the vault does not depend on it.

### Deployment and published claims

- The runtime bytecode of both deployed contracts equals the compiled source at `b8baf34`, byte for byte.
- On 24 September 2026 the live settings matched the public claims: a 0.5% fee and the hardware-wallet admin, with no transfer pending.
- The minimum inactivity period and challenge window are 7 days, and the challenge window cannot be changed after creation.
- The contracts cannot be upgraded and have no ownership traps.
- The published count of 63 tests matched the suite (with [F39](#f39)'s timing caveat).

### The app's handling of addresses, as audited

- An invalid heir or payout address never reaches a signature.
- The heir tab compares full addresses, not shortened ones; an owner's withdrawals and credit pulls go to the connected wallet and cannot be redirected by a pasted address.
- The contract enforces the horizon's limits whatever the app sends, and the full heir address can always be read on chain.

### Areas examined in the second round

- Changes to the vault's balance during a deposit cannot break the equality of the books or the contract's solvency, and the arithmetic error that can block deposits during a shrinking rebase ([F42](#f42)) is temporary and cannot be kept going by an attacker.
- No action an owner can take on an active vault past its horizon can delay the heir or rebuild the veto loop; extending the horizon first is safe against the outgoing heir front-running a heir change.
- The contract's events and views are enough for anyone to build their own alerts; the gap in [F40](#f40) is operational, not in the contract. No paying reminder subscriber was cut off, and the challenge window's length is a fixed guarantee for the heir.

<a id="recommendations"></a>

## Recommendations to the project owner

1. **Keep the warning in force.** Do not invite material value into v1 or v2 until an independent third-party audit is complete.
2. **Do not deploy v2 yet.** First: have v2 audited independently (its source grew from 846 to 1,573 lines and it has only been reviewed by the same kind of agents that wrote it); decide the two open design questions in [`CHANGELOG-v2.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/CHANGELOG-v2.md) (whether `beneficiaryCancelClaim` should be limited to a grace period or replaced by an atomic change of payout address, [F20](#f20); and the view-guard trade-off, [F33](#f33)); confirm each chain's token allowlist, which can never change once deployed; build a v2 app and any v2 watcher, since several event signatures changed; and run a full lifecycle on a test network.
3. **When v2 is deployed, migrate rather than patch.** Pause new-vault creation on v1 (every exit stays open), and ask v1 owners to withdraw in full, which closes their vaults, and to create new ones on v2. The admin cannot move anyone's vault, and top-ups into v1 cannot be stopped on chain ([F32](#f32)).
4. **Until then, decide how v1 stays open.** v1's medium findings are mitigated only off chain, in this app and its documentation. Keeping creation open relies on users reading the warnings; pausing creation now, which is reversible and leaves every existing vault and exit working, removes new exposure while an audited v2 is prepared. The AI agents that compiled this report lean towards pausing if v2 is expected within months.
5. **Publish a fee and sweep commitment for v1**, signed with the admin key: never raise the claim fee on v1 (or at least announce any raise 30 days ahead, as v2 enforces); never unset the fee recipient, and never set it again after unsetting it ([F05](#f05), [F06](#f06), [F07](#f07)); call `sweepSurplus` on v1 only for ETH or for amounts of a token on the app's known list that were sent to the contract by mistake, and return any value that belongs to a vault ([F01](#f01), [F09](#f09), [F11](#f11)); keep the billing contract's price at the maximum ([F23](#f23)). A signed statement is not enforced by code. The only way to enforce "fees only go down" on v1 is to transfer ownership to a small governor contract that allows only cuts, and that contract would itself need an audit.
6. **Move administration to a multisig** instead of a single hardware-wallet key ([F29](#f29)).
7. **Before any BNB Chain launch:** deploy v2, not v1's bytecode; do not deploy the billing contract; confirm the BNB token list (its USDT and USDC use 18 decimals); and re-check the watcher's log paging if it is ever used ([F31](#f31), [F37](#f37)).
8. **Refuse Base's system-contract addresses as payouts in the app.** The fix review found that a native payout to Base's L2-to-L1 message passer starts a withdrawal to the vault's own address on Ethereum, where only code deployed at that address could collect it, and only the key that deployed the vault could deploy code there. v2 refuses the whole range; v1 accepts it, and the app only asks for confirmation.
9. **Add fuzz and invariant tests and a mutation-testing gate** to continuous integration before any v2 deployment ([F38](#f38)).
10. **Adapt the app and documentation proofs of concept** to the rewritten app and pages (see the limitations below), and **publish the machine-readable audit record** (finding texts, both skeptics' verdicts, the full list of sound properties, the items folded into other findings and the run log) in the repository, so every number in this report can be checked from source. Its summary line calls the review "independent-style"; correct that first, because the review was not independent.

### Admin actions

| Action | Why | State |
|---|---|---|
| `NotifySubscription.setPrice(type(uint256).max)` on Base | [F23](#f23) | Done on 26 September 2026: [transaction 0xf3485b1b…3a56cca](https://basescan.org/tx/0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca), block 51,823,544. Re-checked by read-only calls on 27 September 2026. |
| Sign and publish the v1 fee and sweep commitment | [F01](#f01), [F05](#f05), [F06](#f06), [F07](#f07), [F09](#f09), [F11](#f11) | Pending. A signed message, not a transaction. |
| Move the admin role and fee recipient to a multisig | [F29](#f29) | Recommended, pending. |
| Pause new-vault creation on v1 | Recommendation 4, and migration | The owner's decision. |

<a id="limitations"></a>

## Limitations of this review

- **Not independent.** The auditors and the code's author are the same kind of AI system (Anthropic's Claude), so they may share blind spots. No human security auditor has reviewed the code, the findings or this report. This is no substitute for an independent audit.
- **Preliminary and time-boxed.** The audit took about three days. Its second completeness pass did not run (see [Interruptions](#method)).
- **Sound is not proven.** The properties listed as sound are the auditors' judgement. There was no formal verification, and apart from one randomized accounting test that an auditor ran during the audit (it is not in the repository), no fuzzing or invariant testing.
- **No frontend security review.** The app was examined only where a finding led there. Its script integrity, injection into the page, trust in network responses and wallet interaction were not reviewed.
- **The instructions shaped the result.** The full audit record is published in [`audit/2026-09-preliminary/record/`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/record): every raw finding with both skeptics' verdicts, the seven items folded into other findings, the properties marked sound, the run log, every fix-review round, and the exact workflow scripts, so the instructions each agent was given can be read. Those instructions include one exclusion: the auditors were told not to report the security page's stale claim that administration had not been handed over, because it was already being corrected; [F29](#f29) covers it anyway.
- **v2 has not been audited end to end.** It was reviewed only in the five fix-review rounds. Those rounds found 48 further issues and the last round still found six, which suggests that a fresh review would find more.
- **The proofs show that problems exist, not that others do not.** They ran on local Hardhat networks and, for F23 and F30, on read-only data from Base.
- **The app and documentation proofs no longer measure the fixes.** They read the current files and were written against the old app and pages. On 27 September 2026 we ran the eleven such files (F19, F24, F29, F30, F36, F40, F41, F44, F45, F46 and F47) against the updated files: 29 passing, 28 failing, 1 skipped. Of the 28 failures, 22 are harness errors caused by the rewritten app or reworded pages (for example a missing browser object in the test's stand-in page, or a changed form), not the original defects, and 6 can never pass because they read the unchangeable v1 source, the audited commit, or look for a contract view that v1 does not have. So these files do not currently show whether the app and documentation fixes work. The app changes were instead checked by a separate AI agent in a browser against a local copy of v1, with a simulated wallet; they have not been tested with real wallets or on mainnet.
- **Facts about third parties can change**: token issuers' powers, public endpoints' log limits, and Base's forced-inclusion delay were taken from public sources or measured on specific dates.
- **Severity is judgement.** The skeptics disagreed on some findings (see [F40](#f40)); the final severities are the lead agent's.

<a id="reproduce"></a>

## Reproduce the evidence

You need Node.js and git. The evidence suite's [README](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/README.md) explains what each file reads and its side effects (F23 and F30 read from Base's public endpoint; F31 writes and then restores `deployments/bnb.json`).

```sh
git clone https://github.com/vinothkannaongc-prog/inheritance-vault.git
cd inheritance-vault
git checkout audit-2026-09-prelim
npm ci

# The v1 evidence: the 47 proofs of concept. Expected to exit non-zero:
# on v1 the failures are the proof. Takes about 20 minutes.
npm run audit:v1

# The v2 regression tests.
npx hardhat test

# The v2 regression tests run against v1: they should fail, except controls, guards and pins.
VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts
```

When we ran them on 27 September 2026, `npx hardhat test` gave 244 passing and 0 failing, and the v1 run of `test/AuditPrelim2026-09.ts` gave 51 passing (all of them controls, guards or pins) and 124 failing. The recorded run of `npm run audit:v1` is in [`RESULTS-v1.md`](https://github.com/vinothkannaongc-prog/inheritance-vault/blob/audit-2026-09-prelim/audit/2026-09-preliminary/poc/RESULTS-v1.md). To check the live bytecode, use the commands under [Scope](#scope).

> **Before you use it:** this review is preliminary and not independent, and the live contract cannot be changed. Read the [security page](https://willandkey.com/security) and [how it works](https://willandkey.com/how-it-works), try the full flow with a small amount, and do not use material value until an independent audit is complete.
