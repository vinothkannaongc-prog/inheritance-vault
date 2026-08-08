/**
 * End-to-end scenario for the notify watcher against the real contract on a local node.
 *
 * Run:  npx hardhat node                                      (terminal 1)
 *       npx hardhat run scripts/notify-scenario.ts --network localhost
 *
 * Walks one vault through its whole life — quiet, reminder, expiry, claim, finalizable,
 * veto, re-armed reminder — invoking the actual watcher binary between steps and asserting
 * on what lands in its outbox.
 */
import { ethers, network } from "hardhat";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DAY = 86400;

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function main() {
  const [admin, alice, bob, , , feeSink] = await ethers.getSigners();

  const Vault = await ethers.getContractFactory("InheritanceVault", admin);
  const vault = await Vault.deploy(admin.address, 50, feeSink.address);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();
  console.log(`deployed InheritanceVault at ${addr}`);

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await vault.connect(alice).createVault(
    ethers.ZeroAddress, ethers.parseEther("10"), bob.address,
    7 * DAY, 7 * DAY, now + 730 * DAY, { value: ethers.parseEther("10") }
  );

  // Watcher workspace in a temp dir, dev (outbox) transport.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wk-notify-"));
  const outbox = path.join(work, "outbox");
  const cfgPath = path.join(work, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    rpc: "http://127.0.0.1:8547",
    contract: addr,
    watches: [{ owner: alice.address, email: "alice@test", heirEmail: "bob@test", label: "test" }],
  }));

  const watcher = path.resolve(__dirname, "../notify/watcher.js");
  const seen = new Set<string>();
  function runWatcher(): string[] {
    execFileSync(process.execPath, [watcher, "--config", cfgPath], { stdio: "pipe" });
    if (!fs.existsSync(outbox)) return [];
    const fresh: string[] = [];
    for (const f of fs.readdirSync(outbox)) {
      if (seen.has(f)) continue;
      seen.add(f);
      fresh.push(fs.readFileSync(path.join(outbox, f), "utf8"));
    }
    return fresh;
  }

  let step = 0;
  function assertAlerts(got: string[], expectSubjects: string[], label: string) {
    step++;
    const gotSubjects = got.map((m) => m.split("\n")[1]).sort();
    const ok = got.length === expectSubjects.length &&
      expectSubjects.every((e) => gotSubjects.some((g) => g.includes(e)));
    if (!ok) {
      console.error(`STEP ${step} FAIL (${label})\n expected: ${JSON.stringify(expectSubjects)}\n got: ${JSON.stringify(gotSubjects)}`);
      process.exit(1);
    }
    console.log(`STEP ${step} ok — ${label}: ${got.length} alert(s)`);
  }

  assertAlerts(runWatcher(), [], "fresh vault, no alerts");

  await increase(6 * DAY);
  assertAlerts(runWatcher(), ["Check in within 1 day"], "1-day reminder");
  assertAlerts(runWatcher(), [], "reminder not repeated");

  await increase(2 * DAY);
  assertAlerts(runWatcher(), ["EXPIRED", "claimable"], "owner expired + heir claimable");

  await vault.connect(bob).initiateClaim(alice.address, 0, bob.address);
  assertAlerts(runWatcher(), ["ACTION NEEDED"], "owner veto alert on claim");

  await increase(8 * DAY);
  assertAlerts(runWatcher(), ["finalized"], "heir finalizable alert");

  await vault.connect(alice).abortClaim(0);
  assertAlerts(runWatcher(), [], "quiet after veto (clock reset)");

  await increase(6 * DAY + 1);
  assertAlerts(runWatcher(), ["Check in within 1 day"], "reminder RE-ARMED after new deadline");

  // ---- crypto-paid subscription gate ----
  const Sub = await ethers.getContractFactory("NotifySubscription", admin);
  const sub = await Sub.deploy(admin.address, ethers.parseEther("0.001"));
  await sub.waitForDeployment();
  fs.writeFileSync(cfgPath, JSON.stringify({
    rpc: "http://127.0.0.1:8547",
    contract: addr,
    subscription: { contract: await sub.getAddress(), enforce: true },
    watches: [{ owner: alice.address, email: "alice@test", heirEmail: "bob@test", label: "test" }],
  }));

  assertAlerts(runWatcher(), ["paused"], "unpaid watch paused with notice");
  assertAlerts(runWatcher(), [], "paused notice not repeated");

  await sub.connect(alice).subscribe(alice.address, { value: ethers.parseEther("0.002") });
  assertAlerts(runWatcher(), [], "paid: service resumes, nothing new due yet");

  await increase(1 * DAY);
  assertAlerts(runWatcher(), ["EXPIRED", "claimable"], "paid subscriber gets full alerts again");

  fs.rmSync(work, { recursive: true, force: true });
  console.log("\nNOTIFY SCENARIO (incl. crypto-paid subscription): ALL STEPS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
