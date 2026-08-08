# Deploying

You hold the keys and you sign. Nothing in this repo reads, stores, or transmits a private key —
`DEPLOYER_KEY` is read from the environment by Hardhat at run time and never written anywhere.

## What it costs

Measured against live Base gas (0.006 gwei) on 2026-08-09, for both contracts:

| | gas | cost |
|---|---|---|
| InheritanceVault | 3,627,545 | |
| NotifySubscription | 562,560 | |
| **L2 execution** | 4,190,105 | 0.0000251 ETH |
| **L1 data fee** | — | 0.0000001 ETH |
| **Total** | | **≈ 0.0000252 ETH (~$0.08)** |

Contract size 16,163 bytes runtime, comfortably under the 24,576 EIP-170 limit.

**Base Sepolia (do this first):** free. Get testnet ETH from
<https://www.alchemy.com/faucets/base-sepolia> or the Coinbase faucet. Hold **0.02 test ETH** —
the deploy is trivial, the headroom is for exercising vaults, claims and check-ins afterwards.

**Base mainnet (later, after a testnet soak):** fund the deployer with **0.005 ETH** (~$15). That
is ~200× the measured deploy cost; the margin is for gas spikes and post-deploy transactions, not
because the deploy is expensive.

## Base Sepolia

```bash
export DEPLOYER_KEY=0x...          # never commit; use a throwaway key for testnet
npm run deploy:baseSepolia
```

The script prints every constructor argument before sending anything, then reads back ten facts
from the deployed contracts (owner, fee, fee cap, timing minimums, pause state, subscription
price) and refuses to record the deployment if any disagree. Addresses land in
`deployments/baseSepolia.json`.

Optional overrides: `ADMIN_ADDRESS`, `FEE_RECIPIENT`, `CLAIM_FEE_BPS` (default 50),
`SUB_PRICE_ETH` (default 0.001). For mainnet the admin and fee recipient should be a cold wallet,
not the deployer.

## Verify the source

```bash
export BASESCAN_API_KEY=...
npx hardhat verify --network baseSepolia <vaultAddress> <admin> 50 <feeRecipient>
npx hardhat verify --network baseSepolia <subAddress> <admin> 1000000000000000
```

Not optional for a product whose entire pitch is "read the contract, don't trust us."

## Then

1. `site/assets/app.js` → set `CHAINS[84532].contract` and `.notify` to the new addresses.
2. `notify/config.json` → same two addresses; run the watcher once and confirm it reports
   `0 queued`.
3. Redeploy the site to the VPS and check the app connects and lists vaults.

## Mainnet

Refuses to run without `ALLOW_MAINNET=yes`. Do not set it until the testnet deployment has held
real (test) value through a full create → check-in → claim → veto → settle cycle, and an
independent third-party review exists. The in-repo audit
([AUDIT-2026-08-09.md](AUDIT-2026-08-09.md)) was performed by the same system that wrote the
code; it is evidence, not absolution.
