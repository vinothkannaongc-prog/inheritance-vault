# Will & Key notify — RETIRED

**Status (2026-09): retired and not running.** Will & Key sends no alerts of any kind: nobody is
notified when a vault's timer expires, a claim is filed or a claim settles, and no heir is told
that a vault has become claimable. This folder is kept as the record of the former reminder
service and of the code the audits reviewed. It is not a product, it is not sold, and it has no
users.

The watcher polled vault state (read-only, holding no keys, able to sign nothing) and sent
escalating email alerts. Paid reminders were billed through `NotifySubscription.sol`.

## Do not pay the billing contract

`NotifySubscription` on Base (`0x60749aF621180de1DC05DB4f3d158D09dE979dC6`) is retired, and its
sales are disabled on chain since 2026-09-26: the admin (the Ledger key
`0x883C821103B5415C53B11E584D3592205B5CdCA3`) called `setPrice(type(uint256).max)` in tx
`0xf3485b1b4ec0f887838a2eec5181c3815e68913bc23b68570c3b635693a56cca` (block 51823544; recorded in
`deployments/base.json` as `subscriptionSalesDisabled`), so every `subscribe` now reverts
(`ZeroAmount`) and no new `paidUntil` time can be bought. Only the admin could reverse that. Do not
send it funds. Do not deploy `NotifySubscription` on any other chain.

## Before any restart

Do not restart this watcher, on Base or on a new chain such as BNB, until all of the following are
done:

- the alert texts have been checked against the live contract so that none sends an owner to an
  action that reverts (they were corrected in 2026-09: a check-in does not cancel a claim, and
  past the horizon only `extendHorizon` or a full withdrawal does);
- `LOG_PAGE` and the first-run lookback have been revalidated against that chain's RPC
  `eth_getLogs` limits and block time (9,000 blocks is about 5 h on Base but under 2 h on BNB, and
  some BNB RPCs refuse `eth_getLogs` for such ranges);
- `config.subscription.enforce` stays off, because the billing contract is retired;
- the site and terms are updated to say, accurately, what is being sent again.

## Alerts it used to send

| Recipient | Trigger | Note |
|---|---|---|
| Owner | 14 / 7 / 3 / 1 days before deadline | most-urgent tier only; re-arms after every check-in |
| Owner | deadline expired | heir can now claim |
| Owner | **claim initiated** | the veto window is running |
| Owner | horizon within 30 days | check-ins stop working at the horizon |
| Owner | check-in chain exhausted | warnings bit 3 |
| Heir (optional) | vault claimable / claim finalizable | opt-in per watch |

Dedupe keys embed the value they alert about (deadline, claimInitiatedAt), so a check-in or a
new claim re-arms alerts by construction. Missing a cron run is safe — the next run sends
whatever is due.

## Run (development only)

```
npm install
node watcher.js --config config.json
```

No `smtp` in config = dev mode: alerts land as text files in `outbox/`.

## Integration test

`../` is the Hardhat project. The end-to-end scenario deploys the real contract on a local
node, time-travels through a full vault lifecycle, and asserts each alert fires exactly once:

```
cd .. && npx hardhat node --port 8547   # terminal 1 (8545 is claimed by the ozo-dapp node)
cd .. && npx hardhat run scripts/notify-scenario.ts --network localnode   # terminal 2
```

The scenario passed 14 steps locally in August 2026. It has not been validated against a
production RPC.

## Former billing design (historical)

Subscriptions were on-chain in `NotifySubscription.sol`, paid in the chain's native coin, recorded
as `paidUntil[account]` and enforced by this watcher when `config.subscription.enforce` was true.
That contract was reviewed with the vault in the internal review of 2026-08 (not independent). It
is retired and must not be paid.
