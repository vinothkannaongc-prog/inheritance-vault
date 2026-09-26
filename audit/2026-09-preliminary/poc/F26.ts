// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F26/test/poc-F26.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F26 (informational): value-movement events that do not describe a value movement.
 *
 * The property asserted by the failing tests: an event that names a payee and an amount
 * (Withdrawn.to/amount, ClaimSettled.recipient/amount, CreditPaid.to/amount) is only emitted
 * when that payee's balance actually rose by that amount in the same transaction. The balance
 * delta is measured independently of the event, so the test is not self-confirming.
 *
 * A fix that renames the credit-recording events (e.g. WithdrawnToCredit) makes the first two
 * tests pass vacuously, which is the intent: no event named like a payment remains that is not one.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FIVE = ethers.parseEther("5");
const TOKENS = ethers.parseEther("100");
const FEE_BPS = 50;

describe("F26 PoC: value-movement events vs actual transfers", () => {
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
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  async function fotFixture() {
    const f = await loadFixture(fixture);
    const Tok = await ethers.getContractFactory("FeeOnTransferToken", f.admin);
    const token = await Tok.deploy();
    const tokenAddr = await token.getAddress();
    await token.mint(f.alice.address, TOKENS);
    await token.connect(f.alice).approve(await f.vault.getAddress(), ethers.MaxUint256);
    const horizon = (await time.latest()) + 730 * DAY;
    // Vault 1 of alice holds the fee-on-transfer token; _pull records what arrived (99e18).
    await f.vault.connect(f.alice).createVault(tokenAddr, TOKENS, f.bob.address, PERIOD, WINDOW, horizon);
    const held = (await f.vault.getVault(f.alice.address, 1)).balance;
    // The owner withdraws everything to carol: carol is credited `held`.
    await f.vault.connect(f.alice).withdraw(1, held, f.carol.address);
    return { ...f, token, tokenAddr, held };
  }

  /** Every log from the vault whose parsed name is `name` (none if the event no longer exists). */
  async function vaultEvents(vault: any, receipt: any, name: string) {
    const addr = (await vault.getAddress()).toLowerCase();
    const out: any[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== addr) continue;
      let parsed: any = null;
      try {
        parsed = vault.interface.parseLog(log);
      } catch {
        parsed = null;
      }
      if (parsed && parsed.name === name) out.push(parsed);
    }
    return out;
  }

  // ------------------------------------------------------------------ failing: the defect

  it("Withdrawn(to, amount) is emitted only when `to` actually received `amount`", async () => {
    const f = await loadFixture(fixture);
    const before = await ethers.provider.getBalance(f.carol.address);

    const receipt = await (await f.vault.connect(f.alice).withdraw(0, FIVE, f.carol.address)).wait();
    const delta = (await ethers.provider.getBalance(f.carol.address)) - before;

    const logs = await vaultEvents(f.vault, receipt, "Withdrawn");
    for (const ev of logs) {
      expect(
        delta,
        `Withdrawn says ${ev.args.to} received ${ev.args.amount} wei; the funds are only in creditOf ` +
          `(${await f.vault.creditOf(NATIVE, f.carol.address)} wei)`
      ).to.equal(ev.args.amount);
    }
  });

  it("ClaimSettled(recipient, amount) is emitted only when the recipient actually received `amount`", async () => {
    const f = await loadFixture(fixture);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.dave.address);
    await time.increase(WINDOW + 1);

    const before = await ethers.provider.getBalance(f.dave.address);
    // Arbitrary third party (carol) finalizes, so dave pays no gas and his delta is exact.
    const receipt = await (await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0)).wait();
    const delta = (await ethers.provider.getBalance(f.dave.address)) - before;

    const logs = await vaultEvents(f.vault, receipt, "ClaimSettled");
    for (const ev of logs) {
      expect(
        delta,
        `ClaimSettled says ${ev.args.recipient} was settled ${ev.args.amount} wei; the funds are only in creditOf ` +
          `(${await f.vault.creditOf(NATIVE, f.dave.address)} wei)`
      ).to.equal(ev.args.amount);
    }
  });

  it("CreditPaid.amount (withdrawCredit) equals what `to` actually received, for a fee-on-transfer token", async () => {
    const f = await fotFixture();
    const before = await f.token.balanceOf(f.carol.address);

    const receipt = await (await f.vault.connect(f.carol).withdrawCredit(f.tokenAddr, f.carol.address)).wait();
    const received = (await f.token.balanceOf(f.carol.address)) - before;

    const logs = await vaultEvents(f.vault, receipt, "CreditPaid");
    expect(logs.length).to.equal(1);
    expect(logs[0].args.amount, "CreditPaid.amount vs tokens that reached `to`").to.equal(received);
  });

  it("CreditPaid.amount (pushCredit) equals what the account actually received, for a fee-on-transfer token", async () => {
    const f = await fotFixture();
    const before = await f.token.balanceOf(f.carol.address);

    // Arbitrary third party (dave) pushes carol's credit.
    const receipt = await (await f.vault.connect(f.dave).pushCredit(f.tokenAddr, f.carol.address)).wait();
    const received = (await f.token.balanceOf(f.carol.address)) - before;

    const logs = await vaultEvents(f.vault, receipt, "CreditPaid");
    expect(logs.length).to.equal(1);
    expect(logs[0].args.amount, "CreditPaid.amount vs tokens that reached the account").to.equal(received);
  });

  it("withdrawCredit's return value equals what `to` actually received, for a fee-on-transfer token", async () => {
    const f = await fotFixture();
    const before = await f.token.balanceOf(f.carol.address);
    const returned = await f.vault.connect(f.carol).withdrawCredit.staticCall(f.tokenAddr, f.carol.address);
    await (await f.vault.connect(f.carol).withdrawCredit(f.tokenAddr, f.carol.address)).wait();
    const received = (await f.token.balanceOf(f.carol.address)) - before;
    expect(returned, "withdrawCredit() return value vs tokens that reached `to`").to.equal(received);
  });

  // ------------------------------------------------------------------ passing: bounds of the impact

  it("(quantification, passes) a Withdrawn payee that cannot pull never receives anything", async () => {
    const f = await loadFixture(fixture);
    const Rej = await ethers.getContractFactory("RevertingReceiver", f.admin);
    const rejecter = await Rej.deploy();
    const rej = await rejecter.getAddress();

    const receipt = await (await f.vault.connect(f.alice).withdraw(0, FIVE, rej)).wait();
    const logs = await vaultEvents(f.vault, receipt, "Withdrawn");
    console.log(
      `      Withdrawn events naming the rejecter: ${logs.map((l: any) => `${l.args.to} ${ethers.formatEther(l.args.amount)} ETH`).join(", ")}`
    );

    // The value is parked, not delivered, and no party can ever deliver it.
    expect(await ethers.provider.getBalance(rej)).to.equal(0n);
    expect(await f.vault.creditOf(NATIVE, rej)).to.equal(FIVE);
    await expect(f.vault.connect(f.dave).pushCredit(NATIVE, rej)).to.be.revertedWithCustomError(
      f.vault,
      "NativeTransferFailed"
    );
    expect(await f.vault.creditOf(NATIVE, rej)).to.equal(FIVE);
    console.log(`      stranded in creditOf(rejecter): ${ethers.formatEther(FIVE)} ETH (no recovery path by design)`);
  });

  it("(characterisation, passes) CreditPaid precedes the transfer but cannot outlive a failed payout", async () => {
    const f = await fotFixture();
    const receipt = await (await f.vault.connect(f.carol).withdrawCredit(f.tokenAddr, f.carol.address)).wait();
    const vaultAddr = (await f.vault.getAddress()).toLowerCase();
    const order = receipt!.logs.map((l: any) => (l.address.toLowerCase() === vaultAddr ? "vault" : "token"));
    console.log(`      log order in withdrawCredit: ${order.join(" -> ")}`);

    // Atomicity is what makes the ordering harmless: a failed payout reverts the log too.
    const Rej = await ethers.getContractFactory("RevertingReceiver", f.admin);
    const rej = await (await Rej.deploy()).getAddress();
    await f.vault.connect(f.alice).withdraw(0, FIVE, f.dave.address);
    await expect(f.vault.connect(f.dave).withdrawCredit(NATIVE, rej)).to.be.revertedWithCustomError(
      f.vault,
      "NativeTransferFailed"
    );
    expect(await f.vault.creditOf(NATIVE, f.dave.address)).to.equal(FIVE);
  });
});
