# Security policy

## Current security status

InheritanceVault is deployed on Base and has completed an internal adversarial review, 63 unit
tests, and a 14-step local watcher failure/recovery scenario. It has **not** completed an
independent third-party audit or a full-duration Base Sepolia lifecycle test. Treat the contracts
as experimental and do not use material value yet.

The deployed vault is immutable. If a serious contract defect is confirmed, the remediation is a
new reviewed deployment and a clearly communicated migration; the existing bytecode cannot be
patched. No administrator can move user vault balances or payout credits.

Paid reminder sales are disabled. `NotifySubscription` remains on-chain because it is immutable,
but it is retired and must not receive funds or direct calls.

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
