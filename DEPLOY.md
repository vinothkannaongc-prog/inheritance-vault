# Deploying

You hold the keys and you sign. Nothing in this repo reads, stores, or transmits a private key —
`DEPLOYER_KEY` is read from the environment by Hardhat at run time and never written anywhere.

`scripts/deploy.ts` deploys the v2 `InheritanceVault` and nothing else. `NotifySubscription` is
retired (audit 2026-09, F23 and F31) and is never deployed again. The script's header documents
every setting; this file is the runbook.

## The Base deployment

v2 went live on Base on 2026-09-28 at `0xA07b59d9249A996604A5fF482f1E564EdeE3A774` (transaction `0x4bbd4b1d74924f64e0c817ff1815ade20a0141094c091003ec1f527b86413e8e`, block
51900754), with the launch plan's constructor:

| Argument | Value |
|---|---|
| admin | `0x883C821103B5415C53B11E584D3592205B5CdCA3` (the Ledger) |
| claim fee | 50 bps (0.5%) |
| fee recipient | `0x883C821103B5415C53B11E584D3592205B5CdCA3` (the same Ledger) |
| supported tokens, in this order | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH `0x4200000000000000000000000000000000000006`, cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`, EURC `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` |
| wrapped native token | WETH `0x4200000000000000000000000000000000000006` |

The deployer was the former hot key `0x4306a8875a04c0FbaC76CE2FC860E0b3c7aAd986`, which holds no v2
role: the constructor made the Ledger the admin and fee recipient from the first block, so no
handover transaction was needed. The token list can never change. The owner chose to deploy once
the v2 app was built and tested on local networks and forks, and to run the full Base Sepolia
lifecycle alongside; the independent audit comes later (see [SECURITY.md](SECURITY.md)).

## What it costs

Measured on a local Hardhat network with the Base constructor above, on 2026-09-27: **4,926,583
gas**, for 21,119 bytes of runtime code and about 23 KB of transaction data. At a Base gas price of
0.01 gwei that is about 0.00005 ETH, plus Base's L1 data fee. The dry run below prints the chain's
own estimate and the expected cost at the current base fee before anything is sent, and says
whether the deployer's balance covers it.

## Base mainnet, step by step (PowerShell)

Rehearse the same run on a local fork of Base first, and use a keyed Base RPC endpoint
(`BASE_RPC_URL`) for the real run: the public endpoint rate-limits.

```powershell
# 0. Clear every variable that changes what the script deploys. A session reused from the fork
#    rehearsal may still hold one, and the script would follow it on Base too: its read-back
#    compares the contract with the script's own inputs, so it would still report "ok".
Remove-Item Env:CLAIM_FEE_BPS, Env:SUPPORTED_TOKENS, Env:WRAPPED_NATIVE, Env:ALLOW_DEPLOYER_ROLES, Env:ALLOW_MAINNET, Env:DRY_RUN, Env:READBACK_ONLY -ErrorAction SilentlyContinue

# 1. The deployer key, typed into a hidden prompt. It lives only in this PowerShell session.
$k = Read-Host -AsSecureString "Deployer private key"
$env:DEPLOYER_KEY = [System.Net.NetworkCredential]::new("", $k).Password
Remove-Variable k

# 2. The launch configuration. Paste the addresses exactly as shown: on a mainnet the script
#    requires the mixed-case (EIP-55 checksummed) form, which catches a mistyped character.
$env:ADMIN_ADDRESS = "0x883C821103B5415C53B11E584D3592205B5CdCA3"
$env:FEE_RECIPIENT = "0x883C821103B5415C53B11E584D3592205B5CdCA3"
$env:DEPLOYMENT_RECORD = "deployments/base-v2.json"
$env:BASE_RPC_URL = "https://..."   # a keyed Base endpoint

# 3. Dry run: every check, the deployer's nonce, the address the vault will get and the gas.
#    Nothing is sent. Read all of it, against the list below this block.
$env:DRY_RUN = "yes"
npx.cmd hardhat run scripts/deploy.ts --network base
Remove-Item Env:DRY_RUN

# 4. The deployment. Send nothing else from the deployer between the dry run and this.
$env:ALLOW_MAINNET = "yes"
npx.cmd hardhat run scripts/deploy.ts --network base

# 5. Clear the key and the switch.
Remove-Item Env:DEPLOYER_KEY, Env:ALLOW_MAINNET
```

Before step 4, check the dry run against the table at the top of this file. It must show `admin`
and `feeRecipient` as the Ledger (a wallet with no code that has sent transactions), `claim fee` as
`50 bps (0.5%)`, `wrappedNative` as WETH, and `tokens` as USDC, WETH, cbBTC and EURC in that order,
each with its symbol and decimals. If it prints `(from SUPPORTED_TOKENS / WRAPPED_NATIVE, not the
table)`, stop: an override is set. Run step 0 again, then the dry run.

With the variables of step 0 unset, the script takes a claim fee of 50 and Base's token list from
its own table, and checks each token's code, symbol and decimals on chain before it sends. It writes
the record (`deployments/base-v2.json`, and the verification arguments next to it as
`deployments/base-v2.vault-args.js`) as soon as the deployment is mined, then reads back every value
the contract reports about itself. At the end it prints the verification command and the launch
values.

If the read-back cannot finish, **do not deploy again**: the record blocks a second deployment.
Re-run the read-back alone, in the same session (`DEPLOYMENT_RECORD` still names the record, and no
key is needed). The script's own message prints this as a one-line `READBACK_ONLY=yes ...` command,
which PowerShell cannot run; use this form:

```powershell
$env:READBACK_ONLY = "yes"
npx.cmd hardhat run scripts/deploy.ts --network base
Remove-Item Env:READBACK_ONLY
```

The read-back also checks that no vault exists yet and that nothing is locked or credited, so it is
meaningful only before the first vault is created: re-run it straight away. Once anyone has created
a vault on the new contract, a re-run reports failures for a correct deployment and writes them into
the record. Check the values by hand on Basescan's Read Contract tab instead.

## After the deployment

1. **Verify the source on Basescan** (re-runnable, separate from the deploy; it needs one
   Etherscan V2 API key):

   ```powershell
   $env:ETHERSCAN_API_KEY = "..."
   npx.cmd hardhat verify --network base --contract contracts/InheritanceVault.sol:InheritanceVault --constructor-args deployments/base-v2.vault-args.js <vault address>
   Remove-Item Env:ETHERSCAN_API_KEY
   ```

   Then open `https://basescan.org/address/<vault address>#code` and confirm that the Contract tab
   shows the source as verified. The security page sends readers there rather than stating it.

2. **Retire v1.** The Ledger signs `setCreationPaused(true)` on v1,
   `0xC821849A1D74959753450409b594b23eCE7fEe2f`, from Basescan's Write Contract tab. The calldata the
   Ledger shows is `0xa21d131c0000000000000000000000000000000000000000000000000000000000000001`.
   Every existing v1 function except `createVault` keeps working, so a v1 credit can still be
   withdrawn.

3. **Fill in the launch values.** The site and the documents carry markers for every launch fact
   until now. One command replaces them all, after checking each value on chain (the transaction
   created a v2 vault at that address in that block on that date, and the pause transaction paused
   v1), and computes the bytecode fingerprints from the deployed code.

   First check what the documents state without a marker, because that command does not: they
   describe the constructor in the table at the top of this file as fact, and give v2's runtime as
   21,119 bytes. Open `deployments/base-v2.json`: `readBack` must be `ok`; `admin` and
   `feeRecipient` must be the Ledger; under `params`, `claimFeeBps` must be 50, `wrappedNative`
   WETH, and `supportedTokens` USDC, WETH, cbBTC and EURC in that order; and
   `contracts.InheritanceVault` and `deployment.tx` must be the address and transaction you pass
   below. The read-back compared the contract with exactly these values. Then run:

   ```powershell
   node scripts/set-launch-values.js --address <vault address> --block <block> --tx <deploy tx> --date "<d Month yyyy>" --v1-pause-tx <pause tx>
   node scripts/validate-site.js
   ```

   The first command prints the size of the runtime code it read from Base: it must be 21,119
   bytes. If the record or the size differs, stop: the documents describe a different deployment
   and must be corrected before anything is published. Do not pass `--offline`: it skips the checks
   on chain and leaves the two bytecode fingerprints as markers, so `validate-site.js` keeps
   failing.

   `validate-site.js` fails while any marker is left in `site/`. Also confirm that nothing is left
   in `README.md`, `SECURITY.md`, `AUDIT_SCOPE.md`, this file and
   `audit/2026-09-preliminary/REPORT.md`.

4. **Commit, push and merge into `main`, then publish the site.** Commit the new deployment
   record and its `.vault-args.js` file with everything else; `git status` must show no untracked
   file that the site or these documents refer to. The site's links to the changelog and the
   check-in chain specification read `main` on GitHub, so push and merge before publishing, and
   check that `CHANGELOG-v2.md` on `main` has the pre-launch sections. Then publish from a clean
   export of the committed `site/` folder, never from the working tree:

   ```powershell
   git archive HEAD:site -o site.tar   # unpack into an empty folder, then:
   npx.cmd wrangler@latest pages deploy <that folder> --project-name=willandkey --branch=main
   ```

5. **Run the Base Sepolia lifecycle** of v2 (at least 14 days of real time: the minimum inactivity
   period plus the minimum challenge window; the full script takes about 44 days). The lifecycle
   runner is `scripts/lifecycle.ts`, and `deployments/README.md` is its guide: testnet keys,
   faucets, and the Base Sepolia deployment. That deployment uses the same script with
   `--network baseSepolia` and `DEPLOYMENT_RECORD=deployments/baseSepolia-v2.json`, where the runner
   looks for the vault. Its token list is WETH and Circle's test USDC, and the admin and fee
   recipient default to the deployer once `ADMIN_ADDRESS` and `FEE_RECIPIENT` are cleared, as the
   guide's commands do. Then fill the app's testnet slot with
   `node scripts/set-launch-values.js --chain 84532 ...`, which the deploy script prints in full.

## Other chains

Nothing is deployed on BNB Chain. Before any BNB launch: deploy v2 (never v1's bytecode, never
`NotifySubscription`); confirm the BNB token list in `scripts/deploy.ts`, which can never change
once deployed (BNB Chain's USDT and USDC have 18 decimals, not 6); and revalidate any log paging
against a production RPC. On any chain, a mainnet deployment needs `ALLOW_MAINNET=yes`, and the
admin and fee recipient must be named explicitly and may not be the deployer.
