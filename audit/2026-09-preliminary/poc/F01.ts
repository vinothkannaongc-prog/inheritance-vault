// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F01/test/poc-F01.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * F01 PoC: sweepSurplus reaches depositors' principal when one ledger has two token addresses.
 *
 * surplus(token) = balanceOf(token, this) - totalLocked[token] - totalCredited[token]
 * (InheritanceVault.sol surplus()/sweepSurplus()). The lanes are keyed by token ADDRESS; the
 * balance is read from the LEDGER. A double-entry token (TUSD legacy forwarder, Synthetix
 * Proxy/ProxyERC20) or a native coin with an ERC20 facade (Celo GoldToken, Moonbeam precompile)
 * lets the admin price the whole ledger as "surplus" under the second address and sweep it.
 *
 * Every test asserts the SAFE property (T4: "The admin cannot reach a wei of any vault's balance
 * or any credited payout"), so each FAILS against the current contract and must pass once fixed.
 * The admin's sweep is attempted inside try/catch: a fix that makes it revert is a pass.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const DAVE_DEPOSIT = ethers.parseEther("5");
const FEE_BPS = 50;

describe("F01 sweepSurplus through a second entry point of the same ledger", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const vaultAddr = await vault.getAddress();

    // Token T: primary entry A, secondary entry B, one shared ledger.
    const primary = await (await ethers.getContractFactory("F01_DualEntryPrimary", admin)).deploy();
    const secondary = await (await ethers.getContractFactory("F01_DualEntrySecondary", admin)).deploy(
      await primary.getAddress()
    );
    await primary.setSecondary(await secondary.getAddress());
    const A = await primary.getAddress();
    const B = await secondary.getAddress();

    for (const [who, amt] of [
      [alice, DEPOSIT],
      [dave, DAVE_DEPOSIT],
    ] as const) {
      await primary.mint(who.address, amt);
      await primary.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }
    return { vault, vaultAddr, primary, secondary, A, B, admin, alice, bob, carol, dave, feeSink };
  }

  async function aliceVault(f: any) {
    const horizon = (await time.latest()) + 730 * DAY;
    // Alice uses the PRIMARY address, exactly as the app's free-text token field allows.
    await f.vault.connect(f.alice).createVault(f.A, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
  }

  /** The admin's move. A fixed contract may revert here; that counts as safe. */
  async function adminSweepsViaB(f: any): Promise<string> {
    try {
      await f.vault.connect(f.admin).sweepSurplus(f.B, f.admin.address);
      return "sweep succeeded";
    } catch (e: any) {
      return `sweep reverted: ${e?.shortMessage || e?.message}`;
    }
  }

  /** Decodes why a credit payout reverts, so a failure is traceable to the emptied ledger. */
  async function whyPayoutReverts(f: any, who: any): Promise<string> {
    try {
      await f.vault.connect(who).withdrawCredit.staticCall(f.A, who.address);
      return "payout would succeed";
    } catch (e: any) {
      const data = e?.data ?? e?.error?.data;
      try {
        const pe = f.primary.interface.parseError(data);
        return `${pe!.name}(${pe!.args.map((a: any) => a.toString()).join(", ")})`;
      } catch {
        return e?.shortMessage || e?.message;
      }
    }
  }

  it("admin cannot move locked principal out through the token's second address (T4)", async () => {
    const f = await loadFixture(fixture);
    await aliceVault(f);

    // Preconditions: nothing was force-fed; the A lane is exactly solvent.
    expect(await f.vault.totalLocked(f.A)).to.equal(DEPOSIT);
    expect(await f.vault.surplus(f.A)).to.equal(0n);
    expect(await f.primary.balanceOf(f.vaultAddr)).to.equal(DEPOSIT);
    expect(await f.secondary.balanceOf(f.vaultAddr)).to.equal(DEPOSIT); // same ledger via B

    const adminBefore = await f.primary.balanceOf(f.admin.address);
    const surplusB = await f.vault.surplus(f.B);
    const outcome = await adminSweepsViaB(f);
    console.log(`      [F01] surplus(B) before sweep = ${ethers.formatEther(surplusB)} (expected 0); ${outcome}`);

    // SAFE PROPERTY: the ledger still covers the A lanes, and the admin gained nothing.
    const backing = await f.primary.balanceOf(f.vaultAddr);
    const owed = (await f.vault.totalLocked(f.A)) + (await f.vault.totalCredited(f.A));
    expect(backing, "vault's real balance of T must still cover totalLocked[A] + totalCredited[A]")
      .to.be.gte(owed);
    expect((await f.primary.balanceOf(f.admin.address)) - adminBefore, "admin gain").to.equal(0n);
  });

  it("owner can still withdraw her full principal after the admin's sweep attempt", async () => {
    const f = await loadFixture(fixture);
    await aliceVault(f);
    await adminSweepsViaB(f);

    // getVault still shows the full balance and withdraw records the credit happily...
    expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(DEPOSIT);
    await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
    expect(await f.vault.creditOf(f.A, f.alice.address)).to.equal(DEPOSIT);

    console.log(`      [F01] Alice withdrawCredit: ${await whyPayoutReverts(f, f.alice)}`);
    // SAFE PROPERTY: ...and the credit is actually payable.
    await expect(
      f.vault.connect(f.alice).withdrawCredit(f.A, f.alice.address),
      "Alice's withdrawCredit must pay her principal"
    ).to.not.be.reverted;
    expect(await f.primary.balanceOf(f.alice.address)).to.equal(DEPOSIT);
  });

  it("heir's settled inheritance is still payable after the admin's sweep attempt", async () => {
    const f = await loadFixture(fixture);
    await aliceVault(f);

    // Alice goes silent; Bob claims; the window passes; anyone finalizes.
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);
    const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
    expect(await f.vault.creditOf(f.A, f.bob.address)).to.equal(DEPOSIT - fee);
    expect(await f.vault.totalCredited(f.A)).to.equal(DEPOSIT);
    expect(await f.vault.totalLocked(f.A)).to.equal(0n);

    // The admin sweeps the CREDITED lane via B while Bob has not yet pulled.
    await adminSweepsViaB(f);

    console.log(`      [F01] Bob withdrawCredit: ${await whyPayoutReverts(f, f.bob)}`);
    // SAFE PROPERTY: Bob's credit is payable.
    await expect(
      f.vault.connect(f.bob).withdrawCredit(f.A, f.bob.address),
      "Bob's withdrawCredit must pay the inheritance"
    ).to.not.be.reverted;
    expect(await f.primary.balanceOf(f.bob.address)).to.equal(DEPOSIT - fee);
  });

  it("damage: one sweep via B takes every locked and credited unit of T", async () => {
    const f = await loadFixture(fixture);
    await aliceVault(f);
    // Dave opens a vault and withdraws it, so his 5 T sit in the CREDITED lane, unpulled.
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.dave).createVault(f.A, DAVE_DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
    await f.vault.connect(f.dave).withdraw(0, DAVE_DEPOSIT, f.dave.address);

    const tvl = DEPOSIT + DAVE_DEPOSIT;
    const surplusB = await f.vault.surplus(f.B);
    const surplusA = await f.vault.surplus(f.A);
    const adminBefore = await f.primary.balanceOf(f.admin.address);

    let swept: bigint = 0n;
    try {
      const tx = await f.vault.connect(f.admin).sweepSurplus(f.B, f.admin.address);
      const rc = await tx.wait();
      const ev = rc.logs
        .map((l: any) => { try { return f.vault.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p && p.name === "SurplusSwept");
      swept = ev.args.amount;
      console.log(`      [F01] SurplusSwept(token=${ev.args.token === f.B ? "B (second entry)" : ev.args.token}, amount=${ethers.formatEther(swept)})`);
    } catch (e: any) {
      console.log(`      [F01] sweep reverted: ${e?.shortMessage || e?.message}`);
    }

    const adminGain = (await f.primary.balanceOf(f.admin.address)) - adminBefore;
    const backing = await f.primary.balanceOf(f.vaultAddr);
    const locked = await f.vault.totalLocked(f.A);
    const credited = await f.vault.totalCredited(f.A);
    console.log(
      `      [F01] TVL in T = ${ethers.formatEther(tvl)} | surplus(A) = ${ethers.formatEther(surplusA)}` +
        ` | surplus(B) = ${ethers.formatEther(surplusB)} | admin gained ${ethers.formatEther(adminGain)}` +
        ` | vault now holds ${ethers.formatEther(backing)} against totalLocked[A] ${ethers.formatEther(locked)}` +
        ` + totalCredited[A] ${ethers.formatEther(credited)}` +
        ` | Alice getVault balance ${ethers.formatEther((await f.vault.getVault(f.alice.address, 0)).balance)}`
    );

    // SAFE PROPERTY: surplus priced through ANY address is only force-fed value (none here),
    // and the admin gains nothing.
    expect(surplusB, "surplus(B) must not price depositors' funds as surplus").to.equal(0n);
    expect(adminGain, "admin gain from the sweep").to.equal(0n);
  });

  it("native variant: an ERC20 facade over the native coin prices the native TVL as surplus", async () => {
    // Models deploying the same bytecode on a chain with native/ERC20 duality (Celo GoldToken,
    // Moonbeam's native ERC20 precompile). Base and BNB Chain have no such alias today.
    // Mock limitation: plain EVM code cannot debit the vault's native balance, so the facade
    // RECORDS the transfer the vault requests; on those chains that call moves the native coin.
    const f = await loadFixture(fixture);
    const facade = await (await ethers.getContractFactory("F01_NativeFacadeMock", f.admin)).deploy();
    const facadeAddr = await facade.getAddress();
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    expect(await f.vault.surplus(NATIVE)).to.equal(0n);

    const surplusFacade = await f.vault.surplus(facadeAddr);
    try {
      await f.vault.connect(f.admin).sweepSurplus(facadeAddr, f.admin.address);
    } catch {
      /* a fixed contract may refuse */
    }
    const requested = await facade.lastAmount();
    console.log(
      `      [F01] native vault ${ethers.formatEther(DEPOSIT)} | surplus(facade) = ${ethers.formatEther(surplusFacade)}` +
        ` | vault asked facade.transfer(${(await facade.lastTo()) === f.admin.address ? "admin" : await facade.lastTo()}, ${ethers.formatEther(requested)})`
    );

    // SAFE PROPERTY: the vault never asks any token to move value that belongs to the native lane.
    expect(requested, "amount the vault asked the native facade to transfer to the admin").to.equal(0n);
  });
});
