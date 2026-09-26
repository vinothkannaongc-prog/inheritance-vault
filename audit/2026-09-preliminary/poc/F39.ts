// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F39/test/poc-F39.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Part 1 runs the v1 snapshot support/shipped-v1/Audit.ts, not the live test/Audit.ts.
/**
 * F39 PoC: the A-05 regression test (test/Audit.ts:304-315) depends on wall-clock time.
 *
 * The A-05 test asserts HorizonTooSoon(time.latest() + 1 + PERIOD, ...), i.e. it assumes the
 * createVault transaction lands in a block whose timestamp is exactly latest + 1. Under Hardhat
 * 2.29.0 / EDR 0.12, evm_revert (which loadFixture uses) does NOT rewind the block clock: the
 * clock after a revert keeps counting the wall time that has passed since the fixture snapshot
 * was first taken (and adds the elapsed whole seconds a second time). So in A-05 the block
 * timestamp is roughly latest + (wall time since A-01 first loaded the fixture), and the
 * assertion only holds while A-01..A-04 finish in under about one second.
 *
 * Part 1 runs the SHIPPED test/Audit.ts, unmodified, with every test made 150 ms slower (a slow
 * or loaded machine, a CI runner, parallel test runs). Its own A-05 test must pass: it fails
 * today, and it passes once A-05 pins the timestamp with time.setNextBlockTimestamp.
 * Part 2 isolates the mechanism with a copy of the A-05 fixture.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

const SLOW_MS = Number(process.env.F39_SLOW_MS ?? "150");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("F39 PoC: the A-05 regression test depends on wall-clock time", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  // ------------------------------------------------------------------ Part 1
  describe(`Part 1: shipped test/Audit.ts, unmodified, each test ${SLOW_MS} ms slower`, () => {
    let t0 = 0;
    beforeEach(async function () {
      if (t0 === 0) t0 = Date.now();
      await sleep(SLOW_MS);
      if (this.currentTest?.title.startsWith("createVault reports the minimum horizon")) {
        console.log(`      [F39] wall time from first Audit.ts test to A-05: ${Date.now() - t0} ms`);
      }
    });
    // Registers Audit.ts's suites as children of this suite, so the hook above applies to them.
    // (If Audit.ts was already loaded by the same mocha run, the require is a cached no-op.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // Evidence-suite port: the v1 snapshot of test/Audit.ts (support/shipped-v1), not the live file,
    // which the v2 work changes. Only its factory name differs from b8baf34 (InheritanceVaultV1).
    require("../support/shipped-v1/Audit");
  });

  // ------------------------------------------------------------------ Part 2
  describe("Part 2: the assumption A-05 relies on, isolated", () => {
    async function a05Fixture() {
      const [admin, alice, bob, , , feeSink] = await ethers.getSigners();
      const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
      const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
      return { vault, admin, alice, bob };
    }

    it("prime: the first loadFixture takes the snapshot, then 1.2 s of other tests run", async () => {
      await loadFixture(a05Fixture);
      await sleep(1_200); // stands in for A-01..A-04 on a slower machine
    });

    it("A-05 assertion verbatim: HorizonTooSoon minimum == time.latest() + 1 + PERIOD", async () => {
      const f = await loadFixture(a05Fixture);
      const now = await time.latest();
      await expect(
        f.vault
          .connect(f.alice)
          .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, now + PERIOD - DAY, { value: DEPOSIT })
      )
        .to.be.revertedWithCustomError(f.vault, "HorizonTooSoon")
        .withArgs(now + 1 + PERIOD, now + PERIOD - DAY);
    });

    it("prime again: 1.2 s passes after the fixture snapshot", async () => {
      await loadFixture(a05Fixture);
      await sleep(1_200);
    });

    it("the assumption itself: after loadFixture the next block is time.latest() + 1", async () => {
      await loadFixture(a05Fixture);
      const latest = await time.latest();
      await ethers.provider.send("evm_mine", []);
      const next = await time.latest();
      // The A-05 test is only deterministic if this holds. It does not: the clock was not rewound.
      expect(next - latest, "seconds between fixture block and next block").to.equal(1);
    });

    it("control: the recommended fix (pin the timestamp) is deterministic after the same gap", async () => {
      await loadFixture(a05Fixture);
      await sleep(1_200);
      const f = await loadFixture(a05Fixture);
      const t = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(t);
      await expect(
        f.vault
          .connect(f.alice)
          .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, t + PERIOD - DAY, { value: DEPOSIT })
      )
        .to.be.revertedWithCustomError(f.vault, "HorizonTooSoon")
        .withArgs(t + PERIOD, t + PERIOD - DAY);
    });
  });
});
