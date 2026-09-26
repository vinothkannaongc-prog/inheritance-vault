# InheritanceVault

A self-custody **dead man's switch** for EVM chains: deposit ETH or a supported ERC-20 token, name
an heir, and check in on a schedule you chose. Stop checking in for longer than your inactivity
period and your heir may claim; a challenge window then runs during which you can still veto;
after it, anyone can finalize and your heir's payout is credited to them. No custodian, no lawyer
holding a seed phrase, no key-sharing while you're alive.

**Will & Key sends no alerts of any kind.** Nobody will notify you if your timer expires or a claim
is filed, your wallet will not show a claim against your vault, and nobody notifies your heir. The
veto only helps if you look.

Deployed on **Base** (chain id 8453). **BNB Chain is planned, not deployed.** Those are the only
chains the contract has been reviewed for. Do not deploy this bytecode on a chain whose native coin
also has an ERC-20 address (Celo and Moonbeam are examples): there the admin's surplus sweep could
reach vault balances.

## Security status (2026-09)

- **Live contract (v1):** `InheritanceVault` at `0xC821849A1D74959753450409b594b23eCE7fEe2f` on Base,
  immutable and source-verified on Basescan. Its source is `contracts/InheritanceVault.sol` at
  commit `b8baf34`. In the working tree the same source is kept as
  [`contracts/v1/InheritanceVaultV1.sol`](contracts/v1/InheritanceVaultV1.sol), identical except
  for the contract name and a header comment. The working-tree
  [`contracts/InheritanceVault.sol`](contracts/InheritanceVault.sol) is the **v2 source, undeployed**.
- **Internal review (2026-08):** [AUDIT-2026-08-09.md](AUDIT-2026-08-09.md), run by the same system
  that wrote the code. Not independent.
- **Preliminary audit (2026-09):** performed by AI auditing agents at the project's request. Not
  independent. 47 findings (5 medium, 21 low, 21 informational; none rated high or critical),
  published at <https://willandkey.com/audit>, with executable evidence against v1 in
  [audit/2026-09-preliminary/](audit/2026-09-preliminary/).
- **Fixes:** the live contract cannot be changed. Contract fixes exist only as undeployed source for
  a future version (v2). For the live contract, findings are handled by disclosure (this file, the
  site), app changes and operating commitments. Everything below describes the live v1 contract.
- **Independent third-party audit:** still pending. Do not use material value until it and the full
  Base Sepolia lifecycle test are complete.

## How it works

```
create ──► ACTIVE ──(deadline passes, heir claims)──► CLAIM_PENDING ──(window passes, anyone finalizes)──► SETTLED
              │  ▲                                        │
              │  └──── owner veto / cancelling action ────┘
              └──(owner withdraws everything)──► CLOSED
```

- **Check-in** (`checkIn` / `checkInMany`): one cheap transaction resets your inactivity timer, but
  never past your horizon. One call refreshes a whole split estate (one vault per asset/heir);
  it skips vaults with a claim pending or past their horizon. A check-in never cancels a claim.
- **Claim**: only the named beneficiary can initiate, only after your timer expires. The payout
  address is chosen when the claim starts and cannot be changed afterwards. The challenge window
  (min 7 days; we recommend at least 14) is your veto period.
- **What cancels a claim:**
  - Before the horizon: Veto (`abortClaim`), `setBeneficiary`, `setInactivityPeriod`,
    `setCheckInChain`, `extendHorizon`, or any `withdraw`. Each needs your wallet key.
  - Not a cancellation: `checkIn` (reverts `ClaimPendingUseAbort`), `checkInMany` (skips the
    vault), `checkInByChain` and `topUp` (revert `VaultNotActive`), and ordinary wallet activity.
    Only transactions sent to this contract count.
  - At or after the horizon: only `extendHorizon` to at least now + `inactivityPeriod`, or
    withdrawing the entire balance.
  - The end of the window is not a veto deadline. `finalizeClaim` becomes callable, but until a
    finalize transaction is mined the owner key can still cancel. Heirs should finalize promptly;
    owners should not count on the grace.
  - A veto must be included on chain in time. On Base that depends on the sequencer; if it is down
    or censoring, a transaction can be forced in through Ethereum L1, which can take up to about
    12 hours. On BNB Chain it depends on the validators.
- **Horizon (long-stop)**: `absoluteDeadline` is the last date to which check-ins can push the
  deadline, so runaway check-in automation cannot defer the inheritance forever. It is not a
  guaranteed payout date. `guaranteedInheritanceAt` (= horizon + challenge window) is the earliest
  finalization if the heir claims exactly at the horizon and the owner key does nothing; the heir
  still has to claim and finalize. Past the horizon the owner key can still stop a claim by
  extending the horizon (at least one inactivity period ahead each time, repeatable) or by
  withdrawing everything. Never give `extendHorizon` to automation.
- **Paper-seed check-in chain (advanced, no app support)**: an optional S/KEY hash chain
  (`setCheckInChain` / `checkInByChain`) lets whoever holds a 32-byte paper seed keep the vault
  alive after you lose your wallet. The app has no screen for it. The construction is specified in
  [docs/CHECKIN-CHAIN.md](docs/CHECKIN-CHAIN.md); use a fresh seed for every vault and every chain,
  and never re-install an old seed or anchor.
  - A chain check-in counts only if it is mined **strictly before** the deadline. Once the heir has
    started a claim the chain cannot stop it and its values cannot be used while the claim is
    pending; only your wallet key can stop it. If your wallet key later cancels the claim, unused
    values work again, so a leaked seed stays dangerous until you install a new chain. Submit at
    least a day early.
  - Chain values are **bearer credentials**. They cannot withdraw, change the heir or veto a claim,
    but whoever holds the seed, or any unused value, can postpone your heir's claim by up to
    `count` × `inactivityPeriod`, never past the horizon. Size `count` to the time you actually
    need and guard the seed like a key. A value that was broadcast but never mined stays usable by
    whoever holds it.
  - While you still hold the key, and before the horizon, installing a new chain from a fresh
    random anchor replaces a leaked one. An anchor of zero is rejected, so v1 has no other way to
    disarm a chain. After the key is gone there is no way at all.
- **Payouts** go through a pull-payment credit lane: settlement never makes an external call, so
  a hostile recipient can't jam a vault.

## Supported tokens

Supported: the chain's native coin (ETH on Base) and plain ERC-20 tokens that live at a single
contract address, move exactly the amount requested, never change a holder's balance by themselves,
and have no transfer limits. **The live contract does not enforce this: it accepts any token
address.** Choosing a supported token is up to the user.

Not supported, and the guarantees in this file do not hold for them:

- tokens reachable through more than one address (double-entry or proxy tokens, or a native coin
  with an ERC-20 facade): `surplus()` is computed per address, so the admin's sweep can take the
  vaults' balance through the second address;
- rebasing, interest-bearing (aToken-style) or reflection tokens whose balance grows on its own:
  the growth is surplus the admin can sweep, and the heir inherits only the nominal deposit;
- tokens that can debit the vault by more than it pays out (fee-on-top, negative rebasing): all
  vaults in a token share one balance and payouts are first come, first served, so the last
  person to withdraw can get nothing;
- tokens with per-transfer caps, max-wallet limits or transfer cooldowns: a credit is withdrawn in
  one transfer, so a credit above the limit can be frozen, possibly permanently;
- NFTs (ERC-721/1155), and more than one asset per vault.

## Trust model, honestly

| Scenario | Outcome |
|---|---|
| Owner key lost | Vault expires; the heir claims and finalizes. This is the designed recovery. |
| Owner key stolen | Stolen vault. The owner key is the ultimate authority — this contract defends against absence, not compromise. |
| Heir key lost (owner alive) | Owner names a new heir with `setBeneficiary`. |
| Heir key lost (owner gone) | Funds stuck permanently: only the named heir can claim, nothing happens at the horizon, and no admin rescue exists. |
| Nobody is watching | Will & Key sends no alerts. A claim or an expired timer goes unnoticed unless the owner or heir checks. |
| Token issuer acts | All vaults in one token share one balance at the vault contract. An issuer with pause, blocklist, upgrade or wipe powers (Circle can pause and blocklist USDC) can freeze every vault in that token at once. Claims still settle on schedule; payouts wait until the freeze lifts. A wipe is a loss the contract cannot prevent. |
| Admin misbehaves | Can pause *new* vault creation, change the global claim fee (up to 1%, immediately; a vault is never charged more than its creation-time rate), change or unset the fee recipient, sweep surplus, and transfer administration in two steps. For ETH and supported single-address tokens it cannot take a wei of locked or credited value beyond the settlement fee: `surplus()` is the balance minus `totalLocked` minus `totalCredited` for the same token address. That arithmetic does not protect unsupported tokens (above). |

## Admin

Since 2026-09-24 the owner of both contracts, and the fee recipient, is a single Ledger
hardware-wallet key, `0x883C821103B5415C53B11E584D3592205B5CdCA3`. It is not a multisig; moving
administration to a multisig is recommended. It was moved off the deploy key
(`0x4306a8875a04c0FbaC76CE2FC860E0b3c7aAd986`, which now holds no admin power) with
`scripts/transfer-admin.ts` and a two-step accept. Handover transactions on Base (also in
`deployments/base.json`):

| Step | Transaction |
|---|---|
| vault `setFeeRecipient` | `0x83f734ad7bf258d2d6daf64f64bb7562565d199ea0d506ae1e45fe2c5851e894` |
| vault `transferOwnership` | `0x29bc7cdd3ea9bc5b611645a231d22515d536e1bbf2ac42aa134041e875343f06` |
| subscription `transferOwnership` | `0x556b174a26f670fe481d08d6fef92cdaae8b789ae728effc8c462d962ddd0527` |
| vault `acceptOwnership` | `0x5a0bb97d2d421eccc399b6727c49ea37c008a0a7bb782d53cf5a59d1ce85d532` |
| subscription `acceptOwnership` | `0xff034fda9c4065a5dfa6579fa6afba3c6fb6be55da2c5b71ea323780077fd906` |

Admin functions on `InheritanceVault`:

- `setCreationPaused(bool)`: blocks only `createVault`. Top-ups, check-ins, withdrawals, claims,
  finalization and credit withdrawals keep working, so the pause cannot stop deposits into
  existing vaults. In a migration, owners should withdraw in full, which closes the vault.
- `setClaimFee(uint16)`: 0–100 bps, effective immediately, no delay.
- `setFeeRecipient(address)`: effective immediately; `address(0)` means no fee is taken at
  settlement.
- `sweepSurplus(token, to)`: moves `surplus(token)`, the balance above `totalLocked + totalCredited`
  for that token address.
- `transferOwnership` / `acceptOwnership` (two-step). `renounceOwnership` is disabled.

On the retired `NotifySubscription`: `setPrice`, `withdraw`, and the same ownership functions.

## Revenue

A claim fee in basis points is taken **only when an inheritance settles** — never on deposits,
check-ins, or owner withdrawals. How the rate is set in the live contract:

1. `MAX_CLAIM_FEE_BPS = 100` (1%) is burned into the bytecode.
2. Each vault snapshots the global rate in force when `createVault` is mined as its **ceiling**.
   The admin can never raise a vault above it. `setClaimFee` has no delay, so the snapshot is
   whatever rate is in force in that block.
3. Lower global rates apply only while they are in force. A cut that is later reversed does not
   stay with a vault; it can again pay up to its ceiling.
4. `initiateClaim` locks `min(ceiling, global rate)`. `finalizeClaim` applies the lower of that
   locked rate and the global rate in force at settlement, so a rise after the claim starts can
   never take the fee above the locked rate. A cut helps only if it is still in force when the
   claim is finalized: in the live contract the admin can reverse a cut at any moment, with no
   delay.
5. No fee recipient configured at settlement ⇒ no fee taken, so an abandoned admin can never strand
   a claim. The reverse also holds: a claim started while no recipient was set is charged its
   locked rate if a recipient is set before settlement.

## Development

```bash
npm install
npm test          # contract tests for the source in the working tree
npm run build
npm run audit:v1  # v1 evidence suite; expected to fail, see audit/2026-09-preliminary/README.md
```

Deploy keys are env-only (`DEPLOYER_KEY`), never committed. Networks configured: `base`,
`baseSepolia`, `bnb`, `bnbTestnet`.

## Lineage

The state machine is adapted from PQVault (Ozone Chain), which survived an adversarial
multi-round audit. The post-quantum WOTS-K256 signature layer was deliberately not carried over:
this contract targets mainstream wallets, where ordinary ECDSA keys are the authority — see the
trust-model header of the live v1 source,
[`contracts/v1/InheritanceVaultV1.sol`](contracts/v1/InheritanceVaultV1.sol), for exactly what
that trades away. (The header in the working-tree `contracts/InheritanceVault.sol` describes the
undeployed v2.)

## Production status

The immutable contracts are deployed on Base:

- `InheritanceVault`: `0xC821849A1D74959753450409b594b23eCE7fEe2f`
- Retired reminder billing contract: `0x60749aF621180de1DC05DB4f3d158D09dE979dC6`

Paid reminder sales are disabled on the website and the reminder watcher is not running. Sales are
also disabled **on chain** since 2026-09-26: the admin called `setPrice(type(uint256).max)` on the
retired billing contract (tx
`0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca`, block 51823544, recorded in
`deployments/base.json` as `subscriptionSalesDisabled`), so every `subscribe` now reverts
(`ZeroAmount`). Only the admin could reverse that. Do not send the contract funds or call it
directly; refund requests for earlier payments are handled under the site's terms. The website is
a static Cloudflare Pages deployment with locally hosted dependencies and a restrictive Content
Security Policy.

**Status: deployed; internally reviewed and preliminarily audited, neither independently; no
independent third-party audit yet.** The live `InheritanceVault` runtime bytecode exactly matches the compiler
artifact recorded for this repository. Neither review is an independent audit. See
[AUDIT_SCOPE.md](AUDIT_SCOPE.md), [AUDIT-2026-08-09.md](AUDIT-2026-08-09.md),
[audit/2026-09-preliminary/](audit/2026-09-preliminary/) and [SECURITY.md](SECURITY.md).
