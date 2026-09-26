// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F15/test/poc-F15.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F15 -- checkInMany skips vaults silently.
 *
 * InheritanceVault.checkInMany (contracts/InheritanceVault.sol:481-498) `continue`s past an
 * unknown id (:490) and past a vault that is not ACTIVE or has reached its horizon (:492). A
 * skip emits nothing. The only signal is the return value `refreshed`, which is not in a mined
 * receipt, and which counts duplicate ids (acknowledged at :488-489).
 *
 * These tests assert the SAFE property: every id a keeper hands to checkInMany is accounted
 * for in the mined receipt (refreshed or visibly skipped), and the returned count never
 * exceeds the number of distinct vaults actually refreshed. They fail against the current
 * code because of the defect and should pass once a CheckInSkipped-style event and a
 * distinct-count (or duplicate revert) are added.
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

describe("PoC F15 checkInMany skips are invisible in the mined receipt", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink, keeperWatcher] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, dave, feeSink, keeperWatcher };
  }

  async function nativeVault(f: any, heir: string, horizonSecs = 730 * DAY) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, heir, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return horizon;
  }

  /**
   * The vault ids a receipt says anything about. Parsed with the contract's own ABI, so a
   * future CheckInSkipped(owner, vaultId, reason) event is picked up automatically once it
   * exists; today the only vault-scoped event checkInMany can emit is CheckedIn.
   */
  function vaultIdsMentioned(vault: any, receipt: any, owner: string): bigint[] {
    const vaultAddr = (vault.target as string).toLowerCase();
    const ids: bigint[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vaultAddr) continue;
      const parsed = vault.interface.parseLog(log);
      if (!parsed) continue;
      const hasVaultId = parsed.fragment.inputs.some((i: any) => i.name === "vaultId");
      const hasOwner = parsed.fragment.inputs.some((i: any) => i.name === "owner");
      if (!hasVaultId) continue;
      if (hasOwner && (parsed.args.owner as string).toLowerCase() !== owner.toLowerCase()) continue;
      ids.push(parsed.args.vaultId as bigint);
    }
    return ids;
  }

  function eventNames(vault: any, receipt: any): string[] {
    return receipt.logs
      .map((l: any) => vault.interface.parseLog(l))
      .filter((p: any) => p)
      .map((p: any) => p.name);
  }

  /** Two vaults: 0 (heir carol) and 1 (heir bob). The keeper misses one run and bob claims vault 1. */
  async function claimPendingFixture() {
    const f = await loadFixture(fixture);
    await nativeVault(f, f.carol.address); // vault 0
    await nativeVault(f, f.bob.address); // vault 1
    // Keeper runs fine for a while...
    await time.increase(10 * DAY);
    await f.vault.connect(f.alice).checkInMany([0, 1]);
    // ...then is down for a little over one inactivity period (or is front-run at the wire).
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
    expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(2); // CLAIM_PENDING
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(1); // still ACTIVE
    return f;
  }

  it("a claim-pending vault skipped by checkInMany is visible in the mined receipt", async () => {
    const f = await claimPendingFixture();

    // The keeper resumes and refreshes the estate exactly as documented.
    const tx = await f.vault.connect(f.alice).checkInMany([0, 1]);
    const receipt = await tx.wait();

    // The keeper's only mined signal is green...
    expect(receipt!.status).to.equal(1);
    // ...and vault 0 really was refreshed (setup sanity, not the defect).
    expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal((await time.latest()) + PERIOD);
    // Vault 1 really was NOT refreshed and its claim is still running.
    expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(2);

    const mentioned = vaultIdsMentioned(f.vault, receipt, f.alice.address);
    console.log("      receipt events:", eventNames(f.vault, receipt), "vaultIds mentioned:", mentioned);

    // SAFE PROPERTY: every id the keeper submitted is accounted for in the receipt, so a
    // receipt-reading keeper or wallet can see that vault 1 was skipped (and why).
    expect(mentioned, "vault 1 (claim pending) was skipped with no log").to.include(1n);
  });

  it("a horizon-reached vault skipped by checkInMany is visible in the mined receipt", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f, f.carol.address); // vault 0, long horizon
    await nativeVault(f, f.bob.address, PERIOD + DAY); // vault 1, horizon in 31 days
    await time.increase(PERIOD + 2 * DAY); // vault 1 past its horizon

    const receipt = await (await f.vault.connect(f.alice).checkInMany([0, 1])).wait();
    expect(receipt!.status).to.equal(1);
    expect((await f.vault.getVault(f.alice.address, 1)).horizonReached).to.equal(true);

    const mentioned = vaultIdsMentioned(f.vault, receipt, f.alice.address);
    console.log("      receipt events:", eventNames(f.vault, receipt), "vaultIds mentioned:", mentioned);
    expect(mentioned, "vault 1 (horizon reached) was skipped with no log").to.include(1n);
  });

  it("the returned count does not overstate coverage when ids repeat", async () => {
    const f = await claimPendingFixture();
    // A keeper whose id list is buggy -- [0, 0, 1] -- and which checks `refreshed` against the
    // owner's vault count (2) to decide "all covered".
    const ids = [0, 0, 1];
    let refreshed: bigint | null = null;
    let reverted = false;
    try {
      refreshed = await f.vault.connect(f.alice).checkInMany.staticCall(ids);
    } catch {
      reverted = true; // a fix that rejects duplicates outright is also acceptable
    }
    const owned = await f.vault.vaultCount(f.alice.address);
    console.log(`      refreshed=${refreshed} ownedVaults=${owned} distinctRefreshed=1 reverted=${reverted}`);

    if (!reverted) {
      // SAFE PROPERTY: the count equals distinct vaults actually refreshed (only vault 0).
      expect(refreshed, "refreshed counts the duplicate id and equals the owner's vault count").to.equal(1n);
    }
  });

  it("damage: a keeper checking receipts sees green for the whole challenge window while vault 1 is inherited", async () => {
    const f = await claimPendingFixture();
    const claimAt = await time.latest();

    // Keeper keeps running every 2 days through the 14-day challenge window.
    let runs = 0;
    let green = 0;
    let receiptsMentioningVault1 = 0;
    while ((await time.latest()) + 2 * DAY < claimAt + WINDOW) {
      await time.increase(2 * DAY);
      const receipt = await (await f.vault.connect(f.alice).checkInMany([0, 1])).wait();
      runs += 1;
      if (receipt!.status === 1) green += 1;
      if (vaultIdsMentioned(f.vault, receipt, f.alice.address).includes(1n)) receiptsMentioningVault1 += 1;
    }

    // Window elapses; an arbitrary third party (dave) finalizes.
    await time.increaseTo(claimAt + WINDOW + 1);
    await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 1);

    const v1 = await f.vault.getVault(f.alice.address, 1);
    const heirCredit = await f.vault.creditOf(NATIVE, f.bob.address);
    const v0 = await f.vault.getVault(f.alice.address, 0);
    console.log(
      `      keeper runs=${runs} green=${green} receiptsMentioningVault1=${receiptsMentioningVault1}; ` +
        `vault1 state=${v1.state} (3=SETTLED) heirCredit=${ethers.formatEther(heirCredit)} ETH ` +
        `of ${ethers.formatEther(DEPOSIT)} deposited; vault0 state=${v0.state} (owner provably alive)`
    );

    // The damage is real: the owner was demonstrably alive (vault 0 refreshed every run) and
    // still lost vault 1 to settlement.
    expect(v1.state).to.equal(3);
    expect(heirCredit).to.equal(DEPOSIT - (DEPOSIT * BigInt(FEE_BPS)) / 10_000n);
    expect(green).to.equal(runs);

    // SAFE PROPERTY: at least one of the keeper's receipts during the window told it that
    // vault 1 was being skipped.
    expect(receiptsMentioningVault1, `0 of ${runs} green keeper receipts mention vault 1`).to.be.greaterThan(0);
  });
});
