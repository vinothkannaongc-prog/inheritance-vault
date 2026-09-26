// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F14/test/poc-F14.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F14: a full withdrawal during a pending claim ends the claim without ClaimSuperseded
 * (or any other claim-lifecycle event).
 *
 * The safe property asserted here is the one the contract itself promises at the ACT_* constants
 * ("so an indexer can tell WHICH owner action displaced a claim"): an indexer that reconstructs
 * claim state purely from the claim-lifecycle events (ClaimInitiated opens; ClaimAborted,
 * ClaimSuperseded, ClaimSettled close) must agree with the contract's own storage, read through
 * getVault. The indexer never looks at the Withdrawn event -- that is the point: the contract
 * defined a dedicated lifecycle vocabulary and one exit path does not use it.
 *
 * A control test (partial withdraw before the horizon) shows the same indexer is correct when
 * the contract does emit ClaimSuperseded, so the failures below are the defect, not the model.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const ONE = ethers.parseEther("1");
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

const STATE_ACTIVE = 1n;
const STATE_CLAIM_PENDING = 2n;
const STATE_CLOSED = 4n;
const ACT_WITHDRAW = 1n;

type PendingClaim = { recipient: string; finalizableAt: bigint };

describe("F14 PoC: full withdraw ends a pending claim with no claim-lifecycle event", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    // Evidence-suite port: pinned to v1 (the sandbox's F14_IMPL fix-sketch switch is not carried over).
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  async function nativeVault(f: any, horizonSecs = 730 * DAY) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return horizon;
  }

  /**
   * An event-sourced heir tracker, the kind an explorer, subgraph or heir dashboard builds.
   * It replays every log the vault emitted, in order, and keeps only claim-lifecycle state.
   */
  async function indexPendingClaims(vault: any): Promise<Map<string, PendingClaim>> {
    const logs = await ethers.provider.getLogs({
      address: await vault.getAddress(),
      fromBlock: 0,
      toBlock: "latest",
    });
    const pending = new Map<string, PendingClaim>();
    for (const log of logs) {
      const parsed = vault.interface.parseLog(log);
      if (!parsed) continue;
      const lifecycle = ["ClaimInitiated", "ClaimAborted", "ClaimSuperseded", "ClaimSettled"];
      if (!lifecycle.includes(parsed.name)) continue; // admin/ownership events carry no vault key
      const key = `${parsed.args.owner.toLowerCase()}#${parsed.args.vaultId}`;
      switch (parsed.name) {
        case "ClaimInitiated":
          pending.set(key, { recipient: parsed.args.recipient, finalizableAt: parsed.args.finalizableAt });
          break;
        case "ClaimAborted":
        case "ClaimSuperseded":
        case "ClaimSettled":
          pending.delete(key);
          break;
      }
    }
    return pending;
  }

  async function eventNames(vault: any, tx: any): Promise<string[]> {
    const receipt = await tx.wait();
    return receipt.logs
      .map((l: any) => vault.interface.parseLog(l))
      .filter((p: any) => p !== null)
      .map((p: any) => p.name);
  }

  const key = (owner: string, id: number) => `${owner.toLowerCase()}#${id}`;

  // ------------------------------------------------------------------ control (passes today)

  it("CONTROL: a partial withdraw before the horizon emits ClaimSuperseded, and the indexer agrees with the chain", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    expect((await indexPendingClaims(f.vault)).has(key(f.alice.address, 0))).to.equal(true);

    const tx = await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address);
    expect(await eventNames(f.vault, tx)).to.have.members(["ClaimSuperseded", "Withdrawn"]);
    await expect(tx).to.emit(f.vault, "ClaimSuperseded").withArgs(f.alice.address, 0, ACT_WITHDRAW);

    const onChain = await f.vault.getVault(f.alice.address, 0);
    expect(onChain.state).to.equal(STATE_ACTIVE);
    expect((await indexPendingClaims(f.vault)).has(key(f.alice.address, 0))).to.equal(false);
  });

  // ------------------------------------------------------------------ defect, before the horizon

  it("a full withdraw that ends a pending claim before the horizon emits a claim-lifecycle event", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);

    // Alice empties the vault while Bob's claim is pending.
    const tx = await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
    const names = await eventNames(f.vault, tx);

    // Ground truth from storage: the claim is gone and the vault is CLOSED.
    const onChain = await f.vault.getVault(f.alice.address, 0);
    expect(onChain.state).to.equal(STATE_CLOSED);
    expect(onChain.claimRecipient).to.equal(ethers.ZeroAddress);
    expect(onChain.claimInitiatedAt).to.equal(0n);

    // SAFE PROPERTY: the transaction that ended the claim says so in the claim vocabulary.
    const lifecycleEnd = names.filter((n) => ["ClaimSuperseded", "ClaimAborted", "ClaimSettled"].includes(n));
    expect(
      lifecycleEnd.length,
      `full withdraw ended Bob's claim but emitted only [${names.join(", ")}]`
    ).to.be.greaterThan(0);

    // And the event-sourced tracker must agree with storage.
    expect(
      (await indexPendingClaims(f.vault)).has(key(f.alice.address, 0)),
      "event-sourced tracker still shows a pending claim on a CLOSED vault"
    ).to.equal(false);
  });

  // ------------------------------------------------------------------ defect, past the horizon

  it("past the horizon, the full withdraw (one of only two claim-stopping actions) emits a claim-lifecycle event", async () => {
    const f = await loadFixture(fixture);
    const horizon = await nativeVault(f, PERIOD + 5 * DAY); // horizon just past the first deadline
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increaseTo(horizon + 1); // now past the horizon, claim still pending

    // Past the horizon abortClaim is closed and a partial withdraw deliberately leaves the claim running.
    await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    const partial = await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address);
    expect(await eventNames(f.vault, partial)).to.deep.equal(["Withdrawn"]);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING); // consistent

    // The full withdraw of the remainder does stop the claim.
    const tx = await f.vault.connect(f.alice).withdraw(0, DEPOSIT - ONE, f.alice.address);
    const names = await eventNames(f.vault, tx);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLOSED);

    const lifecycleEnd = names.filter((n) => ["ClaimSuperseded", "ClaimAborted", "ClaimSettled"].includes(n));
    expect(
      lifecycleEnd.length,
      `past-horizon full withdraw ended Bob's claim but emitted only [${names.join(", ")}]`
    ).to.be.greaterThan(0);
  });

  // ------------------------------------------------------------------ the heir-facing consequence

  it("every claim an event-sourced tracker shows as finalizable can actually be finalized", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);

    // Bob's dashboard waits until the finalizableAt that ClaimInitiated announced.
    await time.increase(WINDOW + 1);
    const now = BigInt(await time.latest());
    const tracked = await indexPendingClaims(f.vault);

    for (const [k, claim] of tracked) {
      if (claim.finalizableAt > now) continue;
      const [owner, id] = k.split("#");
      // SAFE PROPERTY: a claim the event stream says is live and ripe can be finalized.
      // Today this reverts NoClaimPending: the claim died in a tx that never said so.
      let reason = "ok";
      try {
        await f.vault.connect(f.dave).finalizeClaim.staticCall(owner, BigInt(id));
      } catch (e: any) {
        const decoded = f.vault.interface.parseError(e.data ?? "0x");
        reason = decoded ? decoded.name : String(e.message);
      }
      expect(
        reason,
        `tracker shows ${k} finalizable since ${claim.finalizableAt} (recipient ${claim.recipient}), finalizeClaim -> ${reason}`
      ).to.equal("ok");
    }
  });

  it("quantify: the phantom claim never clears from the event stream (a year later, vault CLOSED)", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);

    await time.increase(365 * DAY);
    const onChain = await f.vault.getVault(f.alice.address, 0);
    const tracked = await indexPendingClaims(f.vault);
    const onChainPending = onChain.state === STATE_CLAIM_PENDING ? 1 : 0;
    expect(
      tracked.size,
      `event stream: ${tracked.size} pending claim(s); storage: ${onChainPending} (state=${onChain.state}, ` +
        `claimInitiatedAt=${onChain.claimInitiatedAt}); nothing the heir or owner can do on a CLOSED vault emits a closing event`
    ).to.equal(onChainPending);
  });
});
