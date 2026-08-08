# Will & Key notify — the check-in reminder service

Polls vault state (read-only, holds no keys, can sign nothing) and sends escalating email
alerts. This is the paid product; the contract stays free.

## Alerts

| Recipient | Trigger | Note |
|---|---|---|
| Owner | 14 / 7 / 3 / 1 days before deadline | most-urgent tier only; re-arms after every check-in |
| Owner | deadline expired | heir can now claim |
| Owner | **claim initiated** | the alert that matters — veto window is running |
| Owner | horizon within 30 days | check-ins stop working at the horizon |
| Owner | check-in chain exhausted | warnings bit 3 |
| Heir (optional) | vault claimable / claim finalizable | opt-in per watch |

Dedupe keys embed the value they alert about (deadline, claimInitiatedAt), so a check-in or a
new claim re-arms alerts by construction. Missing a cron run is safe — the next run sends
whatever is due.

## Run

```
npm install
node watcher.js --config config.json
```

No `smtp` in config = dev mode: alerts land as text files in `outbox/`.

## VPS deployment (once the contract is live)

House pattern — throwaway container from host cron, mail relayed via the host postfix:

```
0 */6 * * * docker run --rm --network host -v /home/ubuntu/willandkey-notify:/app -w /app node:22 node watcher.js --config config.json >> /var/log/willandkey-notify.log 2>&1
```

`config.smtp` for host postfix: `{ "host": "172.17.0.1", "port": 25, "secure": false }`.

Signups are manual for the beta (edit `watches` in config.json). The self-serve signup +
billing flow comes with mainnet.

## Integration test

`../` is the Hardhat project. The end-to-end scenario deploys the real contract on a local
node, time-travels through a full vault lifecycle, and asserts each alert fires exactly once:

```
cd .. && npx hardhat node --port 8547   # terminal 1 (8545 is claimed by the ozo-dapp node)
cd .. && npx hardhat run scripts/notify-scenario.ts --network localnode   # terminal 2
```

## Billing — crypto only

Subscriptions are on-chain: `NotifySubscription.sol` (same repo, audited alongside the vault).
Users pay in the chain's native coin from any wallet; the contract records `paidUntil[account]`
and this watcher enforces it when `config.subscription.enforce` is true — lapsed watches get
exactly one "reminders paused" notice, never silence. Time already purchased survives any price
change. There is no card processor and no fiat anywhere in the loop.
