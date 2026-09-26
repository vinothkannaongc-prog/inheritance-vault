// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F47/test/poc-F47.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/assets/app.js, site/assets/abi.js,
//  site/assets/vendor/ethers.umd.min.js.
/**
 * PoC F47 -- irreversible timing parameters are signed with no echo or summary.
 *
 * These tests drive the REAL site code (site/assets/app.js + abi.js + the vendored ethers UMD
 * build) against a local Hardhat deployment of InheritanceVault. The page runs inside a minimal
 * fake DOM; window.ethereum is an EIP-1193 shim over the Hardhat provider, so connect(),
 * BrowserProvider, the site ABI and runTx() all execute unmodified. prompt()/confirm() are stubs
 * that record what the owner was shown.
 *
 * Tests 1-4 assert the SAFE property and fail against the current site code because of F47.
 * Test 5 quantifies the damage on-chain (it passes: it documents behaviour, not the fix).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

const DAY = 86_400;
const PERIOD = 90 * DAY;
const WINDOW = 30 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("1");
const FEE_BPS = 50;

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const T_2046_01_05 = utc(2046, 1, 5); // what the owner meant
const T_2064_01_05 = utc(2064, 1, 5); // what the owner typed (year digits transposed)
const T_2046_03_02 = utc(2046, 3, 2); // what V8 makes of "2046-02-30"
const iso = (t: bigint | number) => new Date(Number(t) * 1000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ site loader

const SITE = [
  process.env.WK_SITE_DIR,
  path.resolve(__dirname, "..", "..", "..", "site"), // evidence-suite port: repo working tree
].find((p) => p && fs.existsSync(path.join(p, "assets", "app.js"))) as string;

const read = (rel: string) => fs.readFileSync(path.join(SITE, "assets", rel), "utf8");

let ETHERS_UMD: any;
function siteEthers() {
  if (!ETHERS_UMD) {
    const exportsObj: any = {};
    new Function("exports", "module", "define", read("vendor/ethers.umd.min.js"))(exportsObj, {}, undefined);
    ETHERS_UMD = exportsObj;
  }
  return ETHERS_UMD;
}

class FakeText {
  nodeType = 3;
  constructor(public text: string) {}
  get textContent() { return this.text; }
  set textContent(v: string) { this.text = String(v); }
}

class FakeEl {
  nodeType = 1;
  id = ""; className = ""; hidden = false; value = ""; href = ""; target = ""; rel = ""; type = "";
  disabled = false; onclick: any = null; style: any = {}; dataset: any = {};
  children: any[] = [];
  listeners: Record<string, Function[]> = {};
  classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  constructor(public tagName: string) {}
  get textContent(): string { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children = [new FakeText(String(v))]; }
  append(...nodes: any[]) { for (const n of nodes) this.children.push(typeof n === "string" ? new FakeText(n) : n); }
  replaceChildren(...nodes: any[]) { this.children = []; this.append(...nodes); }
  addEventListener(type: string, fn: Function) { (this.listeners[type] ??= []).push(fn); }
  // Evidence-suite port: 5bbad6e added log.setAttribute("role", "status") to vaultCard() (ARIA only;
  // the app logic under test is unchanged). The sandbox stub predates it, so it records attributes.
  attrs: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  async fire(type: string) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, target: this }); }
  click() { void this.fire("click"); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
}

async function loadApp(vaultAddr: string, account: string) {
  const byId = new Map<string, FakeEl>();
  const document = {
    getElementById(id: string) {
      if (!byId.has(id)) { const e = new FakeEl("div"); e.id = id; byId.set(id, e); }
      return byId.get(id)!;
    },
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => new FakeText(String(t)),
    querySelectorAll: () => [],
  };
  const ethereum = {
    selectedAddress: undefined,
    on() {},
    async request({ method, params }: { method: string; params?: any[] }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      return network.provider.request({ method, params: params ?? [] });
    },
  };
  const window: any = { ethereum };
  const ui = {
    prompts: [] as string[],
    promptAnswers: [] as (string | null)[],
    dialogs: [] as string[], // every confirm()/alert() text the owner was shown
    confirmAnswer: false,
  };
  const prompt = (msg: string) => { ui.prompts.push(String(msg)); return ui.promptAnswers.shift() ?? null; };
  const confirm = (msg: string) => { ui.dialogs.push(String(msg)); return ui.confirmAnswer; };
  const alert = (msg: string) => { ui.dialogs.push(String(msg)); };

  const VAULT_ABI = new Function(`${read("abi.js")}\n;return VAULT_ABI;`)();
  const app = new Function(
    "window", "document", "prompt", "confirm", "alert", "location", "ethers", "VAULT_ABI",
    `${read("app.js")}\n;return { S, CHAINS, actHorizon, vaultCard, refreshMine, fmtWhen, connect };`,
  )(window, document, prompt, confirm, alert, { reload() {} }, siteEthers(), VAULT_ABI);

  // The one line of configuration a local deployment needs: register the Hardhat chain.
  app.CHAINS[31337] = {
    name: "Hardhat", contract: vaultAddr, explorer: "http://localhost", hex: "0x7a69",
    rpc: "", coin: "ETH", testnet: true,
  };
  await app.connect();
  expect(app.S.contract, "harness: site connect() did not attach the contract").to.not.equal(null);
  return { app, ui, $: (id: string) => document.getElementById(id), destroy: () => app.S.provider?.destroy?.() };
}

// ------------------------------------------------------------------ tests

describe("PoC F47 -- irreversible timing inputs signed without echo or summary", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const horizon = (await time.latest()) + 730 * DAY;
    await vault.connect(alice).createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, vaultAddr: await vault.getAddress(), admin, alice, bob, carol, horizon };
  }

  let destroy: (() => void) | undefined;
  afterEach(() => { destroy?.(); destroy = undefined; });

  it("actHorizon rejects an impossible calendar date instead of signing the rolled-over one", async () => {
    const f = await loadFixture(fixture);
    const h = await loadApp(f.vaultAddr, f.alice.address);
    destroy = h.destroy;
    h.ui.promptAnswers.push("2046-02-30");
    h.ui.confirmAnswer = true; // even an owner who clicks OK on any review must not get March 2nd

    const before = (await f.vault.getVault(f.alice.address, 0)).absoluteDeadline;
    await h.app.actHorizon(0);
    const after = (await f.vault.getVault(f.alice.address, 0)).absoluteDeadline;

    expect(
      after,
      `owner typed 2046-02-30; the site signed extendHorizon and the vault horizon is now ${iso(after)} ` +
      `(log: "${h.$("log-owner-0").textContent}")`,
    ).to.equal(before);
  });

  it("actHorizon echoes the resolved date with an irreversibility warning, and declining signs nothing", async () => {
    const f = await loadFixture(fixture);
    const h = await loadApp(f.vaultAddr, f.alice.address);
    destroy = h.destroy;
    h.ui.promptAnswers.push("2064-01-05"); // meant 2046-01-05
    h.ui.confirmAnswer = false;            // the owner would decline if shown "2064 ... can never be lowered"

    const before = (await f.vault.getVault(f.alice.address, 0)).absoluteDeadline;
    await h.app.actHorizon(0);
    const after = (await f.vault.getVault(f.alice.address, 0)).absoluteDeadline;

    expect(
      after,
      `no review was shown (dialogs: ${JSON.stringify(h.ui.dialogs)}); extendHorizon was signed straight ` +
      `from the prompt and the horizon moved ${iso(before)} -> ${iso(after)}`,
    ).to.equal(before);
    expect(
      h.ui.dialogs.some((m) => m.includes("2064") && /never|cannot|can't|irrevers|only (be )?(raised|extended|increased)/i.test(m)),
      "the pre-sign review must show the resolved date and say the horizon can never be lowered",
    ).to.equal(true);
  });

  it("the owner's vault card shows the current horizon, not only horizon + challenge window", async () => {
    const f = await loadFixture(fixture);
    const h = await loadApp(f.vaultAddr, f.alice.address); // connect() -> refreshMine() renders the card
    destroy = h.destroy;
    const v = await f.vault.getVault(f.alice.address, 0);
    const card = h.$("vaultList").textContent;

    // Harness sanity: the card rendered, and the guaranteed date (horizon + window) is on it.
    expect(card, "harness: card not rendered").to.include(h.app.fmtWhen(v.guaranteedInheritanceAt));
    expect(h.app.fmtWhen(v.absoluteDeadline)).to.not.equal(h.app.fmtWhen(v.guaranteedInheritanceAt));
    expect(h.app.fmtWhen(v.absoluteDeadline)).to.not.equal(h.app.fmtWhen(v.deadline));

    const shown = [h.app.fmtWhen(v.absoluteDeadline), iso(v.absoluteDeadline)].some((s) => card.includes(s));
    expect(
      shown,
      `current horizon ${iso(v.absoluteDeadline)} (${h.app.fmtWhen(v.absoluteDeadline)}) is not on the card: "${card}"`,
    ).to.equal(true);
  });

  it("createVault shows a pre-sign summary (immutable window, raise-only horizon) and declining creates nothing", async () => {
    const f = await loadFixture(fixture);
    const h = await loadApp(f.vaultAddr, f.carol.address);
    destroy = h.destroy;
    h.$("cAsset").value = "native";
    h.$("cAmount").value = "1";
    h.$("cHeir").value = f.bob.address;
    h.$("cPeriod").value = "90";
    h.$("cWindow").value = "365"; // meant 35: the maximum, immutable veto window
    // cHorizon keeps the page's own default (today + 20 years), set by app.js on load.
    h.ui.confirmAnswer = false;

    await h.$("createBtn").fire("click");
    const count = await f.vault.vaultCount(f.carol.address);
    const created = count > 0n ? await f.vault.getVault(f.carol.address, 0) : undefined;

    expect(
      count,
      `no summary was shown (dialogs: ${JSON.stringify(h.ui.dialogs)}); createVault was signed and vault #0 ` +
      `now has an immutable ${created ? Number(created.challengeWindow) / DAY : "?"}-day challenge window ` +
      `(log: "${h.$("createLog").textContent}")`,
    ).to.equal(0n);
    expect(
      h.ui.dialogs.some((m) => m.includes("365") && /immutable|cannot be changed|can never be changed|permanent/i.test(m)),
      "the pre-sign summary must show the challenge window and mark it immutable",
    ).to.equal(true);
  });

  it("[damage] a transposed year cannot be corrected on the vault and delays the heir 18 years under zombie check-ins", async () => {
    const f = await loadFixture(fixture);
    // A control vault #1 for the same owner, same parameters, whose horizon is set correctly.
    await f.vault.connect(f.alice).createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, f.horizon, { value: DEPOSIT });

    const h = await loadApp(f.vaultAddr, f.alice.address);
    destroy = h.destroy;
    h.ui.promptAnswers.push("2064-01-05", "2046-01-05", "2046-01-05");
    await h.app.actHorizon(0); // the typo, signed through the real site flow
    await h.app.actHorizon(0); // the owner's attempted correction through the site
    await h.app.actHorizon(1); // the control vault gets the intended date
    expect((await f.vault.getVault(f.alice.address, 0)).absoluteDeadline).to.equal(BigInt(T_2064_01_05));
    expect((await f.vault.getVault(f.alice.address, 1)).absoluteDeadline).to.equal(BigInt(T_2046_01_05));
    expect(h.$("log-owner-0").textContent).to.match(/Extend horizon failed/);

    // The horizon is raise-only: the correction reverts on-chain, so the vault cannot be fixed.
    await expect(f.vault.connect(f.alice).extendHorizon(0, T_2046_01_05))
      .to.be.revertedWithCustomError(f.vault, "HorizonNotExtended")
      .withArgs(T_2064_01_05, T_2046_01_05);

    // T3: the owner is gone, but a scheduled check-in bot holding the owner key keeps running.
    // It checks in every 80 days (period 90) and ignores reverts, like unattended automation.
    const bot = async (id: number) => { try { await f.vault.connect(f.alice).checkIn(id); } catch { /* HorizonReached */ } };
    let t = await time.latest();
    while (t + 80 * DAY < T_2046_01_05) { t += 80 * DAY; await time.increaseTo(t); await bot(0); await bot(1); }

    // One day past the INTENDED horizon.
    await time.increaseTo(T_2046_01_05 + DAY);
    await expect(f.vault.connect(f.alice).checkIn(1)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address); // control: heir can claim
    await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
      .to.be.revertedWithCustomError(f.vault, "NotYetExpired");

    // The bot keeps the typo'd vault alive for another 18 years.
    t = await time.latest();
    while (t + 80 * DAY < T_2064_01_05) { t += 80 * DAY; await time.increaseTo(t); await bot(0); }
    await time.increaseTo(T_2064_01_05 - DAY);
    await f.vault.connect(f.alice).checkIn(0); // still accepted a day before the typo'd horizon
    await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
      .to.be.revertedWithCustomError(f.vault, "NotYetExpired");

    await time.increaseTo(T_2064_01_05);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const delayDays = (T_2064_01_05 - T_2046_01_05) / DAY;
    console.log(`      heir's earliest claim: control vault ${iso(T_2046_01_05)}, typo'd vault ${iso(T_2064_01_05)} ` +
      `(+${delayDays} days, ~${(delayDays / 365.25).toFixed(1)} years)`);
    expect(delayDays).to.equal(6574);
  });

  it("[context] V8 rolls impossible ISO dates over rather than returning NaN", () => {
    expect(Date.parse("2046-02-30T00:00:00Z") / 1000).to.equal(T_2046_03_02);
    expect(Date.parse("2046-02-31T00:00:00Z") / 1000).to.equal(utc(2046, 3, 3));
    expect(Number.isNaN(Date.parse("2046-02-32T00:00:00Z"))).to.equal(true);
  });
});
