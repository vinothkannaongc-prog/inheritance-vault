# Independent audit scope

Prepared: 2026-08-10. Updated: 2026-09-26 (admin, fingerprints, preliminary audit).

## Objective

Independently review the immutable Base deployment and its operational tooling. A serious contract
finding requires a new deployment because the deployed contracts have no upgrade mechanism.

## Reviews so far (none independent)

- `AUDIT-2026-08-09.md`: internal adversarial review, produced by the same system involved in
  implementation.
- Preliminary audit, 2026-09: performed by AI auditing agents at the project's request, not
  independent. 47 findings (5 medium, 21 low, 21 informational), published at
  <https://willandkey.com/audit>. The executable v1 evidence suite is in
  `audit/2026-09-preliminary/` (`npm run audit:v1`, expected to fail on v1 by design). The deployed
  contract is immutable, so its contract fixes exist only as undeployed v2 source in this
  repository; the live contract keeps the audited behaviour.

## Exact on-chain targets

| Contract | Base address | Runtime size | Runtime bytecode keccak-256 (EXTCODEHASH) | Runtime bytecode SHA-256 (raw bytes) |
|---|---|---:|---|---|
| `InheritanceVault` | `0xC821849A1D74959753450409b594b23eCE7fEe2f` | 16,163 bytes | `26a231771f3b5e7de6a09b3cd5a3e0d03fb5985d69b9bc4973db5f1e41af9733` | `89ca53b6aaea87fba5e3e0df7019b316f8a44304ef64569ea5a4978c4f9e4d60` |
| `NotifySubscription` (retired) | `0x60749aF621180de1DC05DB4f3d158D09dE979dC6` | 2,108 bytes | `67f23ec7a57f27c4c024c82ac45ef0e3a76e535b4f8224f2ce1de21c8029aec1` | `f2c577fd64b9038127473e87bb1c9981497962e36fde0b82f67465bf92e4bb61` |

Both deployed runtime bytecodes were compared byte-for-byte with the local Hardhat compiler
artifacts on 2026-08-10 and matched exactly. Neither contract has immutable variables, so the
artifact's deployed bytecode equals the on-chain code. The canonical public deployment record is
`deployments/base.json`.

Correction (2026-09): this table previously labelled the keccak-256 values as SHA-256. The values
were always keccak-256 of the runtime bytecode (what `EXTCODEHASH` returns); the true SHA-256
values were added from `eth_getCode` on `https://mainnet.base.org` on 2026-09-26. Reproduce:

```bash
cast keccak $(cast code <address> --rpc-url https://mainnet.base.org)
cast code <address> --rpc-url https://mainnet.base.org | sed 's/^0x//' | xxd -r -p | sha256sum
```

Hashing the hex string instead of the raw bytes gives a different SHA-256.

Since 2026-09-24 both contracts are owned by, and claim fees accrue to, a single Ledger
hardware-wallet key, `0x883C821103B5415C53B11E584D3592205B5CdCA3` (not a multisig); the deploy key
`0x4306…d986` holds no admin power. The five handover transactions are listed in the deployment
record. Admin functions on `InheritanceVault`: `setCreationPaused` (new vault creation only),
`setClaimFee` (immediate, ≤ 100 bps), `setFeeRecipient` (immediate, may be `address(0)`),
`sweepSurplus`, and two-step ownership transfer (`renounceOwnership` disabled). On
`NotifySubscription`: `setPrice`, `withdraw`, and two-step ownership transfer.

## Source and configuration in scope

For the contracts, `test/` and the deploy scripts, review commit `b8baf34`, which matches the
deployment. The working tree has since gained the undeployed v2 contract, its tests and updated
deploy scripts; review those separately, as v2.

- `contracts/InheritanceVault.sol` **at commit `b8baf34`**: the deployed v1 source. In the working
  tree the same source is `contracts/v1/InheritanceVaultV1.sol`, identical except for the contract
  name and a header comment. The working-tree `contracts/InheritanceVault.sol` is the undeployed v2
  source; it is not the deployment and must be reviewed separately, as v2.
- `contracts/NotifySubscription.sol` — review historical/direct-call risk even though sales are
  disabled on the website and on chain (price set to the maximum, 2026-09-26)
- `test/`
- `notify/watcher.js` and its configuration/state handling
- `scripts/notify-scenario.ts`, `scripts/deploy.ts`, `scripts/transfer-admin.ts`
- `hardhat.config.ts`, compiler settings, constructor arguments, and deployment records
- `site/app.html`, `site/assets/app.js`, `site/_headers`, privacy/terms disclosures, and wallet/RPC
  trust boundaries

Solidity build target: compiler `0.8.28`, optimizer enabled with 200 runs, EVM target `cancun`.
Dependencies are locked by `package-lock.json`.

## Verification baseline

Run from a clean checkout:

```bash
npm ci
npm run build
npm test
```

Expected unit result at the deployed v1 source (commit `b8baf34`): **63 passing** (the
wall-clock-sensitive A-05 test can fail on a loaded machine, giving 62 passing and 1 failing;
preliminary-audit finding F39). The working tree now holds the undeployed v2 source and its tests, so the count there differs. The local
watcher scenario additionally expects **14 steps passing** and needs a local Hardhat node on port
8547:

```bash
npm run node
npm run scenario
```

The scenario covers reminder expiry, veto escalation/re-arming, unpaid/paid transitions, critical
alerts during lapse, failure isolation, and claim-event backfill after an outage spanning
settlement.

## Priority review questions

1. Preservation of `totalLocked`, token credits, native credits, and `surplus()` under every state
   transition, hostile token behavior, forced ETH, and reentrancy.
2. Claim finality, horizon behavior, owner vetoes, partial withdrawals, fee snapshot/lock logic,
   and denial-of-inheritance paths.
3. Unsupported token behavior: fee-on-transfer, rebasing, ERC777-style hooks, tokens returning
   malformed data, and insolvent credit lanes.
4. Administrator powers, two-step ownership transfer, fee-recipient changes, pause behavior, and
   the guarantee that administrators cannot seize locked or credited user funds.
5. Hash-chain liveness authorization, replay boundaries, beneficiary front-running, and the known
   post-deadline chain-sniping race.
6. Watcher delivery guarantees, atomic state, deduplication, dead letters, log backfill, RPC
   disagreement, malformed customer configuration, and alert wording at/after the horizon.
7. Browser injection resistance for all chain-derived values, dependency integrity, CSP and
   wallet-provider trust boundaries.

## Known unresolved design questions

The internal review records three design questions in `AUDIT-2026-08-09.md`: the check-in-chain
sniping race, invisible skips in `checkInMany`, and create-time fee-ceiling slippage. They are
disclosed, not represented as fixed. The preliminary audit re-examined all three (findings F16,
F15 and F06) and confirmed each as a finding against the live contract.

## Operational status and exclusions

- Paid reminder subscriptions are disabled in the website and the production watcher is not
  running; Will & Key sends no alerts of any kind. Sales on the retired billing contract are also
  disabled on chain since 2026-09-26: the admin called `setPrice(type(uint256).max)` in tx
  `0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca` (block 51823544; recorded
  in `deployments/base.json` as `subscriptionSalesDisabled`), so every `subscribe` now reverts
  (`ZeroAmount`). Only the admin could reverse it (preliminary-audit finding F23, resolved by this
  admin action). Users are still instructed not to send the contract funds.
- The watcher's log paging (`LOG_PAGE`, initial lookback) was sized for Base and has not been
  validated against a production RPC. It must be revalidated per chain before any restart,
  including a BNB launch.
- The 14-step watcher scenario passed locally. A full Base Sepolia create/check-in/claim/veto/
  settle cycle remains pending and is time-bound by the contract's minimum 7-day inactivity plus
  7-day challenge periods.
- No independent audit has been completed. `AUDIT-2026-08-09.md` was produced by the same system
  involved in implementation and must not be described as independent. The 2026-09 preliminary
  audit was performed by AI auditing agents at the project's request and must not be described as
  independent either.
- Legal, tax, estate-planning, and jurisdiction-specific regulatory conclusions are outside the
  technical audit scope.

## Deliverables requested from the independent reviewer

- report tied to a repository commit and the two runtime bytecode hashes above;
- severity-ranked findings with reproducible tests or transactions;
- explicit review of the known design questions and threat-model assumptions;
- verification of fixes in a separate remediation pass;
- a public final report or a public attestation identifying any redactions and residual risks.
