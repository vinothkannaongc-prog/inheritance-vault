// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F46/test/poc-F46.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: site/assets/app.js.
/**
 * PoC F46 -- the owner's vault card never says when a pending claim becomes final, nor where it
 * pays, although getVault/getOpenVaults return both (finalizableAt, claimRecipient).
 *
 * Method: a real vault on the Hardhat network is driven into CLAIM_PENDING by the heir. The
 * VaultView returned by getOpenVaults(owner) -- exactly the call refreshMine() makes for the
 * connected owner in site/assets/app.js -- is rendered by the UNMODIFIED production vaultCard()
 * from site/assets/app.js, loaded into a node:vm context with a minimal DOM shim. The same
 * struct is rendered once as role "owner" and once as role "heir".
 *
 * These tests assert the INTENDED property (the owner can see the final date and the payout
 * address of a running claim). They fail against the current app.js because of F46 and must
 * pass once the owner card renders finalizableAt and claimRecipient in the CLAIM_PENDING state.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import * as ethersLib from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const DAY = 86_400;
const PERIOD = 90 * DAY; // scenario: heir files on day 90
const WINDOW = 30 * DAY; // C = 30
const HORIZON = 7300 * DAY; // the app's default horizon: today + 20 years
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

// ----------------------------------------------------------------------------- app.js loader

function locateAppJs(): string {
  const candidates = [
    process.env.WK_APP_JS,
    path.resolve(__dirname, "../../../site/assets/app.js"), // evidence-suite port: repo working tree
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`site/assets/app.js not found; tried ${candidates.join(", ")}`);
}

class FakeText {
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  children: any[] = [];
  className = "";
  id = "";
  hidden = false;
  type = "";
  href = "";
  target = "";
  rel = "";
  value = "";
  onclick: any = null;
  listeners: Record<string, Function[]> = {};
  classList = { toggle() {}, add() {}, remove() {} };
  constructor(public tag: string) {}
  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.children = [new FakeText(String(value))];
  }
  append(...nodes: any[]) {
    for (const node of nodes) this.children.push(typeof node === "string" ? new FakeText(node) : node);
  }
  replaceChildren(...nodes: any[]) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type: string, handler: Function) {
    (this.listeners[type] ??= []).push(handler);
  }
  // Evidence-suite port: 5bbad6e added log.setAttribute("role", "status") to vaultCard() (ARIA only;
  // the app logic under test is unchanged). The sandbox stub predates it, so it records attributes.
  attrs: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  querySelector() {
    return null;
  }
  /** every element (depth-first) for class / text inspection */
  walk(): FakeElement[] {
    const out: FakeElement[] = [this];
    for (const child of this.children) if (child instanceof FakeElement) out.push(...child.walk());
    return out;
  }
}

function loadApp(chainNowSeconds: number) {
  const registry = new Map<string, FakeElement>();
  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(String(text)),
    getElementById: (id: string) => {
      if (!registry.has(id)) registry.set(id, new FakeElement("div"));
      return registry.get(id)!;
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document,
    window: {}, // no window.ethereum: the page loads without auto-connecting
    ethers: ethersLib,
    VAULT_ABI: [],
    console,
    location: { reload() {} },
    prompt: () => null,
  });
  vm.runInContext(fs.readFileSync(locateAppJs(), "utf8"), context, { filename: "app.js" });
  // Wallet on Base mainnet (the live deployment); the browser clock equals chain time.
  vm.runInContext(`S.chainId = 8453; Date.now = () => ${chainNowSeconds * 1000};`, context);
  // `short` is a top-level const arrow in app.js (script scope, not a global property): expose it.
  vm.runInContext("globalThis.short = short;", context);
  return context as any;
}

async function render(app: any, vault: any, role: "owner" | "heir"): Promise<FakeElement> {
  return (await app.vaultCard(vault, role)) as FakeElement;
}

// ----------------------------------------------------------------------------- fixture

describe("PoC F46 - owner card hides the final date and payout address of a pending claim", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const horizon = (await time.latest()) + HORIZON;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    // Day 90 (+1s): heir Bob files a claim that pays to Carol, a payout address Alice never named.
    await time.increase(PERIOD + 1);
    await vault.connect(bob).initiateClaim(alice.address, 0, carol.address);
    return { vault, admin, alice, bob, carol, dave, feeSink };
  }

  /** What refreshMine() hands to vaultCard(vault, "owner") for the connected owner. */
  async function ownerView(f: any) {
    const views = await f.vault.getOpenVaults(f.alice.address);
    expect(views.length).to.equal(1);
    return views[0];
  }

  it("the data is on chain: getOpenVaults(owner) returns state 2, finalizableAt and claimRecipient", async () => {
    const f = await loadFixture(fixture);
    const v = await ownerView(f);
    expect(v.state).to.equal(2n);
    expect(v.claimRecipient).to.equal(f.carol.address);
    expect(v.finalizableAt).to.equal(v.claimInitiatedAt + BigInt(WINDOW));
    expect(v.finalizable).to.equal(false);
  });

  it("owner card shows the date the pending claim becomes final (heir card already does)", async () => {
    const f = await loadFixture(fixture);
    const v = await ownerView(f);
    const app = loadApp(await time.latest());

    const finalDate: string = app.fmtWhen(v.finalizableAt);
    // Guard against a coincidental pass: the final date is not any other date the card prints.
    expect(finalDate).to.not.equal(app.fmtWhen(v.deadline));
    expect(finalDate).to.not.equal(app.fmtWhen(v.guaranteedInheritanceAt));

    const ownerCard = await render(app, v, "owner");
    const heirCard = await render(app, v, "heir");
    const ownerText = ownerCard.textContent;
    const heirText = heirCard.textContent;
    console.log("      owner card:", JSON.stringify(ownerText));
    console.log("      heir  card:", JSON.stringify(heirText));

    // Positive controls: the renderer works, the heir sees the date, the owner has a Veto button.
    expect(heirText).to.include(`veto window until ${finalDate}`);
    expect(ownerCard.walk().some((el) => el.tag === "button" && el.textContent === "Veto claim")).to.equal(true);

    // INTENDED: the owner -- the only party who can stop the claim -- is told when it becomes final.
    expect(
      ownerText,
      `owner card for a CLAIM_PENDING vault never shows finalizableAt (${finalDate}); getVault returns it`,
    ).to.include(finalDate);
  });

  it("owner card shows where the pending claim pays (claimRecipient)", async () => {
    const f = await loadFixture(fixture);
    const v = await ownerView(f);
    const app = loadApp(await time.latest());
    const recipient = f.carol.address as string;
    expect(v.claimRecipient).to.equal(recipient);

    const ownerText = (await render(app, v, "owner")).textContent.toLowerCase();
    const shown =
      ownerText.includes(recipient.toLowerCase()) || ownerText.includes(app.short(recipient).toLowerCase());

    // INTENDED: the owner can see that this claim pays Carol, not the heir Alice named (Bob).
    expect(
      shown,
      `owner card never shows claimRecipient ${recipient}; getVault returns it. Card text: ${ownerText}`,
    ).to.equal(true);
  });

  it("damage: 2 days before finality the owner card gives no deadline; then a third party finalizes", async () => {
    const f = await loadFixture(fixture);
    const initial = await ownerView(f);
    const finalizableAt = Number(initial.finalizableAt);

    // Day 119 of the scenario (finality on day 121): Alice opens the app.
    await time.increaseTo(finalizableAt - 2 * DAY);
    const v = await ownerView(f);
    const now = await time.latest();
    const app = loadApp(now);
    const ownerCard = await render(app, v, "owner");
    const ownerText = ownerCard.textContent;

    // Every date/countdown the owner card actually prints, and how they relate to the real deadline.
    const shownDeadlineCountdown: string = app.fmtCountdown(v.deadline); // "Nd ago"
    const shownFarDate: string = app.fmtWhen(v.guaranteedInheritanceAt);
    const farDaysAfterFinality = (Number(v.guaranteedInheritanceAt) - finalizableAt) / DAY;
    expect(ownerText).to.include(shownDeadlineCountdown);
    expect(ownerText).to.include(shownFarDate);
    expect(ownerText).to.include(`veto window ${WINDOW / DAY} days`);
    console.log(`      owner card at T-2d: ${JSON.stringify(ownerText)}`);
    console.log(
      `      only future date on the owner card: ${shownFarDate} = ${farDaysAfterFinality.toFixed(0)} days AFTER ` +
        `the claim actually becomes final (${app.fmtWhen(v.finalizableAt)}, ${app.fmtCountdown(v.finalizableAt)})`,
    );

    // Alice postpones. Two days later an arbitrary third party (Dave) settles the claim to Carol.
    await time.increaseTo(finalizableAt);
    await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
    const credited = await f.vault.creditOf(NATIVE, f.carol.address);
    const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
    expect(credited).to.equal(DEPOSIT - fee);
    expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(3n); // SETTLED, veto gone
    console.log(`      finalized by a third party: ${ethers.formatEther(credited)} ETH credited to claimRecipient`);

    // INTENDED: while the veto was still possible, the owner card stated when it would stop being
    // possible -- as a date or as a countdown.
    const finalDate: string = app.fmtWhen(v.finalizableAt);
    const finalCountdown: string = app.fmtCountdown(v.finalizableAt); // "in 2d 0h"
    expect(
      ownerText.includes(finalDate) || ownerText.includes(finalCountdown),
      `2 days before finality the owner card showed neither ${finalDate} nor "${finalCountdown}"`,
    ).to.equal(true);
  });
});
