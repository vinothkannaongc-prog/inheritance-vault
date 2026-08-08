/**
 * Post-deploy smoke test against a LIVE deployment.
 *
 *   npx hardhat run scripts/smoke.ts --network base
 *
 * Creates a real vault with a dust deposit, checks in, then withdraws everything and pulls the
 * credit — proving the deployed bytecode actually works end to end on the real chain, not just
 * in a test harness. Costs a few cents in gas and returns the deposit.
 *
 * It deliberately does NOT test the claim path: that needs a second wallet as heir and a wait of
 * at least MIN_INACTIVITY (7 days) plus MIN_CHALLENGE (7 days). Run that separately, on purpose,
 * with a vault you intend to leave running.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DUST = ethers.parseEther(process.env.SMOKE_AMOUNT_ETH ?? "0.00002");

async function main() {
  const rec = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}.json`), "utf8")
  );
  const [me] = await ethers.getSigners();
  const vault = await ethers.getContractAt("InheritanceVault", rec.contracts.InheritanceVault, me);
  console.log(`vault ${rec.contracts.InheritanceVault} on ${network.name} as ${me.address}`);

  const before = await ethers.provider.getBalance(me.address);
  const heir = ethers.Wallet.createRandom().address; // never used; the vault is withdrawn, not claimed
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;

  console.log(`creating vault: ${ethers.formatEther(DUST)} ETH, heir ${heir}`);
  const id = await vault.vaultCount(me.address);
  let tx = await vault.createVault(
    ethers.ZeroAddress, DUST, heir, 7 * 86400, 7 * 86400, now + 365 * 86400, { value: DUST }
  );
  await tx.wait();
  console.log(`  created vault #${id}  ${tx.hash}`);

  let v = await vault.getVault(me.address, id);
  console.log(`  state ${v.state} balance ${ethers.formatEther(v.balance)} deadline ${new Date(Number(v.deadline) * 1000).toISOString()}`);
  if (v.state !== 1n || v.balance !== DUST) throw new Error("vault did not record correctly");

  tx = await vault.checkIn(id);
  await tx.wait();
  const after = await vault.getVault(me.address, id);
  console.log(`  checked in; deadline moved ${after.deadline > v.deadline ? "forward ok" : "NOT AT ALL"}  ${tx.hash}`);
  if (after.deadline <= v.deadline) throw new Error("checkIn did not extend the deadline");

  tx = await vault.withdraw(id, DUST, me.address);
  await tx.wait();
  v = await vault.getVault(me.address, id);
  console.log(`  withdrawn; state ${v.state} (4 = CLOSED)  ${tx.hash}`);
  if (v.state !== 4n) throw new Error("full withdrawal did not close the vault");

  const credit = await vault.creditOf(ethers.ZeroAddress, me.address);
  console.log(`  credit owed ${ethers.formatEther(credit)} (no fee on owner withdrawals)`);
  if (credit !== DUST) throw new Error("credit lane did not receive the full amount");

  tx = await vault.withdrawCredit(ethers.ZeroAddress, me.address);
  await tx.wait();
  console.log(`  pulled credit  ${tx.hash}`);
  if ((await vault.creditOf(ethers.ZeroAddress, me.address)) !== 0n) throw new Error("credit not cleared");

  const spent = before - (await ethers.provider.getBalance(me.address));
  console.log(`\nSMOKE TEST PASSED — deposit returned in full, net cost ${ethers.formatEther(spent)} ETH (gas only)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
