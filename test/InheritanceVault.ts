import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY; // inactivity period used throughout
const WINDOW = 14 * DAY; // challenge window used throughout
const HORIZON_YEARS = 2 * 365 * DAY;
const NATIVE = ethers.ZeroAddress;
const FEE_BPS = 50; // 0.5% at deployment
const ONE = ethers.parseEther("1");
const DEPOSIT = ethers.parseEther("10");

describe("InheritanceVault", () => {
  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();

    const Vault = await ethers.getContractFactory("InheritanceVault", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);

    const Token = await ethers.getContractFactory("MintableToken", admin);
    const token = await Token.deploy();
    await token.mint(alice.address, ethers.parseEther("1000"));
    await token.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);

    const FeeToken = await ethers.getContractFactory("FeeOnTransferToken", admin);
    const feeToken = await FeeToken.deploy();
    await feeToken.mint(alice.address, ethers.parseEther("1000"));
    await feeToken.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);

    return { vault, token, feeToken, admin, alice, bob, carol, dave, feeSink };
  }

  /** Creates a native vault owned by alice with bob as heir, on default timings. */
  async function createNative(
    f: Awaited<ReturnType<typeof fixture>>,
    amount: bigint = DEPOSIT,
    period = PERIOD,
    window = WINDOW,
    horizonFromNow = HORIZON_YEARS
  ) {
    const horizon = (await time.latest()) + horizonFromNow;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, amount, f.bob.address, period, window, horizon, { value: amount });
    return { vaultId: (await f.vault.vaultCount(f.alice.address)) - 1n, horizon };
  }

  // ------------------------------------------------------------------ creation

  describe("createVault", () => {
    it("creates a native vault and records every field", async () => {
      const f = await loadFixture(fixture);
      const horizon = (await time.latest()) + HORIZON_YEARS;
      await expect(
        f.vault
          .connect(f.alice)
          .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT })
      ).to.emit(f.vault, "VaultCreated");

      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.owner).to.equal(f.alice.address);
      expect(v.state).to.equal(1); // ACTIVE
      expect(v.beneficiary).to.equal(f.bob.address);
      expect(v.token).to.equal(NATIVE);
      expect(v.balance).to.equal(DEPOSIT);
      expect(v.feeBps).to.equal(FEE_BPS);
      expect(v.inactivityPeriod).to.equal(PERIOD);
      expect(v.challengeWindow).to.equal(WINDOW);
      expect(v.absoluteDeadline).to.equal(horizon);
      expect(v.guaranteedInheritanceAt).to.equal(horizon + WINDOW);
      expect(v.deadline).to.equal((await time.latest()) + PERIOD);
      expect(await f.vault.totalLocked(NATIVE)).to.equal(DEPOSIT);
      expect(await f.vault.vaultsCreated()).to.equal(1);
    });

    it("creates an ERC20 vault via transferFrom", async () => {
      const f = await loadFixture(fixture);
      const horizon = (await time.latest()) + HORIZON_YEARS;
      const addr = await f.token.getAddress();
      await f.vault.connect(f.alice).createVault(addr, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.token).to.equal(addr);
      expect(v.balance).to.equal(DEPOSIT);
      expect(await f.token.balanceOf(await f.vault.getAddress())).to.equal(DEPOSIT);
      expect(await f.vault.totalLocked(addr)).to.equal(DEPOSIT);
    });

    it("records what actually arrived for fee-on-transfer tokens", async () => {
      const f = await loadFixture(fixture);
      const horizon = (await time.latest()) + HORIZON_YEARS;
      const addr = await f.feeToken.getAddress();
      const sent = ethers.parseEther("100");
      const received = sent - sent / 100n; // token burns 1%
      await f.vault.connect(f.alice).createVault(addr, sent, f.bob.address, PERIOD, WINDOW, horizon);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.balance).to.equal(received);
      expect(await f.vault.totalLocked(addr)).to.equal(received);
    });

    it("snapshots the claim fee at creation", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await f.vault.connect(f.admin).setClaimFee(100);
      await createNative(f);
      expect((await f.vault.getVault(f.alice.address, 0)).feeBps).to.equal(50);
      expect((await f.vault.getVault(f.alice.address, 1)).feeBps).to.equal(100);
    });

    it("caps the deadline at the horizon", async () => {
      const f = await loadFixture(fixture);
      // Horizon only one day past the first deadline: clock must clamp to it after a check-in.
      const horizon = (await time.latest()) + PERIOD + DAY;
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      await time.increase(2 * DAY);
      await f.vault.connect(f.alice).checkIn(0);
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(horizon);
    });

    it("rejects bad parameters", async () => {
      const f = await loadFixture(fixture);
      const now = await time.latest();
      const horizon = now + HORIZON_YEARS;
      const c = (args: {
        token?: string; amount?: bigint; ben?: string; period?: number; window?: number; hor?: number; value?: bigint;
      }) =>
        f.vault
          .connect(f.alice)
          .createVault(
            args.token ?? NATIVE,
            args.amount ?? DEPOSIT,
            args.ben ?? f.bob.address,
            args.period ?? PERIOD,
            args.window ?? WINDOW,
            args.hor ?? horizon,
            { value: args.value ?? args.amount ?? DEPOSIT }
          );

      await expect(c({ amount: 0n, value: 0n })).to.be.revertedWithCustomError(f.vault, "ZeroAmount");
      await expect(c({ ben: ethers.ZeroAddress })).to.be.revertedWithCustomError(f.vault, "ZeroAddress");
      await expect(c({ ben: await f.vault.getAddress() })).to.be.revertedWithCustomError(f.vault, "ZeroAddress");
      await expect(c({ ben: f.alice.address })).to.be.revertedWithCustomError(f.vault, "BeneficiaryIsOwner");
      await expect(c({ period: 7 * DAY - 1 })).to.be.revertedWithCustomError(f.vault, "InvalidPeriod");
      await expect(c({ period: 3650 * DAY + 1 })).to.be.revertedWithCustomError(f.vault, "InvalidPeriod");
      await expect(c({ window: 7 * DAY - 1 })).to.be.revertedWithCustomError(f.vault, "InvalidChallengeWindow");
      await expect(c({ window: 365 * DAY + 1 })).to.be.revertedWithCustomError(f.vault, "InvalidChallengeWindow");
      await expect(c({ hor: now + PERIOD - DAY })).to.be.revertedWithCustomError(f.vault, "HorizonTooSoon");
      await expect(c({ hor: now + 36500 * DAY + DAY })).to.be.revertedWithCustomError(f.vault, "HorizonTooFar");
      await expect(c({ value: DEPOSIT - 1n })).to.be.revertedWithCustomError(f.vault, "NativeAmountMismatch");
      await expect(
        c({ token: await f.token.getAddress(), value: 1n })
      ).to.be.revertedWithCustomError(f.vault, "UnexpectedNativeValue");
    });

    it("enforces the open-vault cap", async () => {
      const f = await loadFixture(fixture);
      for (let i = 0; i < 32; i++) await createNative(f, ONE);
      const horizon = (await time.latest()) + HORIZON_YEARS;
      await expect(
        f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, horizon, { value: ONE })
      ).to.be.revertedWithCustomError(f.vault, "TooManyOpenVaults");
    });

    it("respects the creation pause, and only creation", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await f.vault.connect(f.admin).setCreationPaused(true);
      const horizon = (await time.latest()) + HORIZON_YEARS;
      await expect(
        f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, horizon, { value: ONE })
      ).to.be.revertedWithCustomError(f.vault, "CreationIsPaused");
      // The exits stay open while creation is paused.
      await f.vault.connect(f.alice).checkIn(0);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address);
    });
  });

  // ------------------------------------------------------------------ topUp

  describe("topUp", () => {
    it("adds balance permissionlessly without resetting the clock", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      const before = (await f.vault.getVault(f.alice.address, 0)).deadline;
      await time.increase(10 * DAY);
      await f.vault.connect(f.dave).topUp(f.alice.address, 0, ONE, { value: ONE });
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.balance).to.equal(DEPOSIT + ONE);
      expect(v.deadline).to.equal(before); // a stranger's wei is not a liveness proof
    });

    it("is refused mid-claim and on terminal vaults", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(
        f.vault.connect(f.dave).topUp(f.alice.address, 0, ONE, { value: ONE })
      ).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
    });

    it("rejects zero and mismatched value", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await expect(
        f.vault.connect(f.dave).topUp(f.alice.address, 0, 0, { value: 0 })
      ).to.be.revertedWithCustomError(f.vault, "ZeroAmount");
      await expect(
        f.vault.connect(f.dave).topUp(f.alice.address, 0, ONE, { value: ONE - 1n })
      ).to.be.revertedWithCustomError(f.vault, "NativeAmountMismatch");
    });
  });

  // ------------------------------------------------------------------ liveness

  describe("checkIn", () => {
    it("resets the clock, owner only", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(20 * DAY);
      await f.vault.connect(f.alice).checkIn(0);
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal((await time.latest()) + PERIOD);
      // Keyed by msg.sender: someone else simply has no vault 0.
      await expect(f.vault.connect(f.bob).checkIn(0)).to.be.revertedWithCustomError(f.vault, "NoSuchVault");
    });

    it("works after expiry but before a claim, and refuses during a claim", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(PERIOD + DAY);
      await f.vault.connect(f.alice).checkIn(0); // late but unclaimed: still alive
      await time.increase(PERIOD + DAY);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(
        f.vault,
        "ClaimPendingUseAbort"
      );
    });

    it("reverts at the horizon instead of lying with a no-op", async () => {
      const f = await loadFixture(fixture);
      const { horizon } = await createNative(f, DEPOSIT, PERIOD, WINDOW, PERIOD + DAY);
      await time.increaseTo(horizon);
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    });

    it("checkInMany refreshes a split estate in one transaction", async () => {
      const f = await loadFixture(fixture);
      await createNative(f, ONE);
      await createNative(f, ONE);
      await time.increase(10 * DAY);
      await f.vault.connect(f.alice).checkInMany([0, 1]);
      const t = await time.latest();
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(t + PERIOD);
      expect((await f.vault.getVault(f.alice.address, 1)).deadline).to.equal(t + PERIOD);
      await expect(
        f.vault.connect(f.alice).checkInMany(new Array(33).fill(0))
      ).to.be.revertedWithCustomError(f.vault, "BatchTooLarge");
    });
  });

  describe("check-in hash chain", () => {
    /** anchor = H(p1), p1 = H(p2): a 2-use S/KEY chain whose secrets are consumed newest-first. */
    function makeChain() {
      const p2 = ethers.hexlify(ethers.randomBytes(32));
      const p1 = ethers.keccak256(p2);
      const anchor = ethers.keccak256(p1);
      return { anchor, p1, p2 };
    }

    it("validates installation", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      const { anchor } = makeChain();
      await expect(
        f.vault.connect(f.alice).setCheckInChain(0, ethers.ZeroHash, 2)
      ).to.be.revertedWithCustomError(f.vault, "InvalidCheckInChain");
      await expect(f.vault.connect(f.alice).setCheckInChain(0, anchor, 0)).to.be.revertedWithCustomError(
        f.vault,
        "InvalidCheckInChain"
      );
      await expect(
        f.vault.connect(f.alice).setCheckInChain(0, anchor, 100_001)
      ).to.be.revertedWithCustomError(f.vault, "InvalidCheckInChain");
      await expect(f.vault.connect(f.bob).setCheckInChain(0, anchor, 2)).to.be.revertedWithCustomError(
        f.vault,
        "NoSuchVault"
      );
      await f.vault.connect(f.alice).setCheckInChain(0, anchor, 2);
    });

    it("accepts preimages newest-first from anyone, refuses replay and garbage, then exhausts", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      const { anchor, p1, p2 } = makeChain();
      await f.vault.connect(f.alice).setCheckInChain(0, anchor, 2);

      await time.increase(10 * DAY);
      await expect(f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, p2)).to.be.revertedWithCustomError(
        f.vault,
        "BadCheckIn" // p2 is one step too deep while the anchor is still H(p1)
      );
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, p1); // relayable
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal((await time.latest()) + PERIOD);

      await expect(f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, p1)).to.be.revertedWithCustomError(
        f.vault,
        "CheckInAlreadyUsed"
      );
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, p2);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, ethers.hexlify(ethers.randomBytes(32)))
      ).to.be.revertedWithCustomError(f.vault, "CheckInChainExhausted");
      expect(await f.vault.warningsOf(f.alice.address, 0)).to.equal(1 << 3);
    });
  });

  // ------------------------------------------------------------------ owner actions

  describe("withdraw", () => {
    it("credits a partial withdrawal, resets the clock, charges no fee", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(10 * DAY);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.balance).to.equal(DEPOSIT - ONE);
      expect(v.deadline).to.equal((await time.latest()) + PERIOD);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(ONE); // the full amount
      expect(await f.vault.totalLocked(NATIVE)).to.equal(DEPOSIT - ONE);
      expect(await f.vault.totalCredited(NATIVE)).to.equal(ONE);
    });

    it("closes on full withdrawal and removes the vault from the open set", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await expect(f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address))
        .to.emit(f.vault, "Withdrawn")
        .withArgs(f.alice.address, 0, f.alice.address, DEPOSIT, true);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(4); // CLOSED
      expect(await f.vault.openVaultIds(f.alice.address)).to.deep.equal([]);
      expect(await f.vault.vaultsClosed()).to.equal(1);
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
    });

    it("validates caller, amount and target", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await expect(f.vault.connect(f.bob).withdraw(0, ONE, f.bob.address)).to.be.revertedWithCustomError(
        f.vault,
        "NoSuchVault"
      );
      await expect(f.vault.connect(f.alice).withdraw(0, 0, f.alice.address)).to.be.revertedWithCustomError(
        f.vault,
        "ZeroAmount"
      );
      await expect(
        f.vault.connect(f.alice).withdraw(0, DEPOSIT + 1n, f.alice.address)
      ).to.be.revertedWithCustomError(f.vault, "InsufficientBalance");
      await expect(
        f.vault.connect(f.alice).withdraw(0, ONE, await f.vault.getAddress())
      ).to.be.revertedWithCustomError(f.vault, "CannotPayToSelf");
    });

    it("supersedes a pending claim: the owner acting is the liveness proof", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 0, 1); // ACT_WITHDRAW
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state).to.equal(1); // back to ACTIVE
      expect(v.claimRecipient).to.equal(ethers.ZeroAddress);
    });
  });

  describe("setBeneficiary / setInactivityPeriod / extendHorizon", () => {
    it("changes the heir and clears any pending claim", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address))
        .to.emit(f.vault, "BeneficiaryChanged")
        .withArgs(f.alice.address, 0, f.carol.address, f.bob.address);
      // The displaced heir has no authority left; the new one does once the clock re-expires.
      await time.increase(PERIOD + 1);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary");
      await f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address);
    });

    it("validates the new heir", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await expect(
        f.vault.connect(f.alice).setBeneficiary(0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f.vault, "ZeroAddress");
      await expect(f.vault.connect(f.alice).setBeneficiary(0, f.alice.address)).to.be.revertedWithCustomError(
        f.vault,
        "BeneficiaryIsOwner"
      );
    });

    it("adjusts the inactivity period within bounds and resets the clock", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await f.vault.connect(f.alice).setInactivityPeriod(0, 60 * DAY);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.inactivityPeriod).to.equal(60 * DAY);
      expect(v.deadline).to.equal((await time.latest()) + 60 * DAY);
      await expect(
        f.vault.connect(f.alice).setInactivityPeriod(0, 7 * DAY - 1)
      ).to.be.revertedWithCustomError(f.vault, "InvalidPeriod");
    });

    it("extends the horizon, even after it has passed -- a live owner outranks the hard date", async () => {
      const f = await loadFixture(fixture);
      const { horizon } = await createNative(f, DEPOSIT, PERIOD, WINDOW, PERIOD + DAY);
      await time.increaseTo(horizon + DAY);
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      const newHorizon = (await time.latest()) + HORIZON_YEARS;
      await f.vault.connect(f.alice).extendHorizon(0, newHorizon);
      await f.vault.connect(f.alice).checkIn(0); // alive again
      await expect(f.vault.connect(f.alice).extendHorizon(0, newHorizon)).to.be.revertedWithCustomError(
        f.vault,
        "HorizonNotExtended"
      );
      await expect(
        f.vault.connect(f.alice).extendHorizon(0, (await time.latest()) + 36500 * DAY + DAY)
      ).to.be.revertedWithCustomError(f.vault, "HorizonTooFar");
    });
  });

  // ------------------------------------------------------------------ claiming

  describe("claims", () => {
    it("only the beneficiary, only after expiry, on an active vault", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NotYetExpired");
      await time.increase(PERIOD + 1);
      await expect(
        f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address)
      ).to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary");
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f.vault, "ZeroAddress");
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.carol.address); // heir's choice of payout address
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state).to.equal(2); // CLAIM_PENDING
      expect(v.claimRecipient).to.equal(f.carol.address);
      expect(v.finalizableAt).to.equal((await time.latest()) + WINDOW);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
    });

    it("abort is the owner's veto and rate-limits the next claim by a full period", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.alice).abortClaim(0);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state).to.equal(1);
      expect(v.deadline).to.equal((await time.latest()) + PERIOD);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NotYetExpired");
      await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(
        f.vault,
        "NoClaimPending"
      );
    });

    it("finalize waits out the challenge window, then anyone may settle", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.carol.address);
      await expect(f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0)).to.be.revertedWithCustomError(
        f.vault,
        "ChallengeWindowOpen"
      );
      await time.increase(WINDOW + 1);
      const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
      await expect(f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.carol.address, DEPOSIT - fee, fee);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state).to.equal(3); // SETTLED
      expect(v.balance).to.equal(0);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(DEPOSIT - fee);
      expect(await f.vault.creditOf(NATIVE, f.feeSink.address)).to.equal(fee);
      expect(await f.vault.totalLocked(NATIVE)).to.equal(0);
      expect(await f.vault.totalCredited(NATIVE)).to.equal(DEPOSIT);
      expect(await f.vault.vaultsSettled()).to.equal(1);
      expect(await f.vault.openVaultIds(f.alice.address)).to.deep.equal([]);
    });

    it("applies the lower of snapshot and current fee, and no fee without a recipient", async () => {
      const f = await loadFixture(fixture);
      await createNative(f); // snapshot 50 bps
      await createNative(f); // snapshot 50 bps
      await f.vault.connect(f.admin).setClaimFee(25); // lower now: 25 wins over snapshot 50

      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      const fee = (DEPOSIT * 25n) / 10_000n;
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);

      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await time.increase(WINDOW + 1);
      await expect(f.vault.finalizeClaim(f.alice.address, 1))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 1, f.bob.address, DEPOSIT, 0);
    });

    it("settles an ERC20 inheritance end to end", async () => {
      const f = await loadFixture(fixture);
      const addr = await f.token.getAddress();
      const horizon = (await time.latest()) + HORIZON_YEARS;
      await f.vault.connect(f.alice).createVault(addr, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
      await expect(f.vault.connect(f.bob).withdrawCredit(addr, f.bob.address)).to.changeTokenBalances(
        f.token,
        [f.bob, await f.vault.getAddress()],
        [DEPOSIT - fee, -(DEPOSIT - fee)]
      );
    });
  });

  // ------------------------------------------------------------------ credit lane

  describe("credit lane", () => {
    it("pays native credits out and refuses empty pulls", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(f.vault.connect(f.carol).withdrawCredit(NATIVE, f.carol.address)).to.changeEtherBalances(
        [f.carol, await f.vault.getAddress()],
        [ONE, -ONE]
      );
      await expect(
        f.vault.connect(f.carol).withdrawCredit(NATIVE, f.carol.address)
      ).to.be.revertedWithCustomError(f.vault, "NothingCredited");
      expect(await f.vault.totalCredited(NATIVE)).to.equal(0);
    });

    it("pushCredit pays an account that cannot originate transactions", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, f.carol.address)).to.changeEtherBalance(
        f.carol,
        ONE
      );
    });

    it("a reverting payout target leaves the credit intact", async () => {
      const f = await loadFixture(fixture);
      const rejecter = await (await ethers.getContractFactory("RevertingReceiver", f.admin)).deploy();
      await createNative(f);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(
        f.vault.connect(f.carol).withdrawCredit(NATIVE, await rejecter.getAddress())
      ).to.be.revertedWithCustomError(f.vault, "NativeTransferFailed");
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(ONE);
    });
  });

  // ------------------------------------------------------------------ admin & accounting

  describe("admin and accounting boundaries", () => {
    it("bounds the fee and gates the admin functions", async () => {
      const f = await loadFixture(fixture);
      await expect(f.vault.connect(f.admin).setClaimFee(101)).to.be.revertedWithCustomError(
        f.vault,
        "FeeTooHigh"
      );
      await expect(f.vault.connect(f.alice).setClaimFee(10)).to.be.revertedWithCustomError(
        f.vault,
        "OwnableUnauthorizedAccount"
      );
      await expect(f.vault.connect(f.admin).renounceOwnership()).to.be.revertedWithCustomError(
        f.vault,
        "RenounceDisabled"
      );
    });

    it("refuses plain native transfers", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.alice.sendTransaction({ to: await f.vault.getAddress(), value: ONE })
      ).to.be.revertedWithCustomError(f.vault, "UseTopUp");
    });

    it("sweeps only force-fed surplus, never locked or credited value", async () => {
      const f = await loadFixture(fixture);
      const addr = await f.token.getAddress();
      const horizon = (await time.latest()) + HORIZON_YEARS;
      await f.vault.connect(f.alice).createVault(addr, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
      await expect(f.vault.connect(f.admin).sweepSurplus(addr, f.admin.address)).to.be.revertedWithCustomError(
        f.vault,
        "NoSurplus"
      );
      await f.token.connect(f.alice).transfer(await f.vault.getAddress(), ONE); // force-fed
      expect(await f.vault.surplus(addr)).to.equal(ONE);
      await expect(f.vault.connect(f.alice).sweepSurplus(addr, f.alice.address)).to.be.revertedWithCustomError(
        f.vault,
        "OwnableUnauthorizedAccount"
      );
      await expect(f.vault.connect(f.admin).sweepSurplus(addr, f.admin.address)).to.changeTokenBalance(
        f.token,
        f.admin,
        ONE
      );
      // The vault's locked lane is untouched.
      expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(DEPOSIT);
      expect(await f.vault.totalLocked(addr)).to.equal(DEPOSIT);
    });
  });

  // ------------------------------------------------------------------ views

  describe("views", () => {
    it("computes warning bits on chain", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);
      expect(await f.vault.warningsOf(f.alice.address, 0)).to.equal(0);
      await time.increase(PERIOD + 1);
      expect(await f.vault.warningsOf(f.alice.address, 0)).to.equal(1); // expired
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      expect(await f.vault.warningsOf(f.alice.address, 0)).to.equal(1 | (1 << 2)); // expired + pending
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      expect(await f.vault.warningsOf(f.alice.address, 0)).to.equal(1 << 7); // terminal
    });

    it("getOpenVaults reports only live vaults and getVault rejects ghosts", async () => {
      const f = await loadFixture(fixture);
      await createNative(f, ONE);
      await createNative(f, ONE);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address); // closes vault 0
      const open = await f.vault.getOpenVaults(f.alice.address);
      expect(open.length).to.equal(1);
      expect(open[0].vaultId).to.equal(1);
      await expect(f.vault.getVault(f.alice.address, 2)).to.be.revertedWithCustomError(f.vault, "NoSuchVault");
    });
  });

  // ------------------------------------------------------------------ the story

  describe("end to end", () => {
    it("the product story: years of check-ins, then the owner goes silent and the heir inherits", async () => {
      const f = await loadFixture(fixture);
      await createNative(f);

      // Years of routine life: the owner checks in every few weeks.
      for (let i = 0; i < 5; i++) {
        await time.increase(20 * DAY);
        await f.vault.connect(f.alice).checkIn(0);
      }

      // The owner goes silent. The heir must wait out the full inactivity period...
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      // ...and the challenge window, during which a living owner could still veto.
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0); // any keeper can settle

      const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
      await expect(f.vault.connect(f.bob).withdrawCredit(NATIVE, f.bob.address)).to.changeEtherBalance(
        f.bob,
        DEPOSIT - fee
      );
      // Fee revenue is a credit like any other: the business pulls it the same way heirs do.
      await expect(f.vault.connect(f.feeSink).withdrawCredit(NATIVE, f.feeSink.address)).to.changeEtherBalance(
        f.feeSink,
        fee
      );
    });
  });
});
