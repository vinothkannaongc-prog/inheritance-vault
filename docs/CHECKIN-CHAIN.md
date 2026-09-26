# The check-in chain: specification

**Status: advanced, with no app support.** The website app cannot install a chain or relay a
check-in. You need the reference generator (`scripts/checkin-chain.ts`) and a way to send
transactions to the contract directly.

Two contracts are covered:

- **v1** is the InheritanceVault deployed on Base at `0xC821849A1D74959753450409b594b23eCE7fEe2f`.
  It is immutable. It checks a plain keccak step, so every protection described for v1 below is
  off-chain, in how the chain is built.
- **v2** is the fixed source in `contracts/InheritanceVault.sol`. **It is not deployed.** It binds
  every step on chain.

## What a chain is for, and what it is not

A check-in chain lets a vault owner who has lost their wallet key keep the vault alive from a
32-byte paper seed while they coordinate with their heir. Anyone may submit a check-in value
(`checkInByChain` is permissionless and relayable). Possession of the value is the
authentication.

- **It proves liveness and nothing else.** A chain value cannot veto a pending claim, withdraw,
  or change the heir. A keyless owner's real endgame is for the named heir to claim and hand the
  funds back.
- **Unspent values are bearer credentials.** Whoever holds the seed, or the next value, can
  postpone the heir by up to one inactivity period per value, as far as the vault's horizon. Size
  `count` to the keyless coordination window you actually need, not to a lifetime. A pending
  claim holds them off, but on v2 the heir can cancel their own claim (`beneficiaryCancelClaim`,
  for example to correct a payout address). Until the heir claims again, the vault is ACTIVE, and
  any holder of an unspent value can check in and postpone the heir by a full period.
- **A check-in is safe only if it is mined strictly before the deadline.** From the deadline on,
  the heir can start a claim, even in front of your check-in, and while a claim is pending
  `checkInByChain` reverts. Submit at least a day before the deadline, never at the wire.
- **Check-ins move the deadline only as far as the horizon.** The first check-in within one
  inactivity period of the horizon still counts: it moves the deadline to the horizon itself (a
  partial extension) and spends a value. From then on the deadline is pinned at the horizon and
  no check-in can move it. v1 still accepts one there and spends a value for nothing. v2 reverts
  `DeadlinePinnedAtHorizon` and keeps the value unspent. So keep the relayer running until the
  vault is pinned (warnings bit 4, which `next` reports as "the deadline is pinned at the
  horizon"); a relayer that stops one period early leaves the deadline short of the horizon, and
  the heir can claim that much earlier. The remedy for a pinned vault is `extendHorizon`, which
  needs the owner key.

## Construction

A chain for one vault installation is a sequence of 32-byte values:

```
x_0 = tip(seed, context)          derived: the seed itself never appears on chain
x_i = step(x_{i-1}, context)      for i = 1 .. count
anchor = x_count                  what setCheckInChain installs, with count
```

While `getVault(owner, vaultId).hbLeft` is `L`, the value to submit is `x_{L-1}`. So the values
are revealed in the order `x_{count-1}, x_{count-2}, ..., x_0`, which is the order the generator
prints them. Each accepted check-in stores the submitted value as the new `hbAnchor` and
decrements `hbLeft`. The last check-in reveals `x_0`, the derived tip, never the seed.

The context is `(chainId, vault, owner, vaultId, epoch)`:

| Field | Meaning |
|---|---|
| `chainId` | the chain's id (8453 for Base) |
| `vault` | the InheritanceVault contract address |
| `owner` | the vault owner's address |
| `vaultId` | the vault's id under that owner |
| `epoch` | v2: the vault's installation epoch (below). v1: an install index you choose |

All hashes are keccak-256, and `abi.encode` is Solidity's. The tip's tag is a Solidity `string`,
so the tip encodes the types `(string, uint256, address, address, uint256, uint32, bytes32)`; the
v2 step encodes `(bytes32, uint256, address, address, uint256, uint32, bytes32)`:

```
v1 tip(seed) = keccak256(abi.encode("WillAndKey/hb/v1", chainId, vault, owner, vaultId, installIndex, seed))
v2 tip(seed) = keccak256(abi.encode("WillAndKey/hb/v2", chainId, vault, owner, vaultId, epoch, seed))

v1 step(x)   = keccak256(x)                                   the raw 32 bytes, as v1 checks
v2 step(x)   = keccak256(abi.encode(HB_DOMAIN, chainId, vault, owner, vaultId, epoch, x))
HB_DOMAIN    = keccak256("WillAndKey.CheckInChain.v2")        the contract's HB_DOMAIN()
```

On v1 the chain is therefore plain keccak256 from a context-bound tip: v1 checks
`keccak256(value) == hbAnchor` and nothing else, so everything that binds a v1 chain to its vault
and chain lives in the tip. The v2 step is exactly the contract's `hbStep(owner, vaultId, epoch,
x)` view. The generator calls that view to check its own arithmetic before it prints anything,
and `scripts/deploy.ts` checks it against every new deployment.

A worked check: with `CHECKIN_SEED` set, `npx ts-node scripts/checkin-chain.ts anchor --mode v1 --chain-id 8453 --vault
<contract> --owner <owner> --vault-id 0 --epoch 1 --count 3` prints the anchor, the count and the
three values; hashing each printed value with plain keccak256 gives the one printed above it, and
the first gives the anchor.

### The installation epoch (v2)

Every vault has an `hbEpoch`. It is 0 until a chain is first installed, and every
`setCheckInChain` call, a disarm included, increments it. A chain works only on the epoch it was
built for, so re-arming never revives an earlier chain, even one built from the same seed.

**Build a chain for `getVault(...).hbEpoch + 1`**, print that epoch next to the seed, and install
it with the epoch-checked form:

```solidity
setCheckInChain(uint256 vaultId, bytes32 anchor, uint32 count, uint32 expectedEpoch)
```

That form reverts `CheckInChainEpochMismatch(expected, next)` unless the installation gets
exactly `expectedEpoch`. The three-argument form `setCheckInChain(vaultId, anchor, count)` does
not check. With it, a chain built against a stale epoch, or an old printed chain installed
again, is accepted and dead from the start, and nothing says so until a keyless owner needs it.
`CheckInChainSet(owner, vaultId, anchor, count, epoch)` logs the epoch of every installation.

### The install index (v1)

v1 has no epoch. The generator's v1 mode binds the context through the tip only, so you choose
an install index: 1 for the first chain on that vault, then +1 for every re-installation. Print
it next to the seed. **Never use an install index twice on the same vault.** A repeated index
rebuilds a chain whose values may already be public.

## Disarming (v2)

`setCheckInChain(vaultId, 0, 0)` disarms the chain: `hbAnchor` and `hbLeft` become 0, the epoch
moves on, and every remaining value is refused (`InvalidCheckInChain`). Use it when a seed is
exposed. It is an owner action like any other: it resets the clock and, before the horizon,
ends a pending claim. Past the horizon it reverts `HorizonReached`, like every other chain
installation. There a chain cannot fire anyway, and a disarm that ended a claim would be a veto.

v1 cannot disarm, because it refuses a zero anchor. On v1, overwrite an exposed chain with a
chain built from a fresh seed. `getVault` will then report a chain as armed.

`hbAnchor == 0` means no chain is armed. v2 refuses a zero value as a check-in (`BadCheckIn`),
so a spent chain can never pass for a disarmed one.

`hbLeft` is the count the owner declared. The contract cannot verify it. If you overstate it,
warnings bit 3 ("the declared count is used up") never rises on a chain that is really dead.
The generator derives the anchor from the count you give it, so the two always agree.

## Using the generator

The seed is read from the `CHECKIN_SEED` environment variable, so it stays out of your shell
history. Run the commands on an offline machine where you can.

```sh
# A fresh seed, for ONE vault on ONE chain. Write it down and keep it offline.
npx ts-node scripts/checkin-chain.ts seed

# v2, reading the epoch from the vault (and checking the step against the contract):
CHECKIN_SEED=0x... npx ts-node scripts/checkin-chain.ts anchor --mode v2 --rpc <url>     --vault <contract> --owner <owner> --vault-id <id> --count 12

# The value to submit next (read from the vault; refused if it does not lead to the anchor):
CHECKIN_SEED=0x... npx ts-node scripts/checkin-chain.ts next --mode v2 --rpc <url>     --vault <contract> --owner <owner> --vault-id <id>

# v1 (the Base deployment): the same, with --mode v1 and --epoch <your install index>.
# Offline: pass --chain-id and --epoch instead of --rpc, and --left <hbLeft> for `next`.
```

`anchor` prints, in this order:

```
mode v2, chain 8453, vault contract 0x..., owner 0x..., vault 0
anchor 0x...                          the value setCheckInChain installs
count 12
epoch 3                               v2; in v1 mode: "install index 3"
call setCheckInChain(0, 0x..., 12, 3) v1 mode prints the three-argument form

(three reminder lines: bearer credentials; submit at least a day early)
     1  hbLeft     12  0x...          submit first, while getVault shows hbLeft 12
     2  hbLeft     11  0x...
   ...
    12  hbLeft      1  0x...          the last; it is the derived tip, never the seed
```

The numbered lines are every value of the chain, in the order they must be revealed. They are
the paper backup: an owner without the generator can submit line `k` while `hbLeft` is
`count - k + 1`. They are also bearer credentials (see Rules). `--no-values` prints only the
install lines.

`next` also warns when the deadline is pinned at the horizon. In v2, `checkInByChain` then
reverts until the owner extends the horizon. In v1 it is accepted, moves nothing and spends the
value. Before that point `next` prints no warning, because the check-in still moves the
deadline, if only to the horizon.

The generator refuses to print anything, and exits with an error, when:

- the seed is zero, or not 32 bytes of hex (`anchor` and `next`);
- the epoch is outside 1 to 2^32 - 1 (`anchor` and `next`);
- with `--rpc` in v2 mode, the `--epoch` you pass disagrees with the vault: `anchor` needs
  `hbEpoch + 1`, `next` needs `hbEpoch`;
- with `--rpc`, no chain is armed on the vault (never installed, or disarmed) (`next`);
- the chain is used up: `hbLeft` is 0 (`next`);
- with `--rpc`, the seed, epoch and vault do not lead to the anchor installed on chain ("do not
  submit"), for example after the owner re-armed the vault with another chain (`next`).

## Rules

1. **Use a fresh seed for every vault and every chain** (Base, BNB Chain, every testnet). The
   derivation already binds each chain to its vault, chain, owner and installation, so a value
   revealed on one is useless on another. But a leaked seed rebuilds every chain made from it,
   so one seed per vault per chain keeps a leak to one vault.
2. Generate every chain with the reference generator, or with an implementation that reproduces
   its output. Never install a chain whose tip is the raw seed. The last check-in reveals the
   tip, and on v1 a revealed seed can be walked forward into every later chain built from it.
3. On v1, use a fresh install index for every installation on a vault. On v2, use the
   epoch-checked `setCheckInChain`.
4. Never re-install a printed anchor. Generate a new chain.
5. **Chain values are bearer credentials.** Whoever holds the seed, or any unspent value, can
   postpone your heir by one inactivity period per value, as far as the horizon. Store the seed
   and the printed values like a spare key to the vault's timer.
6. **Size `count` sensibly.** It is the number of inactivity periods a holder of the seed can
   add. Pick the keyless coordination window you actually need (for example 6 with a 30-day
   period is about six months), not a lifetime.
7. **Submit each check-in at least a day before the deadline.** A check-in counts only if it is
   mined strictly before the deadline; from the deadline on the heir can start a claim, and a
   pending claim makes `checkInByChain` revert.
8. If the seed may be exposed: on v2, disarm. On v1, install a chain from a new seed.

## Errors (v2)

| Error | Meaning |
|---|---|
| `InvalidCheckInChain()` | no chain is armed (never installed, or disarmed); or, on install, only one of anchor and count was zero, or count > 100,000 |
| `CheckInChainExhausted(vaultId)` | `hbLeft` is 0 |
| `BadCheckIn(vaultId)` | the value is zero, or `hbStep(owner, vaultId, hbEpoch, value) != hbAnchor` |
| `CheckInAlreadyUsed(vaultId, deadline)` | the value was just spent, or the vault was already checked in at this second; the value is not spent |
| `DeadlinePinnedAtHorizon(horizon)` | the deadline already sits at the horizon; the value is not spent; `extendHorizon` first |
| `HorizonReached(horizon)` | past the horizon; nothing can check in or install a chain |
| `CheckInChainEpochMismatch(expected, next)` | the epoch-checked install would have produced a different epoch |
