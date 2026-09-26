// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F20/test/poc-F20.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F20:
 *   "The heir cannot cancel or correct their own pending claim, so a mistyped payout address
 *    is irreversible once the owner is gone."
 *
 * Every test asserts the SAFE property: while the claim is still pending (before settlement,
 * with the owner absent), the named beneficiary can fix the payout address, so the estate ends
 * up where the heir meant it to go. Against the current contract they fail because
 * initiateClaim freezes `claimRecipient`, every exit from CLAIM_PENDING other than
 * finalizeClaim is keyed on msg.sender as the OWNER, and a second initiateClaim reverts
 * VaultNotActive.
 *
 * The heir's correction path tries, in order:
 *   1. beneficiaryCancelClaim(vaultOwner, vaultId) -- the fix recommended in F20 -- if the
 *      contract exposes it (it does not today);
 *   2. initiateClaim(vaultOwner, vaultId, correctRecipient) -- which would also pass if a fix
 *      instead lets the beneficiary re-point a pending claim.
 * So these tests become regression tests for either shape of fix.
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
const NET = DEPOSIT - (DEPOSIT * BigInt(FEE_BPS)) / 10_000n; // 9.95 ETH
const WRONG = "0x000000000000000000000000000000000000dEaD"; // the mistyped payout address

const STATE_ACTIVE = 1;
const STATE_CLAIM_PENDING = 2;
const STATE_SETTLED = 3;

describe("F20 heir cannot correct a mistaken claim recipient", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    // Alice (owner) funds a native vault naming Bob as heir, then goes silent for good.
    const horizon = (await time.latest()) + 730 * DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    await time.increase(PERIOD + 1); // Alice's inactivity deadline has lapsed
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  /** Short revert description for the log, never used as an assertion. */
  function why(e: any): string {
    const m = String(e?.shortMessage ?? e?.message ?? e);
    return m.length > 160 ? m.slice(0, 160) + "..." : m;
  }

  /**
   * Everything the beneficiary (Bob) could plausibly do on his own to fix the recipient.
   * Returns a log of what happened; the caller asserts on contract STATE, not on this log.
   */
  async function heirTriesToCorrect(f: any, correctRecipient: string): Promise<string[]> {
    const log: string[] = [];
    const v: any = f.vault;

    // (1) The recommended fix, if the contract has it.
    if (v.interface.getFunction("beneficiaryCancelClaim") !== null) {
      try {
        await v.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
        log.push("beneficiaryCancelClaim: ok");
      } catch (e) {
        log.push("beneficiaryCancelClaim: reverted " + why(e));
      }
    } else {
      log.push("beneficiaryCancelClaim: not in ABI");
    }

    // (2) The owner-side exit, called by Bob. It is keyed on msg.sender, so Bob can only ever
    // address his OWN vault 0, which does not exist. Shown for completeness.
    try {
      await v.connect(f.bob).abortClaim(0);
      log.push("abortClaim as heir: ok");
    } catch (e) {
      log.push("abortClaim as heir: reverted " + why(e));
    }

    // (3) Re-issue the claim with the right address.
    try {
      await v.connect(f.bob).initiateClaim(f.alice.address, 0, correctRecipient);
      log.push("initiateClaim(correct): ok");
    } catch (e) {
      log.push("initiateClaim(correct): reverted " + why(e));
    }
    return log;
  }

  it("the heir can re-point a pending claim to the address they meant, with the owner absent", async () => {
    const f = await loadFixture(fixture);

    // Bob's one and only claim transaction carries a mistyped payout address.
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, WRONG);
    const before = await f.vault.getVault(f.alice.address, 0);
    expect(before.state).to.equal(STATE_CLAIM_PENDING); // setup sanity
    expect(before.claimRecipient).to.equal(WRONG); // setup sanity

    // He notices immediately -- the challenge window has barely started.
    const log = await heirTriesToCorrect(f, f.bob.address);
    console.log("      heir correction attempts:\n        " + log.join("\n        "));

    const after = await f.vault.getVault(f.alice.address, 0);
    // SAFE PROPERTY: before settlement, the beneficiary can make the pending claim pay the
    // address he intended.
    expect(
      after.claimRecipient,
      "claimRecipient is still the mistyped address after every correction path open to the heir"
    ).to.equal(f.bob.address);
  });

  it("damage: once the window passes, a third party settles and pushes the whole estate to the typo", async () => {
    const f = await loadFixture(fixture);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, WRONG);
    const log = await heirTriesToCorrect(f, f.bob.address);
    console.log("      heir correction attempts:\n        " + log.join("\n        "));

    // Alice never returns. After the (possibly restarted) window, Dave -- any third party --
    // finalizes and pushes whatever was credited.
    await time.increase(WINDOW + 1);
    const settledTo = (await f.vault.getVault(f.alice.address, 0)).claimRecipient;
    await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_SETTLED);

    const bobBefore = await ethers.provider.getBalance(f.bob.address);
    const wrongBefore = await ethers.provider.getBalance(WRONG);
    const wrongCredit = await f.vault.creditOf(NATIVE, WRONG);
    for (const acct of [WRONG, f.bob.address]) {
      try {
        await f.vault.connect(f.dave).pushCredit(NATIVE, acct);
      } catch {
        /* nothing credited to that account */
      }
    }
    const bobGain = (await ethers.provider.getBalance(f.bob.address)) - bobBefore;
    const wrongGain = (await ethers.provider.getBalance(WRONG)) - wrongBefore;
    console.log(
      `      settled to ${settledTo}; credit to typo ${ethers.formatEther(wrongCredit)} ETH; ` +
        `pushed to typo ${ethers.formatEther(wrongGain)} ETH; heir received ${ethers.formatEther(bobGain)} ETH`
    );

    // SAFE PROPERTY: the heir, not the mistyped address, receives the net estate.
    expect(wrongGain, "estate pushed to the mistyped address by a third party").to.equal(0n);
    expect(bobGain, "net estate the heir actually received").to.equal(NET);
  });

  it("damage: a recipient that is a contract with no receive() freezes the estate in the credit lane forever", async () => {
    const f = await loadFixture(fixture);
    // Bob pastes a contract address by mistake (here: an ERC20 contract, which has no
    // receive()/fallback and no way to call withdrawCredit).
    const Tok = await ethers.getContractFactory("MintableToken", f.admin);
    const tok = await Tok.deploy();
    const trap = await tok.getAddress();

    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, trap);
    const log = await heirTriesToCorrect(f, f.bob.address);
    console.log("      heir correction attempts:\n        " + log.join("\n        "));

    await time.increase(WINDOW + 1);
    await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);

    const stranded = await f.vault.creditOf(NATIVE, trap);
    let pushTrap = "ok";
    try {
      await f.vault.connect(f.dave).pushCredit(NATIVE, trap);
    } catch (e) {
      pushTrap = "reverted " + why(e);
    }
    const bobBefore = await ethers.provider.getBalance(f.bob.address);
    try {
      await f.vault.connect(f.dave).pushCredit(NATIVE, f.bob.address);
    } catch {
      /* nothing credited to Bob */
    }
    const bobGain = (await ethers.provider.getBalance(f.bob.address)) - bobBefore;
    console.log(
      `      credit stuck on the contract: ${ethers.formatEther(stranded)} ETH; pushCredit(trap): ${pushTrap}; ` +
        `totalCredited(native) = ${ethers.formatEther(await f.vault.totalCredited(NATIVE))} ETH; ` +
        `heir received ${ethers.formatEther(bobGain)} ETH`
    );

    // SAFE PROPERTY: nothing is frozen on an address that can never collect it, and the heir
    // receives the net estate.
    expect(stranded, "native credit frozen on a contract that can neither receive nor withdraw").to.equal(0n);
    expect(bobGain, "net estate the heir actually received").to.equal(NET);
  });

  it("control: the owner's veto still works while the owner is alive (not the defect)", async () => {
    const f = await loadFixture(fixture);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, WRONG);
    await f.vault.connect(f.alice).abortClaim(0);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);
  });
});
