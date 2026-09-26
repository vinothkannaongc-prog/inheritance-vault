// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F03/test/poc-F03.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F03.
 *
 * The product tells an owner who receives a claim alert that "any action from your wallet cancels
 * the claim - a check-in is enough" (notify/watcher.js:154, site/index.html:153, README.md:22-24,
 * site/guides/dead-mans-switch-crypto.html:96-99, and the _clearPending NatSpec at
 * InheritanceVault.sol:294). The app's "Check in (all vaults)" button sends every open id,
 * pending ones included, to checkInMany (site/assets/app.js:337-341).
 *
 * The first three tests assert that intended property and FAIL against the current contract:
 *   - checkInMany skips the pending vault (:492) with no event and still succeeds;
 *   - checkIn reverts ClaimPendingUseAbort (:460);
 *   - the heir is then paid while the owner believes the claim was vetoed.
 * They are written so that they pass once owner-key checkIn / checkInMany supersede a
 * pre-horizon claim (the v2 fix the finding recommends).
 *
 * The last describe block is a characterization of the remaining owner actions. It passes today
 * and should still pass after the fix; it pins down which actions do and do not stop a claim, so
 * the copy fix can list them exactly.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

const STATE_ACTIVE = 1n;
const STATE_CLAIM_PENDING = 2n;

describe("F03 owner check-in during a pending claim", () => {
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

  async function openVault(f: any, heir: string, horizonSecs = 730 * DAY) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, heir, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return horizon;
  }

  /** Alice: vault 0 (heir Bob), vault 1 (heir Carol). Alice misses vault 1; Carol claims it. */
  async function pendingClaimFixture() {
    const f = await loadFixture(fixture);
    await openVault(f, f.bob.address); // vault 0
    await openVault(f, f.carol.address); // vault 1
    await time.increase(PERIOD + 1); // Alice is in hospital; both deadlines lapse
    await f.vault.connect(f.carol).initiateClaim(f.alice.address, 1, f.carol.address);
    expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_CLAIM_PENDING);
    return f;
  }

  it("the app's 'Check in (all vaults)' batch, confirmed on chain, must cancel the pending claim", async () => {
    const f = await pendingClaimFixture();

    // Exactly what site/assets/app.js:337-341 does: every open id, pending ones included.
    const ids = [...(await f.vault.openVaultIds(f.alice.address))];
    expect(ids.map(Number)).to.deep.equal([0, 1]);

    const refreshed = await f.vault.connect(f.alice).checkInMany.staticCall(ids);
    const tx = await f.vault.connect(f.alice).checkInMany(ids);
    const rcpt = await tx.wait();
    expect(rcpt!.status).to.equal(1); // runTx() shows "confirmed"

    const iface = f.vault.interface;
    const parsed = rcpt!.logs.map((l: any) => iface.parseLog(l)).filter((p: any) => p !== null);
    const touched = (name: string) =>
      parsed.filter((p: any) => p.name === name).map((p: any) => Number(p.args.vaultId));

    // Intended property: a successful owner check-in inside the challenge window is the veto the
    // alert and FAQ promise. Vault 1 must leave CLAIM_PENDING and say so on chain.
    const v1 = await f.vault.getVault(f.alice.address, 1);
    expect(
      v1.state,
      `owner's confirmed checkInMany(${ids}) returned refreshed=${refreshed}, emitted CheckedIn for ` +
        `[${touched("CheckedIn")}] and ClaimSuperseded for [${touched("ClaimSuperseded")}], ` +
        `yet the claim on vault 1 is still running`
    ).to.equal(STATE_ACTIVE);
    expect(touched("ClaimSuperseded")).to.include(1);
    expect(refreshed).to.equal(BigInt(ids.length));
  });

  it("a single owner checkIn before the horizon must cancel the pending claim ('a check-in is enough')", async () => {
    const f = await pendingClaimFixture();
    const v = await f.vault.getVault(f.alice.address, 1);
    expect(await time.latest()).to.be.lessThan(Number(v.absoluteDeadline)); // well before the horizon

    // Intended: the check-in the veto e-mail tells Alice to send succeeds and supersedes the claim.
    let revertedWith = "nothing";
    try {
      await f.vault.connect(f.alice).checkIn.staticCall(1);
    } catch (e: any) {
      revertedWith = f.vault.interface.parseError(e.data)?.name ?? String(e.message);
    }
    expect(revertedWith, "owner checkIn(1) inside the challenge window, before the horizon, reverted").to.equal(
      "nothing"
    );
    await expect(f.vault.connect(f.alice).checkIn(1)).to.emit(f.vault, "ClaimSuperseded");
    expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_ACTIVE);
  });

  it("damage: after the owner's 'successful' batch check-in, a third party settles the vault to the heir", async () => {
    const f = await pendingClaimFixture();

    const ids = [...(await f.vault.openVaultIds(f.alice.address))];
    await (await f.vault.connect(f.alice).checkInMany(ids)).wait(); // app: "confirmed"
    const checkedInAt = await time.latest();
    // The batch did do something, which is why nothing looks wrong: vault 0 was refreshed.
    expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(checkedInAt + PERIOD);

    await time.increase(WINDOW + 1);
    // Arbitrary third party (Dave) finalizes. Swallow a revert: once fixed there is nothing to finalize.
    let finalized = true;
    try {
      await (await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 1)).wait();
    } catch {
      finalized = false;
    }

    const carolCredit = await f.vault.creditOf(NATIVE, f.carol.address);
    const feeCredit = await f.vault.creditOf(NATIVE, f.feeSink.address);
    const v1 = await f.vault.getVault(f.alice.address, 1);

    // Intended: Alice, alive and acting inside the window, keeps her vault.
    expect(
      carolCredit,
      `finalizeClaim by a third party ${finalized ? "SUCCEEDED" : "reverted"}; heir credited ` +
        `${ethers.formatEther(carolCredit)} ETH, fee sink ${ethers.formatEther(feeCredit)} ETH, ` +
        `vault 1 balance now ${ethers.formatEther(v1.balance)} ETH, state ${v1.state}`
    ).to.equal(0n);
    expect(v1.balance).to.equal(DEPOSIT);
    expect(v1.state).to.equal(STATE_ACTIVE);
  });

  describe("characterization (passes before and after the fix): what actually stops a claim", () => {
    it("before the horizon: topUp and checkInByChain revert; a 1-wei partial withdraw cancels", async () => {
      const f = await loadFixture(fixture);
      await openVault(f, f.bob.address); // vault 0
      await openVault(f, f.carol.address); // vault 1
      // Install a hash chain on vault 1 so checkInByChain is exercised for real.
      const seed = ethers.id("alice-seed");
      const p1 = ethers.keccak256(seed); // next preimage to reveal
      const anchor = ethers.keccak256(p1);
      await f.vault.connect(f.alice).setCheckInChain(1, anchor, 2);

      await time.increase(PERIOD + 1);
      await f.vault.connect(f.carol).initiateClaim(f.alice.address, 1, f.carol.address);

      // (checkIn itself is covered by the failing test above; after the fix it cancels here.)
      await expect(
        f.vault.connect(f.alice).topUp(f.alice.address, 1, 1n, { value: 1n })
      ).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
      await expect(
        f.vault.connect(f.alice).checkInByChain(f.alice.address, 1, p1)
      ).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_CLAIM_PENDING);

      // A 1-wei partial withdraw is a working veto before the horizon.
      await expect(f.vault.connect(f.alice).withdraw(1, 1n, f.alice.address))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 1, 1);
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_ACTIVE);
    });

    it("past the horizon: abortClaim and the soft actions revert; only extendHorizon or a full withdraw end it", async () => {
      const f = await loadFixture(fixture);
      await openVault(f, f.bob.address); // vault 0, long horizon
      const horizon = await openVault(f, f.carol.address, PERIOD + DAY); // vault 1, horizon 1 day after deadline

      await time.increase(PERIOD + 1);
      await f.vault.connect(f.carol).initiateClaim(f.alice.address, 1, f.carol.address);
      await time.increaseTo(horizon + 1); // still inside the 14-day window

      // Today ClaimPendingUseAbort; after the v2 fix it must still revert (HorizonReached).
      await expect(f.vault.connect(f.alice).checkIn(1)).to.be.reverted;
      await expect(f.vault.connect(f.alice).checkInMany([1])).to.be.reverted;
      await expect(f.vault.connect(f.alice).abortClaim(1)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await expect(
        f.vault.connect(f.alice).setBeneficiary(1, f.dave.address)
      ).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await expect(
        f.vault.connect(f.alice).setInactivityPeriod(1, PERIOD)
      ).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      // A partial withdraw succeeds but leaves the claim running.
      await f.vault.connect(f.alice).withdraw(1, 1n, f.alice.address);
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_CLAIM_PENDING);

      // A full withdraw ends the claim by closing the vault (checked on a snapshot).
      const snap = await takeSnapshot();
      const bal = (await f.vault.getVault(f.alice.address, 1)).balance;
      await f.vault.connect(f.alice).withdraw(1, bal, f.alice.address);
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(4n); // CLOSED
      await snap.restore();

      // extendHorizon to at least now + inactivityPeriod is the one soft veto left.
      const now = await time.latest();
      await expect(
        f.vault.connect(f.alice).extendHorizon(1, now + DAY)
      ).to.be.revertedWithCustomError(f.vault, "HorizonTooSoon");
      await expect(f.vault.connect(f.alice).extendHorizon(1, now + 2 * PERIOD))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 1, 3);
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_ACTIVE);
    });
  });
});
