// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F41/test/poc-F41.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/assets/app.js, site/assets/abi.js.
/**
 * PoC F41 -- the app shows every heir as `0x` + 4 hex ... 4 hex and accepts any well-formed heir
 * address with no confirmation or lookalike check, so an address-poisoned heir can take an
 * inheritance without the owner ever seeing it.
 *
 * The frontend under test is the REAL site/assets/app.js (and site/assets/abi.js), executed in a
 * node:vm context with a minimal DOM shim and wired to a hardhat deployment of InheritanceVault.
 * Nothing in app.js is re-implemented here: cards are rendered by its own vaultCard/refreshMine,
 * the heir is changed by clicking its own "Change heir" button, vaults are created by clicking its
 * own createBtn handler, and the heir tab is driven through its own hLookupBtn handler.
 *
 * Every `it` asserts the SAFE property, so each fails against the current app for the defect
 * itself and passes once the frontend is fixed (full address on cards, lookalike hard-block).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const FEE_BPS = 50;
const TOKENS = ethers.parseEther("1000");

// F41_SITE lets the same tests run against a candidate fix of the frontend.
const SITE = process.env.F41_SITE ?? path.resolve(__dirname, "..", "..", "..", "site", "assets"); // repo working tree
const APP_JS = path.join(SITE, "app.js");
const ABI_JS = path.join(SITE, "abi.js");

// ------------------------------------------------------------------ minimal DOM shim

class FakeText {
  constructor(public text: string) {}
  get textContent() {
    return this.text;
  }
}

class FakeEl {
  tag: string;
  className = "";
  hidden = false;
  value = "";
  type = "";
  href = "";
  target = "";
  rel = "";
  onclick: any = null;
  dataset: any = {};
  children: any[] = [];
  own = "";
  listeners: Record<string, any[]> = {};
  classList = { toggle() {}, add() {}, remove() {} };
  registry: Map<string, FakeEl>;
  _id = "";

  constructor(tag: string, registry: Map<string, FakeEl>) {
    this.tag = tag.toUpperCase();
    this.registry = registry;
  }
  get id() {
    return this._id;
  }
  set id(v: string) {
    this._id = v;
    this.registry.set(v, this);
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.own = String(v);
    this.children = [];
  }
  append(...nodes: any[]) {
    for (const n of nodes) this.children.push(typeof n === "string" ? new FakeText(n) : n);
  }
  replaceChildren(...nodes: any[]) {
    this.own = "";
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type: string, handler: any) {
    (this.listeners[type] ??= []).push(handler);
  }
  // Evidence-suite port: 5bbad6e added log.setAttribute("role", "status") to vaultCard() (ARIA only;
  // the app logic under test is unchanged). The sandbox stub predates it, so it records attributes.
  attrs: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  async click() {
    const event = { target: this, preventDefault() {} };
    for (const handler of this.listeners.click ?? []) await handler(event);
    if (this.onclick) await this.onclick(event);
  }
  closest() {
    return this;
  }
  all(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: any) => {
      for (const c of n.children ?? []) {
        if (c instanceof FakeEl) {
          if (pred(c)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string) {
    const cls = sel.replace(/^\./, "");
    return this.all((e) => e.className.split(/\s+/).includes(cls))[0] ?? null;
  }
}

/** Boots the unmodified app.js with the given signer as the connected wallet. */
function mountApp(vaultAddr: string, signer: any, promptAnswers: string[] = []) {
  const registry = new Map<string, FakeEl>();
  const document = {
    getElementById(id: string) {
      let e = registry.get(id);
      if (!e) {
        e = new FakeEl("div", registry);
        e.id = id;
      }
      return e;
    },
    createElement: (tag: string) => new FakeEl(tag, registry),
    createTextNode: (text: string) => new FakeText(text),
    querySelectorAll: () => [],
  };
  // Every dialog the app raises is recorded. The owner in these scenarios is the victim of a
  // poisoned address, so confirm() is answered "OK": they believe the address is right.
  const dialogs: string[] = [];
  const context = vm.createContext({
    document,
    window: {},
    ethers,
    console,
    location: { reload() {} },
    prompt: (message: string, dflt?: string) => {
      dialogs.push(`prompt(${JSON.stringify(message)}${dflt ? `, ${dflt}` : ""})`);
      return promptAnswers.shift() ?? null;
    },
    confirm: (message: string) => {
      dialogs.push(`confirm(${JSON.stringify(message)})`);
      return true;
    },
    alert: (message: string) => {
      dialogs.push(`alert(${JSON.stringify(message)})`);
    },
  });
  vm.runInContext(fs.readFileSync(ABI_JS, "utf8"), context, { filename: "abi.js" });
  vm.runInContext(fs.readFileSync(APP_JS, "utf8"), context, { filename: "app.js" });
  const app: any = vm.runInContext("({ S, CHAINS, VAULT_ABI, vaultCard, refreshMine })", context);

  app.CHAINS[31337] = {
    name: "Hardhat", contract: vaultAddr, explorer: "https://explorer.invalid",
    hex: "0x7a69", rpc: "", coin: "ETH", testnet: true,
  };
  app.S.provider = ethers.provider;
  app.S.signer = signer;
  app.S.account = ethers.getAddress(signer.address);
  app.S.chainId = 31337;
  app.S.contract = new ethers.Contract(vaultAddr, app.VAULT_ABI, signer);
  return { app, $: (id: string) => document.getElementById(id), dialogs };
}

/**
 * The poisoner's model, independent of the app: same first 4 and last 4 hex characters AND the
 * same EIP-55 casing on them, different middle. A real attacker grinds a private key for this
 * (32 bits + a few casing bits); on hardhat we impersonate the address instead.
 */
function lookalikeOf(target: string): string {
  for (let i = 0; i < 100_000; i++) {
    const mid = ethers.keccak256(ethers.toUtf8Bytes(`F41-lookalike-${i}`)).slice(2, 34);
    const cand = ethers.getAddress(target.slice(0, 6).toLowerCase() + mid + target.slice(-4).toLowerCase());
    if (cand !== target && cand.slice(0, 6) === target.slice(0, 6) && cand.slice(-4) === target.slice(-4)) {
      return cand;
    }
  }
  throw new Error("no lookalike found");
}

const hexOnly = (s: string) => s.toLowerCase().replace(/[^0-9a-fx]/g, "");

describe("F41 poisoned heir address through the app (real app.js in a vm)", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("InheritanceVaultV1", admin)).deploy(
      admin.address, FEE_BPS, feeSink.address,
    );
    const token = await (await ethers.getContractFactory("MintableToken", admin)).deploy();
    await token.mint(alice.address, TOKENS * 10n);
    const vaultAddr = await vault.getAddress();
    const tokenAddr = await token.getAddress();
    const poisoned = lookalikeOf(bob.address); // what sits in alice's wallet history
    return { vault, token, vaultAddr, tokenAddr, admin, alice, bob, carol, dave, feeSink, poisoned };
  }

  async function horizonDate() {
    return new Date(((await time.latest()) + 730 * DAY) * 1000).toISOString().slice(0, 10);
  }

  /** Fills the real create form and clicks the real Create button. */
  async function createViaApp(ui: any, asset: "native" | "erc20", amount: string, heir: string, token = "") {
    ui.$("cAsset").value = asset;
    ui.$("cToken").value = token;
    ui.$("cAmount").value = amount;
    ui.$("cHeir").value = heir;
    ui.$("cPeriod").value = String(PERIOD / DAY);
    ui.$("cWindow").value = String(WINDOW / DAY);
    ui.$("cHorizon").value = await horizonDate();
    await ui.$("createBtn").click();
    return ui.$("createLog").textContent as string;
  }

  async function openVaultNaming(f: any, heir: string) {
    const views = await f.vault.getOpenVaults(f.alice.address);
    return views.find((v: any) => v.beneficiary.toLowerCase() === heir.toLowerCase());
  }

  // ---------------------------------------------------------------- display

  it("the owner's vault card shows the heir's FULL address", async () => {
    const f = await loadFixture(fixture);
    const ui = mountApp(f.vaultAddr, f.alice);
    // Control: the harness really drives the app's create flow end to end.
    const log = await createViaApp(ui, "native", "1", f.bob.address);
    expect(log, "harness: create flow must reach the contract").to.match(/Create vault: confirmed/);

    await ui.app.refreshMine();
    const cards = ui.$("vaultList").children;
    expect(cards.length).to.equal(1);
    const cardText: string = cards[0].textContent;
    const view = (await f.vault.getOpenVaults(f.alice.address))[0];

    // SAFE: the only place an owner can review who inherits must show all 40 hex characters.
    expect(
      hexOnly(cardText).includes(view.beneficiary.toLowerCase()),
      `owner card never shows heir ${view.beneficiary} in full; it reads:\n    "${cardText}"`,
    ).to.equal(true);
  });

  it("the owner's vault card distinguishes the real heir from an 8-hex lookalike", async () => {
    const f = await loadFixture(fixture);
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(NATIVE, 1n, f.bob.address, PERIOD, WINDOW, horizon, { value: 1n });
    const ui = mountApp(f.vaultAddr, f.alice);

    // Identical vault data; only the heir differs (bob vs. the poisoned lookalike).
    const real = (await f.vault.getVault(f.alice.address, 0)).toObject();
    const lookalike = { ...real, beneficiary: f.poisoned };
    const cardReal: string = (await ui.app.vaultCard(real, "owner")).textContent;
    const cardFake: string = (await ui.app.vaultCard(lookalike, "owner")).textContent;

    console.log(`      real heir  ${f.bob.address}\n      lookalike  ${f.poisoned}`);
    console.log(`      card(real)      "${cardReal}"\n      card(lookalike) "${cardFake}"`);
    // SAFE: two different heirs must not render as the same card.
    expect(cardFake, "a lookalike heir renders byte-for-byte identically to the real heir").to.not.equal(cardReal);
  });

  // ---------------------------------------------------------------- input paths

  it("'Change heir' does not put a lookalike of an existing heir on chain", async () => {
    const f = await loadFixture(fixture);
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(NATIVE, 1n, f.bob.address, PERIOD, WINDOW, horizon, { value: 1n });
    await f.vault.connect(f.alice).createVault(NATIVE, 1n, f.carol.address, PERIOD, WINDOW, horizon, { value: 1n });

    // Alice re-points vault #1 to bob, pasting the (lowercase) poisoned entry from her history.
    const ui = mountApp(f.vaultAddr, f.alice, [f.poisoned.toLowerCase()]);
    await ui.app.refreshMine();
    const card1 = ui.$("vaultList").children.find((c: FakeEl) =>
      c.all((e) => e.id === "log-owner-1").length === 1);
    const changeHeir = card1.all((e: FakeEl) => e.tag === "BUTTON" && e.textContent === "Change heir")[0];
    await changeHeir.click();

    const after = await f.vault.getVault(f.alice.address, 1);
    console.log(`      dialogs raised: ${ui.dialogs.join(" | ")}`);
    console.log(`      tx log: "${ui.$("log-owner-1").textContent}"`);
    // SAFE: an address sharing bob's first and last 4 hex but not bob must never be signed through.
    expect(
      after.beneficiary,
      `app set lookalike ${f.poisoned} as heir of vault #1 (known heir ${f.bob.address}); ` +
        `dialogs: ${ui.dialogs.join(" | ")}`,
    ).to.not.equal(f.poisoned);
  });

  it("'Create vault' does not name a lookalike of an existing heir", async () => {
    const f = await loadFixture(fixture);
    const ui = mountApp(f.vaultAddr, f.alice);
    expect(await createViaApp(ui, "native", "1", f.bob.address)).to.match(/Create vault: confirmed/);

    // Second vault for "the same heir", address copied from poisoned wallet history.
    const log = await createViaApp(ui, "erc20", "1000", f.poisoned, f.tokenAddr);
    console.log(`      create log: "${log}"`);
    console.log(`      dialogs raised: ${ui.dialogs.length === 0 ? "none" : ui.dialogs.join(" | ")}`);
    // SAFE: no open vault of alice may name a lookalike of her existing heir.
    const named = await openVaultNaming(f, f.poisoned);
    expect(named, `app created vault #${named?.vaultId} naming lookalike ${f.poisoned}`).to.equal(undefined);
  });

  // ---------------------------------------------------------------- damage

  it("DAMAGE (theft): the lookalike's holder takes the second vault and the real heir never learns", async () => {
    const f = await loadFixture(fixture);
    const owner = mountApp(f.vaultAddr, f.alice);
    expect(await createViaApp(owner, "native", "1", f.bob.address)).to.match(/Create vault: confirmed/);
    await createViaApp(owner, "erc20", "1000", f.poisoned, f.tokenAddr);

    await owner.app.refreshMine();
    const cardLines = owner.$("vaultList").children.map((c: FakeEl) => c.all((e) => e.className === "meta")[0]
      .children[0].textContent);
    console.log(`      alice's "My vaults" review:\n        ${cardLines.join("\n        ")}`);

    // The attacker learns the naming from the indexed topic.
    const logs = await f.vault.queryFilter(f.vault.filters.VaultCreated(null, null, f.poisoned));
    console.log(`      VaultCreated events with beneficiary topic = lookalike: ${logs.length}`);

    // Alice dies. After the deadline the lookalike's holder claims to a fresh wallet (dave).
    await time.increase(PERIOD + 1);
    const stolen = await openVaultNaming(f, f.poisoned);
    const before = await f.token.balanceOf(f.dave.address);
    if (stolen) {
      await impersonateAccount(f.poisoned);
      await setBalance(f.poisoned, ethers.parseEther("1"));
      const attacker = await ethers.getSigner(f.poisoned);
      await f.vault.connect(attacker).initiateClaim(f.alice.address, stolen.vaultId, f.dave.address);
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.carol).finalizeClaim(f.alice.address, stolen.vaultId); // anyone
      await f.vault.connect(f.dave).withdrawCredit(f.tokenAddr, f.dave.address);
    }
    const attackerGain = (await f.token.balanceOf(f.dave.address)) - before;

    // What bob sees in the heir tab.
    const heir = mountApp(f.vaultAddr, f.bob);
    heir.$("hOwner").value = f.alice.address;
    await heir.$("hLookupBtn").click();
    console.log(`      bob's heir-tab lookup shows ${heir.$("heirList").children.length} card(s): ` +
      `"${heir.$("heirList").textContent}"`);
    console.log(`      bob's credit for the token: ${await f.vault.creditOf(f.tokenAddr, f.bob.address)}`);
    console.log(`      attacker (dave) gained ${ethers.formatEther(attackerGain)} TST of ${ethers.formatEther(TOKENS)}`);

    // SAFE: nobody but the intended heir can receive the owner's deposit.
    expect(attackerGain, "attacker walked off with the inheritance").to.equal(0n);
  });

  it("DAMAGE (freeze): a lowercase near-miss of the heir leaves the deposit unclaimable forever", async () => {
    const f = await loadFixture(fixture);
    const owner = mountApp(f.vaultAddr, f.alice);
    expect(await createViaApp(owner, "native", "1", f.bob.address)).to.match(/Create vault: confirmed/);

    // One middle nibble mistyped, all lowercase: ethers.getAddress applies no checksum to it.
    const lower = f.bob.address.toLowerCase();
    const i = 21;
    const typo = lower.slice(0, i) + (lower[i] === "0" ? "1" : "0") + lower.slice(i + 1);
    expect(ethers.getAddress(typo)).to.not.equal(f.bob.address);
    await createViaApp(owner, "erc20", "1000", typo, f.tokenAddr);

    // Alice dies. Go well past horizon + challenge window.
    await time.increase(730 * DAY + WINDOW + 365 * DAY);
    const frozenVault = await openVaultNaming(f, typo);
    let frozen = 0n;
    if (frozenVault) {
      for (const who of [f.bob, f.alice, f.admin, f.carol, f.dave, f.feeSink]) {
        await expect(
          f.vault.connect(who).initiateClaim(f.alice.address, frozenVault.vaultId, who.address),
        ).to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary");
      }
      expect(await f.vault.surplus(f.tokenAddr)).to.equal(0n);
      await expect(f.vault.connect(f.admin).sweepSurplus(f.tokenAddr, f.admin.address))
        .to.be.revertedWithCustomError(f.vault, "NoSurplus");
      frozen = (await f.vault.getVault(f.alice.address, frozenVault.vaultId)).balance;
      console.log(`      typo heir ${ethers.getAddress(typo)} vs real ${f.bob.address}`);
      console.log(`      totalLocked(token) = ${ethers.formatEther(await f.vault.totalLocked(f.tokenAddr))} TST, surplus 0`);
    }
    // SAFE: no deposit made through the app is left with no party able to claim it.
    expect(frozen, "deposit permanently unclaimable").to.equal(0n);
  });
});
