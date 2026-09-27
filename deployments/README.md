# deployments/

The records in this folder are public addresses and transaction hashes, never keys. They are the
canonical answer to "which contract is live on which chain", so they are committed.

| File | What it records | Written by |
|---|---|---|
| `base.json` | Base mainnet **v1** (`0xC821…fEe2f`), the retired NotifySubscription, the admin handover to the Ledger, and the subscription sales being switched off. Never overwritten. | earlier deploys, by hand |
| `base-v2.json`, `base-v2.vault-args.js` | Base mainnet **v2**, once it is deployed, and the constructor arguments that `hardhat verify` reads. | `scripts/deploy.ts` |
| `baseSepolia-v2.json`, `baseSepolia-v2.vault-args.js` | The Base Sepolia v2 vault that the lifecycle test runs against. | `scripts/deploy.ts` |
| `baseSepolia-lifecycle.json` | The lifecycle runner's progress: vault ids, transaction hashes, what was checked. Addresses only. | `scripts/lifecycle.ts` |

`deployments/hardhat.json` and `deployments/localnode.json` are ignored by git. The local lifecycle
rehearsal keeps its state in `cache/localnode-lifecycle.json`, which git ignores too.

The Base mainnet procedure is in [DEPLOY.md](../DEPLOY.md). What `scripts/deploy.ts` guarantees:

- It prints every argument the deployment fixes forever (admin, fee recipient, fee, the token list,
  and the address the contract will get from the deployer's nonce) before anything is sent.
  `DRY_RUN=yes` stops right there, after asking the chain to estimate the gas: nothing is sent and
  `ALLOW_MAINNET` is not needed. Run it first, every time.
- On a mainnet it refuses: a missing `ALLOW_MAINNET=yes`, an admin or fee recipient that is the hot
  key, an address written without its checksum (all lowercase), an admin equal to the contract's own
  future address, a fee that is not a whole number from 0 to 100, a pending transaction from the
  deployer, and any token that fails its code, symbol or decimals check.
- It writes the record the moment the deployment is mined, before reading the contract back, so a
  lagging RPC cannot lose the address. The `readBack` field says how the read-back went:
  - `ok`: every check passed;
  - `N check(s) FAILED: do not use`;
  - `pending…` or `incomplete: …`: the contract exists but the read-back did not finish. Do **not**
    deploy again (the script refuses while the record exists). Re-run the read-back alone with
    `READBACK_ONLY=yes` and `DEPLOYMENT_RECORD` naming the record; it needs no key.
- Value sent to the contract's address before it existed is reported as a note (it is surplus the
  admin may sweep), not as a failure.
- It ends with the `hardhat verify` command and the `scripts/set-launch-values.js` command with the
  address, block, transaction and UTC date filled in.

## The Base Sepolia lifecycle test

`scripts/lifecycle.ts` walks one deployed v2 vault through its whole life on Base Sepolia, with
three accounts and the contract's minimum timings (a 7-day inactivity period, a 7-day challenge
window), over about 44 days:

| When | What runs | What it proves |
|---|---|---|
| day 0 | The owner creates vaults A, B and C (0.0001 test ETH each) and, with testnet USDC, vault D (1 USDC); checks in on A. The keeper tops A up. | Deposits land in the Locked lane; a check-in moves the deadline; a stranger's top-up does not; a stranger's check-in moves nothing. |
| day 7 | The heir claims A. The heir claims B and the owner vetoes it. The heir claims C to a mistyped address, cancels, and re-files to an address nobody holds a key for. The owner's batch keeper runs `checkInMany` over A, B, C, D and an unknown id. | The veto returns B to ACTIVE with its clock reset; the heir's undo works; the batch skips the two pending claims and the unknown id, and refreshes B and D. |
| day 14 | The keeper finalizes A and C. The heir withdraws a third of its credit to another address, then the rest to itself. The owner closes B and D and pulls their credits. | Settlement, the 0.5% fee, the partial and full pulls, a full withdrawal closing a vault. |
| day 44 | The keeper pushes C's credit to the keyless address, and the fee recipient's credit. | A third party can push a credit, but only after the 30-day grace (it is refused on day 14). |

`checkInMany` only ever refreshes the caller's own vaults, so the batch keeper signs with the owner
key, as a real keeper holding the owner's check-in authority would. The keeper key plays the
stranger: finalizing, pushing and topping up are open to anyone, and checking in is not.

At every step the runner snapshots every tracked balance, credit, grace clock, lane
(`totalLocked`, `totalCredited`, `surplus`), vault field and counter; applies the step to that
snapshot with a model of the contract's rules; and compares the whole model, field by field, with
the chain at the transaction's block. It compares the vault's events in order, with their
arguments, and checks after every step that each token's lanes add up to the vault's balance with
surplus unchanged. The model is not self-confirming: in rehearsal, against seven deliberately
broken builds of the contract (a top-up that moves the deadline, a tenfold fee, a cancel that keeps
the recipient, a grace clock not cleared, no push grace, a batch that refreshes pending claims, a
veto that keeps the old deadline) it stopped at the step that exercises each one.

### 1. Three testnet keys

Use three new accounts that have never held real money, for example three new accounts in a
browser wallet kept for testing (name them Owner, Heir, Keeper). You paste each private key into a
masked prompt; the runner reads them from `OWNER_KEY`, `HEIR_KEY` and `KEEPER_KEY` and never prints
or stores them. It refuses hardhat's public development keys, and the same key twice.

### 2. Fund them from a faucet

Base Sepolia ETH: the Coinbase Developer Platform faucet (<https://portal.cdp.coinbase.com/products/faucet>)
or <https://www.alchemy.com/faucets/base-sepolia>. Suggested: owner 0.005, heir 0.002, keeper 0.002
test ETH. The runner will not start below owner 0.0008, heir 0.00025 and keeper 0.0003 (the 0.0003
locked in vaults, the 0.00005 top-up, and a margin for gas).

Testnet USDC for the owner: <https://faucet.circle.com>, network Base Sepolia, to the owner address.
Vault D uses 1 USDC and gives it back on day 14. Without USDC, the runner skips vault D and says so.

### 3. Deploy the v2 vault to Base Sepolia

`scripts/deploy.ts` lists Base Sepolia's tokens itself: WETH `0x4200…0006` (also the wrapped
native token) and Circle's USDC `0x036C…CF7e` (6 decimals). On a testnet the admin and the fee
recipient default to the deployer; the owner key is a fine deployer (the owner then also receives
the test fees). Deploy from the same source that goes to mainnet: the runner refuses a vault whose
code is not what this checkout compiles to (comments aside).

```powershell
cd "C:\Users\Vinoth\OneDrive\Claude\claude code\inheritance-vault"
npx.cmd hardhat compile
$sec = Read-Host -AsSecureString "Base Sepolia deployer key (the owner key will do)"
$env:DEPLOYER_KEY = [System.Net.NetworkCredential]::new("", $sec).Password.Trim()
Remove-Variable sec
Remove-Item Env:ADMIN_ADDRESS, Env:FEE_RECIPIENT, Env:CLAIM_FEE_BPS, Env:SUPPORTED_TOKENS, Env:WRAPPED_NATIVE, Env:ALLOW_MAINNET, Env:ALLOW_DEPLOYER_ROLES -ErrorAction SilentlyContinue
$env:DEPLOYMENT_RECORD = "deployments/baseSepolia-v2.json"
$env:DRY_RUN = "yes"; npx.cmd hardhat run scripts/deploy.ts --network baseSepolia; Remove-Item Env:DRY_RUN
npx.cmd hardhat run scripts/deploy.ts --network baseSepolia
Remove-Item Env:DEPLOYER_KEY, Env:DEPLOYMENT_RECORD
```

The script ends with the source-verification command (optional on the testnet) and the
`set-launch-values.js --chain 84532 …` command that points the site app's testnet slot at the vault.

### 4. Run it on day 0, 7, 14 and 44

```powershell
cd "C:\Users\Vinoth\OneDrive\Claude\claude code\inheritance-vault"
$o = Read-Host -AsSecureString "OWNER_KEY";  $env:OWNER_KEY  = [System.Net.NetworkCredential]::new("", $o).Password.Trim()
$h = Read-Host -AsSecureString "HEIR_KEY";   $env:HEIR_KEY   = [System.Net.NetworkCredential]::new("", $h).Password.Trim()
$k = Read-Host -AsSecureString "KEEPER_KEY"; $env:KEEPER_KEY = [System.Net.NetworkCredential]::new("", $k).Password.Trim()
Remove-Variable o, h, k
npx.cmd ts-node scripts/lifecycle.ts
Remove-Item Env:OWNER_KEY, Env:HEIR_KEY, Env:KEEPER_KEY
```

Each run does every step that is due by chain time, asserts it, and ends with the next step and
the UTC time it becomes due ("in about 6 d 23 h"). Run it again then; running it early only prints
the same. `npx.cmd ts-node scripts/lifecycle.ts --status` shows progress and the next due time at
any moment, and needs no keys. The test ends with `LIFECYCLE COMPLETE`.

Options: `--rpc <url>` (default `BASE_SEPOLIA_RPC_URL`, else `https://sepolia.base.org`; the runner
retries the public endpoint's lagging answers, but a keyed endpoint is quicker), `--vault <address>`
(default: `deployments/baseSepolia-v2.json`, else `deployments/baseSepolia.json`), `--state <file>`.
Amounts: `LIFECYCLE_ETH` (default `0.0001`) and `LIFECYCLE_USDC_AMOUNT` (default `1`), read when a
lifecycle starts.

### When something goes wrong

- **"fund the testnet accounts first"**: nothing was sent and no state was written. Use a faucet.
- **A run was killed, or a transaction is still pending**: run again. Each transaction is signed
  and recorded before it is broadcast, so the next run picks up the receipt or re-broadcasts the
  same signed bytes. Nothing is ever sent twice.
- **"… .lock exists"**: another run is active. If none is, delete the `.lock` file.
- **A `FAIL` line**: the lifecycle stops at that step. Running again re-checks the same
  transaction (a flaky RPC read heals; a real mismatch does not). Once someone has looked and
  decided the failure is understood, `--accept-failed` marks that step done and records why in the
  state file.
- **"the code at … is not the InheritanceVault compiled from this checkout"**: the contract changed
  since the testnet deployment. Redeploy to Base Sepolia and start a fresh lifecycle (move the old
  `baseSepolia-lifecycle.json` aside and keep it: it is the record of that run).
  `LIFECYCLE_ALLOW_CODE_MISMATCH=yes` overrides, knowingly.

### A local rehearsal in minutes

The same steps run against a local hardhat node, with time travel instead of waiting:

```powershell
npm.cmd run node                               # terminal 1: a hardhat node on 127.0.0.1:8547
npx.cmd ts-node scripts/lifecycle.ts --local   # terminal 2: run it four or five times
```

If port 8547 is taken, start the node with `npx.cmd hardhat node --port <n>` and add
`--rpc http://127.0.0.1:<n>`. `--local` deploys a vault with a WETH and a USDC stand-in on the
first run, funds the three roles from the node's first account (hardhat's development accounts 1
to 3 play owner, heir and keeper unless the three key variables are set), and ends each run by
moving the chain clock to the next due step. Its state is `cache/localnode-lifecycle.json`; after
a node restart the runner notices the old vault is gone and starts afresh.
