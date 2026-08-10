# InheritanceVault

A self-custody **dead man's switch** for EVM chains: deposit ETH/BNB or an ERC20, name an heir,
and check in on a schedule you chose. Stop checking in for longer than your inactivity period and
your heir may claim; a challenge window then runs during which you can still veto; after it,
anyone can finalize and your heir is paid. No custodian, no lawyer holding a seed phrase, no
key-sharing while you're alive.

Target chains: **Base** (ETH L2) primary, **BNB Chain** supported. Anything Cancun-compatible works.

## How it works

```
create ──► ACTIVE ──(deadline passes, heir claims)──► CLAIM_PENDING ──(window passes)──► SETTLED
              │  ▲                                        │
              │  └───────── owner veto / any owner action ┘
              └──(owner withdraws everything)──► CLOSED
```

- **Check-in** (`checkIn` / `checkInMany`): one cheap transaction resets your inactivity timer.
  One call refreshes a whole split estate (one vault per asset/heir).
- **Claim**: only the named beneficiary can initiate, only after your timer expires. The
  challenge window (min 7 days) is your veto period — any action from your key cancels the claim
  and restarts the clock.
- **Hard date**: `absoluteDeadline + challengeWindow` is a guaranteed inheritance date against a
  *lost* owner key and runaway check-in automation. Check-ins stop working at the horizon; only
  your live key can extend it.
- **Lost wallet insurance**: an optional S/KEY hash-chain lets you keep the vault alive from a
  32-byte paper seed even after losing your wallet — liveness only, never authority.
- **Payouts** go through a pull-payment credit lane: settlement never makes an external call, so
  a hostile recipient can't jam a vault.

## Trust model, honestly

| Scenario | Outcome |
|---|---|
| Owner key lost | Vault expires, heir inherits. This is the designed recovery. |
| Owner key stolen | Stolen vault. The owner key is the ultimate authority — this contract defends against absence, not compromise. |
| Heir key lost (owner alive) | Owner names a new heir with `setBeneficiary`. |
| Heir key lost (owner gone) | Funds stuck. Keeping the heir's address current is part of owning a vault. |
| Admin misbehaves | Can pause *new* vault creation and sweep force-fed surplus. Cannot touch a wei of locked or credited value — that is arithmetic (`surplus()`), not a promise. |

Not supported, deliberately: rebasing tokens, NFTs, multiple assets per vault.

## Revenue

A claim fee in basis points is taken **only when an inheritance settles** — never on deposits,
check-ins, or owner withdrawals. Three bounds protect users:

1. `MAX_CLAIM_FEE_BPS = 100` (1%) is burned into the bytecode.
2. Each vault snapshots the fee at creation as a **ceiling** — the admin can never raise it for
   an existing vault; a lower global rate at settlement time wins.
3. No fee recipient configured ⇒ no fee taken. An abandoned admin can never strand a claim.

## Development

```bash
npm install
npm test        # 63 tests
npm run build
```

Deploy keys are env-only (`DEPLOYER_KEY`), never committed. Networks configured: `base`,
`baseSepolia`, `bnb`, `bnbTestnet`.

## Lineage

The state machine is adapted from PQVault (Ozone Chain), which survived an adversarial
multi-round audit. The post-quantum WOTS-K256 signature layer was deliberately not carried over:
this contract targets mainstream wallets, where ordinary ECDSA keys are the authority — see the
trust-model header in [`contracts/InheritanceVault.sol`](contracts/InheritanceVault.sol) for
exactly what that trades away.

## Production status

The immutable contracts are deployed on Base:

- `InheritanceVault`: `0xC821849A1D74959753450409b594b23eCE7fEe2f`
- Retired reminder billing contract: `0x60749aF621180de1DC05DB4f3d158D09dE979dC6`

Paid reminder sales are disabled. The retired billing contract is immutable and cannot be paused,
so do not send it funds or call it directly. The website is a static Cloudflare Pages deployment
with locally hosted dependencies and a restrictive Content Security Policy.

**Status: deployed, internally reviewed, not independently audited.** The live
`InheritanceVault` runtime bytecode exactly matches the compiler artifact recorded for this
repository. The internal adversarial review is evidence, not an independent audit. Do not use
material value until an independent review and the full Base Sepolia lifecycle test are complete.
See [AUDIT_SCOPE.md](AUDIT_SCOPE.md), [AUDIT-2026-08-09.md](AUDIT-2026-08-09.md), and
[SECURITY.md](SECURITY.md).
