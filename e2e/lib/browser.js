"use strict";
// The system Chrome, driven by playwright-core (no browser download), and one isolated browser
// context per scenario. Every context:
//   - keeps the production CSP (no bypassCSP) and records every CSP violation, uncaught page
//     error and console error, each of which fails the scenario;
//   - answers https://mainnet.base.org (the app's public-endpoint fallback, allowed by the CSP)
//     from the local node, so nothing reaches the real Base network;
//   - refuses every other request that is not to the local site, and records it.

const fs = require("fs");
const { chromium } = require("playwright-core");
const { rawRpc } = require("./chain");
const { walletShim, Wallet } = require("./wallet");
const { poll, short, matches, TestFailure } = require("./util");

const CHROME = process.env.WK_E2E_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUBLIC_RPC = "https://mainnet.base.org";

/** The installed Chrome: at CHROME when that file exists, else wherever Playwright finds channel "chrome". */
async function launchBrowser() {
  const options = {
    headless: !process.env.WK_E2E_HEADED,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"],
  };
  if (fs.existsSync(CHROME)) options.executablePath = CHROME;
  else options.channel = "chrome";
  return chromium.launch(options);
}

class Session {
  constructor({ browser, site, nodeUrl, world }) {
    this.browser = browser;
    this.site = site;
    this.nodeUrl = nodeUrl;
    this.world = world;
    this.problems = [];
    this.allowedConsole = [];
    this.unexpectedRequests = [];
    this.publicCalls = [];
    this.publicFaults = { rateLimitNext: 0 };
    this.expectPublic = false;
    this.wallet = new Wallet(nodeUrl, world.abi.v2);
  }

  async open({ wallet = true } = {}) {
    // A zone fourteen hours ahead of UTC: for most of the day its date is not the UTC date, so any
    // place where the app mixes the device's local date with the UTC dates it promises shows up.
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 1000 }, serviceWorkers: "block", locale: "en-US", timezoneId: "Pacific/Kiritimati",
    });
    await this.context.exposeBinding("__e2eReport", (_source, kind, detail) => {
      this.problems.push(`${kind}: ${JSON.stringify(detail)}`);
    });
    if (wallet) {
      await this.context.exposeBinding("__e2eWallet", (source, request) => this.wallet.handle(source, request));
      await this.context.addInitScript(walletShim);
    } else {
      await this.context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          window.__e2eReport("csp", { directive: event.violatedDirective, blocked: event.blockedURI });
        });
      });
    }
    await this.context.route("**/*", (route) => this.route(route));
    this.page = await this.context.newPage();
    this.page.on("pageerror", (error) => this.problems.push(`pageerror: ${error.message}`));
    this.page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (this.allowedConsole.some((pattern) => matches(text, pattern))) return;
      this.problems.push(`console.error: ${text}`);
    });
    this.page.on("crash", () => this.problems.push("the page crashed"));
    return this.page;
  }

  async route(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === this.site.origin) return route.continue();
    if (url.origin === PUBLIC_RPC) return this.publicEndpoint(route);
    this.unexpectedRequests.push(`${request.method()} ${request.url()}`);
    return route.abort("blockedbyclient");
  }

  // The public endpoint, answered by the local node, with an optional rate limit.
  async publicEndpoint(route) {
    const request = route.request();
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    let payload = null;
    try {
      payload = JSON.parse(request.postData() || "null");
    } catch {
      payload = null;
    }
    this.publicCalls.push(payload?.method ?? "?");
    if (!payload?.method) return route.fulfill({ status: 400, headers: cors, body: "not a JSON-RPC request" });
    if (this.publicFaults.delayLogsMs && payload?.method === "eth_getLogs") {
      await new Promise((resolve) => { setTimeout(resolve, this.publicFaults.delayLogsMs); });
    }
    if (this.publicFaults.rateLimitNext > 0) {
      this.publicFaults.rateLimitNext -= 1;
      return route.fulfill({
        status: 429, headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: payload?.id ?? 1, error: { code: -32016, message: "over rate limit" } }),
      });
    }
    const reply = await rawRpc(this.nodeUrl, payload.method, payload.params || []);
    return route.fulfill({
      status: 200, headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, ...reply }),
    });
  }

  /** Fails with every problem recorded so far (CSP, page errors, console errors, stray requests). */
  checkClean() {
    const problems = [...this.problems, ...this.unexpectedRequests.map((r) => `unexpected request: ${r}`)];
    // The app promises to send the wallet's address to the public endpoint only when the wallet's
    // own connection cannot answer the heir search. Any other call there is a privacy leak.
    if (!this.expectPublic && this.publicCalls.length) {
      problems.push(`the page called the public endpoint ${PUBLIC_RPC} (${this.publicCalls.join(", ")}) although the wallet's connection was working`);
    }
    if (problems.length) throw new TestFailure(`the page reported problems:\n  ${problems.join("\n  ")}`);
  }

  async close() {
    await this.context?.close().catch(() => {});
  }
}

/** The app page: navigation, connecting and waiting on what it shows. */
class App {
  constructor(session) {
    this.s = session;
    this.page = session.page;
    this.wallet = session.wallet;
  }

  get url() {
    return `${this.s.site.origin}/app`;
  }

  async open() {
    await this.page.goto(this.url, { waitUntil: "load" });
  }

  /**
   * The DOM text of the first element `target` (a selector or a locator) matches, with runs of
   * whitespace collapsed. DOM text, not innerText: CSS text-transform (the uppercase pills) must
   * not change what is compared.
   */
  async textOf(target) {
    const locator = typeof target === "string" ? this.page.locator(target) : target;
    return locator.first().evaluate((el) => el.textContent.replace(/\s+/g, " ").trim());
  }

  text(selector) {
    return this.textOf(selector);
  }

  /** Waits until the text of `target` (selector or locator) contains or matches `pattern`. */
  async waitText(target, pattern, what, timeout = 20000) {
    return poll(() => this.textOf(target), (t) => matches(t, pattern),
      { timeout, what: what || `${typeof target === "string" ? target : "the element"} to show ${pattern}` });
  }

  async visible(selector) {
    return this.page.locator(selector).first().isVisible();
  }

  /** Connects with the Connect button as `account` and waits for the vault list. */
  async connect(account) {
    this.wallet.account = account;
    await this.page.click("#connectBtn");
    await this.waitConnected(account);
  }

  async waitConnected(account) {
    await this.waitText("#connectBtn", short(account), `the Connect button to show ${short(account)}`);
    await this.waitText("#netPill", "Base", "the network pill to say Base");
    await this.waitVaultsLoaded();
  }

  /** The owner list has been read: vault cards, or the "No vaults yet" card. */
  async waitVaultsLoaded() {
    await poll(async () => this.page.evaluate(() => {
      const empty = document.getElementById("mineEmpty");
      const cards = document.querySelectorAll("#vaultList .vault-card").length;
      return (empty.hidden && cards > 0) || (!empty.hidden && /No vaults yet/.test(empty.textContent));
    }), Boolean, { what: "the owner's vault list to load" });
  }

  /** Switches the wallet to `account`; the app reloads on accountsChanged and reconnects. */
  async switchAccount(account) {
    this.wallet.account = account;
    const state = this.wallet.state();
    const loaded = this.page.waitForEvent("load", { timeout: 20000 });
    await this.page.evaluate(([a, s]) => {
      setTimeout(() => window.__e2eWalletEmit("accountsChanged", [a], s), 0);
    }, [account, state]);
    await loaded;
    await this.waitConnected(account);
  }

  async reload() {
    await this.page.reload({ waitUntil: "load" });
    if (this.wallet.authorized) await this.waitConnected(this.wallet.account);
  }

  async tab(name) {
    await this.page.click(`#tabbtn-${name}`);
    await poll(() => this.page.locator(`#tab-${name}`).isVisible(), Boolean, { what: `the ${name} tab to show` });
  }

  /** The owner card of vault `id`. */
  card(id) {
    return this.page.locator(".vault-card").filter({ has: this.page.locator(`#log-owner-${id}`) });
  }

  heirCard(owner, id) {
    return this.page.locator(".vault-card").filter({ has: this.page.locator(`#log-heir-${owner.toLowerCase()}-${id}`) });
  }

  creditCard(token) {
    return this.page.locator(".vault-card").filter({ has: this.page.locator(`#log-credit-credit-${token.toLowerCase()}`) });
  }

  async cardText(id) {
    return this.textOf(this.card(id));
  }

  /** Clicks a button by its exact visible label inside `scope` (a locator), failing if absent. */
  async press(scope, label) {
    const target = scope.getByRole("button", { name: label, exact: true });
    const count = await target.count();
    if (count !== 1) {
      const buttons = await scope.getByRole("button").allInnerTexts().catch(() => []);
      throw new TestFailure(`expected one "${label}" button, found ${count}; buttons here: ${JSON.stringify(buttons)}`);
    }
    await target.click();
  }

  async buttons(scope) {
    return (await scope.getByRole("button").allInnerTexts()).map((t) => t.trim());
  }

  /**
   * Presses the Sign button `buttonLabel` in `scope`, waits for the wallet to send the transaction,
   * then for `logTarget` to say "<txLabel>: confirmed" with THAT transaction's hash, so an older
   * confirmation still on screen can never satisfy it. Returns the hash.
   */
  async sign(scope, buttonLabel, logTarget, txLabel, timeout = 30000) {
    const before = this.wallet.hashes.length;
    await this.press(scope, buttonLabel);
    return this.waitConfirmed(logTarget, txLabel, before, timeout);
  }

  /** Waits for the wallet's transaction number `before` (0-based) and its confirmation in `logTarget`. */
  async waitConfirmed(logTarget, txLabel, before, timeout = 30000) {
    const hash = await poll(() => this.wallet.hashes[before] ?? null, Boolean,
      { what: `the wallet to send the "${txLabel}" transaction`, timeout });
    await this.waitText(logTarget, `${txLabel}: confirmed ${short(hash)}`, `"${txLabel}: confirmed ${short(hash)}"`, timeout);
    return hash;
  }

  /** The app's fmtLocal(timestamp), formatted by this browser (its locale and time zone). */
  async fmtLocal(timestamp) {
    return this.page.evaluate((ts) => new Date(Number(ts) * 1000).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }), Number(timestamp));
  }

  /** The app's fmtWhen(timestamp), formatted by this browser. */
  async fmtWhen(timestamp) {
    return this.page.evaluate((ts) => new Date(Number(ts) * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }), Number(timestamp));
  }

  /** Waits for the owner card log of `id` to match `pattern`. */
  async waitLog(id, pattern, what, timeout = 30000) {
    return this.waitText(`#log-owner-${id}`, pattern, what || `vault #${id}'s log to show ${pattern}`, timeout);
  }
}

module.exports = { launchBrowser, Session, App, CHROME };
