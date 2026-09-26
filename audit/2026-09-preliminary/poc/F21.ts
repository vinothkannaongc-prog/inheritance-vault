// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F21/test/poc-F21.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F21: the "guaranteed inheritance date" and trust-model T3 over-promise.
 *
 * Public claims under test:
 *   site/app.html:81        "Horizon - guaranteed inheritance date, even if check-in bots run forever"
 *   site/assets/app.js:285  "Guaranteed inheritance by ${fmtWhen(vault.guaranteedInheritanceAt)}"
 *   InheritanceVault.sol:34-41 (T3) "The ONLY way past the date is extendHorizon ... at a cost of
 *                            one full inactivity period per override -- and nothing can do it
 *                            silently or without bound."
 *   README.md:25-27         "absoluteDeadline + challengeWindow is a guaranteed inheritance date"
 *
 * The two FAILING tests assert the property the public text promises and that a v2 contract could
 * enforce. The PASSING tests quantify the gap for the parts whose remedy is documentation/UI only.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;
const MAX_WINDOW = 365 * DAY; // MAX_CHALLENGE
const MIN_PERIOD = 7 * DAY; // MIN_INACTIVITY
const MAX_HORIZON = 36_500 * DAY;

describe("F21 guaranteed-inheritance date and T3 override cost", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, feeSink };
  }

  /** alice owns vault 0, bob is the heir. Returns the horizon H. */
  async function nativeVault(f: any, period: number, window: number, horizonSecs: number) {
    const H = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, period, window, H, { value: DEPOSIT });
    return H;
  }

  /** A check-in bot that ran until just before the horizon: the deadline is pinned to H. */
  async function botRanUntilHorizon(f: any, H: number) {
    await time.increaseTo(H - DAY);
    await f.vault.connect(f.alice).checkIn(0);
    expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(H);
  }

  // ------------------------------------------------------------------ failing (defect) tests

  it("[FAILS] getVault must not report a 'guaranteed inheritance' date that has passed while the heir still cannot finalize", async () => {
    const f = await loadFixture(fixture);
    const H = await nativeVault(f, 30 * DAY, MAX_WINDOW, 730 * DAY);
    await botRanUntilHorizon(f, H);

    // The owner key is lost. The heir initiates 30 days after the horizon.
    await time.increaseTo(H + 30 * DAY);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // Move to the instant getVault (and the app card, app.js:285) calls "Guaranteed inheritance by".
    const before = await f.vault.getVault(f.alice.address, 0);
    await time.increaseTo(Number(before.guaranteedInheritanceAt));
    const v = await f.vault.getVault(f.alice.address, 0);

    // Intended: once the "guaranteed inheritance" instant has passed with no owner action, the
    // heir's pending claim is finalizable. Actual: finalizableAt is claimInitiatedAt + window,
    // 30 days AFTER the date shown as guaranteed; the view ignores the real claim.
    expect(
      v.finalizable,
      `guaranteedInheritanceAt=${v.guaranteedInheritanceAt} has passed but finalizableAt=${v.finalizableAt}`
    ).to.equal(true);
  });

  it("[FAILS] T3: past the horizon an override must cost the full inactivity period in force at the horizon (365d), not 7d", async () => {
    const f = await loadFixture(fixture);
    const P = 365 * DAY;
    const H = await nativeVault(f, P, 30 * DAY, 400 * DAY);
    await time.increaseTo(H + 1); // owner silent; horizon reached; vault still ACTIVE

    // Owner automation, holding the owner key, shrinks the period. Allowed past the horizon while
    // ACTIVE (setInactivityPeriod has no horizon check; _clearPending is a no-op). A v2 that
    // refuses this is also a valid fix, so a revert here is tolerated.
    await f.vault.connect(f.alice).setInactivityPeriod(0, MIN_PERIOD).catch(() => undefined);

    // The heir claims past the horizon.
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // The cheapest override the contract accepts: floor = now + CURRENT period (line 622).
    const pNow = Number((await f.vault.getVault(f.alice.address, 0)).inactivityPeriod);
    const ts = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(ts);
    const overridden = await f.vault
      .connect(f.alice)
      .extendHorizon(0, ts + pNow + 1)
      .then((tx: any) => tx.wait())
      .then(() => true, () => false);

    const v = await f.vault.getVault(f.alice.address, 0);
    if (!overridden) {
      // Fixed world: the cheap override was refused and the heir's claim still stands...
      expect(v.state).to.equal(2);
      // ...while an honest full-period override still works.
      await expect(f.vault.connect(f.alice).extendHorizon(0, (await time.latest()) + P + DAY)).to.not.be.reverted;
      return;
    }
    // The claim was displaced. T3: "at a cost of one full inactivity period per override".
    const heirCooldown = Number(v.deadline) - ts;
    expect(heirCooldown, "seconds the heir must wait before re-claiming after the override").to.be.gte(P);
  });

  // ------------------------------------------------------------------ quantification (pass)

  it("[quantify] the date typed into 'Horizon - guaranteed inheritance date' is paid out up to 365 days later", async () => {
    const f = await loadFixture(fixture);
    const H = await nativeVault(f, 30 * DAY, MAX_WINDOW, 730 * DAY);
    await botRanUntilHorizon(f, H);

    // Check-in bots do stop at H...
    await time.setNextBlockTimestamp(H);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // earliest possible
    await expect(f.vault.connect(f.alice).checkIn(0)).to.be.reverted;

    // ...but the heir cannot inherit on the date the form called the "guaranteed inheritance date".
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.absoluteDeadline).to.equal(H);
    expect(v.guaranteedInheritanceAt).to.equal(H + MAX_WINDOW); // the view is right; the label is not
    expect(v.finalizableAt).to.equal(H + MAX_WINDOW);

    await time.increaseTo(H + MAX_WINDOW - DAY);
    await expect(f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0))
      .to.be.revertedWithCustomError(f.vault, "ChallengeWindowOpen")
      .withArgs(H + MAX_WINDOW);
    await time.increaseTo(H + MAX_WINDOW);
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);
    expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(DEPOSIT - (DEPOSIT * BigInt(FEE_BPS)) / 10_000n);
  });

  it("[quantify] T3 'the ONLY way past the date is extendHorizon' omits the full withdrawal, which works even after the window has elapsed", async () => {
    const f = await loadFixture(fixture);
    const H = await nativeVault(f, 30 * DAY, MAX_WINDOW, 730 * DAY);
    await botRanUntilHorizon(f, H);
    await time.increaseTo(H + 30 * DAY);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // H + 396d: the challenge window is over and the claim is finalizable, but not yet finalized.
    await time.increaseTo(H + 396 * DAY);
    expect((await f.vault.getVault(f.alice.address, 0)).finalizable).to.equal(true);

    // Whoever holds the owner key (the owner, or a thief) closes the vault. No HorizonExtended,
    // no ClaimSuperseded: only Withdrawn(closed=true).
    const tx = f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
    await expect(tx).to.emit(f.vault, "Withdrawn").withArgs(f.alice.address, 0, f.alice.address, DEPOSIT, true);
    await expect(tx).to.not.emit(f.vault, "HorizonExtended");
    await expect(tx).to.not.emit(f.vault, "ClaimSuperseded");

    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(4); // CLOSED
    await expect(f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0)).to.be.revertedWithCustomError(
      f.vault,
      "NoClaimPending"
    );
    expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(0n); // heir gets nothing
    expect(await f.vault.creditOf(NATIVE, f.alice.address)).to.equal(DEPOSIT);
  });

  it("[quantify] blocking the full withdrawal would not help: extendHorizon then withdraw reaches the same end (remedy is documentation)", async () => {
    const f = await loadFixture(fixture);
    const H = await nativeVault(f, 30 * DAY, MAX_WINDOW, 730 * DAY);
    await botRanUntilHorizon(f, H);
    await time.increaseTo(H + 30 * DAY);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    await f.vault.connect(f.alice).extendHorizon(0, (await time.latest()) + 30 * DAY + DAY);
    await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(4);
    expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(0n);
  });

  it("[quantify] three past-horizon overrides cost the heir 3 x 7 days, and one call moves the horizon 100 years", async () => {
    const f = await loadFixture(fixture);
    const P = 365 * DAY;
    const H = await nativeVault(f, P, 30 * DAY, 400 * DAY);
    await time.increaseTo(H + 1);
    await f.vault.connect(f.alice).setInactivityPeriod(0, MIN_PERIOD); // succeeds past the horizon

    let horizon = H;
    const start = await time.latest();
    for (let i = 0; i < 3; i++) {
      // The heir claims at the earliest moment (the deadline), the horizon then passes...
      const d = Number((await f.vault.getVault(f.alice.address, 0)).deadline);
      if ((await time.latest()) < d) await time.increaseTo(d);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      if ((await time.latest()) < horizon) await time.increaseTo(horizon);
      // ...and the owner key displaces the claim for the minimum 7 days + 1 second.
      const ts = (await time.latest()) + 1;
      await time.setNextBlockTimestamp(ts);
      await expect(f.vault.connect(f.alice).extendHorizon(0, ts + MIN_PERIOD + 1))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 0, 3);
      horizon = ts + MIN_PERIOD + 1;
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(ts + MIN_PERIOD);
    }
    const elapsed = (await time.latest()) - start;
    expect(elapsed).to.be.lt(3 * MIN_PERIOD + 10); // ~21 days of denial for three overrides, not 3 years

    // One override may also push the horizon to now + 36,500 days.
    const d = Number((await f.vault.getVault(f.alice.address, 0)).deadline);
    await time.increaseTo(d);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    if ((await time.latest()) < horizon) await time.increaseTo(horizon);
    const ts = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(ts);
    await f.vault.connect(f.alice).extendHorizon(0, ts + MAX_HORIZON);
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.absoluteDeadline).to.equal(ts + MAX_HORIZON);
    expect(v.state).to.equal(1); // claim displaced
  });
});
