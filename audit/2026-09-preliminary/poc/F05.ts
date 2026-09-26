// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F05/test/poc-F05.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F05 -- the A-04 fee lock freezes the RATE but not the "no fee recipient means no fee"
 * switch. A claim initiated while feeRecipient == address(0) (effective fee 0 by the NatSpec,
 * README.md:53, index.html:114 and how-it-works.html:58) is charged the full locked rate if the
 * admin sets a recipient at any point before finalizeClaim.
 *
 * Each test asserts the SAFE property (the claim settles fee-free, as it was when it began), so
 * it fails against the current code because of the defect and passes once initiateClaim locks
 * lockedFeeBps = 0 when feeRecipient is unset.
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

describe("PoC F05: fee lock ignores the zero-recipient switch", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  // Same shape as test/Audit.ts: the live-deployment configuration (recipient set, 50 bps).
  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  // A fresh deployment that starts with no fee recipient (e.g. a new chain) at the 1% cap.
  async function noRecipientFixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, 100, ethers.ZeroAddress);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  async function nativeVault(f: any, amount = DEPOSIT) {
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, amount, f.bob.address, PERIOD, WINDOW, horizon, { value: amount });
  }

  // Control: proves the zero-recipient rule exists and works when nobody toggles it, so the
  // failures below are caused by the toggle, not by the fixture. Passes before and after a fix.
  it("control: a claim that starts and settles with no recipient is fee-free", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
    await expect(f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0))
      .to.emit(f.vault, "ClaimSettled")
      .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
  });

  it("a claim begun with no fee recipient stays fee-free when the admin sets one mid-window", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f); // ceiling snapshot = 50 bps

    // 1. Fee holiday: recipient unset, rate left at 50 bps.
    await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
    expect(await f.vault.feeRecipient()).to.equal(ethers.ZeroAddress);

    // 2. Alice goes inactive; Bob initiates while every public signal says "no fee".
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // 3. During the challenge window the admin re-enables fees.
    await time.increase(WINDOW - DAY);
    await f.vault.connect(f.admin).setFeeRecipient(f.admin.address);
    await time.increase(DAY + 1);

    // 4. Anyone finalizes. SAFE property: the heir receives everything, no fee is credited.
    await expect(f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0))
      .to.emit(f.vault, "ClaimSettled")
      .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
  });

  it("the admin cannot sandwich the settlement through the recipient in one block", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    const v = await f.vault.getVault(f.alice.address, 0);
    const finalizableAt = Number(v.claimInitiatedAt) + WINDOW;
    await time.increaseTo(finalizableAt - 10);
    const blockBefore = await ethers.provider.getBlockNumber();

    // Bundle: setFeeRecipient(admin) -> finalizeClaim -> setFeeRecipient(0), all in one block.
    await network.provider.send("evm_setAutomine", [false]);
    let t1, t2, t3;
    try {
      const gas = { gasLimit: 500_000 };
      t1 = await f.vault.connect(f.admin).setFeeRecipient(f.admin.address, gas);
      t2 = await f.vault.connect(f.admin).finalizeClaim(f.alice.address, 0, gas);
      t3 = await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress, gas);
      await time.setNextBlockTimestamp(finalizableAt);
      await network.provider.send("evm_mine");
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const [r1, r2, r3] = await Promise.all([t1!.wait(), t2!.wait(), t3!.wait()]);
    expect(r1!.status).to.equal(1);
    expect(r2!.status).to.equal(1);
    expect(r3!.status).to.equal(1);
    expect(r1!.blockNumber).to.equal(r2!.blockNumber);
    expect(r2!.blockNumber).to.equal(r3!.blockNumber);

    // Public state reads "no recipient" both before and after the bundle.
    expect(await f.vault.feeRecipient({ blockTag: blockBefore })).to.equal(ethers.ZeroAddress);
    expect(await f.vault.feeRecipient()).to.equal(ethers.ZeroAddress);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(3); // SETTLED

    // SAFE property: the heir got the whole vault and the admin got nothing.
    const adminCredit = await f.vault.creditOf(NATIVE, f.admin.address);
    const heirCredit = await f.vault.creditOf(NATIVE, f.bob.address);
    expect(adminCredit, `admin skimmed ${ethers.formatEther(adminCredit)} ETH`).to.equal(0n);
    expect(heirCredit, "heir short-changed").to.equal(DEPOSIT);
  });

  it("damage: a fresh no-recipient deployment charges the full 1% cap on an in-flight claim", async () => {
    const f = await loadFixture(noRecipientFixture);
    const big = ethers.parseEther("100");
    await nativeVault(f, big); // ceiling snapshot = 100 bps although no fee could be taken
    expect((await f.vault.getVault(f.alice.address, 0)).feeBps).to.equal(100);

    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
    await time.increase(WINDOW + 1);
    await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);

    const heirCredit = await f.vault.creditOf(NATIVE, f.bob.address);
    const feeCredit = await f.vault.creditOf(NATIVE, f.feeSink.address);
    // Quantified: current code moves 1 ETH of a 100 ETH inheritance to the fee sink.
    expect(
      feeCredit,
      `fee sink credited ${ethers.formatEther(feeCredit)} ETH on a claim begun fee-free`
    ).to.equal(0n);
    expect(heirCredit).to.equal(big);
  });
});
