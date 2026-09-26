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
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE * 2n });
    const t = await time.latest();
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(t + 2 * MONTH);
    expect(await f.sub.isActive(f.alice.address)).to.equal(true);
  });

  it("early renewal extends from the current expiry, lapsed renewal from now", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    const firstExpiry = Number(await f.sub.paidUntil(f.alice.address));
    await time.increase(10 * 86400); // renew early
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(firstExpiry + MONTH);

    await time.increase(3 * MONTH); // let it lapse
    expect(await f.sub.isActive(f.alice.address)).to.equal(false);
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal((await time.latest()) + MONTH);
  });

  it("is giftable: anyone can pay for anyone", async () => {
    const f = await loadFixture(fixture);
    await expect(f.sub.connect(f.bob).subscribe(f.alice.address, 0, { value: PRICE }))
      .to.emit(f.sub, "Subscribed");
    expect(await f.sub.isActive(f.alice.address)).to.equal(true);
    expect(await f.sub.isActive(f.bob.address)).to.equal(false);
  });

  it("rejects zero account, zero value, sub-second dust, and >10y prepay", async () => {
    const f = await loadFixture(fixture);
    await expect(f.sub.subscribe(ethers.ZeroAddress, 0, { value: PRICE }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAddress");
    await expect(f.sub.subscribe(f.alice.address, 0, { value: 0 }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
    // With price 0.001 ETH / 30d, one second costs ~0.386 gwei (385,802,470 wei at the least);
    // 100 wei is sub-second dust. (F38 of the 2026-09 audit: this comment said ~385 gwei.)
    await expect(f.sub.subscribe(f.alice.address, 0, { value: 100n }))
      .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
    await expect(f.sub.subscribe(f.alice.address, 0, { value: PRICE * 130n }))
      .to.be.revertedWithCustomError(f.sub, "TooFarAhead");
  });

  it("price changes touch only future purchases and already-bought time survives", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    const boughtUntil = await f.sub.paidUntil(f.alice.address);
    await f.sub.connect(f.admin).setPrice(PRICE * 10n);
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(boughtUntil); // untouched
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
    // At 10x price the same payment buys a tenth of the time.
    expect(await f.sub.paidUntil(f.alice.address)).to.equal(Number(boughtUntil) + MONTH / 10);
    await expect(f.sub.connect(f.alice).setPrice(1))
      .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
    await expect(f.sub.connect(f.admin).setPrice(0))
      .to.be.revertedWithCustomError(f.sub, "PriceIsZero");
  });

  it("the slippage floor stops a price change from silently short-changing a payer", async () => {
    const f = await loadFixture(fixture);
    const MONTH_SECS = BigInt(MONTH);
    // Alice quotes 12 months at the current price and pays with a floor just under it.
    const value = PRICE * 12n;
    const quoted = (value * MONTH_SECS) / PRICE;
    await f.sub.connect(f.admin).setPrice(PRICE * 10n); // repriced before her tx lands
    await expect(
      f.sub.connect(f.alice).subscribe(f.alice.address, (quoted * 99n) / 100n, { value })
    ).to.be.revertedWithCustomError(f.sub, "PriceMoved");
    // Without a floor the same payment silently buys a tenth of the time.
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value });
    expect(await f.sub.paidUntil(f.alice.address)).to.equal((await time.latest()) + MONTH * 12 / 10);
  });

  it("admin withdraws revenue; nobody else; renounce disabled", async () => {
    const f = await loadFixture(fixture);
    await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE * 3n });
    await expect(f.sub.connect(f.alice).withdraw(f.alice.address))
      .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
    await expect(f.sub.connect(f.admin).withdraw(f.admin.address))
      .to.changeEtherBalance(f.admin, PRICE * 3n);
    await expect(f.sub.connect(f.admin).withdraw(f.admin.address))
      .to.be.revertedWithCustomError(f.sub, "NothingToWithdraw");
    await expect(f.sub.connect(f.admin).renounceOwnership())
      .to.be.revertedWithCustomError(f.sub, "RenounceDisabled");
  });

  // Exact boundaries (F38 of the 2026-09 audit, review round 1). The tests above sit far from
  // every boundary, so an off-by-one (`target > cap` read as `>=`) or a rounding change in
  // `added` would pass them. The contract is retired (F35), but it is live and still accepts
  // payments, so its behaviour stays pinned.
  describe("boundaries", () => {
    const MONTH_N = BigInt(MONTH);
    const TEN_YEARS = 3650n * 86400n;
    /** The least msg.value that buys `secs` seconds: ceil(secs * PRICE / MONTH). */
    const costOf = (secs: bigint) => (secs * PRICE + MONTH_N - 1n) / MONTH_N;

    it("one second costs 385,802,470 wei: a wei less is dust and reverts, exactly that buys one second", async () => {
      const f = await loadFixture(fixture);
      expect(costOf(1n)).to.equal(385_802_470n);
      await expect(f.sub.subscribe(f.alice.address, 0, { value: 385_802_469n }))
        .to.be.revertedWithCustomError(f.sub, "ZeroAmount");
      await f.sub.subscribe(f.alice.address, 0, { value: 385_802_470n });
      expect(await f.sub.paidUntil(f.alice.address)).to.equal((await time.latest()) + 1);
    });

    it("a purchase landing exactly on now + MAX_PREPAID succeeds; one second more reverts TooFarAhead", async () => {
      const f = await loadFixture(fixture);
      expect(await f.sub.MAX_PREPAID()).to.equal(TEN_YEARS);
      await expect(f.sub.subscribe(f.bob.address, 0, { value: costOf(TEN_YEARS + 1n) }))
        .to.be.revertedWithCustomError(f.sub, "TooFarAhead");
      await f.sub.subscribe(f.alice.address, 0, { value: costOf(TEN_YEARS) });
      expect(await f.sub.paidUntil(f.alice.address)).to.equal(BigInt(await time.latest()) + TEN_YEARS);
    });

    it("minSecondsAdded equal to what the payment buys succeeds; one more reverts PriceMoved with both numbers", async () => {
      const f = await loadFixture(fixture);
      const value = PRICE; // exactly one month
      await expect(f.sub.subscribe(f.alice.address, MONTH_N + 1n, { value }))
        .to.be.revertedWithCustomError(f.sub, "PriceMoved")
        .withArgs(MONTH_N, MONTH_N + 1n);
      await f.sub.subscribe(f.alice.address, MONTH_N, { value });
      expect(await f.sub.paidUntil(f.alice.address)).to.equal((await time.latest()) + MONTH);
    });

    it("withdraw refuses address(0), and a non-payable recipient reverts NativeTransferFailed with the revenue kept", async () => {
      const f = await loadFixture(fixture);
      await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
      await expect(f.sub.connect(f.admin).withdraw(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(f.sub, "ZeroAddress");
      const sink = await (await ethers.getContractFactory("RevertingReceiver", f.admin)).deploy();
      const sinkAddr = await sink.getAddress();
      await expect(f.sub.connect(f.admin).withdraw(sinkAddr))
        .to.be.revertedWithCustomError(f.sub, "NativeTransferFailed")
        .withArgs(sinkAddr, PRICE);
      expect(await ethers.provider.getBalance(await f.sub.getAddress())).to.equal(PRICE);
    });

    it("a plain transfer is refused: the only way to pay is subscribe()", async () => {
      const f = await loadFixture(fixture);
      await expect(f.alice.sendTransaction({ to: await f.sub.getAddress(), value: PRICE })).to.be.reverted;
      expect(await ethers.provider.getBalance(await f.sub.getAddress())).to.equal(0);
    });

    it("the Ownable2Step handover: nothing changes until the new admin accepts; then only they can act", async () => {
      const f = await loadFixture(fixture);
      await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: PRICE });
      await f.sub.connect(f.admin).transferOwnership(f.bob.address);
      expect(await f.sub.owner()).to.equal(f.admin.address);
      expect(await f.sub.pendingOwner()).to.equal(f.bob.address);
      await expect(f.sub.connect(f.alice).acceptOwnership())
        .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount")
        .withArgs(f.alice.address);
      await f.sub.connect(f.admin).setPrice(PRICE * 2n); // the old admin still rules until then
      await f.sub.connect(f.bob).acceptOwnership();
      expect(await f.sub.owner()).to.equal(f.bob.address);
      expect(await f.sub.pendingOwner()).to.equal(ethers.ZeroAddress);
      await expect(f.sub.connect(f.admin).setPrice(1))
        .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount")
        .withArgs(f.admin.address);
      await expect(f.sub.connect(f.admin).withdraw(f.admin.address))
        .to.be.revertedWithCustomError(f.sub, "OwnableUnauthorizedAccount");
      await expect(f.sub.connect(f.bob).withdraw(f.bob.address)).to.changeEtherBalance(f.bob, PRICE);
    });
  });
});

