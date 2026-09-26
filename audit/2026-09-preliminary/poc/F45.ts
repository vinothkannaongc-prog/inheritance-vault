// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F45/test/poc-F45.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: notify/watcher.js (run as a child process),
//  site/assets/app.js.
/**
 * PoC for F45: past the horizon, the watcher's ACTIVE-state alerts (owner "EXPIRED", heir
 * "claimable", owner "horizon N days away") and the app's warningLines still send people to a
 * check-in that the contract refuses, and promise an ordinary veto that abortClaim no longer
 * provides. B-06 only fixed the CLAIM_PENDING branch (notify/watcher.js:147-154).
 *
 * The watcher is run for real: the unmodified notify/watcher.js is spawned as a child process
 * (`node watcher.js --config ...`, dev-mode outbox transport) against this test's in-process
 * Hardhat chain, served over HTTP by Hardhat's own JSON-RPC server. The emails asserted on are
 * the files it writes to its outbox.
 *
 * Every wording test asserts the INTENDED property (watcher.js:12-13, design rule 5: "Never
 * assert something the contract will refuse") and first proves, on chain, that the action the
 * message names really does revert. They fail against the current code because of the defect.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require("hardhat");

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

// Evidence-suite port: the watcher and app.js are read (read-only) from this repo's working tree.
const WATCHER = path.resolve(__dirname, "../../../notify/watcher.js");
const APP_JS = path.resolve(__dirname, "../../../site/assets/app.js");

const OWNER_EMAIL = "alice@owner.test";
const HEIR_EMAIL = "bob@heir.test";

type Mail = { file: string; to: string; subject: string; body: string };

function runWatcher(cfgPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Async on purpose: the JSON-RPC server lives in THIS process's event loop.
    execFile(process.execPath, [WATCHER, "--config", cfgPath], { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function readOutbox(dir: string): Mail[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const [head, ...rest] = raw.split("\n\n");
      const to = /^To: (.*)$/m.exec(head)![1].trim();
      const subject = /^Subject: (.*)$/m.exec(head)![1].trim();
      return { file, to, subject, body: rest.join("\n\n") };
    });
}

/** The live browser function, lifted verbatim from site/assets/app.js. */
function loadWarningLines(): (w: number) => string[] {
  const src = fs.readFileSync(APP_JS, "utf8");
  const m = /function warningLines\(warnings\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) throw new Error("warningLines not found in app.js");
  return new Function(`${m[0]}; return warningLines;`)();
}

describe("F45 watcher/app alert wording past the horizon", function () {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  this.timeout(120_000);

  let vault: any;
  let alice: any;
  let bob: any;
  let server: any;
  let horizon: number;
  let runDir: string;
  let mails: Mail[] = [];
  let watcherRun: { code: number; stdout: string; stderr: string };

  before(async () => {
    const [admin, a, b, feeSink] = await ethers.getSigners();
    alice = a;
    bob = b;
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);

    // Alice: 30-day check-in period, 14-day veto window, horizon 40 days out.
    const t0 = await time.latest();
    horizon = t0 + 40 * DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });

    // She is diligent: checks in on day 25. _resetClock clamps the deadline to the horizon.
    await time.increase(25 * DAY);
    await vault.connect(alice).checkIn(0);
    expect((await vault.getVault(alice.address, 0)).deadline).to.equal(BigInt(horizon));

    // One day past the horizon, the vault is still ACTIVE, and necessarily expired too.
    await time.increaseTo(horizon + DAY);
    const v = await vault.getVault(alice.address, 0);
    expect(Number(v.state)).to.equal(1);
    expect(v.expired).to.equal(true);
    expect(v.horizonReached).to.equal(true);
    expect(Number(v.warnings)).to.equal(3); // bit 0 expired + bit 1 horizon reached

    // Serve the in-process chain over HTTP and run the real watcher against it.
    server = await hre.run("node:create-server", {
      hostname: "127.0.0.1",
      port: 0,
      provider: hre.network.provider,
    });
    const { port } = await server.listen();

    const runsRoot = path.join(os.tmpdir(), "wk-poc-F45-runs"); // port: outside the repo
    fs.mkdirSync(runsRoot, { recursive: true });
    runDir = fs.mkdtempSync(path.join(runsRoot, "run-"));
    const cfgPath = path.join(runDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          rpc: `http://127.0.0.1:${port}`,
          contract: await vault.getAddress(),
          outboxDir: "outbox",
          stateFile: "state.json",
          watches: [
            {
              owner: alice.address,
              email: OWNER_EMAIL,
              label: "Alice",
              heirEmail: HEIR_EMAIL,
              heirAddress: bob.address,
            },
          ],
        },
        null,
        2
      )
    );
    watcherRun = await runWatcher(cfgPath);
    mails = readOutbox(path.join(runDir, "outbox"));
  });

  after(async () => {
    if (server) await server.close();
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true }); // port: clean the temp run dir
  });

  function only(pred: (m: Mail) => boolean, what: string): Mail {
    const hits = mails.filter(pred);
    expect(
      hits.length,
      `expected exactly one ${what}; watcher exit=${watcherRun.code}\n${watcherRun.stdout}\n${watcherRun.stderr}\n` +
        mails.map((m) => `[${m.to}] ${m.subject}`).join("\n")
    ).to.equal(1);
    return hits[0];
  }

  it("the watcher ran cleanly and sent the owner and heir alerts for the past-horizon vault", async () => {
    expect(watcherRun.code, watcherRun.stderr).to.equal(0);
    only((m) => m.to === OWNER_EMAIL && /EXPIRED/.test(m.subject), "owner EXPIRED alert");
    only((m) => m.to === OWNER_EMAIL && /horizon/i.test(m.subject), "owner horizon alert");
    only((m) => m.to === HEIR_EMAIL && /claimable/i.test(m.subject), "heir claimable alert");
  });

  it("owner EXPIRED alert past the horizon must not send the owner to checkIn (it reverts HorizonReached)", async () => {
    // Ground truth: every check-in route the owner has is refused on chain.
    await expect(vault.connect(alice).checkIn(0))
      .to.be.revertedWithCustomError(vault, "HorizonReached")
      .withArgs(horizon);
    await expect(vault.connect(alice).checkInMany([0])).to.be.revertedWithCustomError(vault, "NothingCheckedIn");

    const m = only((x) => x.to === OWNER_EMAIL && /EXPIRED/.test(x.subject), "owner EXPIRED alert");
    // Design rule 5 (watcher.js:12-13): never tell an owner to take an action that reverts.
    expect(m.body, `owner EXPIRED alert body:\n${m.body}`).to.not.match(/should check in|check in now/i);
  });

  it("owner EXPIRED alert past the horizon must not promise an ordinary veto; it must name extendHorizon", async () => {
    // Ground truth: once the heir starts a claim past the horizon, abortClaim (the ordinary veto)
    // reverts; only extendHorizon (to >= now + one inactivity period) or a full withdraw stops it.
    const snap = await takeSnapshot();
    await vault.connect(bob).initiateClaim(alice.address, 0, bob.address);
    await expect(vault.connect(alice).abortClaim(0))
      .to.be.revertedWithCustomError(vault, "HorizonReached")
      .withArgs(horizon);
    await expect(vault.connect(alice).checkIn(0)).to.be.revertedWithCustomError(vault, "ClaimPendingUseAbort");
    const now = await time.latest();
    await vault.connect(alice).extendHorizon(0, now + PERIOD + DAY); // the one remedy that works
    expect(Number((await vault.getVault(alice.address, 0)).state)).to.equal(1);
    await snap.restore();

    const m = only((x) => x.to === OWNER_EMAIL && /EXPIRED/.test(x.subject), "owner EXPIRED alert");
    // The fixed claim branch (watcher.js:150-153) names the horizon extension; this one must too.
    expect(m.body, `owner EXPIRED alert body:\n${m.body}`).to.match(/extend/i);
    expect(m.body, `owner EXPIRED alert body:\n${m.body}`).to.match(/horizon/i);
  });

  it("heir 'claimable' alert past the horizon must not tell the heir to have the owner check in", async () => {
    await expect(vault.connect(alice).checkIn(0)).to.be.revertedWithCustomError(vault, "HorizonReached");
    const m = only((x) => x.to === HEIR_EMAIL && /claimable/i.test(x.subject), "heir claimable alert");
    expect(m.body, `heir claimable alert body:\n${m.body}`).to.not.match(/tell them to check in/i);
  });

  it("horizon alert first evaluated after the horizon must not say the horizon is still 'days away'", async () => {
    const v = await vault.getVault(alice.address, 0);
    expect(v.horizonReached).to.equal(true);
    expect(BigInt(await time.latest())).to.be.greaterThan(v.absoluteDeadline);
    const m = only((x) => x.to === OWNER_EMAIL && /horizon/i.test(x.subject), "owner horizon alert");
    expect(m.subject, `horizon alert subject: ${m.subject}`).to.not.match(/days? away/i);
  });

  it("app warningLines for a vault past its horizon must not tell the owner to check in", async () => {
    const warningLines = loadWarningLines();
    const bits = Number((await vault.getVault(alice.address, 0)).warnings);
    expect(bits).to.equal(3);
    const lines = warningLines(bits);
    const checkInLines = lines.filter((l) => /\bcheck in\b/i.test(l));
    expect(checkInLines, `warningLines(${bits}) = ${JSON.stringify(lines)}`).to.deep.equal([]);
  });

  it("contrast: the B-06-fixed CLAIM_PENDING branch already words the same horizon state correctly", async () => {
    // Same vault, same moment, one state later: the heir starts a claim and the watcher runs
    // again with the same state file. The claim alert branches on horizonReached (watcher.js:150);
    // the ACTIVE-state alerts above do not. This test passes today and documents the gap.
    const snap = await takeSnapshot();
    try {
      await vault.connect(bob).initiateClaim(alice.address, 0, bob.address);
      const again = await runWatcher(path.join(runDir, "config.json"));
      expect(again.code, again.stderr).to.equal(0);
      const all = readOutbox(path.join(runDir, "outbox"));
      const claim = all.filter((x) => x.to === OWNER_EMAIL && /claim is running/i.test(x.subject));
      expect(claim.length).to.equal(1);
      expect(claim[0].body).to.match(/passed its horizon/);
      expect(claim[0].body).to.match(/extending the horizon/);
      expect(claim[0].body).to.not.match(/a check-in is enough/);
    } finally {
      await snap.restore();
    }
  });
});
