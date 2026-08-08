import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const MONTH = 30 * 86400;
const PRICE = ethers.parseEther("0.001"); // per month

describe("NotifySubscription", () => {
  async function fixture() {
    const [admin, alice, bob] = await ethers.getSigners();
    const Sub = await ethers.getContractFactory("NotifySubscription", admin);
    const sub = await Sub.deploy(admin.address, PRICE);
    return { sub, admin, alice, bob };
  }

  it("credits time pro-rata from now", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE * 2n });
    const t = await time.latest();
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(t + 2 * MONTH);
    expect(await f.sub.isActive(f.alice.address)).to.equal(true);
  });

  it("early renewal extends from the current expiry, lapsed renewal from now", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE });
    const firstExpiry = Number(await f.sub.paidUntil(f.alice.address));
    await time.increase(10 * 86400); // renew early
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(firstExpiry + MONTH);

    await time.increase(3 * MONTH); // let it lapse
    expect(await f.sub.isActive(f.alice.address)).to.equal(false);
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal((await time.latest()) + MONTH);
  });

  it("is giftable: anyone can pay for anyone", async () => {
    const f = await loadFixture(fixture);
    await expect(f.sub.connect(f.bob).subscribe(f.alice.address, { value: PRICE }))
      .to.emit(f.sub, "Subscribed");
    expect(await f.sub.isActive(f.alice.address)).to.equal(true);
    expect(await f.sub.isActive(f.bob.address)).to.equal(false);
  });

  it("rejects zero account, zero value, sub-second dust, and >10y prepay", async () => {
    const f = await loadFixture(fixture);
    await expect(f.sub.subscribe(ethers.ZeroAddress, { value: PRICE }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAddress");
    await expect(f.sub.subscribe(f.alice.address, { value: 0 }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
    // With price 0.001 ETH / 30d, one second costs ~385 gwei; 100 wei is sub-second dust.
    await expect(f.sub.subscribe(f.alice.address, { value: 100n }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
    await expect(f.sub.subscribe(f.alice.address, { value: PRICE * 130n }))
      .to.be.revertedWithCustomError(f.sub, "TooFarAhead");
  });

  it("price changes touch only future purchases and already-bought time survives", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE });
    const boughtUntil = await f.sub.paidUntil(f.alice.address);
    await f.sub.connect(f.admin).setPrice(PRICE * 10n);
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(boughtUntil); // untouched
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE });
    // At 10x price the same payment buys a tenth of the time.
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(Number(boughtUntil) + MONTH / 10);
    await expect(f.sub.connect(f.alice).setPrice(1))
      .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
    await expect(f.sub.connect(f.admin).setPrice(0))
      .to.be.revertedWithCustomError(f.sub, "PriceIsZero");
  });

  it("admin withdraws revenue; nobody else; renounce disabled", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, { value: PRICE * 3n });
    await expect(f.sub.connect(f.alice).withdraw(f.alice.address))
      .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
    await expect(f.sub.connect(f.admin).withdraw(f.admin.address))
      .to.changeEtherBalance(f.admin, PRICE * 3n);
    await expect(f.sub.connect(f.admin).withdraw(f.admin.address))
      .to.be.revertedWithCustomError(f.sub, "NothingToWithdraw");
    await expect(f.sub.connect(f.admin).renounceOwnership())
      .to.be.revertedWithCustomError(f.sub, "RenounceDisabled");
  });
});
