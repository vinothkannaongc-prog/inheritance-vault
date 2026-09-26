// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F12/test/poc-F12.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F12 -- pooled custody: one issuer action against the single vault address freezes
 * every user of that token.
 *
 * The token (contracts/test/PocF12Tokens.sol) mirrors Circle FiatToken's blocklist/pause gates
 * (USDC on Base) plus a Tether-style wipe. InheritanceVault.sol is untouched.
 *
 * Test 1 is the regression test: it asserts the SAFE property (an issuer action aimed at the
 * address that custodies ONE owner's deposit leaves every other user's payout working) and
 * FAILS on the current pooled design. Tests 2-4 pass and characterise the damage.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50n;
const DEPOSIT = 1_000_000_000n; // 1,000 iUSD (6 decimals)
const HEIR_NET = (DEPOSIT * (10_000n - FEE_BPS)) / 10_000n;
const FEE = DEPOSIT - HEIR_NET;
const BLOCKED = "Blacklistable: account is blacklisted";

function reasonOf(e: any): string {
  const m = /reason string '([^']+)'/.exec(e?.message ?? "");
  if (m) return m[1];
  const c = /custom error '([^']+)'/.exec(e?.message ?? "");
  return c ? c[1] : (e?.shortMessage ?? String(e?.message ?? e)).slice(0, 160);
}

describe("PoC F12 pooled custody vs an issuer-controlled token", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, issuer, alice, bob, carol, dave, mallory, erin, frank, feeSink, newbie] =
      await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("InheritanceVaultV1", admin)).deploy(
      admin.address,
      Number(FEE_BPS),
      feeSink.address
    );
    const token = await (await ethers.getContractFactory("F12_IssuerControlledToken", issuer)).deploy();
    const vaultAddr = await vault.getAddress();
    const tokenAddr = await token.getAddress();
    for (const s of [alice, carol, mallory, newbie]) {
      await token.connect(issuer).mint(s.address, 3n * DEPOSIT);
      await token.connect(s).approve(vaultAddr, ethers.MaxUint256);
    }
    return { vault, token, vaultAddr, tokenAddr, admin, issuer, alice, bob, carol, dave, mallory, erin, frank, feeSink, newbie };
  }

  /** Opens a vault and returns the address the token says received the deposit. */
  async function open(f: any, owner: any, heir: any): Promise<string> {
    const horizon = (await time.latest()) + 730 * DAY;
    const tx = await f.vault.connect(owner).createVault(f.tokenAddr, DEPOSIT, heir.address, PERIOD, WINDOW, horizon);
    const rcpt = await tx.wait();
    const sinks: string[] = [];
    for (const log of rcpt!.logs) {
      if (log.address.toLowerCase() !== f.tokenAddr.toLowerCase()) continue;
      const parsed = f.token.interface.parseLog(log);
      if (parsed?.name === "Transfer" && parsed.args.from === owner.address) sinks.push(parsed.args.to);
    }
    expect(sinks.length, "exactly one custody transfer per deposit").to.equal(1);
    return sinks[0];
  }

  /** Tries to pull `who`'s credit to itself; returns null on success or the revert reason. */
  async function tryPull(f: any, who: any, expected: bigint): Promise<string | null> {
    const before = await f.token.balanceOf(who.address);
    try {
      await (await f.vault.connect(who).withdrawCredit(f.tokenAddr, who.address)).wait();
    } catch (e) {
      return reasonOf(e);
    }
    const got = (await f.token.balanceOf(who.address)) - before;
    return got === expected ? null : `paid ${got}, expected ${expected}`;
  }

  // -------------------------------------------------------------------------------------------

  it("[regression] an issuer action against the custodian of ONE owner's deposit must not freeze unrelated users", async () => {
    const f = await loadFixture(fixture);
    await open(f, f.alice, f.bob);
    await open(f, f.carol, f.dave);
    const custodyOfMallory = await open(f, f.mallory, f.erin);

    // Alice goes quiet; her heir Bob claims and settles. Carol, alive, withdraws her own funds.
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW);
    await f.vault.finalizeClaim(f.alice.address, 0);
    await f.vault.connect(f.carol).withdraw(0, DEPOSIT, f.carol.address);

    // The issuer acts against Mallory's funds. The only address the token shows holding them
    // is the one her deposit was transferred to; that is what the issuer can blocklist.
    await f.token.connect(f.issuer).blacklist(custodyOfMallory);

    // SAFE property: Carol and Bob have nothing to do with Mallory, so both must still be paid.
    const frozen: string[] = [];
    const c = await tryPull(f, f.carol, DEPOSIT);
    if (c) frozen.push(`carol (owner, own withdrawal of ${DEPOSIT}): ${c}`);
    const b = await tryPull(f, f.bob, HEIR_NET);
    if (b) frozen.push(`bob (heir of alice, inheritance of ${HEIR_NET}): ${b}`);

    expect(
      frozen,
      `blocklisting ${custodyOfMallory} (custodian of mallory's deposit; vault is ${f.vaultAddr}) froze unrelated users`
    ).to.deep.equal([]);
  });

  // -------------------------------------------------------------------------------------------

  it("[damage] vault address blocklisted: state machine runs, every token call of every user reverts, value frozen not lost", async () => {
    const f = await loadFixture(fixture);
    await open(f, f.alice, f.bob);
    await open(f, f.carol, f.dave);
    await open(f, f.mallory, f.erin);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    await f.token.connect(f.issuer).blacklist(f.vaultAddr);

    // Token-touching entry points: all refused by the issuer, for everyone.
    const horizon = (await time.latest()) + 730 * DAY;
    await expect(
      f.vault.connect(f.newbie).createVault(f.tokenAddr, DEPOSIT, f.frank.address, PERIOD, WINDOW, horizon)
    ).to.be.revertedWith(BLOCKED);
    await expect(f.vault.connect(f.carol).topUp(f.mallory.address, 0, DEPOSIT)).to.be.revertedWith(BLOCKED);

    // The state machine makes no token calls, so it keeps running.
    await f.vault.connect(f.mallory).checkIn(0); // Mallory checks in fine
    await time.increase(WINDOW);
    await f.vault.finalizeClaim(f.alice.address, 0); // Bob's inheritance settles
    await f.vault.connect(f.carol).withdraw(0, DEPOSIT, f.carol.address); // Carol withdraws to credit
    expect(await f.vault.creditOf(f.tokenAddr, f.bob.address)).to.equal(HEIR_NET);
    expect(await f.vault.creditOf(f.tokenAddr, f.carol.address)).to.equal(DEPOSIT);
    expect(await f.vault.creditOf(f.tokenAddr, f.feeSink.address)).to.equal(FEE);

    // ...but nobody can be paid: owner, heir, and the operator's own fee.
    for (const s of [f.bob, f.carol, f.feeSink]) {
      await expect(f.vault.connect(s).withdrawCredit(f.tokenAddr, s.address)).to.be.revertedWith(BLOCKED);
    }
    await expect(f.vault.pushCredit(f.tokenAddr, f.carol.address)).to.be.revertedWith(BLOCKED);

    // Quantify: everything the pool holds is frozen, nothing is lost.
    const frozen = (await f.vault.totalLocked(f.tokenAddr)) + (await f.vault.totalCredited(f.tokenAddr));
    expect(frozen).to.equal(3n * DEPOSIT);
    expect(await f.token.balanceOf(f.vaultAddr)).to.equal(3n * DEPOSIT);
    console.log(`      frozen while vault blocklisted: ${frozen} base units across 4 accounts (3 owners' deposits)`);

    // Issuer lifts the blocklist: everyone is paid in full.
    await f.token.connect(f.issuer).unBlacklist(f.vaultAddr);
    expect(await tryPull(f, f.bob, HEIR_NET)).to.equal(null);
    expect(await tryPull(f, f.carol, DEPOSIT)).to.equal(null);
    expect(await tryPull(f, f.feeSink, FEE)).to.equal(null);

    // Pause: same shape -- check-in and withdraw-to-credit work, payouts wait.
    await f.token.connect(f.issuer).pause();
    await f.vault.connect(f.mallory).checkIn(0);
    await f.vault.connect(f.mallory).withdraw(0, DEPOSIT, f.mallory.address);
    await expect(f.vault.connect(f.mallory).withdrawCredit(f.tokenAddr, f.mallory.address)).to.be.revertedWith(
      "Pausable: paused"
    );
    await f.token.connect(f.issuer).unpause();
    expect(await tryPull(f, f.mallory, DEPOSIT)).to.equal(null);
  });

  // -------------------------------------------------------------------------------------------

  it("[trigger] a blocklisted owner and a blocklisted heir both route pre-blocklist deposits out through a clean address", async () => {
    const f = await loadFixture(fixture);
    await open(f, f.mallory, f.erin); // funded before any sanction
    await open(f, f.alice, f.bob);

    // Owner route: Mallory is blocklisted and cannot move tokens herself...
    await f.token.connect(f.issuer).blacklist(f.mallory.address);
    await expect(f.token.connect(f.mallory).transfer(f.frank.address, 1)).to.be.revertedWith(BLOCKED);
    // ...but the token sees only the vault as sender, so a fresh address receives her deposit.
    await f.vault.connect(f.mallory).withdraw(0, DEPOSIT, f.frank.address);
    expect(await tryPull(f, f.frank, DEPOSIT)).to.equal(null);

    // Heir route: Bob is blocklisted; he still claims and names a clean recipient.
    await f.token.connect(f.issuer).blacklist(f.bob.address);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.frank.address);
    await time.increase(WINDOW);
    await f.vault.finalizeClaim(f.alice.address, 0);
    expect(await tryPull(f, f.frank, HEIR_NET)).to.equal(null);
  });

  // -------------------------------------------------------------------------------------------

  it("[damage, wipe] a Tether-style wipe of the vault address destroys every user's balance and makes later deposits pay old credits", async () => {
    const f = await loadFixture(fixture);
    await open(f, f.alice, f.bob);
    await open(f, f.carol, f.dave);
    await open(f, f.mallory, f.erin);

    await f.token.connect(f.issuer).blacklist(f.vaultAddr);
    await f.token.connect(f.issuer).destroyBlackFunds(f.vaultAddr);
    await f.token.connect(f.issuer).unBlacklist(f.vaultAddr);

    expect(await f.token.balanceOf(f.vaultAddr)).to.equal(0n);
    expect(await f.vault.totalLocked(f.tokenAddr)).to.equal(3n * DEPOSIT); // books still say 3,000
    expect(await f.vault.surplus(f.tokenAddr)).to.equal(0n);

    // Carol withdraws; the pool is empty, so her payout reverts.
    await f.vault.connect(f.carol).withdraw(0, DEPOSIT, f.carol.address);
    await expect(f.vault.connect(f.carol).withdrawCredit(f.tokenAddr, f.carol.address)).to.be.revertedWithCustomError(f.token, "ERC20InsufficientBalance");

    // A newcomer deposits into the insolvent pool -- nothing warns them -- and Carol is paid
    // entirely out of the newcomer's money. The newcomer's vault is now unbacked.
    await open(f, f.newbie, f.frank);
    expect(await tryPull(f, f.carol, DEPOSIT)).to.equal(null);
    expect(await f.token.balanceOf(f.vaultAddr)).to.equal(0n);
    await f.vault.connect(f.newbie).withdraw(0, DEPOSIT, f.newbie.address);
    await expect(f.vault.connect(f.newbie).withdrawCredit(f.tokenAddr, f.newbie.address)).to.be.revertedWithCustomError(f.token, "ERC20InsufficientBalance");
    const unbacked = (await f.vault.totalLocked(f.tokenAddr)) + (await f.vault.totalCredited(f.tokenAddr));
    console.log(`      after wipe: ${unbacked} base units of recorded entitlements backed by 0 tokens`);
    expect(unbacked).to.equal(3n * DEPOSIT);
  });
});
