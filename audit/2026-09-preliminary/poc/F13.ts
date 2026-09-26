// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F13/test/poc-F13.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F13: the challenge window is not a veto deadline.
 *
 * INTENDED property (what the watcher email, the index hero and the guides tell users, and what
 * `getVault().finalizable` reads as to an integrator):
 *
 *   Once block.timestamp >= claimInitiatedAt + challengeWindow (getVault().finalizable == true),
 *   no owner-key action can cancel the claim; the next finalizeClaim settles it.
 *
 * Every test here asserts that property, so every test FAILS against the current contract:
 * abortClaim, the _clearPending actions, a partial or full withdraw and extendHorizon all still
 * succeed after the window and knock the vault out of CLAIM_PENDING.
 *
 * Note for the fix: whether a FULL withdraw and extendHorizon should also be cut off at
 * finalizableAt is the design decision F13 asks for. If the chosen semantic keeps them, the two
 * tests marked [design] must be inverted, not deleted, and the site/watcher copy must change.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

const PENDING = 2n;
const SETTLED = 3n;

describe("F13 PoC: a matured claim must be final once the challenge window has elapsed", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  /**
   * Alice (owner) funds a vault for Bob (heir); Alice goes silent; Bob initiates a claim.
   * Returns finalizableAt without advancing past it.
   */
  async function initiated(f: any, horizonSecs = 730 * DAY) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    const v0 = await f.vault.getVault(f.alice.address, 0);
    await time.increaseTo(Math.max(Number(v0.deadline), await time.latest()) + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(PENDING);
    return { horizon, finalizableAt: Number(v.finalizableAt) };
  }

  /** Scenario step 2: three days after the window closed, the view says finalizable. */
  async function matured(f: any, horizonSecs = 730 * DAY) {
    const r = await initiated(f, horizonSecs);
    await time.increaseTo(r.finalizableAt + 3 * DAY);
    const v = await f.vault.getVault(f.alice.address, 0);
    // Precondition, not the defect: the contract itself says the claim is finalizable.
    expect(v.finalizable, "precondition: getVault().finalizable").to.equal(true);
    expect(await time.latest()).to.be.lt(r.horizon); // before the horizon unless a test says so
    return r;
  }

  /** After a rejected late veto the heir's finalizeClaim must still settle the claim. */
  async function heirStillSettles(f: any) {
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state, "claim must still be pending after the attempted veto").to.equal(PENDING);
    await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(SETTLED);
    expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.be.gt(0n);
  }

  // ------------------------------------------------------------ before the horizon

  describe("before the horizon, after finalizableAt", () => {
    it("abortClaim cannot veto a claim whose challenge window has closed", async () => {
      const f = await loadFixture(fixture);
      await matured(f);
      await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.reverted;
      await heirStillSettles(f);
    });

    it("abortClaim cannot veto at exactly finalizableAt (the boundary finalizeClaim accepts)", async () => {
      const f = await loadFixture(fixture);
      const { finalizableAt } = await initiated(f);
      await time.setNextBlockTimestamp(finalizableAt);
      await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.reverted;
      await heirStillSettles(f);
    });

    const soft: [string, (f: any) => Promise<any>][] = [
      ["setBeneficiary", (f) => f.vault.connect(f.alice).setBeneficiary(0, f.carol.address)],
      ["setInactivityPeriod", (f) => f.vault.connect(f.alice).setInactivityPeriod(0, 60 * DAY)],
      [
        "setCheckInChain",
        (f) => f.vault.connect(f.alice).setCheckInChain(0, ethers.keccak256(ethers.randomBytes(32)), 5),
      ],
      ["partial withdraw (1 wei)", (f) => f.vault.connect(f.alice).withdraw(0, 1n, f.alice.address)],
    ];
    for (const [name, call] of soft) {
      it(`${name} cannot supersede a claim whose challenge window has closed`, async () => {
        const f = await loadFixture(fixture);
        await matured(f);
        await expect(call(f)).to.be.reverted;
        await heirStillSettles(f);
      });
    }

    it("[design] extendHorizon cannot supersede a claim whose challenge window has closed", async () => {
      const f = await loadFixture(fixture);
      const { horizon } = await matured(f);
      await expect(f.vault.connect(f.alice).extendHorizon(0, horizon + 365 * DAY)).to.be.reverted;
      await heirStillSettles(f);
    });

    it("[design] a full withdraw cannot pull the estate out from under a finalizable claim", async () => {
      const f = await loadFixture(fixture);
      await matured(f);
      await expect(f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.carol.address)).to.be.reverted;
      await heirStillSettles(f);
    });
  });

  // ------------------------------------------------------------ past the horizon

  describe("past the horizon, after finalizableAt (the 'guaranteed' inheritance)", () => {
    it("[design] extendHorizon cannot cancel a finalizable claim past the horizon", async () => {
      const f = await loadFixture(fixture);
      // Horizon one day after the inactivity deadline: the claim is initiated past the horizon.
      const horizon = (await time.latest()) + PERIOD + DAY;
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      await time.increaseTo(horizon + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const v = await f.vault.getVault(f.alice.address, 0);
      await time.increaseTo(Number(v.finalizableAt) + DAY);
      const now = await f.vault.getVault(f.alice.address, 0);
      expect(now.finalizable).to.equal(true);
      // guaranteedInheritanceAt = absoluteDeadline + challengeWindow has passed as well.
      expect(await time.latest()).to.be.gt(Number(now.guaranteedInheritanceAt));

      const target = (await time.latest()) + 2 * PERIOD;
      await expect(f.vault.connect(f.alice).extendHorizon(0, target)).to.be.reverted;
      await heirStillSettles(f);
    });
  });

  // ------------------------------------------------------------ ordering at settlement

  describe("ordering: the owner key front-runs the heir's finalizeClaim", () => {
    it("heir's finalizeClaim, sent after the window, still lands when a veto is ordered ahead of it", async () => {
      const f = await loadFixture(fixture);
      const { finalizableAt } = await matured(f);

      await network.provider.send("evm_setAutomine", [false]);
      try {
        const fee = { gasLimit: 500_000n, maxFeePerGas: ethers.parseUnits("100", "gwei") };
        // Heir submits first, at a modest tip.
        const heirTx = await f.vault
          .connect(f.bob)
          .finalizeClaim(f.alice.address, 0, { ...fee, maxPriorityFeePerGas: ethers.parseUnits("1", "gwei") });
        // Owner key (Alice, a thief, or stale automation) sees it and outbids it with abortClaim.
        const vetoTx = await f.vault
          .connect(f.alice)
          .abortClaim(0, { ...fee, maxPriorityFeePerGas: ethers.parseUnits("50", "gwei") });
        await network.provider.send("evm_mine", []);

        const heirR = await ethers.provider.getTransactionReceipt(heirTx.hash);
        const vetoR = await ethers.provider.getTransactionReceipt(vetoTx.hash);
        const block = await ethers.provider.getBlock(heirR!.blockNumber);
        expect(block!.timestamp).to.be.gt(finalizableAt);
        expect(vetoR!.index, "veto was ordered first in the block").to.be.lt(heirR!.index);

        expect(heirR!.status, "heir's finalizeClaim after the window must succeed").to.equal(1);
        expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(SETTLED);
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
    });
  });

  // ------------------------------------------------------------ damage

  describe("damage: what a late veto costs the heir", () => {
    it("a veto after finalizableAt must not push the heir's settlement past the moment they finalize", async () => {
      const f = await loadFixture(fixture);
      const { finalizableAt } = await matured(f); // Bob, told 'closed ... with no veto', waits

      // Alice's key vetoes three days after the window closed. Outcome deliberately not asserted
      // here: a fixed contract reverts; the current one accepts.
      try {
        await f.vault.connect(f.alice).abortClaim(0);
      } catch {
        /* fixed contract */
      }
      const tryAt = await time.latest();

      // Bob now does everything right, as fast as the contract allows, and we measure when he
      // actually gets his credit.
      let settledAt: number;
      try {
        await f.vault.connect(f.bob).finalizeClaim.staticCall(f.alice.address, 0);
        await f.vault.connect(f.bob).finalizeClaim(f.alice.address, 0);
        settledAt = await time.latest();
      } catch (e: any) {
        expect(e.message).to.contain("NoClaimPending"); // the late veto is why
        const v = await f.vault.getVault(f.alice.address, 0);
        await expect(
          f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
        ).to.be.revertedWithCustomError(f.vault, "NotYetExpired");
        await time.increaseTo(Number(v.deadline));
        await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
        await time.increase(WINDOW);
        await f.vault.connect(f.bob).finalizeClaim(f.alice.address, 0);
        settledAt = await time.latest();
      }
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(SETTLED);

      const lostDays = (settledAt - tryAt) / DAY;
      const pastWindowDays = (settledAt - finalizableAt) / DAY;
      console.log(
        `      settlement landed ${lostDays.toFixed(2)} days after the heir tried to finalize ` +
          `(${pastWindowDays.toFixed(2)} days after finalizableAt; PERIOD=${PERIOD / DAY}d, WINDOW=${WINDOW / DAY}d)`
      );
      expect(
        settledAt - tryAt,
        `heir lost ${lostDays.toFixed(2)} days to a veto sent after the challenge window closed`
      ).to.be.lte(60); // a block or two, not a new inactivity period plus a new window
    });
  });
});
