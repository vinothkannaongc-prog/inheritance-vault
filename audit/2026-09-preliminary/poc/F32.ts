// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F32/test/poc-F32.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F32 -- setCreationPaused is not an emergency stop: topUp keeps adding new value to a
 * paused contract.
 *
 * The intended (safe) property asserted here: once the admin has paused the contract for an
 * incident, no NEW value can enter it -- neither through createVault nor through topUp -- while
 * every exit (checkIn, withdraw, initiateClaim, finalizeClaim, withdrawCredit) stays open.
 *
 * Against the current code the first two tests FAIL because topUp has no pause check
 * (InheritanceVault.sol:441-454; only createVault checks creationPaused at :378). The third test
 * is a guard that must keep passing after any fix: a deposit pause must never gate an exit.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

describe("PoC F32 creation pause does not stop new value entering", () => {
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

    const Tok = await ethers.getContractFactory("MintableToken", admin);
    const token = await Tok.deploy();
    const tokenAddr = await token.getAddress();
    await token.mint(alice.address, ethers.parseEther("100"));
    await token.mint(dave.address, ethers.parseEther("100"));
    await token.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await token.connect(dave).approve(vaultAddr, ethers.MaxUint256);

    // Alice (owner) opens a native vault #0 and an ERC20 vault #1 for Bob (heir) BEFORE the incident.
    const horizon = (await time.latest()) + 730 * DAY;
    await vault.connect(alice).createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    await vault.connect(alice).createVault(tokenAddr, DEPOSIT, bob.address, PERIOD, WINDOW, horizon);

    // Incident: a defect is confirmed; the admin pauses, planning a new deployment + migration.
    await vault.connect(admin).setCreationPaused(true);
    expect(await vault.creationPaused()).to.equal(true);

    return { vault, vaultAddr, token, tokenAddr, admin, alice, bob, carol, dave, feeSink, horizon };
  }

  it("while paused, a third party's topUp is refused (native and ERC20)", async () => {
    const f = await loadFixture(fixture);

    // Control: the pause is live and does refuse creation.
    await expect(
      f.vault
        .connect(f.dave)
        .createVault(NATIVE, DEPOSIT, f.carol.address, PERIOD, WINDOW, f.horizon, { value: DEPOSIT })
    ).to.be.revertedWithCustomError(f.vault, "CreationIsPaused");

    // Safe property: Dave (an arbitrary third party) cannot add new value to the paused contract.
    await expect(
      f.vault.connect(f.dave).topUp(f.alice.address, 0, DEPOSIT, { value: DEPOSIT }),
      "native topUp by a stranger succeeded on a paused contract"
    ).to.be.reverted;
    await expect(
      f.vault.connect(f.dave).topUp(f.alice.address, 1, DEPOSIT),
      "ERC20 topUp by a stranger succeeded on a paused contract"
    ).to.be.reverted;
  });

  it("quantified: value accepted by the paused contract should be zero", async () => {
    const f = await loadFixture(fixture);
    const lockedNativeBefore = await f.vault.totalLocked(NATIVE);
    const lockedTokenBefore = await f.vault.totalLocked(f.tokenAddr);
    const vaultEthBefore = await ethers.provider.getBalance(f.vaultAddr);
    const vaultTokBefore = await f.token.balanceOf(f.vaultAddr);

    // After the notice: the owner (who has not seen it) and a helpful third party both top up.
    // Failures are swallowed so the measurement below is what decides the test.
    const attempts = [
      () => f.vault.connect(f.alice).topUp(f.alice.address, 0, DEPOSIT, { value: DEPOSIT }),
      () => f.vault.connect(f.dave).topUp(f.alice.address, 0, DEPOSIT, { value: DEPOSIT }),
      () => f.vault.connect(f.alice).topUp(f.alice.address, 1, DEPOSIT),
      () => f.vault.connect(f.dave).topUp(f.alice.address, 1, DEPOSIT),
    ];
    for (const a of attempts) {
      try {
        await (await a()).wait();
      } catch {
        /* refused: the intended behaviour */
      }
    }

    const nativeIn = (await f.vault.totalLocked(NATIVE)) - lockedNativeBefore;
    const tokenIn = (await f.vault.totalLocked(f.tokenAddr)) - lockedTokenBefore;
    const ethHeld = (await ethers.provider.getBalance(f.vaultAddr)) - vaultEthBefore;
    const tokHeld = (await f.token.balanceOf(f.vaultAddr)) - vaultTokBefore;
    console.log(
      `      value entered during pause: native ${ethers.formatEther(nativeIn)} (held ${ethers.formatEther(ethHeld)}),` +
        ` token ${ethers.formatEther(tokenIn)} (held ${ethers.formatEther(tokHeld)})`
    );

    expect(nativeIn, "native value locked into the paused contract").to.equal(0n);
    expect(tokenIn, "ERC20 value locked into the paused contract").to.equal(0n);
  });

  it("guard: every exit stays open while paused (must keep passing after a fix)", async () => {
    const f = await loadFixture(fixture);

    // Owner liveness and withdrawal on the native vault.
    await f.vault.connect(f.alice).checkIn(0);
    await f.vault.connect(f.alice).withdraw(0, ethers.parseEther("1"), f.alice.address);

    // Owner goes silent: the heir claims the ERC20 vault, anyone finalizes, heir withdraws credit.
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
    await time.increase(WINDOW + 1);
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 1);

    const credit = await f.vault.creditOf(f.tokenAddr, f.bob.address);
    const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
    expect(credit).to.equal(DEPOSIT - fee);
    const before = await f.token.balanceOf(f.bob.address);
    await f.vault.connect(f.bob).withdrawCredit(f.tokenAddr, f.bob.address);
    expect((await f.token.balanceOf(f.bob.address)) - before).to.equal(DEPOSIT - fee);
    expect(await f.vault.creationPaused()).to.equal(true);
  });
});
