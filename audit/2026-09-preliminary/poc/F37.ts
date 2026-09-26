// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F37/test/poc-F37.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: notify/watcher.js (run as a child process).
/**
 * F37 PoC -- chain/RPC environment vs the watcher's log paging.
 *
 * The contract side of F37 (veto inclusion depends on the Base sequencer / BNB validators) has no
 * executable behaviour: it is a documentation gap, cited in the report. What CAN be executed is
 * the watcher side, and measuring it showed the finding understates it: the watcher's 9,000-block
 * eth_getLogs page is not "sized for Base" -- it is rejected by the very Base RPC the shipped
 * config names.
 *
 * Measured 2026-09-24 with read-only JSON-RPC probes (measure-chains.js / probe-caps.js):
 *   https://mainnet.base.org  (notify/config.example.json "rpc")
 *       to - fromBlock = 2000 -> ok;   2001 -> -32614 "eth_getLogs is limited to a 2,000 range"
 *   https://bsc-dataseed.bnbchain.org / bsc-dataseed.binance.org  (hardhat.config.ts "bnb")
 *       even a 1-block eth_getLogs -> -32005 "limit exceeded"
 *   Block time: Base 2.0000 s, BNB 0.4503 s (over the last 100k blocks).
 *
 * The test runs the REAL notify/watcher.js (unmodified, read-only) as a child process against a
 * local JSON-RPC proxy in front of the in-process Hardhat chain. The proxy forwards everything
 * verbatim and only reproduces the measured eth_getLogs policy of the named public RPC. Blocks
 * are produced at Base's real cadence (2 s) with hardhat_mine, so an outage spans as many blocks
 * as it would on mainnet -- unlike scripts/notify-scenario.ts, where 8 days is ONE block.
 *
 * Scenario (the case only the backfill can report -- W-05's reason to exist):
 *   1. Watcher is healthy and runs once; alice has no vault yet.
 *   2. Watcher outage. Alice creates a 7-day / 7-day vault naming bob, goes silent, bob
 *      initiates a claim, the window passes, a third party (carol) finalizes. Bob is credited.
 *   3. Watcher comes back and runs on its 6-hour cron (notify/README.md).
 *   Safe property: alice is told her vault SETTLED while reminders were down.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as http from "http";
import { AddressInfo } from "net";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DAY = 86_400;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;
const BASE_BLOCK_SECS = 2; // measured 2.0000 s/block on Base mainnet
const CRON_SECS = 6 * 3600; // notify/README.md: "0 */6 * * *"
const MAX_RECOVERY_RUNS = 20; // five days of 6-hour cron after the outage; stops early once told

// Evidence-suite port: the watcher is run (read-only) from this repo's working tree.
const REPO_WATCHER = path.resolve(__dirname, "..", "..", "..", "notify", "watcher.js");
// F37_WATCHER lets a candidate fix (e.g. a patched copy) be checked against the same scenario.
const WATCHER = process.env.F37_WATCHER ?? REPO_WATCHER;

const OWNER_MAIL = "alice@willandkey.test";
const HEIR_MAIL = "bob@willandkey.test";

/** eth_getLogs policy of a real public endpoint, as measured. null = no cap (Hardhat node). */
type LogPolicy =
  | { name: string; maxSpan: number; code: number; message: string }
  | { name: string; maxSpan: null };

const UNCAPPED: LogPolicy = { name: "uncapped local node (what notify-scenario.ts uses)", maxSpan: null };
const BASE_PUBLIC: LogPolicy = {
  name: "https://mainnet.base.org (config.example.json)",
  maxSpan: 2000, // to - from <= 2000 accepted, 2001 rejected
  code: -32614,
  message: "eth_getLogs is limited to a 2,000 range",
};
const BNB_DATASEED: LogPolicy = {
  name: "https://bsc-dataseed.bnbchain.org (hardhat.config.ts bnb)",
  maxSpan: -1, // rejected even for a single block
  code: -32005,
  message: "limit exceeded",
};

interface Proxy { url: string; getLogsSeen: number; getLogsRejected: number; close(): Promise<void>; }

async function startProxy(policy: LogPolicy): Promise<Proxy> {
  const stats = { getLogsSeen: 0, getLogsRejected: 0 };
  const handle = async (m: any) => {
    if (m.method === "eth_getLogs" && policy.maxSpan !== null) {
      stats.getLogsSeen += 1;
      const f = m.params?.[0] ?? {};
      const hex = (x: any) => typeof x === "string" && x.startsWith("0x");
      if (hex(f.fromBlock) && hex(f.toBlock)) {
        const span = Number(BigInt(f.toBlock) - BigInt(f.fromBlock));
        if (span > policy.maxSpan) {
          stats.getLogsRejected += 1;
          return { jsonrpc: "2.0", id: m.id, error: { code: policy.code, message: policy.message } };
        }
      }
    } else if (m.method === "eth_getLogs") {
      stats.getLogsSeen += 1;
    }
    try {
      const result = await network.provider.request({ method: m.method, params: m.params ?? [] });
      return { jsonrpc: "2.0", id: m.id, result };
    } catch (e: any) {
      return { jsonrpc: "2.0", id: m.id, error: { code: e.code ?? -32603, message: e.message, data: e.data } };
    }
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const payload = JSON.parse(body);
      const out = Array.isArray(payload) ? await Promise.all(payload.map(handle)) : await handle(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get getLogsSeen() { return stats.getLogsSeen; },
    get getLogsRejected() { return stats.getLogsRejected; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Run { code: number; stderr: string; }
function runWatcher(cfgPath: string): Promise<Run> {
  // Async on purpose: the proxy lives on this process's event loop.
  return new Promise((resolve) =>
    execFile(process.execPath, [WATCHER, "--config", cfgPath], { timeout: 180_000 }, (err: any, _o, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stderr: String(stderr) })
    )
  );
}

function readOutbox(dir: string): { to: string; subject: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
    return { to: lines[0].replace("To: ", "").trim(), subject: lines[1].replace("Subject: ", "").trim() };
  });
}

async function fixture() {
  const [admin, alice, bob, carol, , feeSink] = await ethers.getSigners();
  const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
  const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
  // Give the chain history, as mainnet has: head >> LOG_PAGE, so the first run's page is full-size.
  await mine(10_000, { interval: BASE_BLOCK_SECS });
  return { vault, admin, alice, bob, carol };
}

interface Outcome {
  policy: string;
  runs: Run[];
  mails: { to: string; subject: string }[];
  heirCredit: bigint;
  vaultState: number;
  scanCursorPersisted: boolean;
  getLogsSeen: number;
  getLogsRejected: number;
  outageBlocks: number;
}

async function outageScenario(policy: LogPolicy): Promise<Outcome> {
  const f = await loadFixture(fixture);
  const proxy = await startProxy(policy);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wk-f37-work-")); // port: outside the repo
  try {
    const cfgPath = path.join(work, "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({
      rpc: proxy.url,
      contract: await f.vault.getAddress(),
      watches: [{ owner: f.alice.address, email: OWNER_MAIL, heirEmail: HEIR_MAIL,
                  heirAddress: f.bob.address, label: "F37" }],
    }));
    const runs: Run[] = [];

    // 1. healthy baseline run: alice has no vault yet
    runs.push(await runWatcher(cfgPath));

    // 2. outage, at Base's real block cadence
    const outageStart = await ethers.provider.getBlockNumber();
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, 7 * DAY, 7 * DAY, horizon, { value: DEPOSIT });
    await mine((7 * DAY) / BASE_BLOCK_SECS + 60, { interval: BASE_BLOCK_SECS });
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await mine((7 * DAY) / BASE_BLOCK_SECS + 60, { interval: BASE_BLOCK_SECS });
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);
    const outageBlocks = (await ethers.provider.getBlockNumber()) - outageStart;

    // 3. watcher back on its 6-hour cron
    const outbox = path.join(work, "outbox");
    for (let i = 0; i < MAX_RECOVERY_RUNS; i++) {
      await mine(CRON_SECS / BASE_BLOCK_SECS, { interval: BASE_BLOCK_SECS });
      runs.push(await runWatcher(cfgPath));
      if (readOutbox(outbox).some((m) => m.to === OWNER_MAIL && m.subject.includes("SETTLED while reminders were down"))) break;
    }

    const state = JSON.parse(fs.readFileSync(path.join(work, "state.json"), "utf8"));
    return {
      policy: policy.name,
      runs,
      mails: readOutbox(outbox),
      heirCredit: await f.vault.creditOf(NATIVE, f.bob.address),
      vaultState: Number((await f.vault.getVault(f.alice.address, 0)).state),
      scanCursorPersisted: Object.keys(state.scan ?? {}).length > 0,
      getLogsSeen: proxy.getLogsSeen,
      getLogsRejected: proxy.getLogsRejected,
      outageBlocks,
    };
  } finally {
    await proxy.close();
    fs.rmSync(work, { recursive: true, force: true }); // only the per-test work dir
  }
}

function describeOutcome(o: Outcome): string {
  const firstErr = o.runs.map((r) => r.stderr.split("\n").find((l) => l.includes("backfill failed"))).find(Boolean);
  return [
    `RPC policy: ${o.policy}`,
    `outage spanned ${o.outageBlocks} blocks; vault state after outage = ${o.vaultState} (3 = SETTLED); heir credited ${ethers.formatEther(o.heirCredit)} ETH`,
    `watcher runs: ${o.runs.length} (1 before the outage + ${o.runs.length - 1} on the 6-h cron after it); exit codes: [${o.runs.map((r) => r.code).join(", ")}]`,
    `eth_getLogs calls: ${o.getLogsSeen}, rejected by the RPC policy: ${o.getLogsRejected}`,
    `scan cursor ever persisted: ${o.scanCursorPersisted}`,
    `emails sent: ${JSON.stringify(o.mails)}`,
    `first backfill error: ${firstErr ?? "(none)"}`,
  ].join("\n    ");
}

describe("F37 -- watcher log paging vs the public RPCs of the target chains", function () {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  this.timeout(900_000);

  it("control: on an uncapped node the backfill reports a claim that started and settled during an outage", async () => {
    const o = await outageScenario(UNCAPPED);
    console.log("    " + describeOutcome(o));
    expect(o.vaultState).to.equal(3);
    expect(o.mails.filter((m) => m.to === OWNER_MAIL && m.subject.includes("SETTLED while reminders were down")))
      .to.have.length(1, describeOutcome(o));
  });

  it("SAFE PROPERTY: against the Base RPC the shipped config names, the owner is told the claim SETTLED while reminders were down", async () => {
    const o = await outageScenario(BASE_PUBLIC);
    console.log("    " + describeOutcome(o));
    expect(o.vaultState, "setup: the claim must have settled").to.equal(3);
    // The defect: LOG_PAGE (9,000) exceeds mainnet.base.org's 2,000-block eth_getLogs cap, so
    // every backfill page is refused and the W-05 alert can never be produced on Base.
    expect(
      o.mails.filter((m) => m.to === OWNER_MAIL && m.subject.includes("SETTLED while reminders were down")),
      "owner was never told the estate transferred:\n    " + describeOutcome(o)
    ).to.have.length(1);
  });

  it("DAMAGE: owner receives no email at all about a settled estate -- Base public RPC and BNB dataseed", async () => {
    const results: Outcome[] = [];
    for (const p of [BASE_PUBLIC, BNB_DATASEED]) results.push(await outageScenario(p));
    for (const o of results) console.log("    " + describeOutcome(o));
    for (const o of results) {
      expect(o.vaultState).to.equal(3);
      expect(o.heirCredit).to.be.greaterThan(0n);
    }
    // Safe property: whatever the chain's RPC, an owner whose estate transferred during an outage
    // hears about it from the watcher at least once. Checked against a LOG_PAGE = 2_000 copy of
    // the watcher (F37_WATCHER=...): the Base half then passes (told after 7 cron runs) but the
    // BNB-dataseed half still fails, because no page size survives an RPC that refuses eth_getLogs
    // outright. That half needs a log-free fallback (the contract exposes vaultCount(owner), so
    // getVault(owner, 0..n-1) finds settled vaults without logs) or a logs-capable BNB RPC.
    const silent = results.filter((o) => !o.mails.some((m) => m.to === OWNER_MAIL));
    expect(silent.map((o) => o.policy),
      "policies under which the owner received ZERO emails:\n    " + silent.map(describeOutcome).join("\n\n    "))
      .to.deep.equal([]);
  });
});
