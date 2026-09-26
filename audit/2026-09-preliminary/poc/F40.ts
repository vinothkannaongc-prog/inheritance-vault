// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F40/test/poc-F40.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/index.html, site/how-it-works.html, site/security.html,
//  two guides and AUDIT_SCOPE.md (also at git commit b8baf34).
/**
 * PoC F40 -- the veto window protects only an owner who learns a claim is running, and nothing
 * tells them any more (watcher retired), while the site still sells the veto as the safeguard
 * and still refers to reminders.
 *
 * Part A (characterisation, PASSES): on chain, initiateClaim involves the owner in no way a
 * wallet feed or explorer address page would show -- the only trace is one log with the owner
 * as topic1 -- and an owner who is never alerted loses the vault after exactly
 * inactivityPeriod + challengeWindow, i.e. a plain timelock. challengeWindow has no setter.
 *
 * Part B (the safe property, FAILS today): while the production alert service is not running
 * (AUDIT_SCOPE.md), the public site must not promise reminders / present the watcher as current
 * evidence, and the pages that sell the veto must disclose that no alert of any kind is sent.
 * This becomes a regression test once either the copy is fixed or alerts are restored and
 * AUDIT_SCOPE.md says so.
 *
 * Read-only: the site files are read from the repo working tree and from commit b8baf34 via
 * `git show`; nothing in the repo is written.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const DAY = 86_400;
const PERIOD = 7 * DAY; // MIN_INACTIVITY
const WINDOW = 7 * DAY; // MIN_CHALLENGE
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

// Resolve the real repo (for the site copy). Works both from the PoC sandbox and if this file
// is later moved into the repo's own test/ directory.
// Evidence-suite port: this repo (working tree and git history), read-only.
const REPO = process.env.WK_REPO ?? path.resolve(__dirname, "..", "..", "..");
const AUDITED_COMMIT = "b8baf34";

describe("PoC F40: no alert path while the site sells the veto and refers to reminders", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    return { vault, admin, alice, bob, carol, feeSink };
  }

  // ------------------------------------------------------------------ Part A: on-chain facts

  describe("A. on chain: the owner is never a party to the claim, and silence = loss at P + C", () => {
    it("initiateClaim leaves no owner-facing trace except one owner-indexed log", async () => {
      const f = await loadFixture(fixture);
      const vaultAddr = await f.vault.getAddress();
      const horizon = (await time.latest()) + 730 * DAY;
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      const v0 = await f.vault.getVault(f.alice.address, 0);

      // Heir fires in the very first second the deadline allows (:644 is `<`, not `<=`).
      await time.setNextBlockTimestamp(Number(v0.deadline));
      const aliceBalBefore = await ethers.provider.getBalance(f.alice.address);
      const aliceNonceBefore = await ethers.provider.getTransactionCount(f.alice.address);

      const tx = await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const rc = (await tx.wait())!;
      const blk = (await ethers.provider.getBlock(rc.blockNumber))!;
      expect(blk.timestamp).to.equal(Number(v0.deadline)); // first possible second

      // What a wallet activity feed / explorer address page is built from: from, to, value,
      // internal value transfers, token Transfer logs. None of them involve the owner.
      expect(rc.from).to.equal(f.bob.address);
      expect(rc.to).to.equal(vaultAddr);
      expect(tx.value).to.equal(0n);
      expect(await ethers.provider.getBalance(f.alice.address)).to.equal(aliceBalBefore);
      expect(await ethers.provider.getTransactionCount(f.alice.address)).to.equal(aliceNonceBefore);

      const TRANSFER = ethers.id("Transfer(address,address,uint256)");
      expect(rc.logs.filter((l) => l.topics[0] === TRANSFER)).to.have.length(0);

      // The ONLY trace: a single ClaimInitiated log, emitted by the vault, owner as topic1.
      expect(rc.logs).to.have.length(1);
      const parsed = f.vault.interface.parseLog(rc.logs[0])!;
      expect(parsed.name).to.equal("ClaimInitiated");
      expect(rc.logs[0].address).to.equal(vaultAddr);
      expect(ethers.getAddress(ethers.dataSlice(rc.logs[0].topics[1], 12))).to.equal(f.alice.address);
      expect(parsed.args.finalizableAt).to.equal(BigInt(blk.timestamp + WINDOW));

      // The contract has no push path: the owner can learn this only by polling a view.
      const w = await f.vault.warningsOf(f.alice.address, 0);
      expect(Number(w) & 4).to.equal(4); // "a claim is pending" -- visible only if someone looks
    });

    it("damage: an owner who is never alerted loses the whole vault after exactly P + C of silence", async () => {
      const f = await loadFixture(fixture);
      const horizon = (await time.latest()) + 730 * DAY;
      const cTx = await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      const cRc = (await cTx.wait())!;
      const createdAt = (await ethers.provider.getBlock(cRc.blockNumber))!.timestamp;
      const fromBlock = cRc.blockNumber + 1;
      const aliceNonce = await ethers.provider.getTransactionCount(f.alice.address);

      const v0 = await f.vault.getVault(f.alice.address, 0);
      await time.setNextBlockTimestamp(Number(v0.deadline));
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const v1 = await f.vault.getVault(f.alice.address, 0);

      // One second early: still vetoable (the veto works -- IF the owner knows).
      await time.setNextBlockTimestamp(Number(v1.finalizableAt) - 1);
      await expect(f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0))
        .to.be.revertedWithCustomError(f.vault, "ChallengeWindowOpen");

      // A third party finalizes at the first legal second.
      await time.setNextBlockTimestamp(Number(v1.finalizableAt));
      const fRc = (await (await f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0)).wait())!;
      const settledAt = (await ethers.provider.getBlock(fRc.blockNumber))!.timestamp;

      // Loss is exactly P + C after the owner's last action: 14 days at the contract minimums.
      expect(settledAt - createdAt).to.equal(PERIOD + WINDOW);
      expect(settledAt - createdAt).to.equal(14 * DAY);

      // Owner sent nothing during the whole episode, and no tx in it touched her address.
      expect(await ethers.provider.getTransactionCount(f.alice.address)).to.equal(aliceNonce);
      for (let b = fromBlock; b <= fRc.blockNumber; b++) {
        const block = (await ethers.provider.getBlock(b, true))!;
        for (const h of block.transactions) {
          const t = (await ethers.provider.getTransaction(h))!;
          expect(t.from).to.not.equal(f.alice.address);
          expect(t.to).to.not.equal(f.alice.address);
        }
      }

      // The owner opens the app afterwards: nothing to veto, vault gone from her list.
      await expect(f.vault.connect(f.alice).abortClaim(0))
        .to.be.revertedWithCustomError(f.vault, "NoClaimPending");
      expect(await f.vault.getOpenVaults(f.alice.address)).to.have.length(0);
      const v2 = await f.vault.getVault(f.alice.address, 0);
      expect(v2.state).to.equal(3); // SETTLED
      expect(v2.balance).to.equal(0n);
      const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(DEPOSIT - fee);

      // And no owner can lengthen the veto window after learning alerts are gone: no setter.
      const challengeSetters = f.vault.interface.fragments.filter(
        (fr: any) =>
          fr.type === "function" &&
          /challenge/i.test(fr.name) &&
          fr.stateMutability !== "view" &&
          fr.stateMutability !== "pure"
      );
      expect(challengeSetters).to.have.length(0);
    });
  });

  // -------------------------------------------------- Part B: the safe property (copy vs ops)

  type Source = { label: string; read: (rel: string) => string };

  const sources: Source[] = [
    {
      label: `commit ${AUDITED_COMMIT}`,
      read: (rel) =>
        execFileSync("git", ["-C", REPO, "show", `${AUDITED_COMMIT}:${rel}`], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        }),
    },
    {
      label: "working tree",
      read: (rel) => fs.readFileSync(path.join(REPO, rel), "utf8"),
    },
  ];

  // Statements that tell a reader a reminder/alert channel exists or that the watcher is current.
  const PROMISES: { file: string; re: RegExp }[] = [
    { file: "site/guides/dead-mans-switch-crypto.html", re: /challenge window and reminders are for/i },
    { file: "site/guides/dead-mans-switch-crypto.html", re: /pairs naturally with reminders that escalate/i },
    { file: "site/guides/crypto-inheritance-planning.html", re: /Check your reminders still reach you/i },
    { file: "site/security.html", re: /watcher scenario passes/i },
  ];

  // Pages that sell the veto as the safeguard for a forgetful/hospitalised owner.
  const VETO_PAGES = [
    "site/index.html",
    "site/how-it-works.html",
    "site/guides/dead-mans-switch-crypto.html",
  ];
  // Any plain disclosure that nothing will alert the owner.
  const DISCLOSURE =
    /(no one|nobody|nothing) will (notify|alert|warn|email)|no (alert|notification|reminder)s? (of any kind )?(is|are|will be) sent|(reminder|claim) (and (claim|expiry) )?alerts are not running|does not (notify|alert|warn) you/i;

  function watcherRetired(src: Source): boolean {
    const scope = src.read("AUDIT_SCOPE.md");
    // The sentence wraps across a line break in AUDIT_SCOPE.md:87-88.
    return /production\s+watcher\s+is\s+not\s+running/i.test(scope);
  }

  for (const src of sources) {
    it(`B [${src.label}]: while no alert service runs, the site must not promise reminders and must disclose the silence`, () => {
      // Precondition taken from the project's own operational status, not assumed.
      const retired = watcherRetired(src);
      expect(retired, "AUDIT_SCOPE.md no longer says the watcher is down; re-evaluate").to.equal(true);

      const promises: string[] = [];
      for (const p of PROMISES) {
        const html = src.read(p.file);
        const lines = html.split(/\r?\n/);
        lines.forEach((ln, i) => {
          if (p.re.test(ln)) promises.push(`${p.file}:${i + 1}: ${ln.trim().slice(0, 140)}`);
        });
      }

      const undisclosed = VETO_PAGES.filter((f) => !DISCLOSURE.test(src.read(f)));

      // SAFE PROPERTY: no reminder promise survives, and every veto-selling page discloses
      // that no alert of any kind is sent.
      expect(
        { promises, undisclosedVetoPages: undisclosed },
        `site promises an alert channel that is not running (${src.label})`
      ).to.deep.equal({ promises: [], undisclosedVetoPages: [] });
    });
  }
});
