// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F44/test/poc-F44.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/index.html, site/app.html, site/guides/*.html.
/**
 * PoC for F44 -- heir discovery: the FAQ says three facts are enough, but nothing on chain or on
 * the site lets an heir holding only those facts find or claim the vault.
 *
 * Tests marked [DEFECT] assert the intended property and FAIL against b8baf34.
 * Tests marked [FEASIBILITY] / [DAMAGE] characterise the fix path and the impact; they pass.
 *
 * The site checks read the repo's site/ tree READ-ONLY (override with F44_SITE_DIR).
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
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

const SITE = process.env.F44_SITE_DIR ?? path.resolve(__dirname, "..", "..", "..", "site"); // repo working tree

describe("F44 heir discovery", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    // Alice (owner) names Bob (heir). This is the only fact Bob holds about the vault: which
    // of his addresses was named. He does NOT hold Alice's address (not among the FAQ's three).
    const horizon = (await time.latest()) + 730 * DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, dave, feeSink, horizon };
  }

  /**
   * Call every view/pure function of the contract whose inputs are all addresses or uints,
   * supplying `who` for every address argument and 0 for every uint, and return
   * [signature, stringified result] for each call that did not revert.
   */
  async function probeViews(vault: any, who: string): Promise<[string, string][]> {
    const out: [string, string][] = [];
    for (const frag of vault.interface.fragments) {
      if (frag.type !== "function") continue;
      const f = frag as any;
      if (f.stateMutability !== "view" && f.stateMutability !== "pure") continue;
      if (f.inputs.length === 0) continue;
      const args: any[] = [];
      let ok = true;
      for (const inp of f.inputs) {
        if (inp.baseType === "address") args.push(who);
        else if (inp.baseType.startsWith("uint")) args.push(0);
        else ok = false;
      }
      if (!ok) continue;
      try {
        const res = await vault[f.format("sighash")](...args);
        out.push([f.format("sighash"), JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v))]);
      } catch {
        /* reverted -- e.g. getVault(heir, 0) on a non-existent vault */
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ [DEFECT] on chain

  it("[DEFECT] a view called with only the heir's address resolves the vault's owner", async () => {
    const f = await loadFixture(fixture);
    await time.increase(PERIOD + 1); // deadline passed: this is exactly when the heir needs it

    // Control: the same probe keyed by the OWNER finds a vault naming the heir, so the probe
    // mechanism works and the index exists -- it is keyed by owner only (InheritanceVault.sol:176).
    const byOwner = await probeViews(f.vault, f.alice.address);
    const ownerHits = byOwner.filter(([, r]) => r.toLowerCase().includes(f.bob.address.toLowerCase()));
    expect(ownerHits.map(([s]) => s), "control: owner-keyed discovery works").to.include(
      "getOpenVaults(address)"
    );

    // Specifics the finding names.
    expect(await f.vault.getOpenVaults(f.bob.address)).to.have.length(0);
    expect(await f.vault.openVaultIds(f.bob.address)).to.have.length(0);
    expect(await f.vault.vaultCount(f.bob.address)).to.equal(0n);

    // Intended property: the heir, who knows only his own address, can get from it to the
    // vault's (owner, id) through the contract's read interface. The owner's address is the
    // thing he lacks, so we look for it in the output of every view keyed by the heir.
    const byHeir = await probeViews(f.vault, f.bob.address);
    const heirHits = byHeir.filter(([, r]) => r.toLowerCase().includes(f.alice.address.toLowerCase()));
    console.log(
      `      probed ${byHeir.length} non-reverting views with the heir's address; ` +
        `views returning the owner's address: ${heirHits.length}`
    );
    expect(
      heirHits.map(([s]) => s),
      "no view resolves a vault from its beneficiary's address (heir-side discovery impossible on chain)"
    ).to.not.be.empty;
  });

  // ------------------------------------------------------------------ [FEASIBILITY] event scan

  it("[FEASIBILITY] an event-log scan keyed by topic3 = heir does find the vault (the recommended fix)", async () => {
    const f = await loadFixture(fixture);
    // Second vault: Dave first names Carol, then switches the heir to Bob (BeneficiaryChanged).
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault
      .connect(f.dave)
      .createVault(NATIVE, DEPOSIT, f.carol.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    await f.vault.connect(f.dave).setBeneficiary(0, f.bob.address);
    // Third vault: Dave names Bob, then removes him -- a stale hit the lookup must drop.
    await f.vault
      .connect(f.dave)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    await f.vault.connect(f.dave).setBeneficiary(1, f.carol.address);

    const created = await f.vault.queryFilter(f.vault.filters.VaultCreated(null, null, f.bob.address));
    const changed = await f.vault.queryFilter(f.vault.filters.BeneficiaryChanged(null, null, f.bob.address));
    const candidates = new Map<string, [string, bigint]>();
    for (const e of [...created, ...changed] as any[]) {
      candidates.set(`${e.args[0]}:${e.args[1]}`, [e.args[0], e.args[1]]);
    }
    const confirmed: string[] = [];
    for (const [key, [owner, id]] of candidates) {
      const v = await f.vault.getVault(owner, id);
      if (v.beneficiary === f.bob.address) confirmed.push(key);
    }
    expect(candidates.size).to.equal(3); // alice#0, dave#0 (via change), dave#1 (stale)
    expect(confirmed.sort()).to.deep.equal([`${f.alice.address}:0`, `${f.dave.address}:0`].sort());
  });

  // ------------------------------------------------------------------ [DAMAGE] T2 freeze

  it("[DAMAGE] if the heir never claims, 10 ETH stays locked forever: nobody else can move it", async () => {
    const f = await loadFixture(fixture);
    const v0 = await f.vault.getVault(f.alice.address, 0);
    // Alice is gone. Go 20 years past the guaranteed-inheritance date.
    await time.increaseTo(Number(v0.guaranteedInheritanceAt) + 20 * 365 * DAY);

    // Third party, admin: cannot initiate (only the beneficiary can, InheritanceVault.sol:643).
    await expect(f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address))
      .to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary");
    await expect(f.vault.connect(f.admin).initiateClaim(f.alice.address, 0, f.admin.address))
      .to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary");
    // Nothing to finalize; the horizon releases to no one.
    await expect(f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0))
      .to.be.revertedWithCustomError(f.vault, "NoClaimPending");
    // Admin cannot reach locked value.
    expect(await f.vault.surplus(NATIVE)).to.equal(0n);
    await expect(f.vault.connect(f.admin).sweepSurplus(NATIVE, f.admin.address))
      .to.be.revertedWithCustomError(f.vault, "NoSurplus");

    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(1); // ACTIVE
    expect(v.expired).to.equal(true);
    expect(v.horizonReached).to.equal(true);
    expect(v.balance).to.equal(DEPOSIT);
    expect(await f.vault.totalLocked(NATIVE)).to.equal(DEPOSIT);
    console.log(
      `      20y past guaranteedInheritanceAt: state ACTIVE, balance ${ethers.formatEther(v.balance)} ETH, ` +
        `only msg.sender == ${v.beneficiary} can ever move it`
    );
  });

  // ------------------------------------------------------------------ [DEFECT] site claims

  describe("site: what the FAQ tells owners to give their heir", () => {
    const read = (rel: string) => fs.readFileSync(path.join(SITE, rel), "utf8");

    function faqAnswer(): string {
      const html = read("index.html");
      const m = html.match(/<summary>What does my heir need to know\?<\/summary>\s*<p>([\s\S]*?)<\/p>/);
      expect(m, "FAQ entry present").to.not.equal(null);
      return m![1].replace(/\s+/g, " ");
    }

    it("[DEFECT] the FAQ's list includes the owner's address, which the heir tab requires", () => {
      const app = read("app.html");
      const heirTab = app.slice(app.indexOf('id="tab-heir"'), app.indexOf('id="heirList"'));
      // Precondition: the app's only heir entry point asks for the owner's address.
      expect(heirTab).to.match(/Vault owner's address/);
      const answer = faqAnswer();
      console.log(`      FAQ answer: "${answer}"`);
      expect(
        answer,
        "FAQ must tell owners to give the heir their (owner's) wallet address"
      ).to.match(/\b(owner'?s|your own|your|their)\s+(public\s+)?(wallet\s+)?address\b/i);
    });

    it("[DEFECT] the promised heir walkthrough exists in the guides", () => {
      const answer = faqAnswer();
      expect(answer).to.match(/guides walk them through it/i); // the promise
      const guideDir = path.join(SITE, "guides");
      const guides = fs.readdirSync(guideDir).filter((n) => n.endsWith(".html"));
      // A walkthrough of the app's heir flow must name its controls (app.js:305, :311, app.html:44).
      const covering = guides.filter((n) => {
        const g = fs.readFileSync(path.join(guideDir, n), "utf8");
        return /Initiate claim/i.test(g) && /Finalize inheritance/i.test(g);
      });
      console.log(`      guides: ${guides.join(", ")}; covering the heir claim flow: ${covering.length}`);
      expect(covering, "a guide walking the heir through lookup -> Initiate claim -> Finalize").to.not.be.empty;
    });

    it("[DEFECT] the FAQ tells the heir that nobody will notify them when the time comes", () => {
      const answer = faqAnswer();
      expect(answer, "FAQ must say the heir has to notice the deadline themselves").to.match(
        /notif|must notice|no one will|nobody will|not be (told|alerted)/i
      );
    });
  });
});
