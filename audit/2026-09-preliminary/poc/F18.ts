// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F18/test/poc-F18.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F18: in the last inactivity period before the absolute horizon, check-ins succeed but
 * extend nothing, and each chain check-in still spends a link.
 *
 * Once now + inactivityPeriod >= absoluteDeadline, _resetClock pins `deadline` at
 * absoluteDeadline. checkIn / checkInMany / checkInByChain refuse only once
 * block.timestamp >= absoluteDeadline, so for the whole final period they succeed without moving
 * anything.
 *
 * Every test asserts the SAFE property. Against the current code they fail because of the defect;
 * once fixed they are regression tests. Each is written to accept either fix the finding offers
 * (revert, or succeed without claiming a check-in happened).
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

describe("PoC F18: final-period check-ins succeed but extend nothing", () => {
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

  /** Hash chain: links[0] is the seed, anchor = links[count]; keccak(links[i]) == links[i+1]. */
  function hashChain(count: number) {
    const links: string[] = [ethers.hexlify(ethers.randomBytes(32))];
    for (let i = 0; i < count; i++) links.push(ethers.keccak256(links[i]));
    return { anchor: links[count], links };
  }

  /** Alice's vault: 30-day period, horizon = creation + PERIOD + extraSecs. Returns t0, horizon. */
  async function vaultNearHorizon(f: any, extraSecs: number) {
    const t0 = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(t0);
    const horizon = t0 + PERIOD + extraSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { t0, horizon: BigInt(horizon) };
  }

  /** Sends a tx; returns null if it reverted, otherwise its receipt. */
  async function trySend(p: Promise<any>) {
    try {
      const tx = await p;
      return await tx.wait();
    } catch {
      return null;
    }
  }

  function checkedInLogs(vault: any, receipt: any) {
    const out: any[] = [];
    for (const log of receipt.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed && parsed.name === "CheckedIn") out.push(parsed);
      } catch {
        /* not ours */
      }
    }
    return out;
  }

  /** Puts Alice's vault 0 into the pinned state: deadline == horizon, now < horizon. */
  async function pinnedFixture() {
    const f = await loadFixture(fixture);
    const { t0, horizon } = await vaultNearHorizon(f, 10 * DAY);
    // Day 11: now + PERIOD > horizon, so any clock reset clamps to the horizon.
    await time.increaseTo(t0 + 11 * DAY);
    const chain = hashChain(3);
    await f.vault.connect(f.alice).setCheckInChain(0, chain.anchor, 3);
    const v = await f.vault.getVault(f.alice.address, 0);
    // Setup sanity, NOT the defect: the vault is pinned and still before its horizon.
    expect(v.deadline).to.equal(horizon);
    expect(BigInt(await time.latest())).to.be.lessThan(horizon);
    expect(v.hbLeft).to.equal(3);
    return { ...f, t0, horizon, chain };
  }

  it("checkIn in the final period must not report a successful check-in that extends nothing", async () => {
    const f = await pinnedFixture();
    await time.increase(DAY);
    const before = (await f.vault.getVault(f.alice.address, 0)).deadline;

    const receipt = await trySend(f.vault.connect(f.alice).checkIn(0));
    if (receipt === null) return; // a revert is an honest refusal

    const after = (await f.vault.getVault(f.alice.address, 0)).deadline;
    for (const ev of checkedInLogs(f.vault, receipt)) {
      expect(
        ev.args.newDeadline,
        `checkIn succeeded and emitted CheckedIn(newDeadline=${ev.args.newDeadline}) but the ` +
          `deadline was already ${before} (== horizon ${f.horizon}); nothing was extended`
      ).to.be.greaterThan(before);
    }
    expect(after, "a check-in that did not revert left the deadline unchanged").to.be.greaterThan(before);
  });

  it("a vault created with absoluteDeadline == now + period is pinned from creation, and its check-ins are no-ops", async () => {
    const f = await loadFixture(fixture);
    // createVault only refuses absoluteDeadline < now + period, so == is accepted (:388).
    const { horizon } = await vaultNearHorizon(f, 0);
    expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(horizon); // pinned at birth

    await time.increase(DAY);
    const before = (await f.vault.getVault(f.alice.address, 0)).deadline;
    const receipt = await trySend(f.vault.connect(f.alice).checkIn(0));
    if (receipt === null) return;
    const after = (await f.vault.getVault(f.alice.address, 0)).deadline;
    expect(
      after,
      `checkIn one day after creation succeeded, but deadline stayed ${after} == horizon ${horizon}`
    ).to.be.greaterThan(before);
  });

  it("checkInMany must not count a vault whose deadline could not move", async () => {
    const f = await pinnedFixture();
    // A second, healthy vault with a far horizon.
    const far = (await time.latest()) + 730 * DAY;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, far, { value: DEPOSIT });
    await time.increase(DAY);

    // Only vault 1 can actually be extended.
    const both = await f.vault.connect(f.alice).checkInMany.staticCall([0, 1]);
    expect(both, "refreshed counted the pinned vault 0 as a check-in").to.equal(1n);
  });

  it("checkInMany on only a pinned vault is a total no-op and must revert NothingCheckedIn", async () => {
    const f = await pinnedFixture();
    await time.increase(DAY);
    // The contract's own NatSpec (:487-488) promises "a total no-op still cannot masquerade as
    // success".
    await expect(f.vault.connect(f.alice).checkInMany([0])).to.be.revertedWithCustomError(
      f.vault,
      "NothingCheckedIn"
    );
  });

  it("checkInByChain must not consume a link when the deadline cannot move", async () => {
    const f = await pinnedFixture();
    await time.increase(DAY);
    const before = await f.vault.getVault(f.alice.address, 0);

    // A stranger relays the next preimage (possession of the preimage is the authentication).
    const receipt = await trySend(
      f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, f.chain.links[2])
    );

    const after = await f.vault.getVault(f.alice.address, 0);
    if (after.deadline === before.deadline) {
      expect(
        after.hbLeft,
        `chain check-in ${receipt === null ? "reverted" : "succeeded"}: deadline stayed ` +
          `${after.deadline} (== horizon) yet hbLeft went ${before.hbLeft} -> ${after.hbLeft}`
      ).to.equal(before.hbLeft);
    }
  });

  it("warningsOf must flag that check-ins can no longer extend the vault", async () => {
    const f = await pinnedFixture();
    // NatSpec bit 1 (:795): "horizon reached -- no check-in can extend this vault any further".
    // That condition is already true here: deadline == absoluteDeadline and nothing can move it.
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.deadline).to.equal(v.absoluteDeadline);
    const w = await f.vault.warningsOf(f.alice.address, 0);
    expect(
      w,
      `warnings == ${w} while deadline is pinned at the horizon (${v.absoluteDeadline - BigInt(await time.latest())}s before it)`
    ).to.not.equal(0n);
  });

  it("quantified: a weekly keeper in the final period collects no-op receipts and burns links, then the heir claims and the veto reverts", async () => {
    const f = await loadFixture(fixture);
    // Vault 0: owner checks in weekly by key. Vault 1: a relayer checks in weekly by chain.
    const { t0, horizon } = await vaultNearHorizon(f, 10 * DAY); // horizon = t0 + 40 days
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    const chain = hashChain(10);
    await f.vault.connect(f.alice).setCheckInChain(1, chain.anchor, 10);

    let noOpReceipts = 0;
    let wastedLinks = 0;
    let lastSuccess = 0;
    let nextLink = 9;
    for (const day of [7, 14, 21, 28, 35]) {
      await time.increaseTo(t0 + day * DAY);

      const d0 = (await f.vault.getVault(f.alice.address, 0)).deadline;
      const r0 = await trySend(f.vault.connect(f.alice).checkIn(0));
      if (r0 !== null) {
        lastSuccess = (await ethers.provider.getBlock(r0.blockNumber))!.timestamp;
        const d0After = (await f.vault.getVault(f.alice.address, 0)).deadline;
        if (checkedInLogs(f.vault, r0).length > 0 && d0After === d0) noOpReceipts++;
      }

      const v1 = await f.vault.getVault(f.alice.address, 1);
      await trySend(f.vault.connect(f.carol).checkInByChain(f.alice.address, 1, chain.links[nextLink]));
      const v1After = await f.vault.getVault(f.alice.address, 1);
      if (v1After.hbLeft < v1.hbLeft) nextLink--;
      if (v1After.hbLeft < v1.hbLeft && v1After.deadline === v1.deadline) wastedLinks++;
    }

    // At the horizon the heir claims vault 0, however recently Alice's last check-in landed.
    await time.increaseTo(Number(horizon));
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const claimAt = await time.latest();
    // Alice presses "Veto claim": closed past the horizon (horizon-by-design, not the defect).
    await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    const gapDays = (claimAt - lastSuccess) / DAY;
    console.log(
      `      [F18] no-op CheckedIn receipts=${noOpReceipts}, chain links burned for nothing=${wastedLinks}, ` +
        `heir claimed ${gapDays.toFixed(2)} days after Alice's last successful checkIn (period ${PERIOD / DAY} days)`
    );

    // The defect: success receipts and chain links spent while nothing moved.
    expect(noOpReceipts, "owner received CheckedIn success receipts that extended nothing").to.equal(0);
    expect(wastedLinks, "relayer consumed chain links that extended nothing").to.equal(0);
  });
});
