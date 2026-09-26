// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F19/test/poc-F19.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/assets/app.js, site/assets/abi.js.
/**
 * PoC for audit finding F19 (LOW, frontend-vs-contract / state-machine UX):
 *
 *   Past the horizon the app still offers "Veto claim" (and "Change heir"), which always revert,
 *   and never points the owner to the only remaining veto (extendHorizon to >= now + period).
 *
 * The contract side is correct and is pinned first as ground truth (passing test). The defect is
 * in site/assets/app.js, so the remaining tests load the REAL app.js + abi.js into a node:vm
 * context with a minimal DOM stub, wire the app's `S.contract` to the deployed test vault with
 * the owner's signer, render the owner's vault card with the app's own `vaultCard()`, and click
 * the buttons exactly as the owner would. They assert the intended (safe) behaviour and FAIL
 * against the current app.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const DAY = 86_400;
const PERIOD = 90 * DAY; // the owner's 90-day check-in period from the finding's scenario
const WINDOW = 7 * DAY; // MIN_CHALLENGE: the shortest veto window
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

const STATE_ACTIVE = 1;
const STATE_CLAIM_PENDING = 2;
const STATE_SETTLED = 3;
const ACT_EXTEND_HORIZON = 3;

// Evidence-suite port: the site is read (read-only) from this repo's working tree.
const REPO_SITE_ASSETS = path.resolve(__dirname, "..", "..", "..", "site", "assets");
function assetsDir(): string {
  if (process.env.F19_ASSETS_DIR) return process.env.F19_ASSETS_DIR; // fix-check override
  return REPO_SITE_ASSETS;
}

// ------------------------------------------------------------------ minimal DOM stub

type Node = FakeEl | { nodeType: 3; textContent: string };

class FakeEl {
  static registry = new Map<string, FakeEl>();
  tagName: string;
  className = "";
  children: Node[] = [];
  listeners: Record<string, Function[]> = {};
  hidden = false;
  value = "";
  type = "";
  href = "";
  target = "";
  rel = "";
  onclick: any = null;
  private _id = "";
  private _text = "";
  classList = { toggle: () => undefined };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get id() {
    return this._id;
  }
  set id(v: string) {
    this._id = v;
    FakeEl.registry.set(v, this);
  }
  get textContent(): string {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this._text = String(v);
    this.children = [];
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]) {
    this._text = "";
    this.children = [...nodes];
  }
  addEventListener(type: string, fn: Function) {
    (this.listeners[type] ||= []).push(fn);
  }
  // Evidence-suite port: 5bbad6e added log.setAttribute("role", "status") to vaultCard() (ARIA only;
  // the app logic under test is unchanged). The sandbox stub predates it, so it records attributes.
  attrs: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  click(): Promise<unknown[]> {
    return Promise.all((this.listeners.click || []).map((fn) => fn({ preventDefault() {}, target: this })));
  }
  querySelector() {
    return null;
  }
}

function allButtons(root: Node, out: FakeEl[] = []): FakeEl[] {
  if (root instanceof FakeEl) {
    if (root.tagName === "BUTTON") out.push(root);
    for (const c of root.children) allButtons(c, out);
  }
  return out;
}

// ------------------------------------------------------------------ load the real app

async function loadApp(vaultAddr: string, ownerSigner: any) {
  FakeEl.registry.clear();
  const document = {
    getElementById(id: string) {
      if (!FakeEl.registry.has(id)) {
        const el = new FakeEl("div");
        el.id = id;
      }
      return FakeEl.registry.get(id)!;
    },
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => ({ nodeType: 3 as const, textContent: String(text) }),
    querySelectorAll: () => [],
  };
  const prompts: { message: string; def: any }[] = [];
  const ctx: any = {
    document,
    window: {},
    location: { reload() {} },
    console,
    ethers,
    __chainNow: await time.latest(),
    __promptImpl: (_m: string, _d?: string): string | null => null,
    prompts,
  };
  ctx.prompt = (message: string, def?: string) => {
    prompts.push({ message, def });
    return ctx.__promptImpl(message, def);
  };
  vm.createContext(ctx);
  // A browser's clock tracks the chain's; the test warps the chain, so the page clock follows it.
  vm.runInContext(
    `const __RealDate = Date;
     class ChainDate extends __RealDate {
       constructor(...a) { if (a.length === 0) super(globalThis.__chainNow * 1000); else super(...a); }
       static now() { return globalThis.__chainNow * 1000; }
     }
     globalThis.Date = ChainDate;`,
    ctx,
  );
  const dir = assetsDir();
  vm.runInContext(fs.readFileSync(path.join(dir, "abi.js"), "utf8"), ctx, { filename: "abi.js" });
  vm.runInContext(fs.readFileSync(path.join(dir, "app.js"), "utf8"), ctx, { filename: "app.js" });

  const abi = JSON.parse(vm.runInContext("JSON.stringify(VAULT_ABI)", ctx));
  const contract = new ethers.Contract(vaultAddr, abi, ownerSigner);
  const calls: { fn: string; args: any[] }[] = [];
  // Records what the app actually submits, without changing it.
  ctx.__contract = new Proxy(contract, {
    get(target, prop, _receiver) {
      const v = Reflect.get(target, prop, target);
      if (typeof prop === "string" && typeof v === "function") {
        return (...args: any[]) => {
          calls.push({ fn: prop, args });
          return v(...args);
        };
      }
      return v;
    },
  });
  ctx.__account = await ownerSigner.getAddress();
  ctx.__vaultAddr = vaultAddr;
  vm.runInContext(
    `CHAINS[31337] = { name: "Hardhat", contract: __vaultAddr, explorer: "http://localhost",
                       hex: "0x7a69", rpc: "", coin: "ETH", testnet: true };
     S.chainId = 31337; S.account = __account; S.signer = null; S.contract = __contract;`,
    ctx,
  );

  async function syncClock() {
    ctx.__chainNow = await time.latest();
  }
  async function ownerCard(): Promise<FakeEl> {
    await syncClock();
    const vaults = await contract.getOpenVaults(ctx.__account);
    return ctx.vaultCard(vaults[0], "owner");
  }
  const button = (card: FakeEl, label: RegExp) => allButtons(card).find((b) => label.test(b.textContent));
  const logText = (id: number) => FakeEl.registry.get(`log-owner-${id}`)?.textContent ?? "";
  return { ctx, contract, calls, prompts, ownerCard, button, logText, syncClock };
}

// ------------------------------------------------------------------ fixture

describe("F19 post-horizon veto UX: app offers controls the contract always rejects", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const t0 = await time.latest();
    // Horizon one day past the first inactivity deadline, so the heir can claim either side of it.
    const horizon = t0 + PERIOD + DAY;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, feeSink, horizon };
  }

  /** Alice is alive but has not checked in; the horizon passes; Bob starts a claim. */
  async function pastHorizonClaim() {
    const f = await loadFixture(fixture);
    await time.increaseTo(f.horizon + 60);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(STATE_CLAIM_PENDING);
    expect(v.horizonReached).to.equal(true);
    return f;
  }

  // ---------------------------------------------------------------- contract ground truth

  it("ground truth (passes): past the horizon only extendHorizon >= now + period can stop a claim; a window straddling H flips mid-window", async () => {
    const f = await loadFixture(fixture);
    const H = f.horizon;

    // Bob initiates two seconds before the horizon (inactivity deadline already passed).
    await time.setNextBlockTimestamp(H - 2);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const snap = await takeSnapshot();

    // Branch A: at H - 1 the ordinary veto still works...
    await time.setNextBlockTimestamp(H - 1);
    await expect(f.vault.connect(f.alice).abortClaim(0)).to.emit(f.vault, "ClaimAborted");
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);
    await snap.restore();

    // Branch B: ...one second later, for the rest of the >= 7-day window, it never will again.
    await time.setNextBlockTimestamp(H);
    await expect(f.vault.connect(f.alice).abortClaim(0))
      .to.be.revertedWithCustomError(f.vault, "HorizonReached")
      .withArgs(H);
    await expect(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address))
      .to.be.revertedWithCustomError(f.vault, "HorizonReached")
      .withArgs(H);
    await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(
      f.vault,
      "ClaimPendingUseAbort",
    );

    // Three days before the window closes the owner tries "next week" as a new horizon: refused.
    const late = H - 2 + WINDOW - 3 * DAY;
    await time.increaseTo(late);
    const nextWeek = late + 7 * DAY;
    await expect(f.vault.connect(f.alice).extendHorizon(0, nextWeek)).to.be.revertedWithCustomError(
      f.vault,
      "HorizonTooSoon",
    );

    // The one remaining veto: a horizon at least one inactivity period out.
    const ok = late + PERIOD + 100;
    await expect(f.vault.connect(f.alice).extendHorizon(0, ok))
      .to.emit(f.vault, "ClaimSuperseded")
      .withArgs(f.alice.address, 0, ACT_EXTEND_HORIZON);
    const v = await f.vault.getVault(f.alice.address, 0);
    expect(v.state).to.equal(STATE_ACTIVE);
    expect(v.claimRecipient).to.equal(ethers.ZeroAddress);
  });

  // ---------------------------------------------------------------- the app (real app.js)

  it("app: every claim-stopping button the owner card offers past the horizon actually works", async () => {
    const f = await pastHorizonClaim();
    const app = await loadApp(await f.vault.getAddress(), f.alice);
    const card = await app.ownerCard();
    const labels = allButtons(card).map((b) => b.textContent);
    console.log("      owner card buttons:", JSON.stringify(labels));
    const warnings: string[] = [];
    const walk = (n: Node) => {
      if (n instanceof FakeEl) {
        if (n.className === "warning-text") warnings.push(n.textContent);
        n.children.forEach(walk);
      }
    };
    walk(card);
    console.log("      owner card warnings:", JSON.stringify(warnings));

    app.ctx.__promptImpl = (message: string) => (/heir/i.test(message) ? f.carol.address : null);
    const broken: string[] = [];
    for (const label of [/^Veto claim$/, /^Change heir$/]) {
      const b = app.button(card, label);
      if (!b) continue; // hiding the control is an acceptable fix
      await b.click();
      const v = await f.vault.getVault(f.alice.address, 0);
      if (v.state === BigInt(STATE_CLAIM_PENDING)) broken.push(`${b.textContent} -> ${app.logText(0)}`);
      await app.syncClock();
    }
    expect(
      broken,
      "owner card offered controls that the contract rejects past the horizon; the claim is still pending",
    ).to.deep.equal([]);
  });

  it("app: the owner can learn the only remaining veto (minimum horizon now + period) before submitting", async () => {
    const f = await pastHorizonClaim();
    const app = await loadApp(await f.vault.getAddress(), f.alice);
    const card = await app.ownerCard();
    const now = await time.latest();
    const floor = now + PERIOD;

    // Every acceptable way of stating the floor date: the app's own fmtWhen, or an ISO date,
    // for the floor day and the day after (rounding tolerance).
    const floorStrings = [floor, floor + DAY].flatMap((t) => [
      app.ctx.fmtWhen(t) as string,
      new Date(t * 1000).toISOString().slice(0, 10),
    ]);
    const mentions = (s: string) => floorStrings.some((d) => s.includes(d));

    // Open the horizon prompt the way the owner would, then cancel it, recording what it showed.
    app.ctx.__promptImpl = () => null;
    const extend = app.button(card, /horizon|stop this claim/i);
    if (extend) await extend.click();
    const shown = app.prompts.map((p) => `${p.message} ${p.def ?? ""}`).join(" | ");
    const prefilledOk = app.prompts.some((p) => {
      const t = p.def ? Date.parse(`${p.def}T00:00:00Z`) / 1000 : NaN;
      return !Number.isNaN(t) && t >= floor;
    });

    const cardText = card.textContent;
    console.log("      card text:", JSON.stringify(cardText));
    console.log("      horizon prompt:", JSON.stringify(shown));
    expect(
      mentions(cardText) || mentions(shown) || prefilledOk,
      `neither the card nor the horizon prompt tells the owner the minimum horizon (${floorStrings[0]}) that stops this claim`,
    ).to.equal(true);
  });

  it("app: 'Extend horizon' never submits a date below the contract floor (now + inactivityPeriod)", async () => {
    const f = await pastHorizonClaim();
    const app = await loadApp(await f.vault.getAddress(), f.alice);
    const card = await app.ownerCard();
    const now = await time.latest();
    const nextWeek = new Date((now + 7 * DAY) * 1000).toISOString().slice(0, 10);
    app.ctx.__promptImpl = (message: string) => (/date|horizon/i.test(message) ? nextWeek : null);

    await app.button(card, /horizon|stop this claim/i)!.click();
    const submitted = app.calls
      .filter((c) => c.fn === "extendHorizon")
      .map((c) => Number(c.args[1]));
    const belowFloor = submitted.filter((t) => t < now + PERIOD);
    console.log("      extendHorizon submitted:", submitted, "floor >=", now + PERIOD);
    console.log("      owner log:", JSON.stringify(app.logText(0)));
    expect(
      belowFloor,
      "the app sent extendHorizon with a date the contract must reject (HorizonTooSoon)",
    ).to.deep.equal([]);
  });

  // ---------------------------------------------------------------- damage

  it("damage: a live owner who uses the app's stop controls inside the window still loses the vault", async () => {
    const f = await pastHorizonClaim();
    const app = await loadApp(await f.vault.getAddress(), f.alice);
    const initiatedAt = Number((await f.vault.getVault(f.alice.address, 0)).claimInitiatedAt);

    // Day 1 of the window. Alice objects. Her model of a user: accept any value the app pre-fills;
    // otherwise type the obvious answer (her daughter Carol as heir, "next week" as a new horizon).
    await time.increase(DAY);
    const card = await app.ownerCard();
    const now = await time.latest();
    const nextWeek = new Date((now + 7 * DAY) * 1000).toISOString().slice(0, 10);
    app.ctx.__promptImpl = (message: string, def?: string) => {
      if (def) return def;
      if (/heir/i.test(message)) return f.carol.address;
      if (/date|horizon/i.test(message)) return nextWeek;
      return null;
    };
    const tried: string[] = [];
    for (const b of allButtons(card)) {
      if (!/veto|stop|heir|horizon/i.test(b.textContent)) continue;
      await b.click();
      tried.push(`${b.textContent}: ${app.logText(0)}`);
      await app.syncClock();
    }
    console.log("      Alice tried, inside the window:\n        " + tried.join("\n        "));

    // The window closes; anyone finalizes if the claim is still pending.
    await time.increaseTo(initiatedAt + WINDOW);
    const before = await f.vault.getVault(f.alice.address, 0);
    if (before.state === BigInt(STATE_CLAIM_PENDING)) {
      await f.vault.connect(f.bob).finalizeClaim(f.alice.address, 0);
    }
    const after = await f.vault.getVault(f.alice.address, 0);
    const bobCredit = await f.vault.creditOf(NATIVE, f.bob.address);
    console.log(
      `      final state=${after.state} (3=Settled); heir credited ${ethers.formatEther(bobCredit)} ETH of ${ethers.formatEther(DEPOSIT)} ETH`,
    );
    expect(
      Number(after.state),
      "vault settled to the heir (state 3) although the live owner objected through the app",
    ).to.not.equal(STATE_SETTLED);
    expect(bobCredit).to.equal(0n);
  });
});
