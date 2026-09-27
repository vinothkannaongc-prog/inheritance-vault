"use strict";
// The injected wallet. The page gets an EIP-1193 provider (window.ethereum) whose request()
// crosses into Node through a Playwright binding; Node forwards it to the local hardhat node,
// which signs eth_sendTransaction for the connected account (a default account the node
// unlocks). The binding runs outside the page, so the page's CSP stays exactly the production
// one: the page itself never talks to the node.
//
// The wallet can switch accounts (accountsChanged, which the app answers with a reload), decline
// a signature (EIP-1193 code 4001), run a hook just before it forwards a transaction (another
// party's transaction, or time travel, mined between the app's last read and its transaction),
// and inject connection faults.

const { ethers } = require("ethers");
const { rawRpc } = require("./chain");
const { same } = require("./util");

const BASE_CHAIN = "0x2105";

/**
 * Runs in the page before any page script (context.addInitScript). Everything it needs comes
 * from the binding; its state lives in sessionStorage so it survives the reload the app does on
 * accountsChanged and chainChanged.
 */
function walletShim() {
  const KEY = "__e2e_wallet_state";
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || "null") || {};
    } catch {
      return {};
    }
  };
  const write = (state) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // storage refused: the page then simply starts disconnected
    }
  };
  const listeners = {};
  const provider = {
    isE2EWallet: true,
    // Like an injected wallet that the site was already connected to: the account is known
    // synchronously at load, so the app's auto-connect path runs.
    get selectedAddress() {
      const state = read();
      return state.authorized ? state.account : null;
    },
    get chainId() {
      return read().chainId || null;
    },
    async request(args) {
      const method = args && args.method;
      const params = args && args.params !== undefined ? args.params : [];
      const reply = await window.__e2eWallet({ method, params });
      if (reply && reply.state) write(reply.state);
      if (reply && reply.error) {
        const error = new Error(reply.error.message);
        error.code = reply.error.code;
        if (reply.error.data !== undefined) error.data = reply.error.data;
        throw error;
      }
      return reply ? reply.result : undefined;
    },
    on(event, handler) {
      (listeners[event] = listeners[event] || []).push(handler);
      return provider;
    },
    removeListener(event, handler) {
      listeners[event] = (listeners[event] || []).filter((candidate) => candidate !== handler);
      return provider;
    },
  };
  Object.defineProperty(window, "__e2eWalletEmit", {
    value(event, payload, state) {
      if (state) write(state);
      for (const handler of [...(listeners[event] || [])]) handler(payload);
    },
  });
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__e2eReport("csp", {
      directive: event.violatedDirective, blocked: event.blockedURI, source: event.sourceFile,
      line: event.lineNumber, sample: event.sample,
    });
  });
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

class Wallet {
  constructor(nodeUrl, abi) {
    this.nodeUrl = nodeUrl;
    this.iface = new ethers.Interface(abi);
    this.account = null;
    this.authorized = false;
    this.chainId = BASE_CHAIN;
    this.requests = [];
    this.sent = [];
    this.sentHashes = new Set();
    this.hashes = [];
    this.hooks = [];
    this.rejectNext = 0;
    // Network switching: whether the wallet has Base configured, and whether the person declines
    // switching to it or adding it.
    this.knowsBase = true;
    this.declineSwitch = false;
    this.declineAdd = false;
    this.addChainRequests = [];
    // failCalls: every eth_call fails; failCallsAfterNextReceipt: the same, from the moment a
    // receipt of this wallet's own transaction has been handed to the page; refuseLogs:
    // eth_getLogs is not served; failReceipts: that many eth_getTransactionReceipt calls fail.
    this.faults = { failCalls: false, failCallsAfterNextReceipt: false, refuseLogs: false, failReceipts: 0 };
    this.failedCalls = 0;
  }

  state() {
    return { account: this.account, authorized: this.authorized, chainId: this.chainId };
  }

  /** The v2 function a transaction calls, or null (an approve, say). */
  functionOf(tx) {
    try {
      return this.iface.parseTransaction({ data: tx.data || "0x", value: tx.value || 0 })?.name ?? null;
    } catch {
      return null;
    }
  }

  /** Runs `run(tx)` once, just before the next transaction calling `fn` is forwarded. */
  beforeNext(fn, run) {
    this.hooks.push({ fn, run });
  }

  /** The hash of the last transaction this wallet sent. */
  lastHash() {
    return this.hashes[this.hashes.length - 1] ?? null;
  }

  sentCalls() {
    return this.sent.map((tx) => this.functionOf(tx) || (tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10) : "transfer"));
  }

  async handle(source, request) {
    this.requests.push(request.method);
    try {
      const result = await this.dispatch(source, request.method, request.params || []);
      return { result: result === undefined ? null : result, state: this.state() };
    } catch (error) {
      return {
        error: { code: error.code ?? -32603, message: error.message, data: error.data },
        state: this.state(),
      };
    }
  }

  async dispatch(source, method, params) {
    switch (method) {
      case "eth_requestAccounts":
        if (!this.account) throw rpcError(4001, "User rejected the request.");
        this.authorized = true;
        return [this.account];
      case "eth_accounts":
        return this.authorized && this.account ? [this.account] : [];
      case "eth_chainId":
        return this.chainId;
      case "net_version":
        return String(Number(this.chainId));
      case "wallet_switchEthereumChain": {
        const target = String(params[0]?.chainId || "").toLowerCase();
        if (target !== BASE_CHAIN || !this.knowsBase) throw rpcError(4902, `Unrecognized chain ID "${target}".`);
        if (this.declineSwitch) throw rpcError(4001, "User rejected the request.");
        if (this.chainId !== target) {
          this.chainId = target;
          this.emitSoon(source.page, "chainChanged", target);
        }
        return null;
      }
      case "wallet_addEthereumChain": {
        this.addChainRequests.push(params[0]);
        const target = String(params[0]?.chainId || "").toLowerCase();
        if (this.declineAdd || target !== BASE_CHAIN) throw rpcError(4001, "User rejected the request.");
        this.knowsBase = true;
        if (this.chainId !== target) {
          this.chainId = target;
          this.emitSoon(source.page, "chainChanged", target);
        }
        return null;
      }
      case "eth_sendTransaction":
        return this.sendTransaction(params[0]);
      case "personal_sign":
      case "eth_sign":
      case "eth_signTypedData_v4":
        throw rpcError(4200, `${method} is not supported by the e2e wallet`);
      default:
        return this.forward(method, params);
    }
  }

  async sendTransaction(tx) {
    if (!this.authorized) throw rpcError(4100, "The requested account has not been authorized by the user.");
    if (!same(tx.from, this.account)) throw rpcError(4100, `The wallet is connected as ${this.account}, not ${tx.from}.`);
    this.sent.push(tx);
    if (this.rejectNext > 0) {
      this.rejectNext -= 1;
      throw rpcError(4001, "User rejected the request.");
    }
    const name = this.functionOf(tx);
    const index = this.hooks.findIndex((hook) => hook.fn === name);
    let after = null;
    if (index >= 0) {
      const [hook] = this.hooks.splice(index, 1);
      // A hook may return a function, run once the app's transaction is with the node (for
      // instance to mine it in one block with a transaction the hook left pending).
      after = await hook.run(tx);
    }
    const hash = await this.forward("eth_sendTransaction", [tx]);
    this.sentHashes.add(String(hash).toLowerCase());
    this.hashes.push(hash);
    if (typeof after === "function") await after(hash);
    return hash;
  }

  async forward(method, params) {
    if (method === "eth_call" && this.faults.failCalls) {
      this.failedCalls += 1;
      throw rpcError(-32603, "e2e: the wallet's connection to the network dropped");
    }
    if (method === "eth_getLogs" && this.faults.refuseLogs) {
      throw rpcError(-32601, "the method eth_getLogs does not exist/is not available");
    }
    if (method === "eth_getTransactionReceipt" && this.faults.failReceipts > 0) {
      this.faults.failReceipts -= 1;
      throw rpcError(-32603, "e2e: the receipt could not be fetched");
    }
    const reply = await rawRpc(this.nodeUrl, method, params);
    if (reply.error) throw rpcError(reply.error.code, reply.error.message, reply.error.data);
    if (method === "eth_getTransactionReceipt" && reply.result && this.faults.failCallsAfterNextReceipt
      && this.sentHashes.has(String(reply.result.transactionHash).toLowerCase())) {
      this.faults.failCallsAfterNextReceipt = false;
      this.faults.failCalls = true;
    }
    return reply.result;
  }

  emitSoon(page, event, payload) {
    const state = this.state();
    setTimeout(() => {
      page.evaluate(([e, p, s]) => window.__e2eWalletEmit(e, p, s), [event, payload, state]).catch(() => {});
    }, 0);
  }
}

module.exports = { walletShim, Wallet, BASE_CHAIN };
