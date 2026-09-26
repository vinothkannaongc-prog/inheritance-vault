# Security policy

## Current security status (2026-09)

InheritanceVault is deployed on Base (`0xC821849A1D74959753450409b594b23eCE7fEe2f`). Its deployed
(v1) source shipped with 63 passing unit tests, and the former reminder watcher passed a 14-step
local failure/recovery scenario. Two reviews exist, and neither is independent:

- The internal review ([AUDIT-2026-08-09.md](AUDIT-2026-08-09.md)) was run by the same system that
  wrote the code.
- A **preliminary audit** (2026-09) was performed by AI auditing agents at the project's request. It
  reported 47 findings (5 medium, 21 low, 21 informational), published at
  <https://willandkey.com/audit> with executable evidence in
  [audit/2026-09-preliminary/](audit/2026-09-preliminary/).

It has **not** completed an independent third-party audit or a full-duration Base Sepolia lifecycle
test. Treat the contracts as experimental and do not use material value yet.

The deployed vault is immutable. The preliminary audit's contract fixes exist only as undeployed
source for a future version (v2); the live contract keeps the behaviour the audit describes, and
those findings are handled by disclosure, app changes and operating commitments. If a serious
contract defect is confirmed, the remediation is a new reviewed deployment and a clearly
communicated migration; the existing bytecode cannot be patched.

For ETH and supported single-address tokens, the administrator cannot take any value from a vault
balance or payout credit beyond the settlement fee: `surplus()` is the balance minus `totalLocked`
minus `totalCredited` for the same token address. The fee is at most the vault's creation-time
ceiling (never above 1%). One fee caveat: a claim that starts while no fee recipient is set is
still charged its locked rate if the administrator sets a recipient before settlement. The
guarantee does **not** hold for unsupported tokens (tokens reachable through a second address,
rebasing, interest-bearing or reflection tokens, tokens that debit more than they pay out, and
capped, max-wallet or cooldown tokens); see the README. It also does not protect against a token
issuer freezing or wiping the vault contract's balance of its token.

## Administrator

Since 2026-09-24 the administrator of both contracts, and the fee recipient, is a single Ledger
hardware-wallet key, `0x883C821103B5415C53B11E584D3592205B5CdCA3`, not a multisig. The five handover
transactions are in `deployments/base.json` and the README. On the vault it can:

- `setCreationPaused`: pause or unpause **new vault creation only**. The pause does not stop
  top-ups, check-ins, withdrawals, claims, finalization or credit withdrawals, so it cannot stop
  deposits into existing vaults. A migration notice must tell owners to withdraw in full, which
  closes the vault, and the website must stop offering top-ups;
- `setClaimFee`: change the global claim fee, immediately, within the 1% bytecode cap;
- `setFeeRecipient`: change or unset the fee recipient, immediately;
- `sweepSurplus`: move a token's balance above the accounted lanes for that token address;
- transfer ownership in two steps (`renounceOwnership` is disabled).

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

- affected contract, function, website path, or watcher component;
- Base or Base Sepolia transaction hashes and block numbers, if applicable;
- prerequisites, impact, and the smallest safe reproduction;
- whether disclosure is already public or any funds appear to be at immediate risk.

Receipt of a report is not a promise of a bounty. Any future bounty terms must be published before
the report to apply.

## Supported targets

The exact review target, deployed addresses, bytecode hashes, build settings, known limitations,
and verification commands are maintained in [AUDIT_SCOPE.md](AUDIT_SCOPE.md). The website terms
and privacy notice are in `site/terms.html` and `site/privacy.html`.
