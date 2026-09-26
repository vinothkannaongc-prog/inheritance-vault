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
 * On a mainnet (Base, BNB Chain; by network name or chain id) the admin and the fee recipient
 * must be named explicitly, and neither may be the deployer's hot key:
 *
 *   ADMIN_ADDRESS        the cold wallet that will own the contract from its first block. Passing
 *                        it to the constructor means no handover transaction, and no window in
 *                        which the hot key is admin. Ownable2Step protects transfers, NOT the
 *                        constructor: a wrong address here is permanent, so it is printed with its
 *                        kind (wallet or contract) before anything is sent.
 *   FEE_RECIPIENT        where claim fees are credited; "none" (or the zero address) = no fee.
 *   ALLOW_DEPLOYER_ROLES=yes  lets either of the two name the deployer itself. Do not.
 *
 * On testnets and local chains both default to the deployer.
 *
 * Other settings: CLAIM_FEE_BPS (default 50), SUPPORTED_TOKENS=0xA,0xB|none and WRAPPED_NATIVE
 * (override the per-chain token table below), DEPLOYMENT_RECORD (where the record is written;
 * default deployments/<network>.json, and an existing record is never overwritten).
 *
 * Every constructor argument is printed BEFORE anything is sent, and every claim the contract
 * makes about itself is read back AFTER, because "it deployed" and "it deployed correctly" are
 * different statements. Source verification is a separate, re-runnable step (printed at the end),
 * so an explorer outage can never fail a deployment that has already happened.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { HB_DOMAIN, step as chainStep } from "./checkin-chain";

/** Mainnets by network name, and by chain id, so a renamed network entry is still a mainnet. */
const MAINNETS: Record<string, true> = { base: true, bnb: true };
const MAINNET_CHAIN_IDS: Record<string, string> = { "8453": "Base", "56": "BNB Chain" };

/** Claim fee in basis points. 50 = 0.5%, taken only when an inheritance settles. */
const CLAIM_FEE_BPS = Number(process.env.CLAIM_FEE_BPS ?? 50);

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
 * ADMIN_ADDRESS / FEE_RECIPIENT. On a mainnet the variable must be set, and it may not be the
 * deployer's own address unless ALLOW_DEPLOYER_ROLES=yes. Elsewhere it defaults to the deployer.
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
  if (mainnet && addr === deployer && process.env.ALLOW_DEPLOYER_ROLES !== "yes") {
    throw new Error(
      `${varName} is the deployer's own hot key (${deployer}). Use the cold wallet, or set ` +
        `ALLOW_DEPLOYER_ROLES=yes if you really mean it.`
    );
  }
  return addr;
}

async function main() {
  const net = network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const cid = chainId.toString();
  const table = TOKENS[cid];
  const mainnet = Boolean(MAINNETS[net] || MAINNET_CHAIN_IDS[cid]);
  if (mainnet && process.env.ALLOW_MAINNET !== "yes") {
    throw new Error(`Refusing to deploy to mainnet "${net}" (chainId ${cid}) without ALLOW_MAINNET=yes`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer: set DEPLOYER_KEY in the environment");

  // Everything that can refuse is checked before anything is sent.
  const admin = role("ADMIN_ADDRESS", deployer.address, mainnet, false);
  if (admin === ethers.ZeroAddress) throw new Error("ADMIN_ADDRESS is the zero address");
  const feeRecipient = role("FEE_RECIPIENT", deployer.address, mainnet, true);
  if (!Number.isInteger(CLAIM_FEE_BPS) || CLAIM_FEE_BPS < 0 || CLAIM_FEE_BPS > 100) {
    throw new Error(`CLAIM_FEE_BPS must be an integer from 0 to 100 (the contract's cap), got ${process.env.CLAIM_FEE_BPS}`);
  }

  const recordPath = path.resolve(
    process.env.DEPLOYMENT_RECORD ?? path.join(__dirname, "..", "deployments", `${net}.json`)
  );
  if (fs.existsSync(recordPath)) {
    throw new Error(
      `${path.relative(process.cwd(), recordPath)} already exists. It records an earlier deployment ` +
        `(on Base: the live v1 contract and its admin handover) and is never overwritten. ` +
        `Set DEPLOYMENT_RECORD to a new file, e.g. deployments/${net}-v2.json.`
    );
  }
  const argsPath = recordPath.replace(/\.json$/i, "") + ".vault-args.js";

  // ---- the token list is permanent, so check every entry before anything is sent ----
  const { wrappedNative, supported, overridden } = tokenConfig(cid);
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
  // refuses the OP-stack predeploy range 0x4200...0000 to 0x4200...07FF (review round 2) and the
  // four canonical ERC-4337 EntryPoints (review round 4).
  const ENTRYPOINTS = [
    "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", // v0.6
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032", // v0.7
    "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", // v0.8
    "0x433709009B8330FDa32311DF1C2AFA402eD8D009", // v0.9
  ];
  const forbidden = new Set(
    [wrappedNative, ...supportedAddrs, ...ENTRYPOINTS].filter((a) => a !== ethers.ZeroAddress).map((a) => a.toLowerCase())
  );
  const isPredeploy = (a: string) => BigInt(a) >> 11n === BigInt("0x4200000000000000000000000000000000000000") >> 11n;
  if (forbidden.has(feeRecipient.toLowerCase()) || isPredeploy(feeRecipient)) {
    throw new Error(
      `FEE_RECIPIENT ${feeRecipient} is the wrapped-native token, a listed token, an OP-stack predeploy or an ERC-4337 ` +
        `EntryPoint; the contract refuses it`
    );
  }
  if (forbidden.has(admin.toLowerCase()) || isPredeploy(admin)) {
    throw new Error(`ADMIN_ADDRESS ${admin} is a token or system contract; it could never sign a transaction`);
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
  const describeAccount = async (addr: string) => {
    if (addr === ethers.ZeroAddress) return "none: no fee is charged";
    const code = await ethers.provider.getCode(addr);
    const kind = code === "0x" ? "wallet (no code)" : `contract, ${(code.length - 2) / 2} bytes`;
    return `${kind}${addr === deployer.address ? ", = DEPLOYER" : ""}`;
  };

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("─".repeat(72));
  console.log(`network        ${net} (chainId ${cid})${mainnet ? "  MAINNET" : ""}`);
  console.log(`deployer       ${deployer.address}`);
  console.log(`balance        ${ethers.formatEther(balance)}`);
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

  const Vault = await ethers.getContractFactory("InheritanceVault");
  const vault = await Vault.deploy(admin, CLAIM_FEE_BPS, feeRecipient, supportedAddrs, wrappedNative);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  const tx = vault.deploymentTransaction()!;
  const rc = await tx.wait();
  console.log(`InheritanceVault  ${vaultAddr}   gas ${rc!.gasUsed}  cost ${ethers.formatEther(rc!.gasUsed * rc!.gasPrice)}`);

  // ---- read back what the contract says about itself ----
  console.log("\nverifying…");
  const probe = ethers.id("deploy.ts read-back probe");
  const ctx = { chainId, vault: vaultAddr, owner: admin, vaultId: 0, epoch: 1 };
  const code = await ethers.provider.getCode(vaultAddr);
  const checks: [string, unknown, unknown][] = [
    ["runtime size <= 24576 bytes", (code.length - 2) / 2 <= 24_576, true],
    ["owner", await vault.owner(), admin],
    ["no pending owner", await vault.pendingOwner(), ethers.ZeroAddress],
    ["claim fee in force", await vault.claimFeeBps(), BigInt(CLAIM_FEE_BPS)],
    ["no fee raise pending", `${await vault.pendingClaimFeeBps()}/${await vault.pendingClaimFeeAt()}`, "0/0"],
    ["fee recipient", await vault.feeRecipient(), feeRecipient],
    ["fee recipient active at once", await vault.feeRecipientActiveAt(), 0n],
    ["fee cap (bytecode)", await vault.MAX_CLAIM_FEE_BPS(), 100n],
    ["fee raise delay", await vault.FEE_RAISE_DELAY(), 2_592_000n],
    ["push grace", await vault.PUSH_GRACE(), 2_592_000n],
    ["min challenge window", await vault.MIN_CHALLENGE(), 604_800n],
    ["min inactivity", await vault.MIN_INACTIVITY(), 604_800n],
    ["creation paused", await vault.creationPaused(), false],
    ["no vaults yet", await vault.vaultsCreated(), 0n],
    ["wrapped native", await vault.wrappedNative(), wrappedNative],
    ["supported tokens, in order", (await vault.supportedTokens()).join(","), supportedAddrs.join(",")],
    ["native coin not listed", await vault.isSupportedToken(ethers.ZeroAddress), false],
    ["check-in chain domain", await vault.HB_DOMAIN(), HB_DOMAIN],
    // hbStep binds block.chainid: this proves the published generator matches this chain.
    ["check-in chain step (scripts/checkin-chain.ts)", await vault.hbStep(admin, 0, 1, probe), chainStep("v2", ctx, probe)],
  ];
  for (const a of supportedAddrs) checks.push([`listed ${a}`, await vault.isSupportedToken(a), true]);
  if (mainnet && process.env.ALLOW_DEPLOYER_ROLES !== "yes") {
    checks.push(["owner is not the deployer", (await vault.owner()) !== deployer.address, true]);
    checks.push(["fee recipient is not the deployer", (await vault.feeRecipient()) !== deployer.address, true]);
  }
  let bad = 0;
  for (const [label, got, want] of checks) {
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
  }

  // The admin must be unable to reach vault funds. Assert it rather than assert it in prose.
  for (const t of [ethers.ZeroAddress, ...supportedAddrs]) {
    const s = await vault.surplus(t);
    console.log(`  ${s === 0n ? "ok  " : "note"} surplus reachable by admin in ${t === ethers.ZeroAddress ? "native coin" : t}: ${s}`);
    if (t === ethers.ZeroAddress && s !== 0n) bad++;
  }

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
    deployment: { tx: tx.hash, block: rc!.blockNumber, deployerNonce: tx.nonce },
    // A deployment whose read-back failed is still recorded, so its address is never lost.
    readBack: bad === 0 ? "ok" : `${bad} check(s) FAILED: do not use`,
    params: {
      claimFeeBps: CLAIM_FEE_BPS,
      wrappedNative,
      supportedTokens: supportedAddrs,
      tokens: supported.map((t, i) => ({ address: supportedAddrs[i], symbol: t.symbol, decimals: t.decimals })),
    },
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  // hardhat verify cannot take an array on the command line; it reads the arguments from a module.
  fs.writeFileSync(
    argsPath,
    `module.exports = ${JSON.stringify([admin, CLAIM_FEE_BPS, feeRecipient, supportedAddrs, wrappedNative], null, 2)};\n`
  );
  if (bad > 0) throw new Error(`${bad} post-deploy check(s) failed: do NOT use ${vaultAddr}`);

  const rel = (p: string) => path.relative(process.cwd(), p).replace(/\\/g, "/");
  console.log("\n" + "─".repeat(72));
  console.log(`Recorded in ${rel(recordPath)}`);
  console.log(`\nThe admin is ${admin === deployer.address ? "the DEPLOYER (hot key)" : "already the address you named"}: ` +
    `${admin === deployer.address ? "hand it over with scripts/transfer-admin.ts" : "no handover is needed"}.`);
  console.log("\nNext:");
  console.log(`  1. Verify the source (re-runnable, separate from the deploy):`);
  console.log(`     npx hardhat verify --network ${net} --constructor-args ${rel(argsPath)} ${vaultAddr}`);
  if (EXPLORERS[cid]) console.log(`     ${EXPLORERS[cid]}/address/${vaultAddr}#code`);
  console.log(`  2. This is the v2 contract. Do NOT set site/assets/app.js CHAINS[${cid}].contract to it:`);
  console.log(`     the site app and site/assets/abi.js speak the v1 ABI, and v2 changed getVault and`);
  console.log(`     several events (CHANGELOG-v2.md). Ship a v2 app first.`);
  console.log(`  3. Likewise notify/watcher.js: v2 event signatures differ; do not point the v1 watcher at it.`);
  console.log("─".repeat(72));
}

// exitCode, not process.exit(): exiting with an RPC handle still closing aborts libuv on Windows.
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
