/**
 * Regression tests for the 2026-08-09 adversarial audit.
 *
 * Every test here failed against the pre-audit contract and passes after the fix. A finding
 * that could not be expressed as a failing test here did not go into the audit report.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const ONE = ethers.parseEther("1");
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

describe("Audit 2026-08-09 regressions", () => {
  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVault", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  async function nativeVault(f: any, horizonSecs = 730 * DAY, period = PERIOD, window = WINDOW) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, period, window, horizon, { value: DEPOSIT });
    return horizon;
  }

  // ---------------------------------------------------------------- A-01

  describe("A-01 cross-function reentrancy during the deposit measurement", () => {
    async function reentrantFixture() {
      const f = await loadFixture(fixture);
      const Tok = await ethers.getContractFactory("ReentrantToken", f.admin);
      const token = await Tok.deploy();
      const vaultAddr = await f.vault.getAddress();
      await token.setVault(vaultAddr);
      // The token owns a vault, so its receive-hook runs as that vault's owner.
      await token.mint(await token.getAddress(), ethers.parseEther("100"));
      const horizon = (await time.latest()) + 730 * DAY;
      await token.openVault(f.bob.address, PERIOD, WINDOW, horizon, ethers.parseEther("100"));
      // A well-meaning third party funds the same vault.
      await token.mint(f.dave.address, ethers.parseEther("50"));
      await token.connect(f.dave).approve(vaultAddr, ethers.MaxUint256);
      return { ...f, token, vaultAddr };
    }

    it("a hook that closes the vault mid-topUp cannot strand the deposit", async () => {
      const f = await reentrantFixture();
      await f.token.arm(1, ethers.parseEther("100"), f.carol.address); // re-enter withdraw

      // Pre-fix: this succeeded and wrote 50e18 onto a CLOSED vault, unreachable forever.
      await expect(
        f.vault.connect(f.dave).topUp(await f.token.getAddress(), 0, ethers.parseEther("50"))
      ).to.be.reverted;

      const v = await f.vault.getVault(await f.token.getAddress(), 0);
      expect(v.state).to.equal(1); // still ACTIVE — the whole attack reverted
      expect(v.balance).to.equal(ethers.parseEther("100"));
      expect(await f.vault.totalLocked(await f.token.getAddress())).to.equal(ethers.parseEther("100"));
    });

    it("a hook that starts a claim mid-topUp cannot move funds under the heir", async () => {
      const f = await reentrantFixture();
      await time.increase(PERIOD + 1); // deadline passed, so a claim would be legal
      await f.token.arm(2, 0, f.carol.address); // re-enter initiateClaim
      await expect(
        f.vault.connect(f.dave).topUp(await f.token.getAddress(), 0, ethers.parseEther("50"))
      ).to.be.reverted;
      expect((await f.vault.getVault(await f.token.getAddress(), 0)).state).to.equal(1);
    });
  });

  // ---------------------------------------------------------------- A-02

  describe("A-02 the horizon must actually bound a hostile owner key", () => {
    it("abortClaim is closed past the horizon, so the veto loop cannot run forever", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);

      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      // Pre-fix: abortClaim succeeded and reset the clock to a PAST value, so the heir could be
      // re-aborted every block, forever, for the price of gas.
      await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(
        f.vault,
        "HorizonReached"
      );

      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(3); // SETTLED
    });

    it("soft owner actions cannot displace a claim past the horizon either", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

      for (const call of [
        f.vault.connect(f.alice).setBeneficiary(0, f.carol.address),
        f.vault.connect(f.alice).setInactivityPeriod(0, 60 * DAY),
        f.vault.connect(f.alice).setCheckInChain(0, ethers.keccak256(ethers.randomBytes(32)), 5),
      ]) {
        await expect(call).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      }
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(2); // still pending
    });

    // ROUND 2: the first fix left two ways to run the same unbounded loop. Both are closed here,
    // and the round-1 version of this very test was demonstrating one of them while asserting
    // the opposite.
    it("a dust withdrawal is not a backdoor veto past the horizon", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

      // The owner may still take money out — but 1 wei must not reset the heir's claim, or
      // abortClaim's closure is decorative and the loop runs at 1 wei per iteration.
      await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state).to.equal(2); // claim survives; the heir simply inherits less
      expect(v.balance).to.equal(DEPOSIT - ONE);

      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.be.greaterThan(0);
    });

    it("a full withdrawal past the horizon still closes the vault and the claim with it", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(4); // CLOSED
    });

    it("extendHorizon cannot be satisfied with a horizon that is still in the past", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 100 * DAY);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

      // Pre-fix: +1 second satisfied `newAbsoluteDeadline > absoluteDeadline`, cleared the claim,
      // left the deadline pinned in the past, and could be repeated every block forever.
      await expect(
        f.vault.connect(f.alice).extendHorizon(0, horizon + 1)
      ).to.be.revertedWithCustomError(f.vault, "HorizonTooSoon");

      // A genuine future horizon works and re-arms the whole mechanism.
      await f.vault.connect(f.alice).extendHorizon(0, (await time.latest()) + 400 * DAY);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state).to.equal(1);
      expect(v.deadline).to.equal((await time.latest()) + PERIOD); // clock genuinely reset
    });

    it("setCheckInChain refuses to install a chain that could never be used", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      // Pre-fix: this succeeded, cleared the "chain exhausted" warning bit, and installed a
      // chain every checkInByChain would reject -- a green toast over a dead mechanism.
      await expect(
        f.vault.connect(f.alice).setCheckInChain(0, ethers.keccak256(ethers.randomBytes(32)), 100)
      ).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    });

    it("checkInMany skips ids the owner never had instead of reverting the batch", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f);
      await nativeVault(f);
      await time.increase(10 * DAY);
      // Pre-fix: NoSuchVault reverted the whole call, so one stale id in a keeper's list
      // silently stopped refreshing the entire estate -- the exact trap fix A-03 removed.
      expect(await f.vault.connect(f.alice).checkInMany.staticCall([0, 1, 7])).to.equal(2);
      await f.vault.connect(f.alice).checkInMany([0, 1, 7]);
      const t = await time.latest();
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(t + PERIOD);
      expect((await f.vault.getVault(f.alice.address, 1)).deadline).to.equal(t + PERIOD);
    });

    it("before the horizon the abort cooldown is a full inactivity period", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f); // 730-day horizon, nowhere near
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.alice).abortClaim(0);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NotYetExpired");
    });
  });

  // ---------------------------------------------------------------- A-03

  describe("A-03 checkInMany must not be all-or-nothing", () => {
    it("one horizon-reached vault does not brick check-in for the whole estate", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f); // vault 0, long horizon
      await nativeVault(f, PERIOD + DAY); // vault 1, horizon in 31 days
      await nativeVault(f); // vault 2, long horizon

      await time.increase(PERIOD + 2 * DAY); // vault 1 is past its horizon
      // Pre-fix: this reverted HorizonReached and refreshed NOTHING, so vaults 0 and 2 lapsed.
      await f.vault.connect(f.alice).checkInMany([0, 1, 2]);

      const t = await time.latest();
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(t + PERIOD);
      expect((await f.vault.getVault(f.alice.address, 2)).deadline).to.equal(t + PERIOD);
      // Vault 1 is genuinely past its horizon and is skipped, not silently "refreshed".
      expect((await f.vault.getVault(f.alice.address, 1)).horizonReached).to.equal(true);
    });

    it("one claim-pending vault does not block the owner's other check-ins", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f);
      await nativeVault(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);

      await f.vault.connect(f.alice).checkInMany([0, 1]);
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal((await time.latest()) + PERIOD);
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(2); // untouched; needs abortClaim
    });

    it("reverts when nothing at all could be refreshed, so a no-op never looks like success", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      await expect(f.vault.connect(f.alice).checkInMany([0])).to.be.revertedWithCustomError(
        f.vault,
        "NothingCheckedIn"
      );
    });
  });

  // ---------------------------------------------------------------- A-04

  describe("A-04 the fee cannot be raised under a claim already in flight", () => {
    it("locks the effective rate at initiateClaim", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f);
      await f.vault.connect(f.admin).setClaimFee(0); // publicly advertised 0%

      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      // The creation ceiling stays immutable and keeps agreeing with the VaultCreated event;
      // the locked rate lives in its own field.
      expect((await f.vault.getVault(f.alice.address, 0)).feeBps).to.equal(FEE_BPS);

      // The admin sandwiches the settlement, restoring the creation-time ceiling.
      await f.vault.connect(f.admin).setClaimFee(100);
      await time.increase(WINDOW + 1);
      // Pre-fix: fee was 1% of 10 ETH = 0.1 ETH, invisibly.
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
      expect(await f.vault.creditOf(NATIVE, f.feeSink.address)).to.equal(0);
    });

    it("a rate locked during a promotion does not survive an aborted claim", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f); // ceiling 50 bps
      await f.vault.connect(f.admin).setClaimFee(0); // 48-hour promotion
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // locks 0
      await f.vault.connect(f.alice).abortClaim(0); // owner is alive after all
      await f.vault.connect(f.admin).setClaimFee(FEE_BPS); // promotion ends

      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // re-locks 50
      await time.increase(WINDOW + 1);
      const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
    });

    it("a fee cut after the claim still reaches the heir", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.admin).setClaimFee(10); // cheaper than the 50 bps locked in
      await time.increase(WINDOW + 1);
      const fee = (DEPOSIT * 10n) / 10_000n;
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
    });
  });

  // ---------------------------------------------------------------- A-05

  describe("A-05 revert data must name the value that actually failed", () => {
    it("createVault reports the minimum horizon, not the current time", async () => {
      const f = await loadFixture(fixture);
      const now = await time.latest();
      await expect(
        f.vault
          .connect(f.alice)
          .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, now + PERIOD - DAY, { value: DEPOSIT })
      )
        .to.be.revertedWithCustomError(f.vault, "HorizonTooSoon")
        .withArgs(now + 1 + PERIOD, now + PERIOD - DAY);
    });
  });
});
