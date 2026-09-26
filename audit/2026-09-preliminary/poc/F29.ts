// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F29/test/poc-F29.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: README.md, SECURITY.md, deployments/, site/index.html,
//  site/security.html, site/guides/dead-mans-switch-crypto.html, site/assets/app.js.
/**
 * PoC / regression for F29: public documentation does not match the code or the live state.
 *
 * Pattern used throughout: each test first EXECUTES the contract (or reads the deployment record)
 * to establish ground truth, asserting that ground truth with passing expectations. It then
 * checks that the documentation describing that behaviour agrees with it. Doc/code mismatches are
 * collected and asserted empty at the end, so the only failing assertion is the mismatch itself,
 * and every mismatch is listed in the failure output.
 *
 * Once the documentation is corrected (or the code is changed AND the docs follow it), these
 * tests pass and stay as doc-drift regression tests.
 *
 * Documentation is read from the repo root (../ relative to this file). In the PoC sandbox that
 * copy has no site/ or README, so it falls back to F29_REPO or the repo path below (read-only).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const ONE = ethers.parseEther("1");
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

// Evidence-suite port: documents are read (read-only) from this repo's working tree.
const REPO = process.env.F29_REPO ?? path.resolve(__dirname, "..", "..", "..");

function docPath(rel: string): string {
  return path.join(REPO, rel);
}
function readDoc(rel: string): string {
  return fs.readFileSync(docPath(rel), "utf8");
}
/** Strip HTML tags, NatSpec leaders, markdown bold and collapse whitespace. */
function norm(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*\*(?!\*)\s?/gm, " ")
    .replace(/\/\/\/?/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`doc marker not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`doc end marker not found after ${start}: ${end}`);
  return src.slice(i, j);
}
/** The NatSpec block immediately above `function <name>`. */
function natspecAbove(src: string, fnName: string): string {
  const fi = src.indexOf(`function ${fnName}(`);
  if (fi < 0) throw new Error(`function not found: ${fnName}`);
  const ci = src.lastIndexOf("/**", fi);
  return src.slice(ci, fi);
}
function lineOf(src: string, needle: string): number {
  const i = src.indexOf(needle);
  return i < 0 ? -1 : src.slice(0, i).split("\n").length;
}

describe("F29 public documentation vs code and live state", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  /** Same fee ceiling (50 bps) but NO fee recipient configured -- "no fee is taken at all". */
  async function noRecipientFixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, ethers.ZeroAddress);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  async function nativeVault(f: any, horizonSecs = 730 * DAY, period = PERIOD, window = WINDOW) {
    const horizon = (await time.latest()) + horizonSecs;
    await f.vault
      .connect(f.alice)
      .createVault(NATIVE, DEPOSIT, f.bob.address, period, window, horizon, { value: DEPOSIT });
    return horizon;
  }

  // Evidence-suite port: the v1 source (NatSpec identical to the deployed file; line numbers +15).
  const SOL = "contracts/v1/InheritanceVaultV1.sol";

  // ------------------------------------------------------------------ (5) T2 "stuck until the horizon"

  it("(5) T2: once the owner is gone, a lost heir key strands funds PERMANENTLY -- nothing is released at the horizon", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f, 60 * DAY);
    const g = (await f.vault.getVault(f.alice.address, 0)).guaranteedInheritanceAt;

    // Owner is gone (never acts again); heir bob has lost his key. Go 20 years past the
    // "guaranteed inheritance" date.
    await time.increaseTo(Number(g) + 20 * 365 * DAY);
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.horizonReached).to.equal(true);
    expect(v.expired).to.equal(true);

    // Ground truth: every party other than the lost beneficiary key is refused.
    for (const s of [f.carol, f.dave, f.admin, f.feeSink]) {
      await expect(f.vault.connect(s).initiateClaim(f.alice.address, 0, s.address))
        .to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary")
        .withArgs(s.address, f.bob.address);
    }
    await expect(f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0)).to.be.revertedWithCustomError(
      f.vault,
      "NoClaimPending"
    );
    const after = await f.vault.getVault(f.alice.address, 0);
    expect(after.state).to.equal(1); // still ACTIVE, forever
    expect(after.balance).to.equal(DEPOSIT); // 10 ETH stranded
    expect(await f.vault.totalLocked(NATIVE)).to.equal(DEPOSIT);
    const releasedAtHorizon = false; // established above: no path opens at or after the horizon

    // Doc check.
    const src = readDoc(SOL);
    const t2 = norm(between(src, "T2.", "T3."));
    const problems: string[] = [];
    if (!releasedAtHorizon && /stuck until the horizon/i.test(t2)) {
      problems.push(
        `${SOL}:${lineOf(src, "stuck until the horizon")} T2 says a lost heir key leaves funds "stuck until the horizon", ` +
          `but 20 years past guaranteedInheritanceAt only msg.sender == beneficiary may initiateClaim (:643); the funds are stuck permanently`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  // ------------------------------------------------------------------ (6) _clearPending / T1

  it("(6) _clearPending NatSpec: 'Any owner action supersedes a running claim' is false for checkIn, checkInMany and topUp", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f); // horizon two years out: this is the BEFORE-horizon case
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // Ground truth: three owner-callable actions do NOT supersede the claim.
    const notSuperseding: string[] = [];
    await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "ClaimPendingUseAbort");
    notSuperseding.push("checkIn (reverts ClaimPendingUseAbort)");
    await expect(f.vault.connect(f.alice).checkInMany([0])).to.be.revertedWithCustomError(f.vault, "NothingCheckedIn");
    notSuperseding.push("checkInMany (skips, reverts NothingCheckedIn)");
    await expect(
      f.vault.connect(f.alice).topUp(f.alice.address, 0, ONE, { value: ONE })
    ).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
    notSuperseding.push("topUp by the owner (reverts VaultNotActive)");
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(2); // claim still running

    const src = readDoc(SOL);
    const doc = norm(natspecAbove(src, "_clearPending"));
    const problems: string[] = [];
    if (notSuperseding.length && /Any owner action supersedes a running claim/i.test(doc)) {
      problems.push(
        `${SOL}:${lineOf(src, "Any owner action supersedes")} _clearPending says "Any owner action supersedes a running claim"; ` +
          `before the horizon these owner actions do not: ${notSuperseding.join("; ")}`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  it("(6, control) T1 'veto any claim' survives past the horizon only through extendHorizon or a full withdraw", async () => {
    // Passing control: shows the T1 sentence is imprecise rather than false.
    const f = await loadFixture(fixture);
    const t0 = await time.latest();
    await nativeVault(f, 60 * DAY); // horizon t0+60d, deadline t0+30d
    await time.increaseTo(t0 + 50 * DAY);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // finalizable t0+64d
    await time.increaseTo(t0 + 61 * DAY); // past the horizon, window still open

    await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    await expect(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address)).to.be.revertedWithCustomError(
      f.vault,
      "HorizonReached"
    );
    await expect(f.vault.connect(f.alice).setInactivityPeriod(0, PERIOD)).to.be.revertedWithCustomError(
      f.vault,
      "HorizonReached"
    );
    await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address); // partial withdraw: claim keeps running
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(2);

    // The one soft veto left: extendHorizon, at the cost of a full inactivity period.
    const now = await time.latest();
    await f.vault.connect(f.alice).extendHorizon(0, now + PERIOD + 10);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(1);
  });

  // ------------------------------------------------------------------ (2) "exactly two addresses" / admin powers

  it("(2) index.html FAQ and README admin row omit setClaimFee/setFeeRecipient, and more than two addresses move vault value", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    // Admin powers the FAQ does not name. Both succeed and both decide who gets what at settlement.
    await expect(f.vault.connect(f.admin).setFeeRecipient(f.admin.address)).to.emit(f.vault, "FeeRecipientChanged");
    await expect(f.vault.connect(f.admin).setClaimFee(FEE_BPS)).to.emit(f.vault, "ClaimFeeChanged");
    await time.increase(WINDOW);

    // An arbitrary third party settles and pushes the heir's payout.
    const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);
    await expect(f.vault.connect(f.carol).pushCredit(NATIVE, f.bob.address)).to.changeEtherBalance(f.bob, DEPOSIT - fee);
    // The admin, now fee recipient, takes value that came out of the vault's balance.
    await expect(f.vault.connect(f.admin).withdrawCredit(NATIVE, f.admin.address)).to.changeEtherBalance(f.admin, fee);

    const movers = new Set([f.alice.address, f.bob.address, f.carol.address, f.admin.address]);
    expect(movers.size).to.equal(4);

    const idx = readDoc("site/index.html");
    const faq = norm(between(idx, "Can Will &amp; Key or a hacker take my funds?", "</details>"));
    const readme = readDoc("README.md");
    const row = norm(between(readme, "| Admin misbehaves", "\n"));
    const problems: string[] = [];
    if (/exactly two addresses move funds/i.test(faq)) {
      problems.push(
        `site/index.html:${lineOf(idx, "exactly two addresses")} says "exactly two addresses move funds"; ` +
          `${movers.size} distinct addresses moved vault value here (owner deposit, heir claim, third-party finalize+push, admin fee withdraw)`
      );
    }
    if (!/fee/i.test(faq)) {
      problems.push(
        `site/index.html:${lineOf(idx, "The admin's power is limited")} says the admin's power "is limited to pausing new vault creation and sweeping"; ` +
          `setClaimFee and setFeeRecipient both executed and redirected ${ethers.formatEther(fee)} ETH of the vault to the admin`
      );
    }
    if (!/fee/i.test(row)) {
      problems.push(
        `README.md:${lineOf(readme, "| Admin misbehaves")} "Admin misbehaves" row lists only pause + sweep; omits setClaimFee/setFeeRecipient`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  // ------------------------------------------------------------------ (3) "cannot touch a wei" / "cannot raise your fee"

  it("(3) 'cannot touch a wei of any vault ... or raise your fee': admin turns a 0% in-flight claim into 0.5% and takes the difference", async () => {
    const f = await loadFixture(noRecipientFixture);
    await nativeVault(f); // vault fee ceiling snapshot = 50 bps, but no fee recipient => no fee
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    // At initiation the documented effective fee is ZERO: "if our fee address is ever unset, no fee
    // is taken at all" (index.html:113-114, README "No fee recipient configured => no fee taken").
    expect(await f.vault.feeRecipient()).to.equal(ethers.ZeroAddress);

    // During the challenge window the admin sets itself as fee recipient.
    await f.vault.connect(f.admin).setFeeRecipient(f.admin.address);
    await time.increase(WINDOW);
    await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0);

    const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
    expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(DEPOSIT - fee); // heir: 9.95 ETH, not 10
    expect(await f.vault.creditOf(NATIVE, f.admin.address)).to.equal(fee); // admin: 0.05 ETH of the vault
    const adminTookFromVault = fee > 0n;
    const effectiveFeeRoseMidClaim = true; // 0 bps at initiateClaim -> 50 bps at finalizeClaim, shown above

    const idx = readDoc("site/index.html");
    const evil = norm(between(idx, "We turn evil", "</tr>"));
    const src = readDoc(SOL);
    const t4 = norm(between(src, "T4.", "ACCOUNTING"));
    const sec = readDoc("SECURITY.md");
    const problems: string[] = [];
    if (effectiveFeeRoseMidClaim && /raise your fee/i.test(evil)) {
      problems.push(
        `site/index.html:${lineOf(idx, "raise your fee")} "We cannot ... raise your fee": the effective fee on an in-flight claim rose 0 -> ${FEE_BPS} bps via setFeeRecipient`
      );
    }
    if (adminTookFromVault && /cannot touch a wei of any vault/i.test(evil)) {
      problems.push(
        `site/index.html:${lineOf(idx, "touch a wei")} "We cannot touch a wei of any vault": admin was credited ${ethers.formatEther(fee)} ETH out of this vault's balance`
      );
    }
    if (adminTookFromVault && /cannot reach a wei of any vault's balance/i.test(t4)) {
      problems.push(
        `${SOL}:${lineOf(src, "cannot reach a wei")} T4 "The admin cannot reach a wei of any vault's balance": same ${ethers.formatEther(fee)} ETH`
      );
    }
    if (effectiveFeeRoseMidClaim && /No administrator can move user vault balances/i.test(norm(sec))) {
      problems.push(
        `SECURITY.md:${lineOf(sec, "No administrator can move")} "No administrator can move user vault balances or payout credits": ` +
          `setFeeRecipient moved ${ethers.formatEther(fee)} ETH from the heir's settlement to the admin`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  // ------------------------------------------------------------------ (4) "any ERC-20"

  it("(4) index.html 'any ERC-20': with a positive-rebasing token the admin sweeps the depositor's yield", async () => {
    const f = await loadFixture(fixture);
    const Tok = await ethers.getContractFactory("F29_RebasingToken", f.admin);
    const tok = await Tok.deploy();
    const tokAddr = await tok.getAddress();
    const vaultAddr = await f.vault.getAddress();
    const amt = ethers.parseEther("100");
    await tok.mint(f.alice.address, amt);
    await tok.connect(f.alice).approve(vaultAddr, ethers.MaxUint256);
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(tokAddr, amt, f.bob.address, PERIOD, WINDOW, horizon);

    await tok.rebase(1000); // +10% yield on everything the vault holds
    expect(await tok.balanceOf(vaultAddr)).to.equal(ethers.parseEther("110"));
    const yieldAmt = await f.vault.surplus(tokAddr);
    expect(yieldAmt).to.equal(ethers.parseEther("10"));
    await f.vault.connect(f.admin).sweepSurplus(tokAddr, f.admin.address);
    expect(await tok.balanceOf(f.admin.address)).to.be.closeTo(ethers.parseEther("10"), 1n); // share rounding in the mock; alice's yield, now the admin's
    expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(amt); // vault stays nominal
    const unsupportedClassAccepted = true; // createVault accepted it without complaint

    const idx = readDoc("site/index.html");
    const step = norm(between(idx, "<h3>Lock</h3>", "</div>"));
    const problems: string[] = [];
    if (unsupportedClassAccepted && /any ERC-20/i.test(step)) {
      problems.push(
        `site/index.html:${lineOf(idx, "any ERC-20")} invites "any ERC-20"; a rebasing token (declared unsupported in ${SOL}:60-65 and README:43) ` +
          `was accepted and its ${ethers.formatEther(yieldAmt)}-token yield was swept by the admin`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  // ------------------------------------------------------------------ (8) stale setCheckInChain comment

  it("(8) setCheckInChain comment says installing a chain past the horizon 'would take a fee'; the function has no fee path", async () => {
    const f = await loadFixture(fixture);
    await nativeVault(f, 60 * DAY);
    expect(f.vault.interface.getFunction("setCheckInChain")!.stateMutability).to.equal("nonpayable");

    const before = {
      sink: await f.vault.creditOf(NATIVE, f.feeSink.address),
      admin: await f.vault.creditOf(NATIVE, f.admin.address),
      credited: await f.vault.totalCredited(NATIVE),
      bal: (await f.vault.getVault(f.alice.address, 0)).balance,
    };
    const anchor = ethers.keccak256(ethers.toUtf8Bytes("seed"));
    await f.vault.connect(f.alice).setCheckInChain(0, anchor, 10);
    expect(await f.vault.creditOf(NATIVE, f.feeSink.address)).to.equal(before.sink);
    expect(await f.vault.creditOf(NATIVE, f.admin.address)).to.equal(before.admin);
    expect(await f.vault.totalCredited(NATIVE)).to.equal(before.credited);
    expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(before.bal);
    const takesFee = false; // established above

    const src = readDoc(SOL);
    const body = norm(between(src, "function setCheckInChain(", "emit CheckInChainSet"));
    const problems: string[] = [];
    if (!takesFee && /take a fee/i.test(body)) {
      problems.push(
        `${SOL}:${lineOf(src, "would take a fee")} comment says installing a chain "would take a fee"; setCheckInChain is nonpayable and moves no value`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  // ------------------------------------------------------------------ (1) + (7) deployment state

  it("(1)+(7) security.html / guide say admin was never handed over; README says 'BNB Chain supported' with no BNB deployment", async () => {
    const base = JSON.parse(readDoc("deployments/base.json"));
    const handedOver =
      base.adminHandover &&
      base.adminHandover.to.toLowerCase() !== base.deployer.toLowerCase() &&
      base.admin.toLowerCase() === base.adminHandover.to.toLowerCase();
    expect(handedOver).to.equal(true);

    const depFiles = fs.readdirSync(docPath("deployments"));
    const bnbDeployed = depFiles.some((n) => /bnb|bsc/i.test(n));
    const app = readDoc("site/assets/app.js");
    const bnbEntry = between(app, "56: {", "},");
    const bnbAddrInFrontend = /contract:\s*"0x[0-9a-fA-F]{40}"/.test(bnbEntry);
    expect(bnbDeployed).to.equal(false);
    expect(bnbAddrInFrontend).to.equal(false);

    const sec = readDoc("site/security.html");
    const guide = readDoc("site/guides/dead-mans-switch-crypto.html");
    const readme = readDoc("README.md");
    const problems: string[] = [];
    if (handedOver && /has not yet been transferred from the deployer/i.test(norm(sec))) {
      problems.push(
        `site/security.html:${lineOf(sec, "has not yet been transferred")} says admin "has not yet been transferred from the deployer"; ` +
          `deployments/base.json records the ${base.adminHandover.date} handover to ${base.adminHandover.to} (${base.adminHandover.toKind})`
      );
    }
    if (handedOver && /retains deployer administration/i.test(norm(guide))) {
      problems.push(
        `site/guides/dead-mans-switch-crypto.html:${lineOf(guide, "retains deployer administration")} says Will & Key "retains deployer administration"; same handover`
      );
    }
    if (!bnbDeployed && !bnbAddrInFrontend && /BNB Chain supported/i.test(norm(readme))) {
      problems.push(
        `README.md:${lineOf(readme, "BNB Chain** supported")} says "BNB Chain supported"; deployments/ holds only ${depFiles.join(", ")} and app.js chain 56 has contract ""`
      );
    }
    expect(problems).to.deep.equal([]);
  });

  // ------------------------------------------------------------------ (1) live-state evidence, opt-in

  it("(1, live) Base mainnet: owner = feeRecipient = handover target, no pending owner, single EOA (set F29_LIVE=1)", async function () {
    if (!process.env.F29_LIVE) this.skip();
    this.timeout(60_000);
    const base = JSON.parse(readDoc("deployments/base.json"));
    const p = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL ?? "https://mainnet.base.org", 8453, { staticNetwork: true });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const abi = [
      "function owner() view returns (address)",
      "function pendingOwner() view returns (address)",
      "function feeRecipient() view returns (address)",
      "function claimFeeBps() view returns (uint16)",
      "function creationPaused() view returns (bool)",
    ];
    const v = new ethers.Contract(base.contracts.InheritanceVault, abi, p);
    const s = new ethers.Contract(base.contracts.NotifySubscription, abi.slice(0, 2), p);
    const bn = await p.getBlockNumber();
    const read = async (c: any, fn: string) => {
      await sleep(1200); // public RPC rate-limits bursts
      return c[fn]({ blockTag: bn });
    };
    const live = {
      block: bn,
      vaultOwner: await read(v, "owner"),
      vaultPending: await read(v, "pendingOwner"),
      feeRecipient: await read(v, "feeRecipient"),
      claimFeeBps: Number(await read(v, "claimFeeBps")),
      creationPaused: await read(v, "creationPaused"),
      subOwner: await read(s, "owner"),
      subPending: await read(s, "pendingOwner"),
      adminCode: await p.getCode(base.admin, bn),
    };
    console.log("      live state:", JSON.stringify(live));
    expect(live.vaultOwner).to.equal(base.admin);
    expect(live.feeRecipient).to.equal(base.admin);
    expect(live.subOwner).to.equal(base.admin);
    expect(live.vaultPending).to.equal(ethers.ZeroAddress);
    expect(live.subPending).to.equal(ethers.ZeroAddress);
    expect(live.adminCode).to.equal("0x"); // an EOA: one key, not a multisig contract
    expect(live.vaultOwner).to.not.equal(base.deployer);
  });
});
