# Preliminary audit 2026-09: the v1 evidence suite

This folder holds the executable evidence for the 47 findings (F01 to F47) of the preliminary security
audit of Will & Key, run against **v1**: the InheritanceVault that is deployed, immutable, at
`0xC821849A1D74959753450409b594b23eCE7fEe2f` on Base, and the retired NotifySubscription at
`0x60749aF621180de1DC05DB4f3d158D09dE979dC6`.

The suite exists so that anyone can re-run the audit's proofs of concept against the deployed code,
now and after the fixed source (v2) replaces `contracts/InheritanceVault.sol`. It is not the
regression suite for v2. The v2 regression tests live in `test/AuditPrelim2026-09.ts` and run with
the normal `npx hardhat test`.

## Failures are the evidence

Every PoC asserts the **safe property**: what the code, the site or the docs promise. On v1 those
assertions fail, and each failure is the defect reproduced. So `npm run audit:v1` is expected to
exit non-zero. A PoC file also contains passing tests: controls that prove the setup is sound,
characterisation tests that measure the damage, and guards that a future fix must keep passing.

`poc/RESULTS-v1.md` records one full run: for each finding, how many tests failed and passed, what
the failing assertion shows, and whether that matches the expectation that the safe-property
assertion fails on v1.

## Reproduce

```sh
npm ci
npm run audit:v1
```

`audit:v1` runs `hardhat test` on exactly the 47 files in `poc/` (listed one by one in
`package.json`, because Hardhat does not expand globs on Windows). The recorded run took 18 minutes;
the first one, with cold compile caches, took 44. Most of the time goes to F38, which compiles and runs
the shipped suites against 13 source trees in child Hardhat processes. To run a single finding:

```sh
npx hardhat test audit/2026-09-preliminary/poc/F04.ts
```

Network and side effects, all deliberate and inherited from the audit sandboxes:

- **F23** forks Base mainnet (read-only JSON-RPC to `https://mainnet.base.org`, or `BASE_RPC_URL`)
  to test the live NotifySubscription. If the RPC is unreachable, its fork tests are skipped, not
  failed. Nothing is sent to any chain; impersonation exists only inside the in-process fork.
- **F30** compares a stored `eth_getCode` snapshot with the live code (read-only; skipped offline).
- **F31** runs the working-tree `scripts/deploy.ts` and `scripts/transfer-admin.ts` against its own
  in-process chain, exposed on 127.0.0.1:8591 under the network name `bnb`. No real network is
  configured in that run. It writes `deployments/bnb.json` for the duration of the test and then
  restores the previous file, or deletes it if there was none. Its rehearsal config lives in
  `cache/poc-f31/` and is removed afterwards.
- **F37** and **F45** run the working-tree `notify/watcher.js` as a child process against a local
  JSON-RPC server, with scratch directories under the OS temp directory.
- **F38** writes its mutant source trees to `cache/audit-f38-mutants/` (git-ignored). The trees are
  kept between runs, so a second run skips most compilation.

## What is pinned to v1, and what reads the working tree

**Contract PoCs are pinned to v1.** They deploy `InheritanceVaultV1` (see below) and the unchanged
`NotifySubscription`. v1 is immutable, so these keep failing forever: they are the permanent record
that the deployed contract has the defect.

**App, documentation, script and watcher PoCs read this repository's working tree**: `site/`,
`notify/`, `scripts/`, `README.md`, `SECURITY.md`, `AUDIT_SCOPE.md`, `AUDIT-2026-08-09.md` and
`deployments/`. They start passing as the APP, DOC and SCRIPT remediations land, and then serve as
regression tests for those fixes. `poc/RESULTS-v1.md` records their state before any remediation
edit (HEAD `5bbad6e`). The site was redesigned in `5bbad6e`, after the audit sandboxes ran. Every doc
PoC still found the text it checks in the recorded run; if a later edit removes a quote without fixing
the defect, record that rather than editing the PoC to pass.

Which PoCs read which files is stated at the top of each file and in `poc/RESULTS-v1.md`.

**F38 and F39 run the v1 shipped test suites**, not the live `test/` files, which the v2 work adapts:
`support/shipped-v1/` holds `test/InheritanceVault.ts`, `test/Audit.ts` and
`test/NotifySubscription.ts` exactly as at `b8baf34`, except that the vault factory name is
`InheritanceVaultV1`. Line counts are unchanged, so line references still hold.

## The v1 contract and the deployed-source reference

- `contracts/v1/InheritanceVaultV1.sol` is the v1 source with two changes only: a header comment and
  the contract name (`InheritanceVault` to `InheritanceVaultV1`), so v1 and v2 compile side by side.
  Errors, events, functions, storage layout and NatSpec are unchanged. Do not edit it.
- The byte-exact deployed source is `contracts/InheritanceVault.sol` at git tag **`v1-base`**, which
  points at commit `b8baf34`, the source verified on Basescan. (`contracts/` is identical at `b8baf34`
  and `5bbad6e`.)
- The rename changes the CBOR metadata hash at the end of the runtime bytecode, and nothing else.
  The F30 test `[port] the deployed-runtime snapshot matches the compiled v1 sources` checks that
  every byte of `InheritanceVaultV1`'s runtime before the metadata equals the deployed code, and that
  `NotifySubscription` equals the deployed code exactly.
- `NotifySubscription` is not copied: `contracts/NotifySubscription.sol` is the unchanged v1 source.

## Layout

| Path | What it is |
|---|---|
| `poc/F01.ts` ... `poc/F47.ts` | One PoC file per finding, ported from the audit sandboxes |
| `poc/RESULTS-v1.md` | The v1 run: per-finding failing and passing counts and what they show |
| `support/shipped-v1/` | v1 snapshot of the shipped suites (for F38 and F39) |
| `support/f38/` | F38's proposed boundary and hostile-token suites, and its mutant Hardhat config |
| `support/fixtures/base-runtime-2026-09-24.json` | `eth_getCode` of both Base contracts, captured during the audit (for F30) |
| `../../contracts/v1/InheritanceVaultV1.sol` | v1 source, renamed |
| `../../contracts/audit/FXX_*.sol` | The PoCs' own mocks (12 files) |

The suite also uses the shared helpers in `contracts/test/TestHelpers.sol` (`MintableToken`,
`FeeOnTransferToken`, `RevertingReceiver`, `ReentrantToken`, `IVaultLike`), unchanged since
`b8baf34`.

## How the sandboxes were ported

Each audit sandbox was a copy of the repo with one extra test file, `test/poc-FXX.ts`, plus any mocks
in `contracts/test/`. The port made only these changes:

- `getContractFactory("InheritanceVault")` became `getContractFactory("InheritanceVaultV1")`. F06 and
  F25, which read the storage layout, use the fully qualified `contracts/v1/InheritanceVaultV1.sol`.
  F29 reads the v1 NatSpec from the same file.
- Every contract declared in a carried-over mock was renamed `FXX_<Name>` (for example
  `DualEntryPrimary` to `F01_DualEntryPrimary`), and the tests were updated to match, so no two
  artifacts share a name.
- Paths that pointed into the sandbox or at an absolute path of the original machine now resolve
  from this repository's root. Scratch directories moved to the OS temp directory (F37, F45) or the
  git-ignored `cache/` (F38). Each file's first lines say where it came from and what it reads.
- **Fix sketches were not carried over.** Some sandboxes held patched copies of the vault or the
  subscription, used to show that a PoC turns green once fixed: `InheritanceVaultDomainSep` (F02),
  `F04PatchedVault` (F04), `InheritanceVaultF05Fixed` (F05), `F06FixBound` and `F06FixTimelock`
  (F06), `InheritanceVaultF14Fix` (F14), `InheritanceVaultF22Fixed` (F22), `F33FixedVault` (F33)
  and `NotifySubscriptionFloorFix` (F34). The environment switches that selected them
  (`F02_FIXED`, `F04_VAULT`, `F06_VAULT`, `F08_VAULT`, `F14_IMPL`, `F22_IMPL`, `F33_VAULT`,
  `F34_CONTRACT`, `F42_VAULT`) were removed, and F02's fixed-mode chain derivation with them. No
  test depended on a sketch in its default mode, so no test was deleted. The v2 regression tests
  replace the sketches.
- Only each sandbox's `test/poc-FXX.ts` was ported. Side files such as `poc-F05-fixcheck.ts`,
  `poc-F13-diag.ts` and the sandboxes' fixed copies of the site or watcher were not.
- F30 hashes the deployed runtime from the snapshot instead of the compiled artifact, because the
  renamed artifact's metadata differs; it gained the `[port]` test above to tie the two together.
- F31 still classifies what `scripts/deploy.ts` deploys by the runtime of the working-tree
  `InheritanceVault` artifact, because that script deploys the working-tree contract.
- Every PoC file starts with a `before()` hook that resets the Hardhat network. Each sandbox ran its
  PoC alone on a fresh chain; in one combined run, earlier files leave nonces, balances and block time
  behind (without the reset, F36's "the heir never sent a transaction" control failed because F33 had
  used the same signer).
- The DOM stubs of F19, F41, F46 and F47, which run the real `site/assets/app.js` in a vm, gained a
  `setAttribute` method. The `5bbad6e` redesign added `log.setAttribute("role", "status")` to
  `vaultCard()` (ARIA only; the app logic under test is unchanged), and without it every app test in
  those files failed with a `TypeError` instead of on its assertion. No assertion, quote or regex was
  changed in any PoC.

## Known machine dependence: A-05 (finding F39)

The shipped A-05 test assumes the block after `loadFixture` is `time.latest() + 1`, which only holds
while the tests before it finish within about a second (finding F39). On a slow or loaded machine it
fails. That has two visible effects:

- `npx hardhat test` can report 62 passing and 1 failing (A-05) on v1, with no change to the code.
- In F38, the InheritanceVault control fails and the two SafeERC20 mutants look "killed", because A-05
  fails in every InheritanceVault run. `poc/RESULTS-v1.md` shows, by running those mutant trees by
  hand, that A-05 is the only failing shipped test on them.

The F39 remediation pins the timestamp in the live `test/Audit.ts`. The v1 snapshot in
`support/shipped-v1/` deliberately keeps the unpinned test.
