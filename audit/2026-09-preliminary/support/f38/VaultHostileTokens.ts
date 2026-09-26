/**
 * F38 proposed regression tests for InheritanceVault: token classes the shipped suite never
 * exercises (no-bool return, false return). All pass against the shipped contract.
 * Run by audit/2026-09-preliminary/poc/F38.ts against the real contract and against each mutant.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

describe("F38 InheritanceVault hostile-token classes", () => {
  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("InheritanceVaultV1", admin)).deploy(
      admin.address, FEE_BPS, feeSink.address
    );
    const vaultAddr = await vault.getAddress();
    const noBool = await (await ethers.getContractFactory("F38_NoBoolToken", admin)).deploy();
    const falseTok = await (await ethers.getContractFactory("F38_FalseReturnToken", admin)).deploy();
    for (const t of [noBool, falseTok]) {
      await t.mint(alice.address, ethers.parseEther("1000"));
      await t.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    }
    return { vault, vaultAddr, noBool, falseTok, admin, alice, bob, carol, dave, feeSink };
  }

  /** alice deposits DEPOSIT of `token` into vault 0, then withdraws it all, crediting herself. */
  async function creditAlice(f: any, token: string) {
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(token, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
    expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(DEPOSIT);
    await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
    expect(await f.vault.creditOf(token, f.alice.address)).to.equal(DEPOSIT);
  }

  it("a USDT-style token (no return value) can be deposited, credited and paid out", async () => {
    const f = await loadFixture(fixture);
    const tok = await f.noBool.getAddress();
    await creditAlice(f, tok);
    const before = await f.noBool.balanceOf(f.alice.address);
    await f.vault.connect(f.alice).withdrawCredit(tok, f.alice.address);
    expect(await f.noBool.balanceOf(f.alice.address)).to.equal(before + DEPOSIT);
    expect(await f.vault.creditOf(tok, f.alice.address)).to.equal(0n);
  });

  it("a token that returns false instead of reverting cannot silently eat a credited payout", async () => {
    const f = await loadFixture(fixture);
    const tok = await f.falseTok.getAddress();
    await creditAlice(f, tok);
    await f.falseTok.setFailTransfers(true);
    await expect(f.vault.connect(f.alice).withdrawCredit(tok, f.alice.address)).to.be.reverted;
    expect(await f.vault.creditOf(tok, f.alice.address)).to.equal(DEPOSIT);
  });

  it("damage check: an undelivered payout must stay credited, never become admin-sweepable surplus", async () => {
    const f = await loadFixture(fixture);
    const tok = await f.falseTok.getAddress();
    await creditAlice(f, tok);
    await f.falseTok.setFailTransfers(true);
    try { await f.vault.connect(f.alice).withdrawCredit(tok, f.alice.address); } catch { /* expected on the real contract */ }
    const credit = await f.vault.creditOf(tok, f.alice.address);
    const surplus = await f.vault.surplus(tok);
    const held = await f.falseTok.balanceOf(f.vaultAddr);
    expect(
      { credit, surplus, held },
      `heir/owner credit ${credit}, admin-sweepable surplus ${surplus}, tokens still in vault ${held}`
    ).to.deep.equal({ credit: DEPOSIT, surplus: 0n, held: DEPOSIT });
  });
});
