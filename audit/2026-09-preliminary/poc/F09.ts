// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F09/test/poc-F09.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F09: a credit owed to a wrap-on-receive contract (WETH9 / WBNB) becomes vault-owned
 * wrapped token after a permissionless pushCredit, lands in surplus(), and the admin sweeps it.
 *
 * Every test asserts the SAFE property -- value credited to a user (heir or owner) can never
 * reach the admin -- so it FAILS against the current contract. The scenario steps are run
 * tolerantly (a fixed contract may refuse the WETH address as a destination, refuse the push,
 * or refuse a non-native sweep); the only hard assertion is that the admin gains nothing.
 *
 * F09_WETH9Like is a faithful port of canonical WETH9 and its runtime code is placed at Base's real
 * WETH predeploy address, 0x4200000000000000000000000000000000000006.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50n;
const BASE_WETH = "0x4200000000000000000000000000000000000006";

async function attempt(p: Promise<any>): Promise<boolean> {
  try {
    const tx = await p;
    if (tx && typeof tx.wait === "function") await tx.wait();
    return true;
  } catch {
    return false;
  }
}

describe("PoC F09 wrapped-native payout destination becomes admin-sweepable", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, mallory, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, Number(FEE_BPS), feeSink.address);

    // Put WETH9 bytecode at the Base predeploy address, exactly where an heir would paste it.
    const W = await ethers.getContractFactory("F09_WETH9Like", admin);
    const tmp = await W.deploy();
    const code = await ethers.provider.getCode(await tmp.getAddress());
    await network.provider.send("hardhat_setCode", [BASE_WETH, code]);
    const weth = await ethers.getContractAt("F09_WETH9Like", BASE_WETH);

    const horizon = (await time.latest()) + 730 * DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, weth, admin, alice, bob, mallory, feeSink };
  }

  it("F2: a claim credited to the WETH contract never becomes admin-sweepable", async () => {
    const { vault, weth, admin, alice, bob, mallory } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();
    await time.increase(PERIOD + 1);

    // 1. Bob, wanting to be paid "in WETH", names the WETH contract as his payout address.
    const accepted = await attempt(vault.connect(bob).initiateClaim(alice.address, 0, BASE_WETH));
    if (accepted) {
      // 2. After the window anyone finalizes; the heir's share is credited to the WETH address.
      await time.increase(WINDOW + 1);
      await vault.connect(mallory).finalizeClaim(alice.address, 0);
      const credit = await vault.creditOf(NATIVE, BASE_WETH);
      expect(credit).to.equal(DEPOSIT - (DEPOSIT * FEE_BPS) / 10_000n); // setup sanity
      expect(await vault.surplus(BASE_WETH)).to.equal(0n); // nothing force-fed beforehand

      // 3. Mallory (any third party) pushes the credit. WETH9's fallback mints to the vault.
      await attempt(vault.connect(mallory).pushCredit(NATIVE, BASE_WETH));
      console.log(
        `      credit to WETH=${ethers.formatEther(credit)}  vault WETH balance=${ethers.formatEther(
          await weth.balanceOf(vaultAddr),
        )}  surplus(WETH)=${ethers.formatEther(await vault.surplus(BASE_WETH))}`,
      );
    }

    // 4. The admin sweeps "surplus".
    const before = await weth.balanceOf(admin.address);
    await attempt(vault.connect(admin).sweepSurplus(BASE_WETH, admin.address));
    const gained = (await weth.balanceOf(admin.address)) - before;

    // SAFE PROPERTY (NatSpec :44-46, index.html:116): the admin cannot reach a wei of any
    // credited payout.
    expect(gained, "admin swept WETH that was the heir's credited inheritance").to.equal(0n);
  });

  it("F2b: an owner withdraw to the WETH contract never becomes admin-sweepable", async () => {
    const { vault, weth, admin, alice, mallory } = await loadFixture(fixture);
    const amt = ethers.parseEther("4");

    const accepted = await attempt(vault.connect(alice).withdraw(0, amt, BASE_WETH));
    if (accepted) {
      expect(await vault.creditOf(NATIVE, BASE_WETH)).to.equal(amt); // setup sanity
      await attempt(vault.connect(mallory).pushCredit(NATIVE, BASE_WETH));
    }

    const before = await weth.balanceOf(admin.address);
    await attempt(vault.connect(admin).sweepSurplus(BASE_WETH, admin.address));
    const gained = (await weth.balanceOf(admin.address)) - before;
    expect(gained, "admin swept WETH that was the owner's own withdrawal").to.equal(0n);
  });

  it("F2c (damage): the admin alone, with no accomplice, converts the heir's credit and takes all of it", async () => {
    const { vault, weth, admin, alice, bob, mallory } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();
    await time.increase(PERIOD + 1);

    const accepted = await attempt(vault.connect(bob).initiateClaim(alice.address, 0, BASE_WETH));
    let credit = 0n;
    if (accepted) {
      await time.increase(WINDOW + 1);
      await vault.connect(mallory).finalizeClaim(alice.address, 0);
      credit = await vault.creditOf(NATIVE, BASE_WETH);

      // Control: before the push the value is merely stuck (as NatSpec :67-72 says) and the
      // admin has nothing to sweep.
      await expect(vault.connect(admin).sweepSurplus(BASE_WETH, admin.address)).to.be.revertedWithCustomError(
        vault,
        "NoSurplus",
      );

      // The admin runs the push itself: pushCredit is permissionless.
      await attempt(vault.connect(admin).pushCredit(NATIVE, BASE_WETH));
    }

    const before = await weth.balanceOf(admin.address);
    await attempt(vault.connect(admin).sweepSurplus(BASE_WETH, admin.address));
    const gained = (await weth.balanceOf(admin.address)) - before;

    console.log(
      `      heir credit=${ethers.formatEther(credit)} ETH  admin gained=${ethers.formatEther(gained)} WETH  ` +
        `creditOf(NATIVE,WETH) now=${ethers.formatEther(await vault.creditOf(NATIVE, BASE_WETH))}  ` +
        `totalCredited(NATIVE)=${ethers.formatEther(await vault.totalCredited(NATIVE))}  ` +
        `vault WETH left=${ethers.formatEther(await weth.balanceOf(vaultAddr))}  ` +
        `bob ETH credit=${ethers.formatEther(await vault.creditOf(NATIVE, bob.address))}`,
    );
    expect(gained, `admin took ${ethers.formatEther(gained)} of the heir's ${ethers.formatEther(credit)} credit`).to.equal(
      0n,
    );
  });
});
