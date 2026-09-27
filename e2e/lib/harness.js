"use strict";
// What a scenario gets: the chain, the deployed world, the browser session and the app page,
// plus direct contract access for the parts a scenario sets up or checks WITHOUT the app
// (another party's transactions, the admin's, and every on-chain assertion).

const { ethers } = require("ethers");
const { Chain } = require("./chain");
const { App } = require("./browser");
const { DAY, poll } = require("./util");

const ZERO = ethers.ZeroAddress;

class Harness {
  constructor({ chain, world, session, prepared, outDir }) {
    this.chain = chain;
    this.world = world;
    this.session = session;
    this.prepared = prepared;
    this.outDir = outDir;
    this.wallet = session.wallet;
    this.who = world.who;
    this.steps = [];
    this.soft = [];
  }

  /**
   * A check whose failure is recorded without stopping the scenario, so one wrong line of text
   * does not hide what the later steps would have found. The runner fails the scenario at the
   * end if any was recorded.
   */
  check(condition, message) {
    if (!condition) this.soft.push(`[${this.steps[this.steps.length - 1] || "start"}] ${message}`);
    return Boolean(condition);
  }

  get app() {
    if (!this._app) this._app = new App(this.session);
    return this._app;
  }

  get page() {
    return this.session.page;
  }

  /** Records a named step, so a failure says how far the scenario got. */
  async step(name, fn) {
    this.steps.push(name);
    return fn();
  }

  /** v2, read-only or signing as `as`. */
  v2(as) {
    return this.chain.contract(this.world.v2Address, this.world.abi.v2, as);
  }

  v1(as) {
    return this.chain.contract(this.world.v1Address, this.world.abi.v1, as);
  }

  erc20(address, as) {
    return this.chain.contract(address, this.world.abi.erc20, as);
  }

  async vault(owner, id) {
    return this.v2().getVault(owner, id);
  }

  async now() {
    return this.chain.now();
  }

  /**
   * Creates a vault directly on chain as `owner` (not through the app). Returns its id.
   * `horizon` is absolute (seconds); by default 20 years out.
   */
  async createVault(owner, { token = ZERO, amount = ethers.parseEther("1"), heir = this.who.bob, period = 90 * DAY,
    window = 30 * DAY, horizon } = {}) {
    const now = await this.now();
    const absolute = horizon ?? now + 20 * 365 * DAY;
    const vault = this.v2(owner);
    if (token !== ZERO) {
      await Chain.mined(this.erc20(token, owner).approve(this.world.v2Address, amount));
    }
    const receipt = await Chain.mined(vault.createVault(token, amount, heir, period, window, absolute,
      { value: token === ZERO ? amount : 0n }));
    const created = receipt.logs.map((log) => {
      try {
        return vault.interface.parseLog(log);
      } catch {
        return null;
      }
    }).find((parsed) => parsed?.name === "VaultCreated");
    return Number(created.args.vaultId);
  }

  /** Sends `fn(...args)` on v2 as `as` and waits for it; fails on a revert. */
  async tx(as, fn, ...args) {
    return Chain.mined(this.v2(as)[fn](...args));
  }

  /** The owner's deadline passes: travel to just after it. */
  async expire(owner, id, extra = 60) {
    const v = await this.vault(owner, id);
    const now = await this.now();
    if (Number(v.deadline) + extra > now) await this.chain.travel(Number(v.deadline) + extra - now);
  }

  /** The claim's challenge window ends: travel to just after finalizableAt. */
  async windowEnds(owner, id, extra = 60) {
    const v = await this.vault(owner, id);
    const now = await this.now();
    if (Number(v.finalizableAt) + extra > now) await this.chain.travel(Number(v.finalizableAt) + extra - now);
  }

  async credit(token, account) {
    return this.v2().creditOf(token, account);
  }

  /** Waits for the chain to show `check(vault)` for owner's vault `id`. */
  async waitVault(owner, id, check, what) {
    return poll(() => this.vault(owner, id), check, { what: what || `vault #${id} to change on chain` });
  }
}

module.exports = { Harness, ZERO };
