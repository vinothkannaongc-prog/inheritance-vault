/**
 * F38 proposed regression tests for NotifySubscription: every assertion sits ON a boundary,
 * so an off-by-one or a dropped guard fails here. All pass against the shipped contract.
 * Run by audit/2026-09-preliminary/poc/F38.ts against the real contract and against each mutant.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const MONTH = 30n * 86_400n;
const MAX_PREPAID = 3650n * 86_400n;
const PRICE = ethers.parseEther("0.001"); // per month, as in test/NotifySubscription.ts

describe("F38 NotifySubscription boundaries", () => {
  async function fixture() {
    const [admin, alice, bob, newAdmin] = await ethers.getSigners();
    const Sub = await ethers.getContractFactory("NotifySubscription", admin);
    const sub = await Sub.deploy(admin.address, PRICE);
    return { sub, admin, alice, bob, newAdmin };
  }

  it("dust boundary: 1 wei under one second's price reverts; exactly one second's price buys 1 s", async () => {
    const f = await loadFixture(fixture);
    const oneSecond = (PRICE + MONTH - 1n) / MONTH; // ceil(price / MONTH)
    expect(oneSecond).to.equal(385_802_470n); // ~0.386 gwei, not ~385 gwei
    await expect(f.sub.subscribe(f.alice.address, 0, { value: oneSecond - 1n }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
    const t = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(t);
    await f.sub.subscribe(f.alice.address, 0, { value: oneSecond });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(t + 1);
  });

  it("cap boundary: a purchase landing exactly on the 10-year cap is accepted; one second more is refused", async () => {
    const f = await loadFixture(fixture);
    const exact = (MAX_PREPAID * PRICE + MONTH - 1n) / MONTH; // smallest value that buys MAX_PREPAID
    expect((exact * MONTH) / PRICE).to.equal(MAX_PREPAID);
    const t = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(t);
    await f.sub.subscribe(f.alice.address, 0, { value: exact });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(BigInt(t) + MAX_PREPAID);

    const oneMore = ((MAX_PREPAID + 1n) * PRICE + MONTH - 1n) / MONTH;
    await expect(f.sub.subscribe(f.bob.address, 0, { value: oneMore }))
      .to.be.revertedWithCustomError(f.sub, "TooFarAhead");
  });

  it("slippage boundary: minSecondsAdded == seconds bought is accepted; +1 is refused", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, MONTH, { value: PRICE });
    await expect(f.sub.connect(f.alice).subscribe(f.alice.address, MONTH + 1n, { value: PRICE }))
      .to.be.revertedWithCustomError(f.sub, "PriceMoved")
      .withArgs(MONTH, MONTH + 1n);
  });

  it("withdraw(address(0)) is refused and the revenue stays put", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    await expect(f.sub.connect(f.admin).withdraw(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(f.sub, "ZeroAddress");
    expect(await ethers.provider.getBalance(await f.sub.getAddress())).to.equal(PRICE);
  });

  it("withdraw to a recipient that rejects native value reverts and the revenue stays put", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    const rejecter = await (await ethers.getContractFactory("RevertingReceiver", f.admin)).deploy();
    await expect(f.sub.connect(f.admin).withdraw(await rejecter.getAddress()))
      .to.be.revertedWithCustomError(f.sub, "NativeTransferFailed");
    expect(await ethers.provider.getBalance(await f.sub.getAddress())).to.equal(PRICE);
  });

  it("a plain native transfer (no subscribe call) is refused", async () => {
    const f = await loadFixture(fixture);
    await expect(f.alice.sendTransaction({ to: await f.sub.getAddress(), value: PRICE })).to.be.reverted;
    expect(await ethers.provider.getBalance(await f.sub.getAddress())).to.equal(0n);
  });

  it("the admin handover is two-step (Ownable2Step), as used for the hardware-wallet move", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.admin).transferOwnership(f.newAdmin.address);
    expect(await f.sub.owner()).to.equal(f.admin.address); // nothing moves until accepted
    expect(await f.sub.pendingOwner()).to.equal(f.newAdmin.address);
    await expect(f.sub.connect(f.newAdmin).setPrice(1))
      .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
    await f.sub.connect(f.newAdmin).acceptOwnership();
    expect(await f.sub.owner()).to.equal(f.newAdmin.address);
    await expect(f.sub.connect(f.admin).setPrice(1))
      .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
  });

  it("extreme prices: 1 wei/month and type(uint256).max/month both behave", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.admin).setPrice(1);
    const t = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(t);
    await f.sub.subscribe(f.alice.address, 0, { value: 1n });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(BigInt(t) + MONTH);
    await expect(f.sub.subscribe(f.bob.address, 0, { value: 122n })) // 122 months = 3660 days
      .to.be.revertedWithCustomError(f.sub, "TooFarAhead");
    await f.sub.connect(f.admin).setPrice(ethers.MaxUint256);
    await expect(f.sub.subscribe(f.bob.address, 0, { value: ethers.parseEther("1") }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
  });
});
