// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F16/test/poc-F16.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F16 -- OQ-1 re-evaluated: the heir can permanently kill a keyless owner's S/KEY
 * recovery path whenever a chain check-in lands at or after the inactivity deadline.
 *
 * Actors:
 *   alice  -- vault owner. After setup she has LOST her wallet key: the tests never sign with
 *             her again. She still holds the 32-byte paper seed of her check-in chain.
 *   dave   -- alice's relayer, submitting checkInByChain (permissionless; the preimage is the
 *             authentication).
 *   bob    -- the named heir, running a bot that calls initiateClaim the moment it is legal.
 *   carol  -- an arbitrary third party who finalizes.
 *
 * The first two tests assert the SAFE property (a valid chain check-in submitted before the
 * horizon keeps a keyless owner's vault alive) and FAIL on the current code because of the
 * defect. They are written to pass under either remedy F16 proposes: (a) checkInByChain may
 * supersede a pending claim before the horizon, or (b) initiateClaim on chain-protected vaults
 * waits a grace period past the deadline. The last two tests are CONTROLS that pass today and
 * after a fix: they show that ordering alone decides the race, and that the seed can already
 * hold the heir off until the horizon (the basis for calling the "veto authority" rationale
 * overstated).
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
const CHAIN_LEN = 10;
const GWEI = 1_000_000_000n;
const STATE_ACTIVE = 1n;
const STATE_CLAIM_PENDING = 2n;
const STATE_SETTLED = 3n;

/** An S/KEY chain: links[k] = H^k(seed); anchor = links[n]; preimages are used from n-1 down. */
function makeChain(n: number) {
  const links: string[] = [ethers.hexlify(ethers.randomBytes(32))];
  for (let i = 1; i <= n; i++) links.push(ethers.keccak256(links[i - 1]));
  return { anchor: links[n], preimage: (use: number) => links[n - 1 - use] };
}

describe("F16 -- heir front-runs a keyless owner's chain check-in at the deadline", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);

    const horizon = (await time.latest()) + 730 * DAY; // two years of horizon left
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    const chain = makeChain(CHAIN_LEN);
    await vault.connect(alice).setCheckInChain(0, chain.anchor, CHAIN_LEN);
    // ---- from here on alice's wallet key is LOST; only the seed (chain) remains ----
    const v = await vault.getVault(alice.address, 0);
    return { vault, admin, alice, bob, carol, dave, feeSink, chain, horizon, deadline: Number(v.deadline) };
  }

  /** Mines bob's claim and dave's chain check-in in ONE block at `ts`; mempool orders by tip. */
  async function raceInOneBlock(f: any, ts: number, bobTip: bigint, daveTip: bigint) {
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      // Explicit gasLimit: with automine off, estimateGas would simulate against the pending
      // block and reject whichever transaction is going to lose -- we want both mined.
      const claimTx = await f.vault
        .connect(f.bob)
        .initiateClaim(f.alice.address, 0, f.bob.address, {
          gasLimit: 300_000,
          maxFeePerGas: 500n * GWEI,
          maxPriorityFeePerGas: bobTip,
        });
      const chainTx = await f.vault
        .connect(f.dave)
        .checkInByChain(f.alice.address, 0, f.chain.preimage(0), {
          gasLimit: 300_000,
          maxFeePerGas: 500n * GWEI,
          maxPriorityFeePerGas: daveTip,
        });
      await ethers.provider.send("evm_mine", [ts]);
      const claimRcpt = (await ethers.provider.getTransactionReceipt(claimTx.hash))!;
      const chainRcpt = (await ethers.provider.getTransactionReceipt(chainTx.hash))!;
      return { claimRcpt, chainRcpt, chainTx };
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  }

  async function revertReason(f: any, p: Promise<any>) {
    try {
      await p;
      return "(no revert)";
    } catch (e: any) {
      const data = e?.data ?? e?.error?.data;
      try {
        const parsed = f.vault.interface.parseError(data);
        return `${parsed?.name}(${parsed?.args.join(", ")})`;
      } catch {
        return e?.shortMessage ?? String(e);
      }
    }
  }

  it("a valid chain check-in mined in the SAME block as the heir's claim keeps the vault alive", async () => {
    const f = await loadFixture(fixture);
    // Setup sanity: the preimage is genuinely the next link of the installed chain.
    expect(ethers.keccak256(f.chain.preimage(0))).to.equal(f.chain.anchor);

    // Both transactions sit in the mempool; the block's timestamp is exactly the deadline,
    // which is still ~23 months before the horizon. Bob outbids the relayer on priority fee.
    const { claimRcpt, chainRcpt } = await raceInOneBlock(f, f.deadline, 50n * GWEI, 1n * GWEI);

    // Preconditions of the race (not the defect): one block, at the deadline, before the horizon.
    expect(claimRcpt.blockNumber).to.equal(chainRcpt.blockNumber);
    expect(claimRcpt.index).to.be.lessThan(chainRcpt.index); // bob ordered first
    const blk = (await ethers.provider.getBlock(chainRcpt.blockNumber))!;
    expect(blk.timestamp).to.equal(f.deadline);
    expect(blk.timestamp).to.be.lessThan(f.horizon);

    const v = await f.vault.getVault(f.alice.address, 0);
    const why = await revertReason(
      f,
      f.vault.connect(f.dave).checkInByChain.staticCall(f.alice.address, 0, f.chain.preimage(0))
    );
    console.log(
      `      [F16] claim status=${claimRcpt.status}, chain check-in status=${chainRcpt.status}, ` +
        `vault state=${v.state}, hbLeft=${v.hbLeft}/${CHAIN_LEN}; retrying the same valid preimage -> ${why}`
    );

    // SAFE PROPERTY: the keyless owner's valid check-in, mined before the horizon, is honoured
    // and the vault stays ACTIVE with one link consumed. Current code: the chain transaction
    // reverts VaultNotActive and the vault is CLAIM_PENDING, which only the lost key can undo.
    expect(chainRcpt.status, "chain check-in in the same block as the claim must not revert").to.equal(1);
    expect(v.state, "vault must be ACTIVE after the owner's same-block chain check-in").to.equal(STATE_ACTIVE);
    expect(v.hbLeft).to.equal(CHAIN_LEN - 1);
  });

  it("damage: a relayer 2 s late loses a 10-ETH vault and every remaining preimage, 23 months before the horizon", async () => {
    const f = await loadFixture(fixture);

    // Bob's bot claims in the deadline second (on Base: next 2-second block).
    await time.setNextBlockTimestamp(f.deadline);
    try {
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    } catch {
      /* under remedy (b) the claim is not yet legal here */
    }
    // Alice's relayer lands one Base block later, then retries once the next block after that.
    const results: string[] = [];
    for (const dt of [2, 4]) {
      await time.setNextBlockTimestamp(f.deadline + dt);
      results.push(
        await revertReason(f, f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, f.chain.preimage(0)))
      );
      if (results[results.length - 1] === "(no revert)") break;
    }

    // Alice has no key for abortClaim. The window runs out; anyone finalizes.
    await time.increase(WINDOW + 1);
    try {
      await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);
    } catch {
      /* fixed code: no claim pending */
    }

    const v = await f.vault.getVault(f.alice.address, 0);
    const bobCredit = await f.vault.creditOf(NATIVE, f.bob.address);
    const horizonLeftDays = (f.horizon - f.deadline) / DAY;
    console.log(
      `      [F16] relayer attempts: ${results.join(" | ")}\n` +
        `      [F16] vault state=${v.state} (3=SETTLED), balance=${ethers.formatEther(v.balance)} ETH, ` +
        `heir credited=${ethers.formatEther(bobCredit)} ETH, unused preimages=${v.hbLeft}/${CHAIN_LEN}, ` +
        `horizon was ${horizonLeftDays.toFixed(0)} days away`
    );

    // SAFE PROPERTY: a living, keyless owner whose relayer was seconds late -- long before the
    // horizon -- still owns the vault. Current code: settled to the heir, whole chain dead.
    expect(v.state, "vault must still be ACTIVE (not SETTLED) while the owner's chain was live").to.equal(
      STATE_ACTIVE
    );
    expect(v.state).to.not.equal(STATE_SETTLED);
    expect(v.balance).to.equal(DEPOSIT);
    expect(bobCredit).to.equal(0n);
  });

  it("control: with the tips reversed the same two transactions leave the vault ACTIVE (ordering alone decides)", async () => {
    const f = await loadFixture(fixture);
    const { claimRcpt, chainRcpt } = await raceInOneBlock(f, f.deadline, 1n * GWEI, 50n * GWEI);
    expect(claimRcpt.blockNumber).to.equal(chainRcpt.blockNumber);
    expect(chainRcpt.status).to.equal(1);
    expect(claimRcpt.status).to.equal(0); // NotYetExpired: the chain reset the deadline first
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(STATE_ACTIVE);
    expect(v.deadline).to.equal(f.deadline + PERIOD);
    expect(v.hbLeft).to.equal(CHAIN_LEN - 1);
  });

  it("control: the seed ALONE can already hold the heir off until the horizon, but no further", async () => {
    const [admin, alice, bob, , dave, feeSink] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("InheritanceVaultV1", admin)).deploy(
      admin.address,
      FEE_BPS,
      feeSink.address
    );
    const horizon = (await time.latest()) + 125 * DAY;
    await vault.connect(alice).createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    const chain = makeChain(CHAIN_LEN);
    await vault.connect(alice).setCheckInChain(0, chain.anchor, CHAIN_LEN);

    let used = 0;
    // Keyless alice checks in via the seed one day before each deadline.
    for (;;) {
      const d = Number((await vault.getVault(alice.address, 0)).deadline);
      if (d >= horizon) break;
      await time.increaseTo(d - DAY);
      await expect(vault.connect(bob).initiateClaim(alice.address, 0, bob.address)).to.be.revertedWithCustomError(
        vault,
        "NotYetExpired"
      );
      await vault.connect(dave).checkInByChain(alice.address, 0, chain.preimage(used++));
    }
    // The last chain check-in clamped the deadline to the horizon: the seed held the heir off
    // for the vault's whole life. At the horizon the chain stops and the heir can claim.
    expect((await vault.getVault(alice.address, 0)).deadline).to.equal(horizon);
    await time.increaseTo(horizon);
    await expect(
      vault.connect(dave).checkInByChain(alice.address, 0, chain.preimage(used))
    ).to.be.revertedWithCustomError(vault, "HorizonReached");
    await vault.connect(bob).initiateClaim(alice.address, 0, bob.address);
    expect((await vault.getVault(alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
    console.log(`      [F16] seed-only liveness held the heir off for ${used} periods, up to the horizon`);
  });
});
