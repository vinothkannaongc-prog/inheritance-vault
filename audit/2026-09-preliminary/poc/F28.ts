// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F28/test/poc-F28.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F28 (informational): the lost-wallet check-in chain is advertised
 * (README "Lost wallet insurance", site/index.html trust table) but the contract cannot tell a
 * dead chain from a live one, a zero element hides the chain entirely, and an armed chain cannot
 * be disarmed.
 *
 * Every test asserts the SAFE / INTENDED property. Against the current contract they FAIL, and
 * the failing assertion is the defect itself.
 *
 * The app (site/assets/app.js:189) and the watcher (notify/watcher.js:165) rely on warnings bit 3
 * ("a check-in chain is configured but exhausted") as the ONLY signal that the lost-wallet path
 * is gone. These tests check that bit.
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
const BIT3 = 1 << 3;

const H = (x: string) => ethers.keccak256(x);

describe("F28 check-in chain: unverified count, zero element, no disarm", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const horizon = (await time.latest()) + 730 * DAY;
    // alice = owner, bob = heir, carol = relayer (anyone), dave = arbitrary third party
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, dave, feeSink, horizon };
  }

  // ------------------------------------------------------------------ (a) count is unverified

  describe("(a) an overstated count keeps a dead chain looking alive", () => {
    /** Alice's own generator: anchor = H^2(s) (two real steps) but she types count = 3. */
    async function deadChainWithOverstatedCount() {
      const f = await loadFixture(fixture);
      const s = ethers.hexlify(ethers.randomBytes(32));
      const x1 = H(s);
      const anchor = H(x1);
      await f.vault.connect(f.alice).setCheckInChain(0, anchor, 3);

      // Wallet lost. A relayer spends both real steps, strictly before each deadline.
      await time.increase(20 * DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, x1);
      await time.increase(20 * DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, s);

      // The chain is now dead: its anchor is the raw seed s, and a further check-in would need
      // a keccak preimage of s. Every value the owner holds is refused:
      await expect(f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, s))
        .to.be.revertedWithCustomError(f.vault, "CheckInAlreadyUsed");
      await expect(f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, x1))
        .to.be.revertedWithCustomError(f.vault, "BadCheckIn");
      await expect(f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, anchor))
        .to.be.revertedWithCustomError(f.vault, "BadCheckIn");
      return { ...f, s };
    }

    it("a chain with no usable preimage left is reported as exhausted (warnings bit 3)", async () => {
      const f = await deadChainWithOverstatedCount();
      const v = await f.vault.getVault(f.alice.address, 0);
      console.log(
        `      [F28a] after both real steps: hbAnchor == seed: ${v.hbAnchor === f.s}, ` +
          `hbLeft=${v.hbLeft}, warnings=${v.warnings} (bit3=${Number(v.warnings) & BIT3 ? 1 : 0})`
      );
      // SAFE: the app and the watcher must be told the lost-wallet path is gone.
      expect(Number(v.warnings) & BIT3, "warnings bit 3 on a chain with no usable preimage left").to.equal(BIT3);
      expect(v.hbLeft, "hbLeft on a chain with no usable preimage left").to.equal(0);
    });

    it("damage: the owner is never warned before the heir can claim", async () => {
      const f = await deadChainWithOverstatedCount();
      // Sample the on-chain warnings daily from the moment the chain died until it expires.
      let sawBit3 = false;
      let days = 0;
      while (!(await f.vault.getVault(f.alice.address, 0)).expired) {
        if (Number(await f.vault.warningsOf(f.alice.address, 0)) & BIT3) sawBit3 = true;
        await time.increase(DAY);
        days++;
      }
      // The heir can now start the claim; the owner's paper seed cannot stop it.
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const v = await f.vault.getVault(f.alice.address, 0);
      console.log(
        `      [F28a] dead chain went unreported for ${days} days; claim now pending, hbLeft still ${v.hbLeft}`
      );
      // SAFE: at some point before the deadline lapsed, bit 3 should have told the owner.
      expect(sawBit3, "bit 3 raised at any point between chain death and expiry").to.equal(true);
    });
  });

  // ------------------------------------------------------------------ (b) zero element

  describe("(b) a chain element equal to 0x00..00 hides the chain", () => {
    it("an exhausted chain whose last element is zero is still reported as exhausted", async () => {
      const f = await loadFixture(fixture);
      // A hand-rolled generator with an unset (zero) seed. Count is EXACT (2), so the owner did
      // everything else right.
      const s = ethers.ZeroHash;
      const x1 = H(s);
      const anchor = H(x1);
      await f.vault.connect(f.alice).setCheckInChain(0, anchor, 2);

      await time.increase(20 * DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, x1);
      await time.increase(20 * DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, s); // accepted: H(0) == x1

      const v = await f.vault.getVault(f.alice.address, 0);
      console.log(
        `      [F28b] exact count, zero seed: hbAnchor=${v.hbAnchor}, hbLeft=${v.hbLeft}, ` +
          `warnings=${v.warnings} (bit3=${Number(v.warnings) & BIT3 ? 1 : 0})`
      );
      // SAFE: an installed-then-exhausted chain raises bit 3, exactly as the non-zero case does
      // (test/InheritanceVault.ts:316 expects warnings == 1 << 3 there).
      expect(Number(v.warnings) & BIT3, "warnings bit 3 after the last element (0x00..00) was spent").to.equal(BIT3);
    });

    it("with an overstated count the zero element leaves hbLeft > 0 on an 'uninstalled' chain", async () => {
      const f = await loadFixture(fixture);
      const s = ethers.ZeroHash;
      const x1 = H(s);
      await f.vault.connect(f.alice).setCheckInChain(0, H(x1), 6);
      await time.increase(20 * DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, x1);
      await time.increase(20 * DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, s);

      const v = await f.vault.getVault(f.alice.address, 0);
      console.log(`      [F28b] overstated count: hbAnchor=${v.hbAnchor}, hbLeft=${v.hbLeft}, warnings=${v.warnings}`);
      // SAFE: a relayer trying the next step is told the chain is used up, not that none exists.
      await expect(
        f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, ethers.hexlify(ethers.randomBytes(32))),
        "a spent chain must revert CheckInChainExhausted, not InvalidCheckInChain"
      ).to.be.revertedWithCustomError(f.vault, "CheckInChainExhausted");
    });
  });

  // ------------------------------------------------------------------ (d) no disarm

  describe("(d) an armed chain cannot be disarmed", () => {
    it("the owner can clear an exposed chain so the vault reports no chain armed", async () => {
      const f = await loadFixture(fixture);
      const s = ethers.hexlify(ethers.randomBytes(32));
      const x1 = H(s);
      await f.vault.connect(f.alice).setCheckInChain(0, H(x1), 2);

      // The paper seed leaks. Anyone holding it can now keep the vault alive and delay the heir.
      await time.increase(25 * DAY);
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, x1);

      // Diagnostic only: name the guard that blocks the disarm.
      try {
        await f.vault.connect(f.alice).setCheckInChain.staticCall(0, ethers.ZeroHash, 0);
      } catch (e: any) {
        const parsed = f.vault.interface.parseError(e.data);
        console.log(`      [F28d] setCheckInChain(0, 0x00..00, 0) reverts ${parsed?.name}`);
      }
      // SAFE: the owner (key still in hand) disarms the chain outright.
      await expect(
        f.vault.connect(f.alice).setCheckInChain(0, ethers.ZeroHash, 0),
        "owner disarm via setCheckInChain(id, 0, 0)"
      ).to.not.be.reverted;
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.hbAnchor).to.equal(ethers.ZeroHash);
      expect(v.hbLeft).to.equal(0);
    });
  });
});
