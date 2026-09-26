// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F43/test/poc-F43.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F43: past the horizon, setBeneficiary and setInactivityPeriod still succeed on an
 * ACTIVE vault without moving the (already expired) deadline.
 *
 * Every `it` marked [REGRESSION] asserts the SAFE property and fails against commit b8baf34
 * because of the defect. Tests marked [CONTROL] pass today and pin the surrounding behaviour
 * (checkIn's guard, the pre-horizon race, the extendHorizon race) so the failures cannot be
 * blamed on the fixture.
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

const STATE_ACTIVE = 1n;
const STATE_CLAIM_PENDING = 2n;
const STATE_SETTLED = 3n;

describe("F43 owner actions that succeed past the horizon on an ACTIVE vault", () => {
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

  /** Alice's native vault, heir Bob. */
  async function nativeVault(f: any, horizonSecs: number, period = PERIOD, window = WINDOW) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, period, window, horizon, { value: DEPOSIT });
    return horizon;
  }

  /** Mines the promise's transaction and reports whether it succeeded, without throwing. */
  async function succeeds(p: Promise<any>): Promise<boolean> {
    try {
      const tx = await p;
      await tx.wait();
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------- Variant A (no adversary)

  describe("Variant A: uncontested heir change past the horizon", () => {
    it("[CONTROL] checkIn refuses past the horizon with HorizonReached (the rule at :462-464)", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(
        f.vault,
        "HorizonReached"
      );
    });

    it("[REGRESSION] setBeneficiary past the horizon must refuse like checkIn, not report success", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);

      await expect(
        f.vault.connect(f.alice).setBeneficiary(0, f.carol.address)
      ).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    });

    it("[REGRESSION] setInactivityPeriod past the horizon must refuse like checkIn, not report success", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      const before = await f.vault.getVault(f.alice.address, 0);

      let refused = false;
      try {
        await (await f.vault.connect(f.alice).setInactivityPeriod(0, 60 * DAY)).wait();
      } catch (e: any) {
        refused = true;
        expect(e.message).to.contain("HorizonReached");
      }
      const after = await f.vault.getVault(f.alice.address, 0);
      console.log(
        `      setInactivityPeriod(60d) past horizon: refused=${refused}; ` +
          `deadline ${before.deadline} -> ${after.deadline}; period ${before.inactivityPeriod} -> ${after.inactivityPeriod}; ` +
          `expired=${after.expired}`
      );
      expect(
        refused,
        "setInactivityPeriod succeeded past the horizon but left the deadline in the past (vault still expired)"
      ).to.equal(true);
    });

    it("[REGRESSION] a new heir named past the horizon must not be able to claim in the next block", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);

      const setOk = await succeeds(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address));
      const v = await f.vault.getVault(f.alice.address, 0);
      console.log(
        `      setBeneficiary(carol) succeeded=${setOk}; beneficiary=${v.beneficiary === f.carol.address ? "carol" : "bob"}; ` +
          `deadline=${v.deadline} absoluteDeadline=${v.absoluteDeadline} now=${await time.latest()} expired=${v.expired}`
      );

      // Fix-agnostic: whether the fix refuses setBeneficiary (carol is then not the heir) or
      // makes it move the deadline (carol must wait), carol's immediate claim must fail.
      await expect(
        f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address)
      ).to.be.reverted;
    });

    it("[REGRESSION] damage: the heir Alice named while alive inherits the whole balance and Alice's veto is closed", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);

      const setOk = await succeeds(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address));
      const claimOk = await succeeds(
        f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address)
      );

      if (claimOk) {
        // The living owner reaches for every ordinary control; each one is closed.
        await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(
          f.vault,
          "HorizonReached"
        );
        await expect(
          f.vault.connect(f.alice).setBeneficiary(0, f.bob.address)
        ).to.be.revertedWithCustomError(f.vault, "HorizonReached");
        await expect(
          f.vault.connect(f.alice).setInactivityPeriod(0, 60 * DAY)
        ).to.be.revertedWithCustomError(f.vault, "HorizonReached");
        await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(
          f.vault,
          "ClaimPendingUseAbort"
        );
        await time.increase(WINDOW + 1);
        await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0); // arbitrary third party
      }

      const v = await f.vault.getVault(f.alice.address, 0);
      const carolCredit = await f.vault.creditOf(NATIVE, f.carol.address);
      const feeCredit = await f.vault.creditOf(NATIVE, f.feeSink.address);
      console.log(
        `      setBeneficiary ok=${setOk}, carol initiateClaim ok=${claimOk}, final state=${v.state}, ` +
          `carol credit=${ethers.formatEther(carolCredit)} ETH, fee=${ethers.formatEther(feeCredit)} ETH of ${ethers.formatEther(DEPOSIT)} deposited`
      );

      expect(
        Number(v.state),
        "vault SETTLED (3) to a claim the living owner opened by 'changing heir'"
      ).to.not.equal(Number(STATE_SETTLED));
      expect(carolCredit).to.equal(0n);
    });
  });

  // --------------------------------------------------------------- Variant B (front-run race)

  describe("Variant B: the outgoing heir front-runs the owner's heir change", () => {
    const GAS = 300_000n;
    const LOW = { gasLimit: GAS, maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"), maxFeePerGas: ethers.parseUnits("200", "gwei") };
    const HIGH = { gasLimit: GAS, maxPriorityFeePerGas: ethers.parseUnits("100", "gwei"), maxFeePerGas: ethers.parseUnits("200", "gwei") };

    /**
     * Owner broadcasts `ownerTx`; if `bobFrontRuns`, Bob broadcasts initiateClaim with a higher
     * priority fee before the block is mined. One block is mined. Returns both receipts' status
     * and the resulting vault view.
     */
    async function race(f: any, ownerCall: (low: any) => Promise<any>, bobFrontRuns: boolean) {
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const ownerTx = await ownerCall(LOW);
        const bobTx = bobFrontRuns
          ? await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address, HIGH)
          : null;
        await network.provider.send("evm_mine");
        const ownerRc = await ethers.provider.getTransactionReceipt(ownerTx.hash);
        const bobRc = bobTx ? await ethers.provider.getTransactionReceipt(bobTx.hash) : null;
        if (bobRc) expect(bobRc.blockNumber).to.equal(ownerRc!.blockNumber); // same block
        if (bobRc) expect(bobRc.index).to.be.lessThan(ownerRc!.index); // Bob ordered first
        return {
          ownerStatus: ownerRc!.status,
          bobStatus: bobRc ? bobRc.status : null,
          v: await f.vault.getVault(f.alice.address, 0),
        };
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
    }

    it("[CONTROL] before the horizon the owner wins the race: the claim is superseded and Carol is heir", async () => {
      const f = await loadFixture(fixture);
      await nativeVault(f, 3 * PERIOD);
      await time.increase(PERIOD + 1); // expired, horizon still ahead
      const r = await race(
        f,
        (o) => f.vault.connect(f.alice).setBeneficiary(0, f.carol.address, o),
        true
      );
      expect(r.bobStatus).to.equal(1);
      expect(r.ownerStatus).to.equal(1);
      expect(r.v.state).to.equal(STATE_ACTIVE);
      expect(r.v.beneficiary).to.equal(f.carol.address);
      expect(r.v.expired).to.equal(false);
    });

    it("[REGRESSION] past the horizon, setBeneficiary's outcome must not depend on whether the outgoing heir front-runs it", async () => {
      // Uncontested run.
      const f1 = await loadFixture(fixture);
      const h1 = await nativeVault(f1, PERIOD + DAY);
      await time.increaseTo(h1 + 1);
      const uncontested = await race(
        f1,
        (o) => f1.vault.connect(f1.alice).setBeneficiary(0, f1.carol.address, o),
        false
      );

      // Contested run, identical setup.
      const f2 = await loadFixture(fixture);
      const h2 = await nativeVault(f2, PERIOD + DAY);
      await time.increaseTo(h2 + 1);
      const contested = await race(
        f2,
        (o) => f2.vault.connect(f2.alice).setBeneficiary(0, f2.carol.address, o),
        true
      );

      const name = (a: string, f: any) => (a === f.bob.address ? "bob" : a === f.carol.address ? "carol" : a);
      console.log(
        `      uncontested: owner status=${uncontested.ownerStatus}, state=${uncontested.v.state}, ` +
          `heir=${name(uncontested.v.beneficiary, f1)}, expired=${uncontested.v.expired}`
      );
      console.log(
        `      contested:   bob status=${contested.bobStatus}, owner status=${contested.ownerStatus}, ` +
          `state=${contested.v.state}, heir=${name(contested.v.beneficiary, f2)}, ` +
          `claimRecipient=${name(contested.v.claimRecipient, f2)}`
      );

      // Sanity on the contested run: this is the reported end state today, and it would equally
      // hold after a fix that refuses setBeneficiary past the horizon.
      expect(contested.bobStatus).to.equal(1);
      expect(contested.v.state).to.equal(STATE_CLAIM_PENDING);
      expect(contested.v.beneficiary).to.equal(f2.bob.address);
      expect(contested.v.claimRecipient).to.equal(f2.bob.address);
      // Alice's mined revert is _clearPending's HorizonReached (:314-316), replayed on the same state.
      await expect(
        f2.vault.connect(f2.alice).setBeneficiary.staticCall(0, f2.carol.address)
      ).to.be.revertedWithCustomError(f2.vault, "HorizonReached");

      // The defect: the same owner transaction is "confirmed" when uncontested and reverts when
      // front-run, so the app's green toast depends on transaction ordering.
      expect(
        uncontested.ownerStatus,
        "setBeneficiary succeeds uncontested but reverts when front-run: outcome is order-dependent"
      ).to.equal(contested.ownerStatus);
    });

    it("[CONTROL] extendHorizon cannot be front-run: the vault ends ACTIVE and not expired either way", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      // Enough margin over the floor now + inactivityPeriod for the next block's timestamp.
      const newHorizon = (await time.latest()) + PERIOD + DAY;
      const r = await race(
        f,
        (o) => f.vault.connect(f.alice).extendHorizon(0, newHorizon, o),
        true
      );
      expect(r.bobStatus).to.equal(1); // Bob's claim did land first...
      expect(r.ownerStatus).to.equal(1); // ...and extendHorizon cleared it
      expect(r.v.state).to.equal(STATE_ACTIVE);
      expect(r.v.expired).to.equal(false);
      expect(r.v.beneficiary).to.equal(f.bob.address);
    });

    it("[CONTROL] the app's extendHorizon date of 'today + period' at 00:00Z falls below the floor and reverts HorizonTooSoon", async () => {
      const f = await loadFixture(fixture);
      const horizon = await nativeVault(f, PERIOD + DAY);
      await time.increaseTo(horizon + 1);
      // Midday so that 00:00Z of (today + PERIOD) is strictly below now + PERIOD.
      const now = await time.latest();
      const midday = now - (now % DAY) + DAY + 12 * 3600;
      await time.increaseTo(midday);
      const appDate = midday - (midday % DAY) + PERIOD; // what actHorizon sends for "today + 30 days"
      await expect(f.vault.connect(f.alice).extendHorizon(0, appDate)).to.be.revertedWithCustomError(
        f.vault,
        "HorizonTooSoon"
      );
    });
  });
});
