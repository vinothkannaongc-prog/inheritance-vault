/**
 * End-to-end scenario for the notify watcher against the real contracts on a local node.
 *
 * Run:  npx hardhat node --port 8547                                        (terminal 1)
 *       npx hardhat run scripts/notify-scenario.ts --network localnode      (terminal 2)
 *
 * Walks one vault through its whole life — quiet, reminder, expiry, claim, escalation, veto,
 * re-armed reminder, unpaid pause, on-chain renewal, second lapse, and a claim that settles
 * while the watcher is down — invoking the real watcher binary between steps.
 *
 * Assertions match on RECIPIENT as well as subject: "the right person gets the right email" is
 * the product, and an earlier version of this script would have passed with the owner's veto
 * alert routed to the heir.
 */
import { ethers, network } from "hardhat";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DAY = 86400;
const RPC = process.env.SCENARIO_RPC ?? "http://127.0.0.1:8547";

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

  const Sub = await ethers.getContractFactory("NotifySubscription", admin);
  const sub = await Sub.deploy(admin.address, ethers.parseEther("0.001"));
  await sub.waitForDeployment();
  const subAddr = await sub.getAddress();

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await vault.connect(alice).createVault(
    ethers.ZeroAddress, ethers.parseEther("10"), bob.address,
    7 * DAY, 7 * DAY, now + 730 * DAY, { value: ethers.parseEther("10") }
  );

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wk-notify-"));
  const outbox = path.join(work, "outbox");
  const cfgPath = path.join(work, "config.json");
  const OWNER_MAIL = "alice@willandkey.test";
  const HEIR_MAIL = "bob@willandkey.test";

  function writeConfig(enforce: boolean) {
    fs.writeFileSync(cfgPath, JSON.stringify({
      rpc: RPC,
      contract: addr,
      subscription: enforce ? { contract: subAddr, enforce: true } : undefined,
      // The config deliberately holds a differently-cased owner address than the chain returns,
      // so a regression that keys dedupe on config text instead of chain data re-blasts and fails.
      watches: [{
        owner: alice.address.toLowerCase(), email: OWNER_MAIL, heirEmail: HEIR_MAIL,
        heirAddress: bob.address, label: "test",
      }],
    }));
  }
  writeConfig(false);

  const watcher = path.resolve(__dirname, "../notify/watcher.js");
  const seen = new Set<string>();
  function runWatcher(): { to: string; subject: string }[] {
    try {
      execFileSync(process.execPath, [watcher, "--config", cfgPath], { stdio: "pipe" });
    } catch (e: any) {
      // Exit 2 means "something failed but state was still persisted" — surface it loudly.
      console.error(`watcher exited ${e.status}: ${e.stderr?.toString() ?? ""}`);
      if (e.status !== 2) throw e;
    }
    if (!fs.existsSync(outbox)) return [];
    const fresh: { to: string; subject: string }[] = [];
    for (const f of fs.readdirSync(outbox).sort()) {
      if (seen.has(f)) continue;
      seen.add(f);
      const lines = fs.readFileSync(path.join(outbox, f), "utf8").split("\n");
      fresh.push({ to: lines[0].replace("To: ", "").trim(), subject: lines[1].replace("Subject: ", "").trim() });
    }
    return fresh;
  }

  let step = 0;
  let failed = false;
  /** expect: [recipient, subject-fragment] pairs. Order-insensitive, count-exact. */
  function assertAlerts(got: { to: string; subject: string }[], expect: [string, string][], label: string) {
    step++;
    const remaining = [...got];
    let ok = got.length === expect.length;
    if (ok) {
      for (const [to, frag] of expect) {
        const i = remaining.findIndex((m) => m.to === to && m.subject.includes(frag));
        if (i === -1) { ok = false; break; }
        remaining.splice(i, 1);
      }
    }
    if (!ok) {
      console.error(
        `STEP ${step} FAIL (${label})\n expected: ${JSON.stringify(expect)}\n got: ${JSON.stringify(got)}`
      );
      failed = true;
    } else {
      console.log(`STEP ${step} ok — ${label}: ${got.length} alert(s)`);
    }
  }

  assertAlerts(runWatcher(), [], "fresh vault, no alerts");

  await increase(6 * DAY);
  assertAlerts(runWatcher(), [[OWNER_MAIL, "Check in within 1 day"]], "1-day reminder to the OWNER");
  assertAlerts(runWatcher(), [], "reminder not repeated");

  await increase(2 * DAY);
  assertAlerts(runWatcher(), [
    [OWNER_MAIL, "EXPIRED"],
    [HEIR_MAIL, "claimable"],
  ], "expiry alerts split correctly between owner and heir");

  await vault.connect(bob).initiateClaim(alice.address, 0, bob.address);
  assertAlerts(runWatcher(), [[OWNER_MAIL, "ACTION NEEDED"]], "veto alert to the OWNER, not the heir");
  // Two runs inside one challenge window must not produce a duplicate dressed as an escalation.
  assertAlerts(runWatcher(), [], "no duplicate veto alert on the very next run");

  await increase(8 * DAY);
  assertAlerts(runWatcher(), [
    [OWNER_MAIL, "ACTION NEEDED"],   // escalation as the settlement date passes
    [HEIR_MAIL, "finalized"],
  ], "veto ESCALATES while the heir is told it is finalizable");

  // The veto works, and the clock genuinely moves — asserted on chain, not by silence.
  const beforeAbort = (await vault.getVault(alice.address, 0)).deadline;
  await vault.connect(alice).abortClaim(0);
  const afterAbort = (await vault.getVault(alice.address, 0)).deadline;
  if (afterAbort <= beforeAbort) {
    console.error(`STEP FAIL: abortClaim did not reset the clock (${beforeAbort} -> ${afterAbort})`);
    failed = true;
  }
  assertAlerts(runWatcher(), [], "quiet after a veto that reset the clock");

  await increase(6 * DAY + 1);
  assertAlerts(runWatcher(), [[OWNER_MAIL, "Check in within 1 day"]], "reminder RE-ARMED on the new deadline");

  // ---- crypto-paid subscription gate ----
  writeConfig(true);
  assertAlerts(runWatcher(), [[OWNER_MAIL, "paused"]], "unpaid watch paused with a notice");
  assertAlerts(runWatcher(), [], "paused notice not repeated within the week");

  await sub.connect(alice).subscribe(alice.address, 0, { value: ethers.parseEther("0.002") }); // 2 months
  await increase(2 * DAY);
  assertAlerts(runWatcher(), [
    [OWNER_MAIL, "EXPIRED"],
    [HEIR_MAIL, "claimable"],
  ], "paid subscriber receives real alerts again");

  await increase(61 * DAY); // subscription lapses a second time
  const afterSecondLapse = runWatcher();
  assertAlerts(afterSecondLapse, [
    [OWNER_MAIL, "paused"],
    // Critical alerts survive a lapse. Round 2 caught the alternative: the heir being invited to
    // claim on the same day the owner was told nothing was happening.
    [OWNER_MAIL, "EXPIRED"],
    [HEIR_MAIL, "claimable"],
  ], "on a second lapse only ADVANCE reminders stop; critical alerts still reach both parties");

  // ---- a claim that starts AND settles while the watcher is down, with billing lapsed ----
  await vault.connect(bob).initiateClaim(alice.address, 0, bob.address);
  await increase(8 * DAY);
  await vault.connect(admin).finalizeClaim(alice.address, 0); // watcher never ran in between
  assertAlerts(runWatcher(), [
    [OWNER_MAIL, "SETTLED while reminders were down"],  // backfilled from ClaimInitiated logs
    [OWNER_MAIL, "now closed"],
    [HEIR_MAIL, "has closed"],
  ], "missed claim is backfilled and the terminal state is reported");

  fs.rmSync(work, { recursive: true, force: true });
  if (failed) {
    console.error("\nNOTIFY SCENARIO: FAILURES ABOVE");
    process.exit(1);
  }
  console.log("\nNOTIFY SCENARIO: ALL STEPS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
