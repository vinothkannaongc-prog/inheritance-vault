/**
 * Moves admin control and fee revenue off the deploy key onto a cold wallet.
 *
 *   COLD_ADDRESS=0x... npx hardhat run scripts/transfer-admin.ts --network base
 *
 * The deployment record is read from DEPLOYMENT_RECORD, or deployments/<network>.json. It works
 * for a v1 record (InheritanceVault + NotifySubscription) and for a vault-only record, which is
 * what scripts/deploy.ts now writes (NotifySubscription is retired and no longer deployed). A v2
 * deployment made with ADMIN_ADDRESS set to the cold wallet needs no handover at all; this script
 * is for the Base v1 deployment's history and for future rotations.
 *
 * ORDER MATTERS, and it is the reason this is a script rather than ad-hoc calls:
 *
 *   1. setFeeRecipient(cold)      <- MUST come first. Only the owner can call it, so doing this
 *                                    after the ownership handover would strand the setting on a
 *                                    key you are trying to retire. Done only when fees are
 *                                    credited to the signing key itself: a zero recipient (fees
 *                                    off) is left off, because switching fees on is a fee change,
 *                                    not a handover (and on v2 it waits FEE_RAISE_DELAY), and a
 *                                    recipient that is some other address is left alone.
 *   2. vault.transferOwnership(cold)
 *   3. sub.transferOwnership(cold)   only if the record names a NotifySubscription
 *   4. From the COLD wallet: acceptOwnership() on each contract offered.
 *
 * Step 4 is deliberately not automated here: it must be signed by the cold wallet, which is the
 * entire point of Ownable2Step. An address that cannot sign cannot become owner, so a typo
 * leaves control exactly where it is instead of destroying it.
 *
 * Until step 4 completes, the current owner retains full control. Nothing is at risk in between.
 * Without CONFIRM=yes this is a dry run that sends nothing.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Only what both v1 and v2 share, so one script serves either deployment. */
const OWNABLE2STEP = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
];
const VAULT = [...OWNABLE2STEP, "function feeRecipient() view returns (address)", "function setFeeRecipient(address)"];

const EXPLORERS: Record<string, string> = {
  "8453": "Basescan (https://basescan.org)",
  "84532": "Basescan Sepolia (https://sepolia.basescan.org)",
  "56": "BscScan (https://bscscan.com)",
  "97": "BscScan testnet (https://testnet.bscscan.com)",
};
const COINS: Record<string, string> = { "8453": "ETH", "84532": "ETH", "56": "BNB", "97": "tBNB" };

async function main() {
  const raw = process.env.COLD_ADDRESS;
  if (!raw) throw new Error("Set COLD_ADDRESS to the wallet that should hold admin control");
  const cold = ethers.getAddress(raw.trim());
  if (cold === ethers.ZeroAddress) throw new Error("COLD_ADDRESS is the zero address");

  const recordPath = path.resolve(
    process.env.DEPLOYMENT_RECORD ?? path.join(__dirname, "..", "deployments", `${network.name}.json`)
  );
  if (!fs.existsSync(recordPath)) throw new Error(`No deployment record at ${recordPath} (set DEPLOYMENT_RECORD)`);
  const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const vaultAddr: string | undefined = rec.contracts?.InheritanceVault;
  const subAddr: string | undefined = rec.contracts?.NotifySubscription || undefined;
  if (!vaultAddr) throw new Error(`${recordPath} names no InheritanceVault`);

  const [me] = await ethers.getSigners();
  if (!me) throw new Error("No signer: set DEPLOYER_KEY in the environment");
  const cid = (await ethers.provider.getNetwork()).chainId.toString();
  if (rec.chainId !== undefined && String(rec.chainId) !== cid) {
    throw new Error(`${recordPath} is for chain ${rec.chainId}, but this network is chain ${cid}`);
  }
  // Refusals that need no contract read come first, so a dry run always gets this far.
  if (cold === me.address) throw new Error("COLD_ADDRESS is the current signer: that changes nothing");

  for (const [name, addr] of [["InheritanceVault", vaultAddr], ["NotifySubscription", subAddr]] as const) {
    if (addr && (await ethers.provider.getCode(addr)) === "0x") {
      throw new Error(`No contract code at the recorded ${name} ${addr}: wrong network or record?`);
    }
  }
  const vault = new ethers.Contract(vaultAddr, VAULT, me);
  const sub = subAddr ? new ethers.Contract(subAddr, OWNABLE2STEP, me) : undefined;

  const owner: string = await vault.owner();
  const subOwner: string | undefined = sub ? await sub.owner() : undefined;
  const feeRecipient: string = await vault.feeRecipient();
  const coldBalance = await ethers.provider.getBalance(cold);
  const coldCode = await ethers.provider.getCode(cold);
  const coin = COINS[cid] ?? "native coin";

  console.log("─".repeat(64));
  console.log(`network         ${network.name} (chainId ${cid})`);
  console.log(`record          ${path.relative(process.cwd(), recordPath)}`);
  console.log(`signing as      ${me.address}`);
  console.log(`vault           ${vaultAddr}`);
  console.log(`vault owner     ${owner}`);
  console.log(`subscription    ${subAddr ? `${subAddr} (owner ${subOwner})` : "none in this record"}`);
  console.log(`fee recipient   ${feeRecipient}${feeRecipient === ethers.ZeroAddress ? "  (none: fees off)" : ""}`);
  console.log(`NEW admin       ${cold}`);
  console.log(`  balance       ${ethers.formatEther(coldBalance)} ${coin}`);
  console.log(`  type          ${coldCode === "0x" ? "EOA (wallet)" : `contract (${(coldCode.length - 2) / 2} bytes); a Safe/multisig is fine, but it must be able to call acceptOwnership`}`);
  console.log("─".repeat(64));

  if (owner !== me.address) throw new Error(`You are not the vault owner (${owner} is): nothing to transfer`);
  if (sub && subOwner !== me.address) throw new Error(`You are not the subscription owner (${subOwner} is)`);

  const moveFee = feeRecipient === me.address;
  const steps = [
    moveFee
      ? `setFeeRecipient(${cold})`
      : `fee recipient left as is (${feeRecipient === cold ? "already the cold wallet" : feeRecipient === ethers.ZeroAddress ? "fees are off" : "not the signing key"})`,
    `vault.transferOwnership(${cold})`,
    ...(sub ? [`subscription.transferOwnership(${cold})`] : []),
  ];
  console.log("Plan:");
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  if (coldBalance === 0n) {
    console.log(`\nWARNING: the cold wallet holds no ${coin} on this network. It needs a small amount`);
    console.log("         to sign acceptOwnership. Fund it before the last step.");
  }
  if (process.env.CONFIRM !== "yes") {
    console.log("\nDry run. Nothing was sent. Re-run with CONFIRM=yes to send these transactions.");
    return;
  }

  // 1: fee revenue first, while this key still has the authority to set it
  if (moveFee) {
    const tx = await vault.setFeeRecipient(cold);
    await tx.wait();
    console.log(`fee recipient -> ${cold}  ${tx.hash}`);
  }

  // 2 and 3: hand over ownership; neither takes effect until the cold wallet accepts
  let tx = await vault.transferOwnership(cold);
  await tx.wait();
  console.log(`vault ownership offered  ${tx.hash}`);
  if (sub) {
    tx = await sub.transferOwnership(cold);
    await tx.wait();
    console.log(`subscription ownership offered  ${tx.hash}`);
  }

  console.log("\nState now:");
  console.log(`  vault owner  ${await vault.owner()}  (pending: ${await vault.pendingOwner()})`);
  if (sub) console.log(`  sub owner    ${await sub.owner()}  (pending: ${await sub.pendingOwner()})`);
  console.log(`  fee to       ${await vault.feeRecipient()}`);

  console.log("\n" + "─".repeat(64));
  console.log(`LAST STEP: from the COLD wallet, on ${network.name}, call acceptOwnership() on:`);
  console.log(`  ${vaultAddr}   acceptOwnership()`);
  if (sub) console.log(`  ${subAddr}   acceptOwnership()`);
  const explorer = EXPLORERS[cid];
  console.log(`\nUse ${explorer ? `${explorer}'s` : "the chain explorer's"} 'Write Contract' tab with the cold wallet connected,`);
  console.log("or your wallet's own contract-interaction screen. Until then this key remains admin.");
  console.log("─".repeat(64));
}

// exitCode, not process.exit(): exiting with an RPC handle still closing aborts libuv on Windows.
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
