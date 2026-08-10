# Independent audit scope

Prepared: 2026-08-10

## Objective

Independently review the immutable Base deployment and its operational tooling. A serious contract
finding requires a new deployment because the deployed contracts have no upgrade mechanism.

## Exact on-chain targets

| Contract | Base address | Runtime size | Runtime bytecode SHA-256 |
|---|---|---:|---|
| `InheritanceVault` | `0xC821849A1D74959753450409b594b23eCE7fEe2f` | 16,163 bytes | `26a231771f3b5e7de6a09b3cd5a3e0d03fb5985d69b9bc4973db5f1e41af9733` |
| `NotifySubscription` (retired) | `0x60749aF621180de1DC05DB4f3d158D09dE979dC6` | 2,108 bytes | `67f23ec7a57f27c4c024c82ac45ef0e3a76e535b4f8224f2ce1de21c8029aec1` |

Both deployed runtime bytecodes were compared byte-for-byte with the local Hardhat compiler
artifacts on 2026-08-10 and matched exactly. The canonical public deployment record is
`deployments/base.json`.

## Source and configuration in scope

- `contracts/InheritanceVault.sol`
- `contracts/NotifySubscription.sol` — review historical/direct-call risk even though sales are
  disabled in the website
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

Expected unit result: **63 passing**. The local watcher scenario additionally expects **14 steps
passing** and needs a local Hardhat node on port 8547:

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
disclosed, not represented as fixed.

## Operational status and exclusions

- Paid reminder subscriptions are disabled in the website and the production watcher is not
  running. The retired immutable billing contract has no pause switch and remains directly
  callable; users are instructed not to pay it.
- The 14-step watcher scenario passed locally. A full Base Sepolia create/check-in/claim/veto/
  settle cycle remains pending and is time-bound by the contract's minimum 7-day inactivity plus
  7-day challenge periods.
- No independent audit has been completed. `AUDIT-2026-08-09.md` was produced by the same system
  involved in implementation and must not be described as independent.
- Legal, tax, estate-planning, and jurisdiction-specific regulatory conclusions are outside the
  technical audit scope.

## Deliverables requested from the independent reviewer

- report tied to a repository commit and the two runtime bytecode hashes above;
- severity-ranked findings with reproducible tests or transactions;
- explicit review of the known design questions and threat-model assumptions;
- verification of fixes in a separate remediation pass;
- a public final report or a public attestation identifying any redactions and residual risks.
