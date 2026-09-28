/**
 * Deploys the v2 InheritanceVault, and nothing else, then reads its state back.
 *
 *   ADMIN_ADDRESS=0x... FEE_RECIPIENT=0x... npx hardhat run scripts/deploy.ts --network baseSepolia
 *
 * NotifySubscription is NOT deployed. It is retired (audit 2026-09 F23/F31): the Base instance is
 * immutable and must not be copied onto another chain, where it would take payments for nothing.
 *
 * The deployer key comes from the DEPLOYER_KEY environment variable and is never read, logged,
 * or written anywhere by this script. Mainnet requires ALLOW_MAINNET=yes as a second pair of
 * hands: a testnet typo costs nothing, a mainnet one is permanent.
 *
 * DRY_RUN=yes runs every check, prints everything the deployment would fix forever (with the
 * deployer's nonce, the address the contract will get and the gas it will use, estimated by the
 * chain itself) and sends NOTHING; it does not need ALLOW_MAINNET. Run it first, read it, then run
 * the same command without DRY_RUN. Printing the arguments is only a safeguard if something waits
 * for the reader: a real run prints them and sends in the same breath.
 *
 * On a mainnet (Base, BNB Chain; by network name or chain id) the admin and the fee recipient
 * must be named explicitly, and neither may be the deployer's hot key:
 *
 *   ADMIN_ADDRESS        the cold wallet that will own the contract from its first block. Passing
 *                        it to the constructor means no handover transaction, and no window in
 *                        which the hot key is admin. Ownable2Step protects transfers, NOT the
 *                        constructor: a wrong address here is permanent. On a mainnet it must be
 *                        written with its EIP-55 checksum (mixed case, as wallets print it): an
 *                        all-lowercase address carries no checksum, so a typo in it would pass.
 *   FEE_RECIPIENT        where claim fees are credited; "none" (or the zero address) = no fee.
 *                        The same checksum rule applies.
 *   ALLOW_DEPLOYER_ROLES=yes  lets either of the two name the deployer itself. Do not.
 *
 * On testnets and local chains both default to the deployer.
 *
 * Other settings: CLAIM_FEE_BPS (default 50; digits only), SUPPORTED_TOKENS=0xA,0xB|none and
 * WRAPPED_NATIVE (override the per-chain token table below; on Base or BNB mainnet only together
 * with ALLOW_TOKEN_OVERRIDE=yes, because the list is permanent), DEPLOYMENT_RECORD (where the record is
 * written; default deployments/<network>.json, and an existing record is never overwritten).
 *
 * Every constructor argument is printed BEFORE anything is sent, and every claim the contract
 * makes about itself is read back AFTER, because "it deployed" and "it deployed correctly" are
 * different statements. The record is written as soon as the deployment is mined, BEFORE the
 * read-back, so an RPC failure during the read-back (a lagging load-balanced node answers "0x"
 * for a contract it has not seen yet) cannot lose the address; the record then blocks a second
 * deployment, and READBACK_ONLY=yes (with DEPLOYMENT_RECORD naming the record) re-runs the
 * read-back alone, before any vault is created. Source verification is a separate, re-runnable
 * step (printed at the end), so an explorer outage can never fail a deployment that has already
 * happened.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { HB_DOMAIN, step as chainStep } from "./checkin-chain";

/** Mainnets by network name, and by chain id, so a renamed network entry is still a mainnet. */
const MAINNETS: Record<string, true> = { base: true, bnb: true };
const MAINNET_CHAIN_IDS: Record<string, string> = { "8453": "Base", "56": "BNB Chain" };

/**
 * Claim fee in basis points. 50 = 0.5%, taken only when an inheritance settles. Parsed strictly:
 * Number("") and Number(" ") are 0, so a variable set but left empty would otherwise deploy a
 * zero fee, which every vault created before a (30-day) raise would keep as its ceiling forever.
 */
const CLAIM_FEE_BPS = process.env.CLAIM_FEE_BPS === undefined
  ? 50
  : /^\s*\d+\s*$/.test(process.env.CLAIM_FEE_BPS) ? Number(process.env.CLAIM_FEE_BPS) : NaN;

/**
 * The ERC20s each chain's vault accepts, FIXED FOREVER at deployment: the v2 contract has no
 * function that adds or removes one (audit 2026-09 F01). Keyed by chain id, not by network name,
 * so a rehearsal chain that is merely NAMED "bnb" never inherits BNB Chain's list. The native
 * coin is always accepted and is not listed. Every entry must meet the contract's SUPPORTED
 * TOKENS rules: one address per ledger, a balance that moves only by transfers, no fee, no
 * transfer hooks.
 *
 * These are PROPOSED lists, not a decision: whoever runs a mainnet deploy confirms them first.
 * Every address, symbol and decimals value was checked read-only (eth_getCode / eth_call) against
 * each mainnet on 2026-09-26, and the script re-checks all three before it sends anything.
 * Issuer control, which the contract discloses and cannot prevent:
 *   - upgradeable proxies with blocklist and pause: Base USDC, EURC and cbBTC (FiatToken-style),
 *     BNB USDC (Binance-Peg, EIP-1967 proxy);
 *   - owner-controlled Binance-Peg BEP20 tokens (not proxies): BNB USDT, BTCB, ETH;
 *   - no admin at all: WETH, WBNB.
 * BNB Chain's USDT and USDC have 18 decimals, not 6 as on Ethereum and Base. The app must read
 * decimals() and never assume 6.
 *
 * wrappedNative is refused as a payout address (F09). It is required on the two mainnets, and it
 * must also be in `supported`: the contract refuses an unlisted one (review round 2), because a
 * native payout is measured across the listed tokens only.
 */
type TokenEntry = { symbol: string; decimals: number; address: string };
type TokenConfig = { name: string; mainnet: boolean; wrappedNative: string; supported: TokenEntry[] };
const TOKENS: Record<string, TokenConfig> = {
  "8453": {
    name: "Base",
    mainnet: true,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    supported: [
      { symbol: "USDC", decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      { symbol: "WETH", decimals: 18, address: "0x4200000000000000000000000000000000000006" },
      { symbol: "cbBTC", decimals: 8, address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
      { symbol: "EURC", decimals: 6, address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
    ],
  },
  "56": {
    name: "BNB Chain",
    mainnet: true,
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    supported: [
      { symbol: "USDT", decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955" },
      { symbol: "USDC", decimals: 18, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
      { symbol: "WBNB", decimals: 18, address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
      { symbol: "BTCB", decimals: 18, address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
      { symbol: "ETH", decimals: 18, address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
    ],
  },
  "84532": {
    name: "Base Sepolia",
    mainnet: false,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    supported: [
      { symbol: "WETH", decimals: 18, address: "0x4200000000000000000000000000000000000006" },
      { symbol: "USDC", decimals: 6, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    ],
  },
  "97": {
    name: "BNB Testnet",
    mainnet: false,
    wrappedNative: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    supported: [{ symbol: "WBNB", decimals: 18, address: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" }],
  },
};

const EXPLORERS: Record<string, string> = {
  "8453": "https://basescan.org",
  "84532": "https://sepolia.basescan.org",
  "56": "https://bscscan.com",
  "97": "https://testnet.bscscan.com",
};

const ERC20_META = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const ERC20_BALANCE = ["function balanceOf(address) view returns (uint256)"];

/** "yes" or unset. Anything else is refused, so a mistyped DRY_RUN=1 cannot become a real deployment. */
function flag(name: string): boolean {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") return false;
  if (v === "yes") return true;
  throw new Error(`${name} must be "yes" or unset, got ${JSON.stringify(process.env[name])}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => ((e as { shortMessage?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e)));

/** The token configuration for this run: the chain's table, or the environment's override. */
function tokenConfig(chainId: string): {
  wrappedNative: string;
  supported: { symbol?: string; decimals?: number; address: string }[];
  overridden: boolean;
} {
  const table = TOKENS[chainId];
  const envList = process.env.SUPPORTED_TOKENS?.trim();
  const envWrapped = process.env.WRAPPED_NATIVE?.trim();
  const supported =
    envList === undefined || envList === ""
      ? table?.supported ?? []
      : envList.toLowerCase() === "none"
        ? []
        : envList.split(",").map((a) => ({ address: ethers.getAddress(a.trim()) }));
  const wrappedNative = ethers.getAddress(envWrapped || table?.wrappedNative || ethers.ZeroAddress);
  return { wrappedNative, supported, overridden: Boolean(envList || envWrapped) };
}

/**
 * ADMIN_ADDRESS / FEE_RECIPIENT. On a mainnet the variable must be set, in checksummed form, and
 * it may not be the deployer's own address unless ALLOW_DEPLOYER_ROLES=yes. Elsewhere it defaults
 * to the deployer.
 */
function role(varName: string, deployer: string, mainnet: boolean, allowNone: boolean): string {
  const raw = process.env[varName]?.trim();
  if (!raw) {
    if (mainnet) {
      throw new Error(
        `${varName} must be set explicitly on a mainnet. Pass the cold wallet's address; the ` +
          `deployer's hot key is never used by default.`
      );
    }
    return deployer;
  }
  const addr = allowNone && raw.toLowerCase() === "none" ? ethers.ZeroAddress : ethers.getAddress(raw);
  // getAddress verifies a checksum only when the input has one (mixed case). An all-lowercase
  // (or all-uppercase) address is accepted as typed, so a one-character typo in it would become
  // a permanent admin that nobody holds. On a mainnet, insist on the checksummed form.
  if (mainnet && addr !== ethers.ZeroAddress && raw !== addr) {
    throw new Error(
      `${varName} must be written in its checksummed (mixed-case) form on a mainnet, exactly as your ` +
        `wallet or the explorer prints it: without a checksum a mistyped address would be accepted.`
    );
  }
  if (mainnet && addr === deployer && process.env.ALLOW_DEPLOYER_ROLES !== "yes") {
    throw new Error(
      `${varName} is the deployer's own hot key (${deployer}). Use the cold wallet, or set ` +
        `ALLOW_DEPLOYER_ROLES=yes if you really mean it.`
    );
  }
  return addr;
}

/** What the read-back compares the deployed contract with. */
interface Expected {
  chainId: bigint;
  mainnet: boolean;
  deployer: string;
  admin: string;
  feeRecipient: string;
  claimFeeBps: number;
  wrappedNative: string;
  supported: string[];
}

/**
 * Reads back every claim the new contract makes about itself and prints one line per check.
 * Returns the number of failed checks; throws only if a read itself fails (a lagging RPC), which
 * the caller retries. Meaningful only before the first vault is created.
 */
async function readBack(vaultAddr: string, x: Expected): Promise<number> {
  // A load-balanced RPC can answer from a node that has not seen the deployment block yet.
  let code = "0x";
  for (let i = 0; i < 20 && code === "0x"; i++) {
    code = await ethers.provider.getCode(vaultAddr);
    if (code === "0x") await sleep(3000);
  }
  if (code === "0x") throw new Error(`the RPC still shows no code at ${vaultAddr} after 60 s`);

  const vault = await ethers.getContractAt("InheritanceVault", vaultAddr);
  const probe = ethers.id("deploy.ts read-back probe");
  const ctx = { chainId: x.chainId, vault: vaultAddr, owner: x.admin, vaultId: 0, epoch: 1 };
  const checks: [string, unknown, unknown][] = [
    ["runtime size <= 24576 bytes", (code.length - 2) / 2 <= 24_576, true],
    ["owner", await vault.owner(), x.admin],
    ["no pending owner", await vault.pendingOwner(), ethers.ZeroAddress],
    ["claim fee in force", await vault.claimFeeBps(), BigInt(x.claimFeeBps)],
    ["no fee raise pending", `${await vault.pendingClaimFeeBps()}/${await vault.pendingClaimFeeAt()}`, "0/0"],
    ["fee recipient", await vault.feeRecipient(), x.feeRecipient],
    ["fee recipient active at once", await vault.feeRecipientActiveAt(), 0n],
    ["fee cap (bytecode)", await vault.MAX_CLAIM_FEE_BPS(), 100n],
    ["fee raise delay", await vault.FEE_RAISE_DELAY(), 2_592_000n],
    ["push grace", await vault.PUSH_GRACE(), 2_592_000n],
    ["min challenge window", await vault.MIN_CHALLENGE(), 604_800n],
    ["min inactivity", await vault.MIN_INACTIVITY(), 604_800n],
    ["creation paused", await vault.creationPaused(), false],
    ["no vaults yet", await vault.vaultsCreated(), 0n],
    ["wrapped native", await vault.wrappedNative(), x.wrappedNative],
    ["supported tokens, in order", (await vault.supportedTokens()).join(","), x.supported.join(",")],
    ["native coin not listed", await vault.isSupportedToken(ethers.ZeroAddress), false],
    ["check-in chain domain", await vault.HB_DOMAIN(), HB_DOMAIN],
    // hbStep binds block.chainid: this proves the published generator matches this chain.
    ["check-in chain step (scripts/checkin-chain.ts)", await vault.hbStep(x.admin, 0, 1, probe), chainStep("v2", ctx, probe)],
  ];
  for (const a of x.supported) checks.push([`listed ${a}`, await vault.isSupportedToken(a), true]);
  if (x.mainnet && process.env.ALLOW_DEPLOYER_ROLES !== "yes") {
    checks.push(["owner is not the deployer", (await vault.owner()) !== x.deployer, true]);
    checks.push(["fee recipient is not the deployer", (await vault.feeRecipient()) !== x.deployer, true]);
  }
  // The admin must be unable to reach vault funds. Assert it rather than assert it in prose: both
  // lanes the admin cannot touch start empty, and surplus() is exactly what the address holds, all
  // of it value that arrived before the contract existed (anyone can send to a future CREATE
  // address). Such value is no depositor's, the admin may sweep it, and it is reported, not failed
  // on: failing would let anyone who can predict the deployer's nonce sink a launch for 1 wei.
  const notes: string[] = [];
  for (const t of [ethers.ZeroAddress, ...x.supported]) {
    const name = t === ethers.ZeroAddress ? "native coin" : t;
    const held = t === ethers.ZeroAddress
      ? await ethers.provider.getBalance(vaultAddr)
      : await new ethers.Contract(t, ERC20_BALANCE, ethers.provider).balanceOf(vaultAddr);
    checks.push([`nothing locked in ${name}`, await vault.totalLocked(t), 0n]);
    checks.push([`nothing credited in ${name}`, await vault.totalCredited(t), 0n]);
    checks.push([`surplus in ${name} = what the address holds`, await vault.surplus(t), held]);
    if (held !== 0n) {
      notes.push(`${held} (${name}) was sent to this address before the contract existed: surplus, sweepable by the admin, nobody's deposit`);
    }
  }
  let bad = 0;
  for (const [label, got, want] of checks) {
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
  }
  for (const n of notes) console.log(`  note ${n}`);
  return bad;
}

/** Runs the read-back, retrying reads that fail (not checks that fail) a few times. */
async function readBackWithRetries(vaultAddr: string, x: Expected): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readBack(vaultAddr, x);
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  (a read failed: ${errText(e)}; retrying in 5 s)`);
      await sleep(5000);
    }
  }
}

const rel = (p: string) => path.relative(process.cwd(), p).replace(/\\/g, "/");

/** READBACK_ONLY=yes: re-runs the read-back of a recorded deployment and updates its readBack field. */
async function readBackOnly(net: string, chainId: bigint, mainnet: boolean) {
  const recordPath = path.resolve(process.env.DEPLOYMENT_RECORD ?? path.join(__dirname, "..", "deployments", `${net}.json`));
  if (!fs.existsSync(recordPath)) throw new Error(`READBACK_ONLY: no record at ${rel(recordPath)}`);
  const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (String(rec.chainId) !== chainId.toString()) {
    throw new Error(`${rel(recordPath)} is for chain ${rec.chainId}, but this network is chain ${chainId}`);
  }
  const vaultAddr: string | undefined = rec.contracts?.InheritanceVault;
  if (rec.version !== "v2" || !vaultAddr || !rec.params) throw new Error(`${rel(recordPath)} is not a v2 deploy.ts record`);
  console.log(`read-back of ${vaultAddr} (${rel(recordPath)}, network ${net}, chainId ${chainId})`);
  const bad = await readBackWithRetries(vaultAddr, {
    chainId, mainnet, deployer: rec.deployer, admin: rec.admin, feeRecipient: rec.feeRecipient,
    claimFeeBps: rec.params.claimFeeBps, wrappedNative: rec.params.wrappedNative, supported: rec.params.supportedTokens,
  });
  rec.readBack = bad === 0 ? "ok" : `${bad} check(s) FAILED: do not use`;
  fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));
  console.log(`\n${rel(recordPath)}: readBack = ${rec.readBack}`);
  if (bad > 0) throw new Error(`${bad} post-deploy check(s) failed: do NOT use ${vaultAddr}`);
}

async function main() {
  const dryRun = flag("DRY_RUN");
  const net = network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const cid = chainId.toString();
  const table = TOKENS[cid];
  const mainnet = Boolean(MAINNETS[net] || MAINNET_CHAIN_IDS[cid]);
  if (flag("READBACK_ONLY")) return readBackOnly(net, chainId, mainnet);
  if (mainnet && process.env.ALLOW_MAINNET !== "yes" && !dryRun) {
    throw new Error(`Refusing to deploy to mainnet "${net}" (chainId ${cid}) without ALLOW_MAINNET=yes`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer: set DEPLOYER_KEY in the environment");

  // Everything that can refuse is checked before anything is sent.
  const admin = role("ADMIN_ADDRESS", deployer.address, mainnet, false);
  if (admin === ethers.ZeroAddress) throw new Error("ADMIN_ADDRESS is the zero address");
  const feeRecipient = role("FEE_RECIPIENT", deployer.address, mainnet, true);
  if (!Number.isInteger(CLAIM_FEE_BPS) || CLAIM_FEE_BPS < 0 || CLAIM_FEE_BPS > 100) {
    throw new Error(
      `CLAIM_FEE_BPS must be an integer from 0 to 100 (the contract's cap), got ${JSON.stringify(process.env.CLAIM_FEE_BPS)}`
    );
  }

  const recordPath = path.resolve(
    process.env.DEPLOYMENT_RECORD ?? path.join(__dirname, "..", "deployments", `${net}.json`)
  );
  if (fs.existsSync(recordPath)) {
    let earlier: { version?: string; contracts?: { InheritanceVault?: string }; readBack?: string } = {};
    try {
      earlier = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    } catch {
      // not a record we can read: the generic refusal below still applies
    }
    if (earlier.version === "v2" && earlier.contracts?.InheritanceVault) {
      // Most likely a run of this script whose read-back did not finish. The contract exists.
      throw new Error(
        `${rel(recordPath)} already records a v2 deployment at ${earlier.contracts.InheritanceVault} ` +
          `(readBack: ${earlier.readBack}). Do NOT deploy again. If its read-back is not "ok", re-run it alone:\n` +
          `  READBACK_ONLY=yes DEPLOYMENT_RECORD=${rel(recordPath)} npx hardhat run scripts/deploy.ts --network ${net}`
      );
    }
    throw new Error(
      `${path.relative(process.cwd(), recordPath)} already exists. It records an earlier deployment ` +
        `(on Base: the live v1 contract and its admin handover) and is never overwritten. ` +
        `Set DEPLOYMENT_RECORD to a new file, e.g. deployments/${net}-v2.json.`
    );
  }
  const argsPath = recordPath.replace(/\.json$/i, "") + ".vault-args.js";

  // ---- the token list is permanent, so check every entry before anything is sent ----
  const { wrappedNative, supported, overridden } = tokenConfig(cid);
  // On a known mainnet the reviewed table above is the list. A SUPPORTED_TOKENS or WRAPPED_NATIVE
  // left over in the shell would otherwise change a permanent list with no other warning than a
  // line in the preview, so an override needs its own acknowledgement there.
  if (overridden && MAINNET_CHAIN_IDS[cid] && table?.mainnet && !flag("ALLOW_TOKEN_OVERRIDE")) {
    throw new Error(
      `SUPPORTED_TOKENS / WRAPPED_NATIVE are set, but on ${table.name} the token list is permanent and ` +
        `must be the reviewed table in this script. Clear them (PowerShell: Remove-Item ` +
        `Env:SUPPORTED_TOKENS, Env:WRAPPED_NATIVE), or set ALLOW_TOKEN_OVERRIDE=yes if you really ` +
        `mean to deploy a different permanent list.`
    );
  }
  const supportedAddrs = supported.map((t) => ethers.getAddress(t.address));
  if (new Set(supportedAddrs.map((a) => a.toLowerCase())).size !== supportedAddrs.length) {
    throw new Error("the supported-token list contains a duplicate");
  }
  if (supportedAddrs.includes(ethers.ZeroAddress)) {
    throw new Error("address(0) is the native coin, which is always accepted; do not list it");
  }
  if (table?.mainnet && wrappedNative === ethers.ZeroAddress) {
    throw new Error(`No wrapped-native token configured for ${table.name}`);
  }
  // The constructor's rule (review round 2), checked here so a mistake costs no gas.
  if (wrappedNative !== ethers.ZeroAddress && !supportedAddrs.includes(wrappedNative)) {
    throw new Error(
      `WRAPPED_NATIVE ${wrappedNative} is not in the supported-token list; the contract refuses an unlisted ` +
        `wrapped-native token (list it too, or set WRAPPED_NATIVE to the zero address)`
    );
  }
  if (mainnet && !table) {
    console.log(`WARNING: "${net}" is a mainnet name, but chain ${cid} is not a known mainnet. This is a`);
    console.log(`         rehearsal chain, so no token table applies (native coin only unless overridden).`);
  }
  // The constructor's payout-address rule (F09), checked here so a mistake costs no gas. It also
  // refuses the OP-stack predeploy range 0x4200...0000 to 0x4200...07FF (review round 2), the
  // four canonical ERC-4337 EntryPoints (review round 4) and Venus vBNB (review round 5).
  const ENTRYPOINTS = [
    "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", // v0.6
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032", // v0.7
    "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", // v0.8
    "0x433709009B8330FDa32311DF1C2AFA402eD8D009", // v0.9
    "0xA07c5b74C9B40447a954e1466938b865b6BBea36", // Venus vBNB (BNB Chain)
  ];
  const forbidden = new Set(
    [wrappedNative, ...supportedAddrs, ...ENTRYPOINTS].filter((a) => a !== ethers.ZeroAddress).map((a) => a.toLowerCase())
  );
  const isPredeploy = (a: string) => BigInt(a) >> 11n === BigInt("0x4200000000000000000000000000000000000000") >> 11n;
  if (forbidden.has(feeRecipient.toLowerCase()) || isPredeploy(feeRecipient)) {
    throw new Error(
      `FEE_RECIPIENT ${feeRecipient} is the wrapped-native token, a listed token, an OP-stack predeploy, an ERC-4337 ` +
        `EntryPoint or Venus vBNB; the contract refuses it`
    );
  }
  if (forbidden.has(admin.toLowerCase()) || isPredeploy(admin)) {
    throw new Error(`ADMIN_ADDRESS ${admin} is a token or system contract; it could never sign a transaction`);
  }

  // The address the contract will get is fixed by the deployer and its next nonce. A transaction
  // from the deployer still pending would take that nonce first.
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const minedNonce = await ethers.provider.getTransactionCount(deployer.address, "latest");
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
  if (admin === predicted) {
    throw new Error(`ADMIN_ADDRESS ${admin} is the address this deployment will create: the contract would own itself`);
  }

  const problems: string[] = [];
  const describeToken = async (addr: string, want?: { symbol?: string; decimals?: number }) => {
    if ((await ethers.provider.getCode(addr)) === "0x") {
      problems.push(`no contract code at ${addr}`);
      return "NO CODE";
    }
    const t = new ethers.Contract(addr, ERC20_META, ethers.provider);
    let symbol = "?";
    let decimals = -1;
    try {
      [symbol, decimals] = await Promise.all([t.symbol(), t.decimals().then(Number)]);
    } catch {
      problems.push(`${addr} does not answer symbol()/decimals()`);
      return "NOT AN ERC20";
    }
    if (want?.symbol !== undefined && symbol !== want.symbol) {
      problems.push(`${addr} reports symbol ${symbol}, expected ${want.symbol}`);
    }
    if (want?.decimals !== undefined && decimals !== want.decimals) {
      problems.push(`${addr} reports ${decimals} decimals, expected ${want.decimals}`);
    }
    return `${symbol} (${decimals} dp)`;
  };
  // Kind and history: a typo'd address is a wallet with no code too, but one that has never sent
  // a transaction; the cold wallet you mean has.
  const describeAccount = async (addr: string) => {
    if (addr === ethers.ZeroAddress) return "none: no fee is charged";
    const [code, sent] = await Promise.all([
      ethers.provider.getCode(addr),
      ethers.provider.getTransactionCount(addr, "latest"),
    ]);
    const kind = code === "0x" ? "wallet (no code)" : `contract, ${(code.length - 2) / 2} bytes`;
    const history = sent === 0 ? "has NEVER sent a transaction here" : `has sent ${sent} transaction(s)`;
    return `${kind}, ${history}${addr === deployer.address ? ", = DEPLOYER" : ""}`;
  };

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("─".repeat(72));
  console.log(`network        ${net} (chainId ${cid})${mainnet ? "  MAINNET" : ""}${dryRun ? "  DRY RUN" : ""}`);
  console.log(`deployer       ${deployer.address}`);
  console.log(`balance        ${ethers.formatEther(balance)}`);
  console.log(`nonce          ${nonce}${nonce !== minedNonce ? `  (${nonce - minedNonce} transaction(s) from the deployer still pending)` : ""}`);
  console.log(`contract at    ${predicted}  (from the deployer and this nonce)`);
  console.log(`admin          ${admin}  (${await describeAccount(admin)})`);
  console.log(`feeRecipient   ${feeRecipient}  (${await describeAccount(feeRecipient)})`);
  console.log(`claim fee      ${CLAIM_FEE_BPS} bps (${CLAIM_FEE_BPS / 100}%)`);
  console.log(`record         ${path.relative(process.cwd(), recordPath)}`);
  console.log(
    `wrappedNative  ${wrappedNative}${wrappedNative === ethers.ZeroAddress ? "  (none)" : `  ${await describeToken(wrappedNative)}`}`
  );
  if (supported.length === 0) console.log("tokens         none: native-coin vaults only");
  for (const [i, t] of supported.entries()) {
    const label = i === 0 ? "tokens        " : "              ";
    console.log(`${label} ${supportedAddrs[i]}  ${await describeToken(supportedAddrs[i], t)}`);
  }
  if (overridden) console.log("               (from SUPPORTED_TOKENS / WRAPPED_NATIVE, not the table)");
  console.log("               (this list can never be changed after deployment)");
  console.log("─".repeat(72));

  if (problems.length > 0) {
    throw new Error(`Refusing to deploy; the token list failed its checks:\n  - ${problems.join("\n  - ")}`);
  }
  if (balance === 0n) {
    throw new Error("Deployer has zero balance: fund it before deploying");
  }
  if (nonce !== minedNonce && mainnet && !dryRun) {
    throw new Error(
      `The deployer has ${nonce - minedNonce} pending transaction(s). Wait until they are mined (or replace them): ` +
        `the deployment's nonce, and so its address, must be certain before it is sent.`
    );
  }

  const Vault = await ethers.getContractFactory("InheritanceVault");
  const ctorArgs = [admin, CLAIM_FEE_BPS, feeRecipient, supportedAddrs, wrappedNative] as const;

  if (dryRun) {
    // eth_estimateGas runs the constructor against the live chain: a revert shows up here, free.
    const gas = await deployer.estimateGas(await Vault.getDeployTransaction(...ctorArgs));
    const block = await ethers.provider.getBlock("latest");
    const baseFee = block?.baseFeePerGas ?? 0n;
    // What hardhat's automatic fee provider will offer: the next block's base fee x 81/64 as
    // maxFeePerGas, the latest block's median tip as maxPriorityFeePerGas. The node needs
    // gas x maxFeePerGas in the account up front (on an OP-stack chain, plus a small L1 data fee).
    let maxFee = baseFee * 2n;
    let tip = 0n;
    try {
      const fh = await ethers.provider.send("eth_feeHistory", ["0x1", "latest", [50]]);
      tip = BigInt(fh.reward?.[0]?.[0] ?? 0);
      if (tip === 0n) tip = BigInt(await ethers.provider.send("eth_maxPriorityFeePerGas", []));
      maxFee = (BigInt(fh.baseFeePerGas[1]) * 81n) / 64n;
      if (maxFee < tip) maxFee += tip;
    } catch {
      // no fee history: keep the conservative 2 x base fee
    }
    const upfront = gas * maxFee;
    const expected = gas * (baseFee + tip);
    const prefunded = await ethers.provider.getBalance(predicted);
    const gwei = (w: bigint) => ethers.formatUnits(w, "gwei");
    console.log(`DRY RUN: nothing was sent.`);
    console.log(`  the constructor runs cleanly against the chain (eth_estimateGas): ${gas} gas`);
    console.log(`  base fee now ${gwei(baseFee)} gwei, tip ${gwei(tip)} gwei: the deployment should cost about ${ethers.formatEther(expected)} ETH`);
    console.log(`  the node will want ${ethers.formatEther(upfront)} ETH up front (${gas} gas x maxFeePerGas ${gwei(maxFee)} gwei)`);
    console.log(
      balance > upfront
        ? `  the balance covers that ${(Number(balance) / Number(upfront)).toFixed(1)} times over`
        : `  WARNING: the balance does not cover that; the node would refuse the transaction (nothing is lost). Fund the deployer.`
    );
    if (prefunded !== 0n) {
      console.log(`  note: ${predicted} already holds ${prefunded} wei; it will be surplus the admin can sweep (harmless)`);
    }
    console.log(`  the contract lands at ${predicted} only if the deployer sends nothing else first`);
    console.log(`To deploy exactly this, run the same command without DRY_RUN.`);
    return;
  }

  const vault = await Vault.deploy(...ctorArgs);
  const tx = vault.deploymentTransaction()!;
  console.log(`sent           ${tx.hash}  (nonce ${tx.nonce}); waiting for it to be mined`);
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error(`deployment transaction ${tx.hash} failed`);
  const vaultAddr = ethers.getAddress(rc.contractAddress ?? ethers.getCreateAddress({ from: deployer.address, nonce: tx.nonce }));
  // A load-balanced endpoint can answer null for a block it has not seen yet, even though another
  // node has just returned the receipt (the Base launch on 2026-09-28 got null here once).
  let mined = await ethers.provider.getBlock(rc.blockNumber).catch(() => null);
  for (let i = 0; !mined && i < 10; i++) {
    await sleep(1500);
    mined = await ethers.provider.getBlock(rc.blockNumber).catch(() => null);
  }
  console.log(`InheritanceVault  ${vaultAddr}   gas ${rc.gasUsed}  cost ${ethers.formatEther(rc.gasUsed * rc.gasPrice)}`);
  if (vaultAddr !== predicted) console.log(`note: the contract is at ${vaultAddr}, not the ${predicted} printed above`);

  // The record first: from here on the deployment exists whatever happens to the read-back, and
  // the record's existence refuses a second deployment by re-running this script.
  const record = {
    version: "v2",
    network: net,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    admin,
    feeRecipient,
    contracts: { InheritanceVault: vaultAddr },
    // deployerNonce (review round 2): this contract's address on EVERY chain is derived from the
    // deployer and this nonce, so value some payee forwards to "msg.sender" on another chain lands
    // at an address only the deployer key, sending from this nonce there, could ever put code at.
    // Once the deployer's nonce on a chain has passed it, nobody can.
    deployment: { tx: tx.hash, block: rc.blockNumber, timestamp: mined?.timestamp ?? null, deployerNonce: tx.nonce },
    // A deployment whose read-back failed is still recorded, so its address is never lost.
    readBack: "pending: the contract is deployed; its read-back has not finished",
    params: {
      claimFeeBps: CLAIM_FEE_BPS,
      wrappedNative,
      supportedTokens: supportedAddrs,
      tokens: supported.map((t, i) => ({ address: supportedAddrs[i], symbol: t.symbol, decimals: t.decimals })),
    },
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), { flag: "wx" });
  // hardhat verify cannot take an array on the command line; it reads the arguments from a module.
  fs.writeFileSync(
    argsPath,
    `module.exports = ${JSON.stringify([admin, CLAIM_FEE_BPS, feeRecipient, supportedAddrs, wrappedNative], null, 2)};\n`
  );
  console.log(`recorded       ${rel(recordPath)} (read-back pending)`);

  // ---- read back what the contract says about itself ----
  console.log("\nverifying…");
  let bad: number;
  try {
    bad = await readBackWithRetries(vaultAddr, {
      chainId, mainnet, deployer: deployer.address, admin, feeRecipient,
      claimFeeBps: CLAIM_FEE_BPS, wrappedNative, supported: supportedAddrs,
    });
  } catch (e) {
    record.readBack = `incomplete: ${errText(e)}`;
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    throw new Error(
      `The contract IS deployed at ${vaultAddr} (tx ${tx.hash}) and recorded in ${rel(recordPath)}, but its ` +
        `read-back could not finish: ${errText(e)}. Do NOT deploy again. Re-run the read-back alone:\n` +
        `  READBACK_ONLY=yes DEPLOYMENT_RECORD=${rel(recordPath)} npx hardhat run scripts/deploy.ts --network ${net}`
    );
  }
  record.readBack = bad === 0 ? "ok" : `${bad} check(s) FAILED: do not use`;
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  if (bad > 0) throw new Error(`${bad} post-deploy check(s) failed: do NOT use ${vaultAddr}`);

  console.log("\n" + "─".repeat(72));
  console.log(`Recorded in ${rel(recordPath)}`);
  console.log(`\nThe admin is ${admin === deployer.address ? "the DEPLOYER (hot key)" : "already the address you named"}: ` +
    `${admin === deployer.address ? "hand it over with scripts/transfer-admin.ts" : "no handover is needed"}.`);
  console.log("\nNext:");
  console.log(`  1. Verify the source (re-runnable, separate from the deploy; needs ETHERSCAN_API_KEY):`);
  console.log(
    `     npx hardhat verify --network ${net} --contract contracts/InheritanceVault.sol:InheritanceVault ` +
      `--constructor-args ${rel(argsPath)} ${vaultAddr}`
  );
  if (EXPLORERS[cid]) console.log(`     ${EXPLORERS[cid]}/address/${vaultAddr}#code`);
  if (cid === "8453" || cid === "84532") {
    // The deploy block's UTC date, as the site writes it ("28 September 2026"). If the block could
    // not be read, say so: a date made up from timestamp 0 would read as 1 January 1970.
    const d = mined ? new Date(Number(mined.timestamp) * 1000) : null;
    const date = d
      ? `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`
      : `<the UTC date of block ${rc.blockNumber}>`;
    const launch = `--address ${vaultAddr} --block ${rc.blockNumber} --tx ${tx.hash} --date "${date}"`;
    if (cid === "8453") {
      console.log(`  2. The launch values (V2_ADDRESS_TBD, V2_BLOCK_TBD, V2_TX_TBD, V2_DATE_TBD): scripts/set-launch-values.js`);
      console.log(`     checks them on chain and fills the markers in; add --v1-pause-tx once the Ledger has paused v1:`);
      console.log(`     node scripts/set-launch-values.js ${launch}`);
    } else {
      console.log(`  2. The site app's Base Sepolia slot: node scripts/set-launch-values.js --chain 84532 ${launch}`);
    }
  } else {
    console.log(`  2. This is the v2 contract: point only v2-aware tools at it (CHANGELOG-v2.md lists what changed).`);
  }
  console.log(`  3. notify/watcher.js speaks the v1 events; do not point it at v2.`);
  console.log("─".repeat(72));
}

// exitCode, not process.exit(): exiting with an RPC handle still closing aborts libuv on Windows.
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
