/**
 * Deploys InheritanceVault + NotifySubscription and verifies the result on chain.
 *
 *   npx hardhat run scripts/deploy.ts --network baseSepolia
 *
 * The deployer key comes from the DEPLOYER_KEY environment variable and is never read, logged,
 * or written anywhere by this script. Mainnet requires ALLOW_MAINNET=yes as a second pair of
 * hands: a testnet typo costs nothing, a mainnet one is permanent.
 *
 * Every constructor argument is printed BEFORE anything is sent, and every claim the contracts
 * make about themselves is read back AFTER, because "it deployed" and "it deployed correctly"
 * are different statements.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const MAINNETS: Record<string, true> = { base: true, bnb: true };

/** Claim fee in basis points. 50 = 0.5%, taken only when an inheritance settles. */
const CLAIM_FEE_BPS = Number(process.env.CLAIM_FEE_BPS ?? 50);
/** Reminder subscription price per 30 days, in the chain's native coin. */
const SUB_PRICE = ethers.parseEther(process.env.SUB_PRICE_ETH ?? "0.001");

async function main() {
  const net = network.name;
  if (MAINNETS[net] && process.env.ALLOW_MAINNET !== "yes") {
    throw new Error(`Refusing to deploy to mainnet "${net}" without ALLOW_MAINNET=yes`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set DEPLOYER_KEY in the environment");

  const balance = await ethers.provider.getBalance(deployer.address);
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // The admin can pause new vault creation and sweep force-fed value. It can never reach a
  // vault balance or a credited payout. Default to the deployer; override for a cold wallet.
  const admin = process.env.ADMIN_ADDRESS
    ? ethers.getAddress(process.env.ADMIN_ADDRESS)
    : deployer.address;
  // Accrues claim fees as credits, indefinitely. Worth a dedicated address.
  const feeRecipient = process.env.FEE_RECIPIENT
    ? ethers.getAddress(process.env.FEE_RECIPIENT)
    : deployer.address;

  console.log("─".repeat(64));
  console.log(`network        ${net} (chainId ${chainId})`);
  console.log(`deployer       ${deployer.address}`);
  console.log(`balance        ${ethers.formatEther(balance)}`);
  console.log(`admin          ${admin}${admin === deployer.address ? "  (= deployer)" : ""}`);
  console.log(`feeRecipient   ${feeRecipient}${feeRecipient === deployer.address ? "  (= deployer)" : ""}`);
  console.log(`claim fee      ${CLAIM_FEE_BPS} bps (${CLAIM_FEE_BPS / 100}%)`);
  console.log(`sub price      ${ethers.formatEther(SUB_PRICE)} / 30 days`);
  console.log("─".repeat(64));

  if (balance === 0n) {
    throw new Error("Deployer has zero balance — fund it before deploying");
  }

  const Vault = await ethers.getContractFactory("InheritanceVault");
  const vault = await Vault.deploy(admin, CLAIM_FEE_BPS, feeRecipient);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  const vaultRc = await vault.deploymentTransaction()!.wait();
  console.log(`InheritanceVault    ${vaultAddr}   gas ${vaultRc!.gasUsed}`);

  const Sub = await ethers.getContractFactory("NotifySubscription");
  const sub = await Sub.deploy(admin, SUB_PRICE);
  await sub.waitForDeployment();
  const subAddr = await sub.getAddress();
  const subRc = await sub.deploymentTransaction()!.wait();
  console.log(`NotifySubscription  ${subAddr}   gas ${subRc!.gasUsed}`);

  const totalGas = vaultRc!.gasUsed + subRc!.gasUsed;
  const spent = (vaultRc!.gasUsed * vaultRc!.gasPrice) + (subRc!.gasUsed * subRc!.gasPrice);
  console.log(`total gas ${totalGas}  cost ${ethers.formatEther(spent)}`);

  // ---- read back what the contracts say about themselves ----
  console.log("\nverifying…");
  const checks: [string, unknown, unknown][] = [
    ["vault owner", await vault.owner(), admin],
    ["claim fee", await vault.claimFeeBps(), BigInt(CLAIM_FEE_BPS)],
    ["fee recipient", await vault.feeRecipient(), feeRecipient],
    ["fee cap (bytecode)", await vault.MAX_CLAIM_FEE_BPS(), 100n],
    ["min challenge window", await vault.MIN_CHALLENGE(), 604800n],
    ["min inactivity", await vault.MIN_INACTIVITY(), 604800n],
    ["creation paused", await vault.creationPaused(), false],
    ["sub owner", await sub.owner(), admin],
    ["sub price", await sub.pricePerMonth(), SUB_PRICE],
  ];
  let bad = 0;
  for (const [label, got, want] of checks) {
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
  }
  if (bad > 0) throw new Error(`${bad} post-deploy check(s) failed — do NOT use these addresses`);

  // The admin must be unable to reach vault funds. Assert it rather than assert it in prose.
  const surplus = await vault.surplus(ethers.ZeroAddress);
  console.log(`  ok   native surplus reachable by admin: ${ethers.formatEther(surplus)} (expected 0)`);
  if (surplus !== 0n) throw new Error("Fresh deployment reports non-zero surplus");

  const record = {
    network: net,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    admin,
    feeRecipient,
    contracts: { InheritanceVault: vaultAddr, NotifySubscription: subAddr },
    params: { claimFeeBps: CLAIM_FEE_BPS, subPricePerMonth: SUB_PRICE.toString() },
  };
  const dir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}.json`), JSON.stringify(record, null, 2));

  console.log("\n" + "─".repeat(64));
  console.log(`Recorded in deployments/${net}.json\n`);
  console.log("Next:");
  console.log(`  1. site/assets/app.js  -> CHAINS[${chainId}].contract = "${vaultAddr}"`);
  console.log(`                            CHAINS[${chainId}].notify   = "${subAddr}"`);
  console.log(`  2. notify/config.json  -> contract + subscription.contract`);
  console.log(`  3. npx hardhat verify --network ${net} ${vaultAddr} ${admin} ${CLAIM_FEE_BPS} ${feeRecipient}`);
  console.log("─".repeat(64));
}

main().catch((e) => { console.error(e); process.exit(1); });
