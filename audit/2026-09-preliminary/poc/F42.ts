// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F42/test/poc-F42.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * F42 PoC: _pull (InheritanceVault.sol:345-356) credits the depositor with EVERY change in the
 * vault's token balance between its two balanceOf reads, not just the depositor's own transfer.
 *
 * Every test below asserts the SAFE / INTENDED property (the depositor is credited with what
 * their own transfer delivered; any pool-wide gain or third-party payment stays in surplus;
 * a deposit that cannot be measured reverts with the named error). Against the current code
 * they fail because of the defect. The one test tagged [context] passes before and after a fix.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50;
const T = (n: number | string) => ethers.parseEther(String(n));

async function baseFixture() {
  const [admin, alice, bob, carol, dave, feeSink, mallory, erin] = await ethers.getSigners();
  // Evidence-suite port: pinned to v1 (the sandbox's F42_VAULT fix-sketch switch is not carried over).
  const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
  const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
  const vaultAddr = await vault.getAddress();
  return { vault, vaultAddr, admin, alice, bob, carol, dave, feeSink, mallory, erin };
}

async function horizon() {
  return (await time.latest()) + 730 * DAY;
}

describe("F42 _pull measurement window credits pool-wide balance changes to the depositor", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  // ------------------------------------------------------------------ positive direction

  /**
   * +25% per epoch, rebase runs inside the first transfer after the boundary.
   * Alice locks 1000; Bob locks 1000 then withdraws 200 to Dave (unwithdrawn credit);
   * 100 T is force-fed. Vault holds 2100 = locked 1800 + credited 200 + surplus 100.
   */
  async function positiveRebaseFixture() {
    const f = await baseFixture();
    const Tok = await ethers.getContractFactory("F42_RebaseOnTransferToken", f.admin);
    const token = await Tok.deploy();
    const tokenAddr = await token.getAddress();
    await token.configureRebase(DAY, 5, 4);
    for (const s of [f.alice, f.bob]) {
      await token.mint(s.address, T(1000));
      await token.connect(s).approve(f.vaultAddr, ethers.MaxUint256);
    }
    await token.mint(f.mallory.address, T(8));
    await token.connect(f.mallory).approve(f.vaultAddr, ethers.MaxUint256);
    await token.mint(f.admin.address, T(100));

    const h = await horizon();
    await f.vault.connect(f.alice).createVault(tokenAddr, T(1000), f.carol.address, PERIOD, WINDOW, h);
    await f.vault.connect(f.bob).createVault(tokenAddr, T(1000), f.carol.address, PERIOD, WINDOW, h);
    await f.vault.connect(f.bob).withdraw(0, T(200), f.dave.address); // Dave: 200 credited, unwithdrawn
    await token.transfer(f.vaultAddr, T(100)); // force-fed -> surplus

    expect(await token.balanceOf(f.vaultAddr)).to.equal(T(2100));
    expect(await f.vault.totalLocked(tokenAddr)).to.equal(T(1800));
    expect(await f.vault.totalCredited(tokenAddr)).to.equal(T(200));
    expect(await f.vault.surplus(tokenAddr)).to.equal(T(100));
    return { ...f, token, tokenAddr };
  }

  it("auto-rebase: a 4 T createVault that triggers a +25% rebase is credited 4 T, and the pool's 525 T gain stays in surplus", async () => {
    const f = await loadFixture(positiveRebaseFixture);
    await time.increase(DAY); // epoch boundary passed; Mallory's deposit is the first transfer

    const tx = f.vault
      .connect(f.mallory)
      .createVault(f.tokenAddr, T(4), f.erin.address, PERIOD, WINDOW, await horizon());
    await expect(tx).to.emit(f.token, "Rebased"); // the deposit itself triggered the rebase

    const recorded = (await f.vault.getVault(f.mallory.address, 0)).balance;
    const sur = await f.vault.surplus(f.tokenAddr);
    console.log(
      `      Mallory sent 4 T; vault recorded ${ethers.formatEther(recorded)} T; ` +
        `surplus ${ethers.formatEther(sur)} T (design: 100 + 2100*25% = 625 T)`
    );

    // INTENDED: the depositor is credited with at most what she sent; the rebase on the
    // pre-existing 2100 T (locked + credited + surplus) accrues to surplus, as the NatSpec at
    // InheritanceVault.sol:60-62 promises for positive rebases.
    expect(recorded, "depositor credited with more than she sent").to.equal(T(4));
    expect(sur, "pool-wide rebase gain did not reach surplus").to.equal(T(625));
  });

  it("auto-rebase via topUp WHILE CREATION IS PAUSED: Mallory's round trip (8 T in) must return 8 T, not 534 T", async () => {
    const f = await loadFixture(positiveRebaseFixture);
    // Mallory opens a dust vault before the admin pauses creation.
    await f.vault
      .connect(f.mallory)
      .createVault(f.tokenAddr, T(4), f.erin.address, PERIOD, WINDOW, await horizon());
    await f.vault.connect(f.admin).setCreationPaused(true);
    await expect(
      f.vault.connect(f.mallory).createVault(f.tokenAddr, T(4), f.erin.address, PERIOD, WINDOW, await horizon())
    ).to.be.revertedWithCustomError(f.vault, "CreationIsPaused");

    await time.increase(DAY);
    // Vault holds 2104 T before; topUp is not pause-gated (InheritanceVault.sol:441-454).
    await expect(f.vault.connect(f.mallory).topUp(f.mallory.address, 0, T(4))).to.emit(f.token, "Rebased");

    const bal = (await f.vault.getVault(f.mallory.address, 0)).balance;
    const before = await f.token.balanceOf(f.mallory.address);
    await f.vault.connect(f.mallory).withdraw(0, bal, f.mallory.address);
    await f.vault.connect(f.mallory).withdrawCredit(f.tokenAddr, f.mallory.address);
    const cashedOut = (await f.token.balanceOf(f.mallory.address)) - before;
    const sur = await f.vault.surplus(f.tokenAddr);
    console.log(
      `      Mallory deposited 8 T nominal (4 + 4), cashed out ${ethers.formatEther(cashedOut)} T; ` +
        `admin-sweepable surplus left: ${ethers.formatEther(sur)} T (design: 100 + 2104*25% = 626 T)`
    );
    console.log(
      `      Alice/Bob/Dave nominal: ${ethers.formatEther((await f.vault.getVault(f.alice.address, 0)).balance)} / ` +
        `${ethers.formatEther((await f.vault.getVault(f.bob.address, 0)).balance)} / ` +
        `${ethers.formatEther(await f.vault.creditOf(f.tokenAddr, f.dave.address))} T (intact)`
    );

    expect(cashedOut, "depositor extracted the pool-wide rebase gain").to.equal(T(8));
    expect(sur, "pool-wide rebase gain did not reach surplus").to.equal(T(626));
  });

  it("settle-on-touch reward: a 1-wei deposit is credited 1 wei; the vault's 300 T pending reward stays in surplus", async () => {
    const f = await loadFixture(baseFixture);
    const Tok = await ethers.getContractFactory("F42_SettleOnTouchRewardToken", f.admin);
    const token = await Tok.deploy();
    const tokenAddr = await token.getAddress();
    await token.mint(f.alice.address, T(1000));
    await token.connect(f.alice).approve(f.vaultAddr, ethers.MaxUint256);
    await f.vault.connect(f.alice).createVault(tokenAddr, T(1000), f.carol.address, PERIOD, WINDOW, await horizon());

    await token.accrueReward(f.vaultAddr, T(300)); // reward accrues to the vault address, unsettled
    expect(await f.vault.surplus(tokenAddr)).to.equal(0n); // surplus() cannot see pending rewards

    await token.mint(f.mallory.address, 1n);
    await token.connect(f.mallory).approve(f.vaultAddr, ethers.MaxUint256);
    await f.vault.connect(f.mallory).createVault(tokenAddr, 1n, f.erin.address, PERIOD, WINDOW, await horizon());
    const recorded = (await f.vault.getVault(f.mallory.address, 0)).balance;

    await f.vault.connect(f.mallory).withdraw(0, recorded, f.mallory.address);
    await f.vault.connect(f.mallory).withdrawCredit(tokenAddr, f.mallory.address);
    const got = await token.balanceOf(f.mallory.address);
    const sur = await f.vault.surplus(tokenAddr);
    console.log(`      Mallory sent 1 wei; recorded ${recorded} wei; cashed out ${got} wei; surplus ${sur} wei`);

    expect(got, "depositor took the vault's settled reward").to.equal(1n);
    expect(sur, "settled reward did not reach surplus").to.equal(T(300));
  });

  it("sender-hook (ERC777-style) token: a 1-wei deposit is credited 1 wei; a third-party payment the hook triggers stays in surplus", async () => {
    const f = await loadFixture(baseFixture);
    const Tok = await ethers.getContractFactory("F42_SenderHookToken", f.admin);
    const token = await Tok.deploy();
    const tokenAddr = await token.getAddress();
    const Dist = await ethers.getContractFactory("F42_Distributor", f.admin);
    const dist = await Dist.deploy(tokenAddr);
    await token.mint(await dist.getAddress(), T(300));
    await dist.setOwed(f.vaultAddr, T(300)); // e.g. an airdrop owed to the vault address

    await token.mint(f.alice.address, T(1000));
    await token.connect(f.alice).approve(f.vaultAddr, ethers.MaxUint256);
    await f.vault.connect(f.alice).createVault(tokenAddr, T(1000), f.carol.address, PERIOD, WINDOW, await horizon());

    const Claimer = await ethers.getContractFactory("F42_HookClaimer", f.mallory);
    const claimer = await Claimer.deploy(f.vaultAddr, tokenAddr, await dist.getAddress());
    const claimerAddr = await claimer.getAddress();
    await token.mint(claimerAddr, 1n);

    await claimer.connect(f.mallory).depositOneWei(f.erin.address, PERIOD, WINDOW, await horizon());
    const recorded = (await f.vault.getVault(claimerAddr, 0)).balance;
    await claimer.connect(f.mallory).withdrawTo(0, recorded, f.mallory.address);
    await f.vault.connect(f.mallory).withdrawCredit(tokenAddr, f.mallory.address);
    const got = await token.balanceOf(f.mallory.address);
    const sur = await f.vault.surplus(tokenAddr);
    console.log(`      Mallory sent 1 wei; recorded ${recorded} wei; cashed out ${got} wei; surplus ${sur} wei`);

    expect(got, "depositor took a third-party payment to the vault address").to.equal(1n);
    expect(sur, "third-party payment did not reach surplus").to.equal(T(300));
  });

  // ------------------------------------------------------------------ negative direction

  /** -20% per epoch. Alice and Bob lock 1000 each; Carol is an honest depositor holding 1000. */
  async function negativeRebaseFixture() {
    const f = await baseFixture();
    const Tok = await ethers.getContractFactory("F42_RebaseOnTransferToken", f.admin);
    const token = await Tok.deploy();
    const tokenAddr = await token.getAddress();
    await token.configureRebase(DAY, 4, 5);
    for (const s of [f.alice, f.bob, f.carol]) {
      await token.mint(s.address, T(1000));
      await token.connect(s).approve(f.vaultAddr, ethers.MaxUint256);
    }
    await token.mint(f.admin.address, T(1));
    const h = await horizon();
    await f.vault.connect(f.alice).createVault(tokenAddr, T(1000), f.dave.address, PERIOD, WINDOW, h);
    await f.vault.connect(f.bob).createVault(tokenAddr, T(1000), f.dave.address, PERIOD, WINDOW, h);
    expect(await token.balanceOf(f.vaultAddr)).to.equal(T(2000));
    return { ...f, token, tokenAddr };
  }

  it("negative rebase: an unmeasurable deposit reverts with NothingReceived, not an arithmetic panic", async () => {
    const f = await loadFixture(negativeRebaseFixture);
    await time.increase(DAY);
    const h = await horizon();
    // 400 exactly offsets the 400 T pool loss: after == before -> NothingReceived (named error).
    await expect(
      f.vault.connect(f.carol).createVault(f.tokenAddr, T(400), f.erin.address, PERIOD, WINDOW, h)
    ).to.be.revertedWithCustomError(f.vault, "NothingReceived");
    // 100 < 400: after < before. INTENDED: the same named error; ACTUAL: Panic(0x11) at :353.
    await expect(
      f.vault.connect(f.carol).createVault(f.tokenAddr, T(100), f.erin.address, PERIOD, WINDOW, h)
    ).to.be.revertedWithCustomError(f.vault, "NothingReceived");
  });

  it("negative rebase: Carol's honest 500 T deposit must be recorded as 500 T (or refused), not 100 T while Alice and Bob exit whole", async () => {
    const f = await loadFixture(negativeRebaseFixture);
    await time.increase(DAY);
    await expect(
      f.vault.connect(f.carol).createVault(f.tokenAddr, T(500), f.erin.address, PERIOD, WINDOW, await horizon())
    )
      .to.emit(f.token, "Rebased")
      .and.to.emit(f.token, "Transfer")
      .withArgs(f.carol.address, f.vaultAddr, T(500)); // the token delivered 500 T from Carol
    const recorded = (await f.vault.getVault(f.carol.address, 0)).balance;

    // Everyone exits. Measure what each walks away with.
    const out: Record<string, bigint> = {};
    for (const [name, s] of [["alice", f.alice], ["bob", f.bob], ["carol", f.carol]] as const) {
      const bal = (await f.vault.getVault(s.address, 0)).balance;
      const b0 = await f.token.balanceOf(s.address);
      await f.vault.connect(s).withdraw(0, bal, s.address);
      await f.vault.connect(s).withdrawCredit(f.tokenAddr, s.address);
      out[name] = (await f.token.balanceOf(s.address)) - b0;
    }
    console.log(
      `      Carol sent 500 T, recorded ${ethers.formatEther(recorded)} T. Exits: ` +
        `Alice ${ethers.formatEther(out.alice)}, Bob ${ethers.formatEther(out.bob)}, Carol ${ethers.formatEther(out.carol)} T; ` +
        `vault left with ${ethers.formatEther(await f.token.balanceOf(f.vaultAddr))} T. ` +
        `A passive 1000 T holder now has 800 T; Carol alone paid the pool's 400 T loss.`
    );

    expect(recorded, "honest depositor silently charged with the pool's negative rebase").to.equal(T(500));
  });

  it("[context] the negative-rebase lock-out is transient: a 1-wei self-transfer by anyone triggers the rebase and ends it", async () => {
    const f = await loadFixture(negativeRebaseFixture);
    await time.increase(DAY);
    const h = await horizon();
    await expect(f.vault.connect(f.carol).createVault(f.tokenAddr, T(100), f.erin.address, PERIOD, WINDOW, h)).to.be
      .reverted; // the revert also undoes the rebase
    await expect(f.token.connect(f.admin).transfer(f.admin.address, 1n)).to.emit(f.token, "Rebased");
    await f.vault.connect(f.carol).createVault(f.tokenAddr, T(100), f.erin.address, PERIOD, WINDOW, h);
    expect((await f.vault.getVault(f.carol.address, 0)).balance).to.equal(T(100));
  });
});
