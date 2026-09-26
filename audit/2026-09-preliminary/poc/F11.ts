// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F11/test/poc-F11.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F11 (LOW): yield on positive-rebase, interest-bearing (aToken-style) and
 * reflection deposits accrues to surplus() and sweepSurplus() hands it to the admin.
 *
 * The site promises "We cannot touch a wei of any vault" (site/index.html:116) and invites
 * "any ERC-20" (site/index.html:75); the app's create form accepts any token address
 * (site/assets/app.js:361). These tests assert the promised property -- the admin receives
 * nothing that grew out of a user's locked deposit, and the heir inherits what the vault holds
 * for them -- so they FAIL against the current contract because of the defect.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const YEAR = 365 * DAY;
const PERIOD = 400 * DAY; // Alice checks in once a year
const WINDOW = 14 * DAY;
const FEE_BPS = 50n;
const PRINCIPAL = ethers.parseEther("10000"); // "10,000 aBasUSDC"
const fmt = (x: bigint) => Number(ethers.formatEther(x)).toFixed(2);

describe("F11 balance-increasing deposits: yield becomes admin-sweepable surplus", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("InheritanceVaultV1", admin)).deploy(
      admin.address,
      FEE_BPS,
      feeSink.address
    );
    const token = await (await ethers.getContractFactory("F11_YieldToken", admin)).deploy();
    const vaultAddr = await vault.getAddress();
    const tokenAddr = await token.getAddress();
    await token.mint(alice.address, PRINCIPAL);
    await token.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    return { vault, token, vaultAddr, tokenAddr, admin, alice, bob, carol, dave, feeSink };
  }

  // Alice (owner) locks her whole balance for Bob (heir), 12-year horizon.
  async function aliceVault(f: any) {
    const horizon = (await time.latest()) + 12 * YEAR;
    await f.vault
      .connect(f.alice)
      .createVault(f.tokenAddr, PRINCIPAL, f.bob.address, PERIOD, WINDOW, horizon);
    expect(await f.vault.surplus(f.tokenAddr)).to.equal(0n); // nothing force-fed at the start
  }

  // Ten years at 5% a year, Alice alive and checking in each year.
  async function tenYearsAtFivePercent(f: any) {
    for (let y = 0; y < 10; y++) {
      await time.increase(YEAR);
      await f.token.accrue(500);
      await f.vault.connect(f.alice).checkIn(0);
    }
  }

  // The admin's periodic sweep. Tolerates a revert, so a fix that refuses the sweep passes.
  async function adminSweep(f: any): Promise<bigint> {
    const before = await f.token.balanceOf(f.admin.address);
    try {
      await f.vault.connect(f.admin).sweepSurplus(f.tokenAddr, f.admin.address);
    } catch {
      /* refused: nothing taken */
    }
    return (await f.token.balanceOf(f.admin.address)) - before;
  }

  it("positive rebase (aToken model): the admin cannot sweep a wei of the yield on a locked deposit", async () => {
    const f = await loadFixture(fixture);
    await aliceVault(f);
    await tenYearsAtFivePercent(f);

    const held = await f.token.balanceOf(f.vaultAddr);
    const accrued = held - PRINCIPAL;
    expect(accrued > 0n, "precondition: Alice's deposit grew").to.equal(true);
    console.log(
      `      vault holds ${fmt(held)} for Alice's one vault; locked lane says ` +
        `${fmt(await f.vault.totalLocked(f.tokenAddr))}; surplus() = ${fmt(await f.vault.surplus(f.tokenAddr))}`
    );

    const taken = await adminSweep(f);
    console.log(`      admin sweepSurplus took ${fmt(taken)} (${(Number((taken * 10000n) / PRINCIPAL) / 100).toFixed(2)}% of principal)`);

    // The site's promise: "We cannot touch a wei of any vault".
    expect(taken, "admin swept the yield accrued on Alice's locked deposit").to.equal(0n);
    expect(await f.token.balanceOf(f.vaultAddr)).to.equal(held);
  });

  it("quantified end to end: Bob inherits the nominal deposit and the admin keeps ~63% of principal", async () => {
    const f = await loadFixture(fixture);
    await aliceVault(f);
    await tenYearsAtFivePercent(f);
    const held = await f.token.balanceOf(f.vaultAddr); // everything in the vault is Alice's estate

    const taken = await adminSweep(f);

    // Alice goes silent; Bob claims; a stranger finalizes; Bob pulls his credit.
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);
    const b0 = await f.token.balanceOf(f.bob.address);
    await f.vault.connect(f.bob).withdrawCredit(f.tokenAddr, f.bob.address);
    const heirGot = (await f.token.balanceOf(f.bob.address)) - b0;
    const feeGot = await f.vault.creditOf(f.tokenAddr, f.feeSink.address);

    const expectedFee = (held * FEE_BPS) / 10_000n;
    const expectedHeir = held - expectedFee;
    console.log(`      estate held by vault : ${fmt(held)}`);
    console.log(`      heir (Bob) received  : ${fmt(heirGot)}   (expected ${fmt(expectedHeir)})`);
    console.log(`      claim fee credited   : ${fmt(feeGot)}   (${FEE_BPS} bps)`);
    console.log(`      admin swept          : ${fmt(taken)}`);
    console.log(`      left in vault        : ${fmt(await f.token.balanceOf(f.vaultAddr))}`);

    expect(heirGot, "Bob inherited only the nominal deposit; the yield went to the admin").to.be.closeTo(
      expectedHeir,
      1_000n
    );
    expect(taken).to.equal(0n);
  });

  it("reflection token (BNB variant): reflections earned from third-party transfers are not the admin's", async () => {
    const f = await loadFixture(fixture);
    await f.token.setReflectionFee(200); // 2% of every transfer reflected to all holders
    await aliceVault(f);
    const lockedAtDeposit = await f.token.balanceOf(f.vaultAddr);

    // Ordinary market volume between two strangers; the vault takes no part in it.
    await f.token.mint(f.carol.address, ethers.parseEther("1000000"));
    for (let i = 0; i < 10; i++) {
      await f.token.connect(f.carol).transfer(f.dave.address, await f.token.balanceOf(f.carol.address));
      await f.token.connect(f.dave).transfer(f.carol.address, await f.token.balanceOf(f.dave.address));
    }
    const held = await f.token.balanceOf(f.vaultAddr);
    expect(held > lockedAtDeposit, "precondition: reflections credited the vault").to.equal(true);
    console.log(
      `      vault received ${fmt(lockedAtDeposit)} at deposit, holds ${fmt(held)} after third-party volume; ` +
        `surplus() = ${fmt(await f.vault.surplus(f.tokenAddr))}`
    );

    const taken = await adminSweep(f);
    console.log(`      admin sweepSurplus took ${fmt(taken)}`);
    expect(taken, "admin swept reflections earned by Alice's locked deposit").to.equal(0n);
  });
});
