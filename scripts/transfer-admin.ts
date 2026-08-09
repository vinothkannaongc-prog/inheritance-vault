/**
 * Moves admin control and fee revenue off the deploy key onto a cold wallet.
 *
 *   COLD_ADDRESS=0x... npx hardhat run scripts/transfer-admin.ts --network base
 *
 * ORDER MATTERS, and it is the reason this is a script rather than three ad-hoc calls:
 *
 *   1. setFeeRecipient(cold)      <- MUST come first. Only the owner can call it, so doing this
 *                                    after the ownership handover would strand the setting on a
 *                                    key you are trying to retire.
 *   2. vault.transferOwnership(cold)
 *   3. sub.transferOwnership(cold)
 *   4. From the COLD wallet: acceptOwnership() on BOTH contracts.
 *
 * Step 4 is deliberately not automated here — it must be signed by the cold wallet, which is the
 * entire point of Ownable2Step: an address that cannot sign cannot become owner, so a typo
 * leaves control exactly where it is instead of destroying it.
 *
 * Until step 4 completes, the current owner retains full control. Nothing is at risk in between.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const raw = process.env.COLD_ADDRESS;
  if (!raw) throw new Error("Set COLD_ADDRESS to the wallet that should hold admin control");
  const cold = ethers.getAddress(raw.trim());

  const rec = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}.json`), "utf8")
  );
  const [me] = await ethers.getSigners();
  const vault = await ethers.getContractAt("InheritanceVault", rec.contracts.InheritanceVault, me);
  const sub = await ethers.getContractAt("NotifySubscription", rec.contracts.NotifySubscription, me);

  const owner = await vault.owner();
  const subOwner = await sub.owner();
  const feeRecipient = await vault.feeRecipient();
  const coldBalance = await ethers.provider.getBalance(cold);
  const coldCode = await ethers.provider.getCode(cold);

  console.log("─".repeat(64));
  console.log(`network         ${network.name}`);
  console.log(`signing as      ${me.address}`);
  console.log(`vault owner     ${owner}`);
  console.log(`sub owner       ${subOwner}`);
  console.log(`fee recipient   ${feeRecipient}`);
  console.log(`NEW admin       ${cold}`);
  console.log(`  balance       ${ethers.formatEther(coldBalance)} ETH`);
  console.log(`  type          ${coldCode === "0x" ? "EOA (wallet)" : `contract (${(coldCode.length - 2) / 2} bytes) — a Safe/multisig is fine, but it must be able to call acceptOwnership`}`);
  console.log("─".repeat(64));

  if (cold === me.address) throw new Error("COLD_ADDRESS is the current signer — that changes nothing");
  if (owner !== me.address) throw new Error(`You are not the vault owner (${owner} is) — nothing to transfer`);
  if (subOwner !== me.address) throw new Error(`You are not the subscription owner (${subOwner} is)`);
  if (coldBalance === 0n) {
    console.log("WARNING: the cold wallet holds no ETH on this network. It needs a small amount");
    console.log("         (a cent or two) to sign acceptOwnership. Fund it before step 4.\n");
  }
  if (process.env.CONFIRM !== "yes") {
    console.log("Dry run. Re-run with CONFIRM=yes to send these three transactions.");
    return;
  }

  // 1 — fee revenue first, while this key still has the authority to set it
  if (feeRecipient === cold) {
    console.log("1/3 fee recipient already set — skipping");
  } else {
    const tx = await vault.setFeeRecipient(cold);
    await tx.wait();
    console.log(`1/3 fee recipient -> ${cold}  ${tx.hash}`);
  }

  // 2 & 3 — hand over ownership; neither takes effect until the cold wallet accepts
  let tx = await vault.transferOwnership(cold);
  await tx.wait();
  console.log(`2/3 vault ownership offered  ${tx.hash}`);

  tx = await sub.transferOwnership(cold);
  await tx.wait();
  console.log(`3/3 subscription ownership offered  ${tx.hash}`);

  console.log("\nState now:");
  console.log(`  vault owner  ${await vault.owner()}  (pending: ${await vault.pendingOwner()})`);
  console.log(`  sub owner    ${await sub.owner()}  (pending: ${await sub.pendingOwner()})`);
  console.log(`  fee to       ${await vault.feeRecipient()}`);

  console.log("\n" + "─".repeat(64));
  console.log("STEP 4 — from the COLD wallet, on Base, call acceptOwnership() on both:");
  console.log(`  ${rec.contracts.InheritanceVault}   acceptOwnership()`);
  console.log(`  ${rec.contracts.NotifySubscription}   acceptOwnership()`);
  console.log("\nUse Basescan's 'Write Contract' tab with the cold wallet connected, or your");
  console.log("wallet's own contract-interaction screen. Until then this key remains admin.");
  console.log("─".repeat(64));
}

main().catch((e) => { console.error(e); process.exit(1); });
