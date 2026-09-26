// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F07/test/poc-F07.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F07 — "Your rate is locked when you create the vault. It can go down if we lower fees
 * later; it can never go up." (site/index.html) is not what the contract does.
 *
 * Only a CEILING is fixed at creation (v.feeBps). The effective rate is
 * min(v.feeBps, claimFeeBps at initiateClaim, claimFeeBps at finalizeClaim), so a vault whose
 * rate fell during a fee cut goes straight back up to the ceiling when the admin restores the
 * global rate. Nothing ratchets a vault down to the lowest rate it has been offered.
 *
 * These tests assert the property the site promises, so they FAIL against the current code.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50; // 0.5%, the advertised launch rate

describe("PoC F07: a fee cut the vault has seen can be reversed back up to the creation ceiling", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, feeSink };
  }

  async function nativeVault(f: any) {
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
  }

  /** Settle vault 0 from the current state (owner silent from here) and return the fee taken. */
  async function settleAndReadFee(f: any): Promise<bigint> {
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
    const tx = await f.vault.finalizeClaim(f.alice.address, 0);
    const rc = await tx.wait();
    const ev = rc!.logs
      .map((l: any) => {
        try {
          return f.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "ClaimSettled");
    expect(ev, "ClaimSettled must be emitted").to.not.equal(undefined);
    return ev!.args.fee as bigint;
  }

  /** What the heir would pay if the owner went silent right now; state is rolled back after. */
  async function probeFeeNow(f: any): Promise<bigint> {
    const snap = await takeSnapshot();
    const fee = await settleAndReadFee(f);
    await snap.restore();
    return fee;
  }

  it("an heir never pays more than the lowest rate the vault was lowered to", async () => {
    const f = await loadFixture(fixture);

    // 1. Alice creates a vault while the global rate is 0.5%; the ceiling snapshot is 50 bps.
    await nativeVault(f);
    expect((await f.vault.getVault(f.alice.address, 0)).feeBps).to.equal(FEE_BPS);

    // 2. The admin cuts the fee to 0% ("fee-free inheritance").
    await f.vault.connect(f.admin).setClaimFee(0);

    // 3. The promotion runs for two months. Alice is alive and actively checks in during it,
    //    so even a fix that ratchets the vault's rate at owner interactions would capture 0 bps.
    await time.increase(25 * DAY);
    await f.vault.connect(f.alice).checkIn(0);
    await time.increase(25 * DAY);
    await f.vault.connect(f.alice).checkIn(0);

    // 4. The promotion ends: the admin restores 0.5%. No claim is in flight.
    await f.vault.connect(f.admin).setClaimFee(FEE_BPS);

    // 5. Alice dies; Bob claims and settles.
    const fee = await settleAndReadFee(f);

    // SAFE PROPERTY (site/index.html:133-134): the rate "can go down ... it can never go up".
    // The vault's rate went down to 0 bps in step 2; it must not come back up to 50 bps.
    expect(fee, "fee taken after the vault's rate had been lowered to 0 bps").to.equal(0n);
  });

  it("quantifies it: the vault's effective rate is not monotone non-increasing", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);

    // Rate at creation (probe: owner goes silent now and Bob claims).
    const atCreation = await probeFeeNow(f);

    // Rate during the promotion: the cut really does reach this vault (control).
    await f.vault.connect(f.admin).setClaimFee(0);
    await time.increase(20 * DAY);
    await f.vault.connect(f.alice).checkIn(0);
    const duringPromo = await probeFeeNow(f);

    // Rate after the admin restores the global fee.
    await f.vault.connect(f.admin).setClaimFee(FEE_BPS);
    const afterRestore = await probeFeeNow(f);

    const ceilingFee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
    console.log(
      `      fee on a ${ethers.formatEther(DEPOSIT)} ETH vault: at creation ${ethers.formatEther(atCreation)}` +
        `, during the cut ${ethers.formatEther(duringPromo)}, after restore ${ethers.formatEther(afterRestore)} ETH`
    );

    // Controls: these hold today and show the rate genuinely went down for this vault.
    expect(atCreation).to.equal(ceilingFee);
    expect(duringPromo).to.equal(0n);

    // SAFE PROPERTY: once the vault's rate has gone down it can never go back up.
    expect(afterRestore, "the vault's rate went back up after it had gone down").to.be.lte(duringPromo);
  });
});
