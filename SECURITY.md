# Security policy

## Current security status (V2_DATE_ISO_TBD)

The live contract is **InheritanceVault v2** on Base (`V2_ADDRESS_TBD`), deployed on V2_DATE_ISO_TBD
(transaction `V2_TX_TBD`, block V2_BLOCK_TBD). It is immutable. **v2 has not been independently
audited.** Every review so far was run by AI systems of the same kind that wrote the code:

- The internal review of v1 ([AUDIT-2026-08-09.md](AUDIT-2026-08-09.md)), run by the same system
  that wrote the code.
- A **preliminary audit** of v1 (2026-09), performed by AI auditing agents at the project's request.
  It reported 47 findings (5 medium, 21 low, 21 informational), published at
  <https://willandkey.com/audit> with executable evidence in
  [audit/2026-09-preliminary/](audit/2026-09-preliminary/).
- v2 was written in response. Its fix reviews, also by AI agents, are recorded in
  [CHANGELOG-v2.md](CHANGELOG-v2.md): five fix-review rounds (48 issues), a pre-launch finalization
  and a pre-launch review (16 issues, none a defect in the contract). On 2026-09-27 the v2 suite had
  263 passing tests and none failing.

v2 has **not** completed an independent third-party audit or a full-duration Base Sepolia lifecycle
test. Treat it as experimental and do not use material value yet. If a serious contract defect is
confirmed, the remediation is a new reviewed deployment and a clearly communicated migration; the
existing bytecode cannot be patched.

For ETH and the four listed tokens (USDC, WETH, cbBTC and EURC, fixed at deployment; no other token
can be deposited), the administrator cannot take any value from a vault balance or payout credit
beyond the settlement fee: `surplus()` is the balance minus `totalLocked` minus `totalCredited` for
the same token, and `sweepSurplus` accepts only the native coin and the listed tokens. The fee is at
most the vault's creation-time ceiling (never above 1%), a raise takes effect only 30 days after it
is announced, and a fee recipient set after a period with none is in force only 30 days later. The
guarantee does not protect against a token issuer freezing or wiping the vault contract's balance of
its token: the issuers of USDC and EURC (Circle) and cbBTC (Coinbase) can pause, blocklist and
upgrade them.

## Retired v1

InheritanceVault v1 (`0xC821849A1D74959753450409b594b23eCE7fEe2f`) was the live contract from
2026-08-09 to V2_DATE_ISO_TBD. It is immutable, so it was retired rather than fixed: the administrator
paused its new-vault creation (`setCreationPaused(true)`, transaction `V1_PAUSE_TX_TBD`). On
2026-09-27 it held no user funds: its one vault, the project's own test, was closed, and its only
balance was a 0.00002 ETH credit owed to the former deploy key. Every contract behaviour the
preliminary audit reported is still present in v1. Do not send it funds. A v1 credit can still be
withdrawn with `withdrawCredit`.

## Administrator

The administrator of all three contracts, and the fee recipient of both vaults, is a single Ledger
hardware-wallet key, `0x883C821103B5415C53B11E584D3592205B5CdCA3`, not a multisig. v2 named it in
its constructor (deploy transaction `V2_TX_TBD`), so the deploy key never held a v2 role; on v1 and
the billing contract it took over from the deploy key on 2026-09-24 (five handover transactions, in
`deployments/base.json` and the README). On v2 it can:

- `setCreationPaused`: pause or unpause **new vault creation only**. The pause does not stop
  top-ups, check-ins, withdrawals, claims, finalization or credit withdrawals, so it cannot stop
  deposits into existing vaults. A migration notice must tell owners to withdraw in full, which
  closes the vault, and the website must stop offering top-ups;
- `setClaimFee`: cut the global claim fee at once, or schedule a raise that takes effect 30 days
  later, within the 1% bytecode cap (`applyClaimFee`, which anyone may call, only records a raise
  whose time has come);
- `setFeeRecipient`: change or remove the fee recipient at once; a recipient set after a period with
  none is in force only 30 days later;
- `sweepSurplus`: move the native coin's or a listed token's balance above the accounted lanes;
- transfer ownership in two steps (`renounceOwnership` is disabled).

It cannot add or remove a token. On v1 it can pause creation, change the fee at once with no delay,
change or unset the fee recipient, sweep surplus in any token, and transfer ownership.

## Retired reminder billing contract

Paid reminder sales are disabled on the website and the reminder watcher is not running; Will & Key
sends no alerts of any kind. Sales on `NotifySubscription`
(`0x60749aF621180de1DC05DB4f3d158D09dE979dC6`) are also disabled **on chain** since 2026-09-26: the
admin called `setPrice(type(uint256).max)` in tx
`0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca` (block 51823544; recorded in
`deployments/base.json` as `subscriptionSalesDisabled`), so every `subscribe` now reverts
(`ZeroAmount`). Only the admin could reverse that. Status of audit finding F23: resolved by this
admin action. The contract must still not receive funds or direct calls; refund requests for earlier
payments are handled under the site's terms.

## Reporting a vulnerability

Until a dedicated private security mailbox is published, report a suspected vulnerability by
opening a GitHub issue containing **only a minimal, non-exploitable description** and asking for a
private contact channel. Do not publish working exploit steps, secrets, personal information, or
affected-user data in a public issue.

Never send a seed phrase, private key, wallet backup, one-time password, or recovery code. The
project will never need one to investigate a report.

Please include, once a private channel is established:

- affected contract (v2 or v1), function, or website path;
- Base or Base Sepolia transaction hashes and block numbers, if applicable;
- prerequisites, impact, and the smallest safe reproduction;
- whether disclosure is already public or any funds appear to be at immediate risk.

Receipt of a report is not a promise of a bounty. Any future bounty terms must be published before
the report to apply.

## Supported targets

The exact review target, deployed addresses, bytecode hashes, build settings, known limitations,
and verification commands are maintained in [AUDIT_SCOPE.md](AUDIT_SCOPE.md). The website terms
and privacy notice are in `site/terms.html` and `site/privacy.html`.
