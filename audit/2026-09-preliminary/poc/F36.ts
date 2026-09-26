// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F36/test/poc-F36.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/assets/app.js.
/**
 * PoC for audit finding F36: anyone can name any address as the heir of a vault holding an
 * arbitrary token, and the site's heir card renders that token by its self-reported symbol()
 * only, with no token address and no allowlist flag.
 *
 * Test 1 asserts the SAFE property on the real site code (site/assets/app.js, loaded verbatim:
 * vaultCard -> fmtAmount -> meta) and FAILS today: the heir card for a vault holding a
 * look-alike "USDC" gives the heir nothing that tells it apart from real USDC.
 * Test 2 quantifies the contract-level surface (no heir consent, beneficiary-indexed logs,
 * cost to the spammer, zero on-chain loss). It passes; it records behaviour, not a fix.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import * as ethersLib from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50;
const MILLION_USDC = 1_000_000n * 10n ** 6n; // 6 decimals, as real USDC

// F36_APP_JS lets a reviewer point the test at a candidate fix without touching the site copy.
const APP_JS = process.env.F36_APP_JS || path.join(__dirname, "..", "..", "..", "site", "assets", "app.js"); // repo working tree

// ---------------------------------------------------------------- minimal DOM for app.js

class FakeNode {
  children: any[] = [];
  className = "";
  id = "";
  type = "";
  hidden = false;
  constructor(public tag: string) {}
  set textContent(value: string) {
    this.children = [{ textContent: String(value) }];
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }
  append(...nodes: any[]) {
    for (const n of nodes) this.children.push(typeof n === "string" ? { textContent: n } : n);
  }
  replaceChildren(...nodes: any[]) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener() {}
  // So a fix that puts the token address in an attribute (explorer href, title) is still seen.
  attrs: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => ({ textContent: String(text) }),
  getElementById: () => null,
};

/** Leaf texts joined by " | " -- only for readable failure messages. */
function pretty(node: any): string {
  const leaves: string[] = [];
  const walk = (n: any) => {
    if (!(n instanceof FakeNode)) {
      if (n.textContent.trim()) leaves.push(n.textContent.trim());
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return leaves.join(" | ");
}

/**
 * Loads the site's own rendering code from app.js, unmodified, by slicing the declarations the
 * heir card depends on. Throws if a marker moved, so a refactor fails loudly instead of passing.
 */
function loadApp(provider: any) {
  const src = fs.readFileSync(APP_JS, "utf8");
  const between = (start: string, end: string) => {
    const i = src.indexOf(start);
    const j = i < 0 ? -1 : src.indexOf(end, i);
    if (i < 0 || j < 0) throw new Error(`app.js marker not found: ${start} .. ${end}`);
    return src.slice(i, j);
  };
  const code = [
    between("const CHAINS", "function notice("), // CHAINS, ZERO, STATES, ERC20_ABI, S, tokenMeta, short, element, button
    between("function fmtWhen(", "function renderTx("), // fmtWhen, fmtCountdown, meta, fmtAmount
    between("function warningLines(", "function ownerLog("),
    between("async function vaultCard(", "async function refreshMine("),
  ].join("\n");
  const factory = new Function(
    "ethers",
    "document",
    "provider",
    `"use strict";\n${code}\nS.provider = provider; S.chainId = 8453;\nreturn { vaultCard, fmtAmount };`,
  );
  return factory(ethersLib, fakeDocument, provider) as {
    vaultCard: (vault: any, role: string) => Promise<FakeNode>;
    fmtAmount: (token: string, amount: bigint) => Promise<string>;
  };
}

const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const UNVERIFIED_FLAG =
  /unverified|not verified|unknown token|unlisted|not (on|in) (the )?allow ?list|not a recogni[sz]ed token/i;

// ---------------------------------------------------------------- fixture

describe("F36 heir-targeted spam vaults with look-alike tokens", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, mallory, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const vaultAddr = await vault.getAddress();
    const Tok = await ethers.getContractFactory("F36_LabelledToken");

    // The genuine asset Alice (Dave's parent) really holds.
    const usdc = await Tok.connect(admin).deploy("USD Coin", "USDC", 6);
    // Mallory's worthless look-alike: same name, symbol and decimals, minted for free.
    const fake = await Tok.connect(mallory).deploy("USD Coin", "USDC", 6);

    const horizon = (await time.latest()) + 730 * DAY;

    await usdc.mint(alice.address, MILLION_USDC);
    await usdc.connect(alice).approve(vaultAddr, MILLION_USDC);
    await vault.connect(alice).createVault(await usdc.getAddress(), MILLION_USDC, dave.address, PERIOD, WINDOW, horizon);

    // Dave signs nothing. Mallory names him as heir anyway.
    await fake.connect(mallory).mint(mallory.address, MILLION_USDC);
    await fake.connect(mallory).approve(vaultAddr, MILLION_USDC);
    await vault.connect(mallory).createVault(await fake.getAddress(), MILLION_USDC, dave.address, PERIOD, WINDOW, horizon);

    return { vault, vaultAddr, admin, alice, mallory, carol, dave, feeSink, usdc, fake, horizon };
  }

  // The site's heir flow (app.js hLookupBtn): the heir types an owner address, and the page
  // lists that owner's open vaults whose beneficiary is the connected wallet.
  async function heirLookup(f: any, owner: string) {
    const vaults = await f.vault.getOpenVaults(owner);
    return vaults.filter((v: any) => v.beneficiary.toLowerCase() === f.dave.address.toLowerCase());
  }

  it("heir card for a vault in a look-alike token must identify the token (address or unverified flag)", async () => {
    const f = await loadFixture(fixture);
    const app = loadApp(ethers.provider);

    const [genuine] = await heirLookup(f, f.alice.address);
    const [spoof] = await heirLookup(f, f.mallory.address);
    // Fixture sanity, not the defect: both lookups found exactly the vault they should.
    expect(genuine.token).to.equal(await f.usdc.getAddress());
    expect(spoof.token).to.equal(await f.fake.getAddress());

    const genuineCard = await app.vaultCard(genuine, "heir");
    const spoofCard = await app.vaultCard(spoof, "heir");

    const text = spoofCard.textContent.toLowerCase();
    const fakeAddr = spoof.token as string;
    // Every own property of every node (href, title, attrs, text leaves) -- not just visible text.
    const everything = JSON.stringify(spoofCard).toLowerCase();
    const identifiesToken =
      text.includes(fakeAddr.toLowerCase()) ||
      text.includes(shortAddr(fakeAddr).toLowerCase()) ||
      everything.includes(fakeAddr.toLowerCase()) ||
      UNVERIFIED_FLAG.test(spoofCard.textContent);

    expect(
      identifiesToken,
      `\n  Mallory's spam vault, as the site shows it to Dave:\n    ${pretty(spoofCard)}` +
        `\n  Alice's genuine vault, as the site shows it to Dave:\n    ${pretty(genuineCard)}` +
        `\n  Look-alike token ${fakeAddr} (real USDC here is ${genuine.token}) appears nowhere on the card\n`,
    ).to.equal(true);
  });

  it("quantify: no heir consent, beneficiary-indexed logs, near-zero cost, zero on-chain loss", async () => {
    const f = await loadFixture(fixture);
    const daveEthBefore = await ethers.provider.getBalance(f.dave.address);

    // A second spammer shows the per-owner cap (MAX_OPEN_VAULTS = 32) is no limit on spam:
    // fresh addresses are free. One raw unit of a worthless token is enough.
    const Tok = await ethers.getContractFactory("F36_LabelledToken");
    const fake2 = await Tok.connect(f.carol).deploy("USD Coin", "USDC", 6);
    await fake2.connect(f.carol).mint(f.carol.address, 1n);
    await fake2.connect(f.carol).approve(f.vaultAddr, 1n);
    const horizon = (await time.latest()) + 730 * DAY;
    const tx = await f.vault
      .connect(f.carol)
      .createVault(await fake2.getAddress(), 1n, f.dave.address, 7 * DAY, 7 * DAY, horizon);
    const rcpt = await tx.wait();
    console.log(`      gas for one spam createVault (ERC20, 1 raw unit): ${rcpt!.gasUsed}`);

    // Dave never sent a transaction: nothing asked for or recorded his consent.
    expect(await ethers.provider.getTransactionCount(f.dave.address)).to.equal(0);

    // Any indexer or explorer filtering VaultCreated by the indexed beneficiary topic sees all three.
    const logs = await f.vault.queryFilter(f.vault.filters.VaultCreated(null, null, f.dave.address));
    expect(logs.length).to.equal(3);
    const rows = [];
    for (const log of logs) {
      const a = (log as any).args;
      const t = await ethers.getContractAt("F36_LabelledToken", a.token);
      rows.push({ owner: a.owner, token: a.token, symbol: await t.symbol(), name: await t.name(), decimals: await t.decimals(), amount: a.amount });
    }
    console.log("      VaultCreated logs with beneficiary topic = Dave:");
    for (const r of rows) {
      console.log(`        owner ${r.owner}  ${ethersLib.formatUnits(r.amount, r.decimals)} ${r.symbol} ("${r.name}")  token ${r.token}`);
    }
    // Every token-describing field except the address is identical between genuine and spam.
    for (const r of rows) {
      expect([r.symbol, r.name, r.decimals]).to.deep.equal(["USDC", "USD Coin", 6n]);
    }
    expect(new Set(rows.map((r) => r.token)).size).to.equal(3);

    // The contract itself stays safe: nothing reaches Dave, and his balances are untouched.
    expect(await ethers.provider.getBalance(f.dave.address)).to.equal(daveEthBefore);
    for (const r of rows) {
      expect(await f.vault.creditOf(r.token, f.dave.address)).to.equal(0n);
    }
    expect(await f.usdc.balanceOf(f.dave.address)).to.equal(0n);
  });
});
