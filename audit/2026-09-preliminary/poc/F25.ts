// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F25/test/poc-F25.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F25 (informational): integrator-facing views.
 *
 *  (1) The fee that will actually be charged -- min(lockedFeeBps, claimFeeBps), or 0 when
 *      feeRecipient == 0 -- is not observable. lockedFeeBps is private (no getter), is not in
 *      VaultView, and is not emitted in ClaimInitiated. getVault only returns the creation-time
 *      ceiling `feeBps`, which the app labels "fee".
 *  (2) getVault computes expired / guaranteedInheritanceAt from stale fields for SETTLED and
 *      CLOSED vaults, so a terminal vault reports expired == true.
 *
 * Every `it` below asserts the INTENDED property and therefore fails against b8baf34. The
 * ground truth each assertion is compared against (the rate actually stored at slot 4 of the
 * Vault struct, the fee actually taken at settlement, the terminal state/warnings) is read
 * independently first, so a failure is the missing/stale view field and nothing else.
 */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const CEILING_BPS = 50; // 0.5% -- the fee advertised on the site, snapshotted at creation
const PROMO_BPS = 20; // 0.2% -- a later global cut, in force when the heir initiates

const STATE_SETTLED = 3n;
const STATE_CLOSED = 4n;
const TERMINAL_BIT = 128n;

describe("F25 views hide the effective fee and report stale timing for terminal vaults", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, CEILING_BPS, feeSink.address);
    const horizon = (await time.latest()) + 730 * DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, dave, feeSink, horizon };
  }

  /** Reads Vault.lockedFeeBps straight from storage, using the compiler's storage layout. */
  async function rawLockedFeeBps(vault: any, owner: string, vaultId: number): Promise<bigint> {
    const fqn = "contracts/v1/InheritanceVaultV1.sol:InheritanceVaultV1";
    const bi = await hre.artifacts.getBuildInfo(fqn);
    const layout = (bi!.output.contracts["contracts/v1/InheritanceVaultV1.sol"].InheritanceVaultV1 as any)
      .storageLayout;
    const vaultsVar = layout.storage.find((s: any) => s.label === "_vaults");
    // mapping(address => mapping(uint256 => Vault)) -> find the Vault struct type
    const outerType = layout.types[vaultsVar.type];
    const innerType = layout.types[outerType.value];
    const structType = layout.types[innerType.value];
    const member = structType.members.find((m: any) => m.label === "lockedFeeBps");

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const inner = ethers.keccak256(coder.encode(["address", "uint256"], [owner, BigInt(vaultsVar.slot)]));
    const base = BigInt(ethers.keccak256(coder.encode(["uint256", "bytes32"], [vaultId, inner])));
    const word = BigInt(
      await ethers.provider.getStorage(await vault.getAddress(), base + BigInt(member.slot))
    );
    return (word >> BigInt(member.offset * 8)) & 0xffffn;
  }

  // ------------------------------------------------------------------ (1) the hidden fee

  it("getVault exposes the fee locked at initiateClaim (ceiling 0.5%, locked 0.2%)", async () => {
    const f = await loadFixture(fixture);
    await f.vault.connect(f.admin).setClaimFee(PROMO_BPS);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // Ground truth: the contract really did lock 20 bps.
    expect(await rawLockedFeeBps(f.vault, f.alice.address, 0)).to.equal(BigInt(PROMO_BPS));
    // And there is no public getter for it either.
    expect(f.vault.interface.getFunction("lockedFeeBps")).to.equal(null);

    const v = (await f.vault.getVault(f.alice.address, 0)).toObject();
    // The only fee number the view offers is the ceiling, which the app prints as "fee 0.5%".
    expect(v.feeBps).to.equal(BigInt(CEILING_BPS));

    // INTENDED: the heir can read the rate that is locked for this claim.
    const visible = v.lockedFeeBps ?? v.effectiveFeeBps;
    expect(visible, "VaultView has no lockedFeeBps/effectiveFeeBps field").to.not.be.undefined;
    expect(visible).to.equal(BigInt(PROMO_BPS));
  });

  it("ClaimInitiated carries the locked fee rate", async () => {
    const f = await loadFixture(fixture);
    await f.vault.connect(f.admin).setClaimFee(PROMO_BPS);
    await time.increase(PERIOD + 1);
    const tx = await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const rc = await tx.wait();
    const log = rc!.logs
      .map((l: any) => {
        try {
          return f.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "ClaimInitiated");
    expect(log, "ClaimInitiated not emitted").to.not.equal(undefined);

    expect(await rawLockedFeeBps(f.vault, f.alice.address, 0)).to.equal(BigInt(PROMO_BPS));

    // INTENDED: an indexer learns the locked rate from the event that locks it.
    const args = log!.args.toObject();
    const emitted = args.lockedFeeBps ?? args.effectiveFeeBps ?? args.feeBps;
    expect(emitted, `ClaimInitiated has no fee field (args: ${Object.keys(args).join(", ")})`).to.not.be
      .undefined;
    expect(emitted).to.equal(BigInt(PROMO_BPS));
  });

  it("with no fee recipient the view reports an effective fee of 0, not the 0.5% ceiling", async () => {
    const f = await loadFixture(fixture);
    await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress); // "charge nothing"

    const v = (await f.vault.getVault(f.alice.address, 0)).toObject();
    expect(v.feeBps).to.equal(BigInt(CEILING_BPS)); // what the app shows as "fee 0.5%"

    // Ground truth: settle and observe that 0 is charged.
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
    await expect(f.vault.finalizeClaim(f.alice.address, 0))
      .to.emit(f.vault, "ClaimSettled")
      .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);

    // INTENDED: the view that preceded settlement quoted the fee that settlement charged.
    expect(v.effectiveFeeBps, "VaultView has no effectiveFeeBps field").to.not.be.undefined;
    expect(v.effectiveFeeBps).to.equal(0n);
  });

  it("measures the gap between the view's fee and the fee actually taken", async () => {
    const f = await loadFixture(fixture);
    await f.vault.connect(f.admin).setClaimFee(PROMO_BPS);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    // The best fee figure the view offers: the effective/locked rate if a future version
    // exposes one, otherwise the ceiling (which is what site/assets/app.js:286 prints as "fee").
    const view = (await f.vault.getVault(f.alice.address, 0)).toObject();
    const shown: bigint = view.effectiveFeeBps ?? view.lockedFeeBps ?? view.feeBps;
    await time.increase(WINDOW + 1);
    const rc = await (await f.vault.finalizeClaim(f.alice.address, 0)).wait();
    const settled = rc!.logs
      .map((l: any) => {
        try {
          return f.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "ClaimSettled")!;
    const actualFee: bigint = settled.args.fee;
    const displayedFee = (DEPOSIT * BigInt(shown)) / 10_000n;
    console.log(
      `      fee quoted by getVault=${shown} bps -> displayed fee ${ethers.formatEther(displayedFee)} ETH; ` +
        `actual fee ${ethers.formatEther(actualFee)} ETH; overstated by ` +
        `${ethers.formatEther(displayedFee - actualFee)} ETH on a 10 ETH vault`
    );
    // INTENDED: the fee the view quotes during the challenge window is the fee settlement takes.
    expect(displayedFee, "view overstates the fee the heir actually pays").to.equal(actualFee);
  });

  // ------------------------------------------------------------------ (2) stale timing fields

  it("a CLOSED vault does not report expired / a guaranteed inheritance date", async () => {
    const f = await loadFixture(fixture);
    // Full withdraw: _resetClock runs, then the vault closes.
    await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
    await time.increase(PERIOD + 1); // pass the (reset) deadline

    const v = await f.vault.getVault(f.alice.address, 0);
    // Ground truth: terminal, and nobody can claim.
    expect(v.state).to.equal(STATE_CLOSED);
    expect(v.warnings).to.equal(TERMINAL_BIT);
    await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
      .to.be.revertedWithCustomError(f.vault, "VaultNotActive")
      .withArgs(0, STATE_CLOSED);

    // INTENDED: timing fields are zeroed for terminal vaults.
    expect(v.expired, "closed vault reports expired == true").to.equal(false);
    expect(v.guaranteedInheritanceAt, "closed vault reports a guaranteed inheritance date").to.equal(0n);
  });

  it("a SETTLED vault does not report expired / a guaranteed inheritance date", async () => {
    const f = await loadFixture(fixture);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
    await f.vault.finalizeClaim(f.alice.address, 0);

    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(STATE_SETTLED);
    expect(v.warnings).to.equal(TERMINAL_BIT);
    await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
      .to.be.revertedWithCustomError(f.vault, "VaultNotActive")
      .withArgs(0, STATE_SETTLED);

    expect(v.expired, "settled vault reports expired == true").to.equal(false);
    expect(v.guaranteedInheritanceAt, "settled vault reports a guaranteed inheritance date").to.equal(0n);
  });
});
