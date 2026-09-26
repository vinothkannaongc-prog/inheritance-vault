// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F33/test/poc-F33.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F33 -- read-only reentrancy: the public views answer while the contract-wide lock is
 * held, so a caller reached from a token callback during a deposit (or payout) reads a
 * half-applied state. surplus() -- the figure that defines what the admin may sweep -- then
 * labels a user's in-flight deposit as admin-sweepable surplus.
 *
 * The regression tests assert the SAFE property: while a deposit/payout is in flight, surplus()
 * must either refuse to answer (nonReentrantView) or report the true surplus (0 here). They fail
 * against the current code because surplus() answers with the phantom value.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50;
const DEPOSIT = ethers.parseEther("1000");
const TOPUP = ethers.parseEther("50");
const VAULT_NAME = "InheritanceVaultV1"; // evidence-suite port: pinned to v1 (the F33_VAULT fix-sketch switch is not carried over)

describe("F33 read-only reentrancy: views during an in-flight deposit", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory(VAULT_NAME, admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const vaultAddr = await vault.getAddress();

    const token = await (await ethers.getContractFactory("F33_HookToken", admin)).deploy();
    const observer = await (await ethers.getContractFactory("F33_ViewObserver", admin)).deploy();
    const tokenAddr = await token.getAddress();
    const obsAddr = await observer.getAddress();

    for (const s of [alice, dave]) {
      await token.mint(s.address, ethers.parseEther("10000"));
      await token.connect(s).approve(vaultAddr, ethers.MaxUint256);
    }
    return { vault, vaultAddr, token, tokenAddr, observer, obsAddr, admin, alice, bob, carol, dave, feeSink };
  }

  async function createAliceVault(f: any, amount = DEPOSIT) {
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(f.tokenAddr, amount, f.bob.address, PERIOD, WINDOW, horizon);
  }

  it("surplus() does not report an in-flight createVault deposit as admin-sweepable surplus", async () => {
    const f = await loadFixture(fixture);
    // Hook fires after balances update on the transfer into the vault.
    await f.token.setup(f.vaultAddr, f.obsAddr, 1);
    await f.observer.arm(f.vaultAddr, f.tokenAddr, f.alice.address, 0, false, false);

    await createAliceVault(f);

    expect(await f.observer.fired()).to.equal(true, "hook did not run -- setup error, not the defect");
    // Ground truth after the transaction: the whole deposit is locked, nothing is surplus.
    expect(await f.vault.surplus(f.tokenAddr)).to.equal(0n);
    expect(await f.vault.totalLocked(f.tokenAddr)).to.equal(DEPOSIT);

    const ok: boolean = await f.observer.surplusOk();
    const seen: bigint = await f.observer.seenSurplus();
    console.log(
      `      [createVault in flight] surplus() answered=${ok} value=${ethers.formatEther(seen)} ` +
        `totalLocked=${ethers.formatEther(await f.observer.seenLocked())} ` +
        `tokenBalance(vault)=${ethers.formatEther(await f.observer.seenTokenBalance())}`
    );
    // SAFE: either refused while the lock is held, or truthful (0).
    expect(
      !ok || seen === 0n,
      `surplus() answered mid-deposit with ${ethers.formatEther(seen)} (the whole in-flight deposit)`
    ).to.equal(true);
  });

  it("surplus()/getVault() do not answer a half-applied state during an in-flight topUp", async () => {
    const f = await loadFixture(fixture);
    await createAliceVault(f, ethers.parseEther("100")); // observer not wired yet: clean deposit
    await f.token.setup(f.vaultAddr, f.obsAddr, 1);
    await f.observer.arm(f.vaultAddr, f.tokenAddr, f.alice.address, 0, true, false);

    // A third party (dave) tops up Alice's vault; the hook reads the views mid-deposit.
    await f.vault.connect(f.dave).topUp(f.alice.address, 0, TOPUP);

    expect(await f.observer.fired()).to.equal(true, "hook did not run -- setup error, not the defect");
    expect(await f.vault.surplus(f.tokenAddr)).to.equal(0n);
    expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(ethers.parseEther("150"));

    const sOk: boolean = await f.observer.surplusOk();
    const sSeen: bigint = await f.observer.seenSurplus();
    const gOk: boolean = await f.observer.getVaultOk();
    let gBal: bigint | undefined;
    if (gOk) {
      gBal = f.vault.interface.decodeFunctionResult("getVault", await f.observer.getVaultRet())[0].balance;
    }
    console.log(
      `      [topUp in flight] surplus() answered=${sOk} value=${ethers.formatEther(sSeen)}; ` +
        `getVault() answered=${gOk} balance=${gBal === undefined ? "-" : ethers.formatEther(gBal)}; ` +
        `tokenBalance(vault)=${ethers.formatEther(await f.observer.seenTokenBalance())}`
    );
    expect(
      !sOk || sSeen === 0n,
      `surplus() answered mid-topUp with ${ethers.formatEther(sSeen)} (dave's in-flight top-up)`
    ).to.equal(true);
  });

  it("surplus() does not report a phantom while a credit payout is in flight (pre-transfer hook)", async () => {
    const f = await loadFixture(fixture);
    await createAliceVault(f); // clean
    await f.vault.connect(f.alice).withdraw(0, ethers.parseEther("400"), f.carol.address); // credit carol
    await f.token.setup(f.vaultAddr, f.obsAddr, 2); // hook BEFORE balances move, on outbound
    await f.observer.arm(f.vaultAddr, f.tokenAddr, f.alice.address, 0, false, false);

    await f.vault.connect(f.carol).withdrawCredit(f.tokenAddr, f.carol.address);

    expect(await f.observer.fired()).to.equal(true, "hook did not run -- setup error, not the defect");
    expect(await f.vault.surplus(f.tokenAddr)).to.equal(0n);

    const ok: boolean = await f.observer.surplusOk();
    const seen: bigint = await f.observer.seenSurplus();
    console.log(
      `      [withdrawCredit in flight] surplus() answered=${ok} value=${ethers.formatEther(seen)} ` +
        `totalCredited=${ethers.formatEther(await f.observer.seenCredited())}`
    );
    expect(
      !ok || seen === 0n,
      `surplus() answered mid-payout with ${ethers.formatEther(seen)} (carol's in-flight payout)`
    ).to.equal(true);
  });

  // ------------------------------------------------------------- impact bounding (passes today)

  it("bounding: the phantom surplus cannot be swept, even by an admin reached from the hook", async () => {
    const [deployer, alice, bob, , , feeSink] = await ethers.getSigners();
    const observer = await (await ethers.getContractFactory("F33_ViewObserver", deployer)).deploy();
    const obsAddr = await observer.getAddress();
    // Worst case for the bound: the admin itself is the contract the hook calls.
    const vault = await (await ethers.getContractFactory(VAULT_NAME, deployer)).deploy(
      obsAddr,
      FEE_BPS,
      feeSink.address
    );
    const vaultAddr = await vault.getAddress();
    const token = await (await ethers.getContractFactory("F33_HookToken", deployer)).deploy();
    const tokenAddr = await token.getAddress();
    await token.mint(alice.address, DEPOSIT);
    await token.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await token.setup(vaultAddr, obsAddr, 1);
    await observer.arm(vaultAddr, tokenAddr, alice.address, 0, false, true);

    const horizon = (await time.latest()) + 730 * DAY;
    await vault.connect(alice).createVault(tokenAddr, DEPOSIT, bob.address, PERIOD, WINDOW, horizon);

    expect(await observer.sweepAttempted()).to.equal(true);
    expect(await observer.sweepOk()).to.equal(false); // nonReentrant on sweepSurplus holds
    const err = vault.interface.parseError(await observer.sweepRet());
    expect(err?.name).to.equal("ReentrancyGuardReentrantCall");
    expect(await token.balanceOf(obsAddr)).to.equal(0n);
    expect(await token.balanceOf(vaultAddr)).to.equal(DEPOSIT);
    expect((await vault.getVault(alice.address, 0)).balance).to.equal(DEPOSIT);
    expect(await vault.surplus(tokenAddr)).to.equal(0n);
  });
});
