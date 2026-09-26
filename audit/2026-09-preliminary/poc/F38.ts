// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F38/test/poc-F38.ts.
// Mutates copies of contracts/v1/InheritanceVaultV1.sol and contracts/NotifySubscription.sol and runs the
// v1 shipped suites (support/shipped-v1) and the proposed suites (support/f38) on them. See ../README.md.
/**
 * F38 PoC: test coverage gaps, demonstrated by MUTATION TESTING.
 *
 * Method. For each regression the finding says would ship unnoticed, a mutant copy of the
 * contract is written to its own source tree (f38-mutants/<id>/contracts, same contract name,
 * exactly one textual edit that must match exactly once). The UNMODIFIED shipped test files are
 * then run against that tree in a child Hardhat process (hardhat.f38-mutant.config.ts).
 *
 *   0. Control: every suite passes on an unmutated tree, so a failure later is a real kill.
 *   1. INTENDED PROPERTY: "the shipped suite fails when this regression is introduced".
 *      A test here FAILS when the mutant survives. This is F38.
 *   2. The proposed boundary / hostile-token tests (f38/*.ts) kill each of those mutants.
 *   3. Two regressions the finding says would slip through, which the shipped suite in fact kills.
 *   4. The "~385 gwei" comment at test/NotifySubscription.ts:52 against an on-chain measurement.
 *
 * InheritanceVault.sol and NotifySubscription.sol are never edited; mutants are separate copies.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Evidence-suite port. Paths are relative to the repo root. The "shipped" suites are the v1 test files
// (support/shipped-v1: test/*.ts at b8baf34 with only the vault factory name changed to
// InheritanceVaultV1), and the mutated vault is contracts/v1/InheritanceVaultV1.sol, so this PoC keeps
// measuring v1 while the live test/ and contracts/InheritanceVault.sol move to v2. Mutant trees live
// under the git-ignored hardhat cache directory.
const ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js");
const SUPPORT = "audit/2026-09-preliminary/support";
const MUT_CFG = `${SUPPORT}/f38/hardhat.f38-mutant.config.ts`;
const TREES = "cache/audit-f38-mutants";

type Kind = "ns" | "iv";
const SHIPPED: Record<Kind, string[]> = {
  ns: [`${SUPPORT}/shipped-v1/NotifySubscription.ts`],
  iv: [`${SUPPORT}/shipped-v1/InheritanceVault.ts`, `${SUPPORT}/shipped-v1/Audit.ts`],
};
const SHIPPED_COUNT: Record<Kind, number> = { ns: 7, iv: 56 };
const PROPOSED: Record<Kind, string[]> = {
  ns: [`${SUPPORT}/f38/NotifySubscriptionBoundary.ts`],
  iv: [`${SUPPORT}/f38/VaultHostileTokens.ts`],
};
const PROPOSED_COUNT: Record<Kind, number> = { ns: 8, iv: 3 };
const SOURCE: Record<Kind, string> = { ns: "NotifySubscription.sol", iv: "v1/InheritanceVaultV1.sol" };

interface Mutant {
  id: string;
  kind: Kind;
  regression: string;
  edits: [string, string][];
}

// Regressions F38 says the shipped suite would let through.
const CLAIMED_SURVIVORS: Mutant[] = [
  {
    id: "NS-CAP-GTE", kind: "ns",
    regression: "NotifySubscription.sol:72 `target > cap` becomes `target >= cap`",
    edits: [["if (target > cap) revert TooFarAhead(cap);", "if (target >= cap) revert TooFarAhead(cap);"]],
  },
  {
    id: "NS-SLIP-LTE", kind: "ns",
    regression: "NotifySubscription.sol:66 `added < minSecondsAdded` becomes `<=`",
    edits: [["if (added < minSecondsAdded) revert", "if (added <= minSecondsAdded) revert"]],
  },
  {
    id: "NS-DUST-OFF1", kind: "ns",
    regression: "NotifySubscription.sol:65 dust guard rewritten as `msg.value < pricePerMonth / MONTH` (floor: 1 wei short)",
    edits: [["if (added == 0) revert ZeroAmount();", "if (msg.value < pricePerMonth / MONTH) revert ZeroAmount();"]],
  },
  {
    id: "NS-WD-ZERO", kind: "ns",
    regression: "NotifySubscription.sol:93 withdraw drops its address(0) check (revenue burnable)",
    edits: [["if (to == address(0)) revert ZeroAddress();", "// F38 mutant: zero-address check removed"]],
  },
  {
    id: "NS-WD-UNCHECKED", kind: "ns",
    regression: "NotifySubscription.sol:98 withdraw ignores a failed native send",
    edits: [["if (!ok) revert NativeTransferFailed(to, amount);", "if (!ok) {}"]],
  },
  {
    id: "NS-RECEIVE", kind: "ns",
    regression: "NotifySubscription gains a receive() that accepts plain transfers with no credit",
    edits: [["    function isActive(address account)", "    receive() external payable {}\n\n    function isActive(address account)"]],
  },
  {
    id: "NS-ONESTEP", kind: "ns",
    regression: "NotifySubscription drops Ownable2Step for one-step Ownable (the production handover path)",
    edits: [
      ['import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";',
       'import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";'],
      ["contract NotifySubscription is Ownable2Step {", "contract NotifySubscription is Ownable {"],
    ],
  },
  {
    id: "IV-PAYOUT-UNCHECKED", kind: "iv",
    regression: "InheritanceVault.sol:364 _payout uses IERC20.transfer instead of SafeERC20.safeTransfer",
    edits: [["IERC20(token).safeTransfer(to, amount);", "IERC20(token).transfer(to, amount);"]],
  },
  {
    id: "IV-PULL-UNCHECKED", kind: "iv",
    regression: "InheritanceVault.sol:352 _pull uses IERC20.transferFrom instead of SafeERC20.safeTransferFrom",
    edits: [["IERC20(token).safeTransferFrom(msg.sender, address(this), amount);",
             "IERC20(token).transferFrom(msg.sender, address(this), amount);"]],
  },
];

// Regressions F38 says (or implies) would slip through, but which the shipped suite already kills.
const CLAIMED_BUT_KILLED: (Mutant & { killedBy: string })[] = [
  {
    id: "IV-PULL-NOVALUE", kind: "iv",
    regression: "InheritanceVault.sol:350 _pull drops `if (msg.value != 0) revert UnexpectedNativeValue()` (F38's own exploit-scenario example)",
    edits: [["if (msg.value != 0) revert UnexpectedNativeValue();", "// F38 mutant: msg.value check removed"]],
    killedBy: "rejects bad parameters",
  },
  {
    id: "NS-CEIL", kind: "ns",
    regression: "NotifySubscription.sol:64 `added` rounds UP instead of down (a rounding-direction regression)",
    edits: [["uint256 added = (msg.value * MONTH) / pricePerMonth;",
             "uint256 added = (msg.value * MONTH + pricePerMonth - 1) / pricePerMonth;"]],
    killedBy: "rejects zero account, zero value, sub-second dust, and >10y prepay",
  },
];

// ------------------------------------------------------------------ harness

function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Writes a source tree for `id`: the (possibly mutated) contract plus the test helper mocks. */
function buildTree(id: string, kind: Kind, edits: [string, string][]): string {
  const orig = fs.readFileSync(path.join(ROOT, "contracts", SOURCE[kind]), "utf8");
  let src = orig;
  for (const [from, to] of edits) {
    const n = occurrences(src, from);
    if (n !== 1) throw new Error(`HARNESS: mutant ${id}: pattern occurs ${n} times, need exactly 1: ${from}`);
    src = src.replace(from, to);
  }
  if (edits.length > 0 && src === orig) throw new Error(`HARNESS: mutant ${id} is identical to the original`);
  const rel = `${TREES}/${id}`;
  const dir = path.join(ROOT, rel);
  fs.mkdirSync(path.join(dir, "contracts", "test"), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(dir, "contracts", SOURCE[kind])), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts", SOURCE[kind]), src);
  for (const helper of ["test/TestHelpers.sol", "audit/F38_HostileTokens.sol"]) {
    fs.copyFileSync(path.join(ROOT, "contracts", helper), path.join(dir, "contracts", "test", path.basename(helper)));
  }
  return rel;
}

interface Run { passing: number; failing: number; failed: string[]; raw: string }
const memo = new Map<string, Run>();

/** Runs test files, unmodified, against one source tree in a child Hardhat process. */
function runSuite(tree: string, files: string[], expectedTotal: number): Run {
  const key = `${tree}|${files.join(",")}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const env: NodeJS.ProcessEnv = { ...process.env, F38_MUTANT_DIR: tree, FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("HARDHAT_")) delete env[k];
  const r = spawnSync(process.execPath, [CLI, "--config", MUT_CFG, "test", ...files], {
    cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const p = raw.match(/(\d+) passing/);
  if (!p) throw new Error(`HARNESS: ${files.join(" ")} did not run on ${tree}:\n${raw.slice(-4000)}`);
  const fm = raw.match(/(\d+) failing/);
  const run: Run = {
    passing: Number(p[1]),
    failing: fm ? Number(fm[1]) : 0,
    failed: [...new Set([...raw.matchAll(/^\s+\d+\) (.+?)(:)?$/gm)].map((m) => m[1].trim()))],
    raw,
  };
  if (run.passing + run.failing !== expectedTotal) {
    throw new Error(`HARNESS: expected ${expectedTotal} tests on ${tree}, saw ${run.passing}+${run.failing}\n${raw.slice(-4000)}`);
  }
  memo.set(key, run);
  return run;
}

const table: string[] = [];

describe("F38 PoC: shipped test suites vs. mutants", function () {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  this.timeout(0);

  after(() => {
    console.log("\n    F38 mutation summary (shipped suite result on each mutant):");
    for (const line of table) console.log("      " + line);
  });

  describe("0. control: every suite passes on the unmutated contracts", () => {
    for (const kind of ["ns", "iv"] as Kind[]) {
      it(`${kind}: shipped suite ${SHIPPED[kind].join(" + ")} passes ${SHIPPED_COUNT[kind]}/${SHIPPED_COUNT[kind]}`, () => {
        const r = runSuite(buildTree(`${kind}-ORIGINAL`, kind, []), SHIPPED[kind], SHIPPED_COUNT[kind]);
        expect(r.failing, r.failed.join(" | ")).to.equal(0);
      });
      it(`${kind}: proposed suite ${PROPOSED[kind].join(" + ")} passes ${PROPOSED_COUNT[kind]}/${PROPOSED_COUNT[kind]}`, () => {
        const r = runSuite(buildTree(`${kind}-ORIGINAL`, kind, []), PROPOSED[kind], PROPOSED_COUNT[kind]);
        expect(r.failing, r.failed.join(" | ")).to.equal(0);
      });
    }
  });

  describe("1. INTENDED: the shipped suite must fail when each regression is introduced (FAILS = F38)", () => {
    for (const m of CLAIMED_SURVIVORS) {
      it(`${m.id}: ${m.regression}`, () => {
        const r = runSuite(buildTree(m.id, m.kind, m.edits), SHIPPED[m.kind], SHIPPED_COUNT[m.kind]);
        table.push(`${m.id.padEnd(20)} ${r.failing === 0 ? "SURVIVED" : "killed  "} shipped ${r.passing} passing / ${r.failing} failing`);
        expect(
          r.failing,
          `mutant ${m.id} SURVIVED the shipped suite: ${r.passing}/${SHIPPED_COUNT[m.kind]} shipped tests still pass`
        ).to.be.greaterThan(0);
      });
    }
  });

  describe("2. the proposed tests (f38/*.ts) kill every one of those mutants", () => {
    for (const m of CLAIMED_SURVIVORS) {
      it(`${m.id} is killed by ${PROPOSED[m.kind].join(" + ")}`, () => {
        const r = runSuite(buildTree(m.id, m.kind, m.edits), PROPOSED[m.kind], PROPOSED_COUNT[m.kind]);
        expect(r.failing, `proposed suite did not kill ${m.id}`).to.be.greaterThan(0);
        console.log(`        killed by: ${r.failed.join(" | ")}`);
      });
    }
  });

  describe("3. over-claims in F38: regressions the shipped suite already kills", () => {
    for (const m of CLAIMED_BUT_KILLED) {
      it(`${m.id}: ${m.regression}`, () => {
        const r = runSuite(buildTree(m.id, m.kind, m.edits), SHIPPED[m.kind], SHIPPED_COUNT[m.kind]);
        table.push(`${m.id.padEnd(20)} ${r.failing === 0 ? "SURVIVED" : "killed  "} shipped ${r.passing} passing / ${r.failing} failing`);
        expect(r.failing, `${m.id} survived`).to.be.greaterThan(0);
        expect(r.failed.some((t) => t.includes(m.killedBy)), `killed by: ${r.failed.join(" | ")}`).to.equal(true);
        console.log(`        killed by: ${r.failed.join(" | ")}`);
      });
    }
  });

  describe("4. the dust comment at test/NotifySubscription.ts:52", () => {
    it("'one second costs ~385 gwei' must match what one second actually costs on the contract", async () => {
      // Evidence-suite port: the v1 snapshot of test/NotifySubscription.ts (byte-identical to b8baf34).
      const line = fs.readFileSync(path.join(ROOT, SUPPORT, "shipped-v1", "NotifySubscription.ts"), "utf8").split(/\r?\n/)[51];
      const m = line.match(/one second costs ~(\d+) gwei/);
      expect(m, `line 52 is: ${line}`).to.not.equal(null);
      const claimed = ethers.parseUnits(m![1], "gwei");

      // Measure on the real contract: the smallest payment that buys one second.
      const PRICE = ethers.parseEther("0.001");
      const MONTH = 30n * 86_400n;
      const [admin, alice] = await ethers.getSigners();
      const sub = await (await ethers.getContractFactory("NotifySubscription", admin)).deploy(admin.address, PRICE);
      const cost = (PRICE + MONTH - 1n) / MONTH;
      await expect(sub.subscribe(alice.address, 0, { value: cost - 1n })).to.be.revertedWithCustomError(sub, "ZeroAmount");
      const t = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(t);
      await sub.subscribe(alice.address, 0, { value: cost });
      expect(await sub.paidUntil(alice.address)).to.equal(t + 1); // `cost` is the measured price of one second

      console.log(`        measured: ${cost} wei = ${ethers.formatUnits(cost, "gwei")} gwei; comment says ~${m![1]} gwei; ` +
        `the shipped dust test pays 100 wei, ${cost / 100n}x below the boundary`);
      expect(
        Number(cost),
        `one second costs ${cost} wei (${ethers.formatUnits(cost, "gwei")} gwei), not ~${m![1]} gwei: off by ${Number(claimed) / Number(cost)}x`
      ).to.be.closeTo(Number(claimed), Number(claimed) / 100);
    });
  });
});
