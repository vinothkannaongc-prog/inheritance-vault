// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F10/test/poc-F10.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F10 -- payouts are not measured, so a token that debits the vault by MORE than the
 * recorded amount (fee on top), or whose balance falls on its own (negative rebase, issuer or
 * agent burn), makes the shared per-token pool insolvent and the loss lands on whoever exits last.
 *
 * Each failing assertion states the SAFE property. They are written so that a fixed contract
 * (payout measurement that refuses an over-debit, a deficit-aware credit lane) makes them pass.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50;
const AMT = ethers.parseEther("100");
const fmt = (x: bigint) => ethers.formatEther(x);

describe("PoC F10 -- over-debiting tokens make the shared pool insolvent", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, eve, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const vaultAddr = await vault.getAddress();

    const fot = await (await ethers.getContractFactory("F10_FeeOnTopToken", admin)).deploy();
    const shr = await (await ethers.getContractFactory("F10_ShrinkingToken", admin)).deploy();
    for (const t of [fot, shr]) {
      for (const u of [alice, carol, eve]) {
        await t.mint(u.address, ethers.parseEther("1000"));
        await t.connect(u).approve(vaultAddr, ethers.MaxUint256);
      }
    }
    return { vault, vaultAddr, fot, shr, admin, alice, bob, carol, dave, eve, feeSink };
  }

  async function open(f: any, token: any, owner: any, heir: any, amount = AMT) {
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault
      .connect(owner)
      .createVault(await token.getAddress(), amount, heir.address, PERIOD, WINDOW, horizon);
  }

  async function lanes(f: any, token: any) {
    const t = await token.getAddress();
    const bal: bigint = await token.balanceOf(f.vaultAddr);
    const locked: bigint = await f.vault.totalLocked(t);
    const credited: bigint = await f.vault.totalCredited(t);
    const surplus: bigint = await f.vault.surplus(t);
    return { bal, locked, credited, owed: locked + credited, surplus };
  }

  // ------------------------------------------------------------------ fee on top

  it("F10-a fee-on-top: one user's payout must not consume the backing of another user's vault", async () => {
    const f = await loadFixture(fixture);
    const T = await f.fot.getAddress();
    await open(f, f.fot, f.alice, f.bob);
    await open(f, f.fot, f.carol, f.dave);

    const s0 = await lanes(f, f.fot);
    expect(s0.bal).to.equal(2n * AMT); // deposits were measured: 200 in, 200 locked
    expect(s0.locked).to.equal(2n * AMT);

    // Alice exits in full. A fixed contract may refuse the over-debiting payout; either way the
    // property below must hold afterwards.
    await f.vault.connect(f.alice).withdraw(0, AMT, f.alice.address);
    const aliceBefore: bigint = await f.fot.balanceOf(f.alice.address);
    let paid = true;
    try {
      await f.vault.connect(f.alice).withdrawCredit(T, f.alice.address);
    } catch {
      paid = false;
    }
    const aliceGot = (await f.fot.balanceOf(f.alice.address)) - aliceBefore;

    // Carol, who did nothing unusual, now exits in full the way the app does it.
    await f.vault.connect(f.carol).withdraw(0, AMT, f.carol.address);
    const c0: bigint = await f.fot.balanceOf(f.carol.address);
    let carolErr = "";
    try {
      await f.vault.connect(f.carol).withdrawCredit(T, f.carol.address);
    } catch (e: any) {
      carolErr = (e.shortMessage ?? e.message ?? String(e)).split("\n")[0];
    }
    const carolGot = (await f.fot.balanceOf(f.carol.address)) - c0;

    const s1 = await lanes(f, f.fot);
    console.log(
      `      [F10-a] Alice payout ${paid ? "succeeded" : "refused"}; Alice received ${fmt(aliceGot)}. ` +
        `Vault holds ${fmt(s1.bal)} against locked ${fmt(s1.locked)} + credited ${fmt(s1.credited)} = ${fmt(s1.owed)}; ` +
        `surplus() reports ${fmt(s1.surplus)}. Carol received ${fmt(carolGot)}` +
        (carolErr ? ` -- her withdrawCredit reverted: ${carolErr}` : "")
    );

    expect(
      s1.bal,
      "after Alice's exit the vault must still hold at least totalLocked + totalCredited (Carol's 100 must stay fully backed)"
    ).to.be.gte(s1.owed);
  });

  it("F10-b fee-on-top: sweepSurplus must not dip into the locked lane (T4: admin cannot reach a wei of any vault)", async () => {
    const f = await loadFixture(fixture);
    const T = await f.fot.getAddress();
    await open(f, f.fot, f.alice, f.bob);
    await open(f, f.fot, f.carol, f.dave);
    // An arbitrary third party force-feeds 10 tokens straight to the contract (surplus lane).
    await f.fot.connect(f.eve).transfer(f.vaultAddr, ethers.parseEther("10"));
    const s0 = await lanes(f, f.fot);
    expect(s0.surplus).to.equal(ethers.parseEther("10"));

    let swept = true;
    try {
      await f.vault.connect(f.admin).sweepSurplus(T, f.admin.address);
    } catch {
      swept = false;
    }
    const s1 = await lanes(f, f.fot);
    console.log(
      `      [F10-b] sweep ${swept ? "succeeded" : "refused"}; vault holds ${fmt(s1.bal)} against ` +
        `locked ${fmt(s1.locked)} + credited ${fmt(s1.credited)} = ${fmt(s1.owed)}`
    );
    expect(s1.bal, "a surplus sweep must leave the locked + credited lanes fully backed").to.be.gte(s1.owed);
  });

  // ------------------------------------------------------------------ balance falls on its own

  it("F10-c negative rebase / issuer burn: an unrelated heir must not be left with nothing while the pool still holds tokens", async () => {
    const f = await loadFixture(fixture);
    const T = await f.shr.getAddress();
    await open(f, f.shr, f.alice, f.bob);
    await open(f, f.shr, f.carol, f.dave);

    // The token shrinks the vault's balance by 10% (negative rebase / forced burn). No vault call.
    await f.shr.shrink(f.vaultAddr, 1_000);
    const s0 = await lanes(f, f.shr);
    expect(s0.bal).to.equal(ethers.parseEther("180"));
    expect(s0.owed).to.equal(ethers.parseEther("200"));

    // Alice exits first, in full, and is paid 100 -- more than her 90 pro-rata share.
    await f.vault.connect(f.alice).withdraw(0, AMT, f.alice.address);
    const a0: bigint = await f.shr.balanceOf(f.alice.address);
    await f.vault.connect(f.alice).withdrawCredit(T, f.alice.address);
    const aliceGot = (await f.shr.balanceOf(f.alice.address)) - a0;

    // Carol goes silent; Dave (her heir, who did nothing) inherits through the normal path.
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.dave).initiateClaim(f.carol.address, 0, f.dave.address);
    await time.increase(WINDOW + 1);
    await f.vault.connect(f.eve).finalizeClaim(f.carol.address, 0);
    const daveCredit: bigint = await f.vault.creditOf(T, f.dave.address);

    const d0: bigint = await f.shr.balanceOf(f.dave.address);
    let err = "";
    try {
      await f.vault.connect(f.dave).withdrawCredit(T, f.dave.address);
    } catch (e: any) {
      err = (e.shortMessage ?? e.message ?? String(e)).split("\n")[0];
    }
    const daveGot = (await f.shr.balanceOf(f.dave.address)) - d0;
    const s1 = await lanes(f, f.shr);
    console.log(
      `      [F10-c] surplus() after the 10% shrink reported ${fmt(s0.surplus)} (a 20-token deficit is invisible). ` +
        `Alice received ${fmt(aliceGot)} (pro-rata would be 90). Dave credited ${fmt(daveCredit)}, ` +
        `vault still holds ${fmt(s1.bal)}, Dave received ${fmt(daveGot)}${err ? ` -- withdrawCredit reverted: ${err}` : ""}`
    );

    expect(daveGot, "the heir of an unrelated vault must recover what the pool still holds for him, not zero").to.be.gt(0n);
  });

  it("F10-d negative rebase / issuer burn: a depositor who arrives AFTER the shortfall must not fund it", async () => {
    const f = await loadFixture(fixture);
    const T = await f.shr.getAddress();
    await open(f, f.shr, f.alice, f.bob);
    await f.shr.shrink(f.vaultAddr, 1_000); // pool 90, Alice owed 100
    await f.vault.connect(f.alice).withdraw(0, AMT, f.alice.address); // credited 100, unpayable

    // Eve, a new user, creates a 100-token vault a week later. The deficit is invisible to her.
    await time.increase(7 * DAY);
    expect(await f.vault.surplus(T)).to.equal(0n);
    await open(f, f.shr, f.eve, f.bob);

    // Alice's stale credit is now payable -- out of Eve's deposit.
    await f.vault.connect(f.alice).withdrawCredit(T, f.alice.address);
    const s1 = await lanes(f, f.shr);
    const eveVault = await f.vault.getVault(f.eve.address, 0);
    console.log(
      `      [F10-d] Alice paid ${fmt(AMT)} in full after Eve deposited. Eve's vault records ${fmt(eveVault.balance)}; ` +
        `the contract holds ${fmt(s1.bal)} of that token in total`
    );
    expect(s1.bal, "a later depositor's vault must stay fully backed").to.be.gte(eveVault.balance);
  });

  // ------------------------------------------------------------------ calibration (passes)

  it("[calibration] an owner whose vault is still live can dodge the loss by withdrawing no more than the pool holds", async () => {
    const f = await loadFixture(fixture);
    const T = await f.shr.getAddress();
    await open(f, f.shr, f.alice, f.bob);
    await open(f, f.shr, f.carol, f.dave);
    await f.shr.shrink(f.vaultAddr, 1_000);
    await f.vault.connect(f.alice).withdraw(0, AMT, f.alice.address);
    await f.vault.connect(f.alice).withdrawCredit(T, f.alice.address); // pool now 80

    // Carol, still alive and paying attention, withdraws exactly 80 and is paid.
    await f.vault.connect(f.carol).withdraw(0, ethers.parseEther("80"), f.carol.address);
    await expect(f.vault.connect(f.carol).withdrawCredit(T, f.carol.address)).to.not.be.reverted;
    // The other 20 stays "locked" in her vault with nothing behind it.
    expect((await f.vault.getVault(f.carol.address, 0)).balance).to.equal(ethers.parseEther("20"));
    expect(await f.shr.balanceOf(f.vaultAddr)).to.equal(0n);
  });
});
