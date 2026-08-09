/**
 * Withdraws a vault in full and pulls the resulting credit. Recovery/cleanup tool.
 *
 *   VAULT_ID=0 npx hardhat run scripts/close-vault.ts --network base
 *
 * Written for the case where a smoke test created a vault and did not finish: the deposit sits
 * in an ACTIVE vault whose heir is a throwaway address nobody holds a key for. The owner can
 * always withdraw, so nothing is lost — but it should not be left running against a clock.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const id = BigInt(process.env.VAULT_ID ?? "0");
  const rec = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}.json`), "utf8")
  );
  const [me] = await ethers.getSigners();
  const vault = await ethers.getContractAt("InheritanceVault", rec.contracts.InheritanceVault, me);

  const v = await vault.getVault(me.address, id);
  console.log(`vault #${id} owned by ${me.address}`);
  console.log(`  state ${v.state} (1=ACTIVE 2=CLAIM_PENDING 3=SETTLED 4=CLOSED)`);
  console.log(`  balance ${ethers.formatEther(v.balance)}  heir ${v.beneficiary}`);

  if (v.state === 4n || v.state === 3n) {
    console.log("  already terminal — nothing to withdraw");
  } else if (v.balance === 0n) {
    console.log("  zero balance — nothing to withdraw");
  } else {
    const tx = await vault.withdraw(id, v.balance, me.address);
    await tx.wait();
    console.log(`  withdrawn in full  ${tx.hash}`);
    const after = await vault.getVault(me.address, id);
    console.log(`  state now ${after.state} (expected 4 = CLOSED)`);
  }

  const credit = await vault.creditOf(ethers.ZeroAddress, me.address);
  if (credit === 0n) {
    console.log("no native credit outstanding");
  } else {
    console.log(`pulling credit ${ethers.formatEther(credit)} ETH`);
    const tx = await vault.withdrawCredit(ethers.ZeroAddress, me.address);
    await tx.wait();
    console.log(`  paid out  ${tx.hash}`);
  }
  console.log("\nDone. Funds are back in your wallet.");
}

main().catch((e) => { console.error(e); process.exit(1); });
