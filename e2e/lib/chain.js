"use strict";
// The local chain: compiling into the e2e build directory, running a hardhat node that reports
// chain id 8453 (e2e/hardhat.config.ts), and the JSON-RPC helpers the scenarios use to set up
// state, travel in time and read results.

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { sleep } = require("./util");

const REPO = path.resolve(__dirname, "..", "..");
const HARDHAT_CLI = path.join(REPO, "node_modules", "hardhat", "internal", "cli", "cli.js");
const CONFIG = path.join(REPO, "e2e", "hardhat.config.ts");
const BUILD = process.env.WK_E2E_BUILD_DIR || path.join(os.tmpdir(), "willandkey-e2e-build");

/** A TCP port nobody listens on right now (never a fixed one: 8545 and 8547 belong to other nodes). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function hardhat(args, logFile) {
  const child = spawn(process.execPath, [HARDHAT_CLI, "--config", CONFIG, ...args], {
    cwd: REPO,
    env: { ...process.env, WK_E2E_BUILD_DIR: BUILD },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = logFile ? fs.createWriteStream(logFile) : null;
  let text = "";
  const take = (chunk) => {
    const s = chunk.toString();
    if (text.length < 200000) text += s;
    if (out) out.write(s);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  return { child, output: () => text };
}

/** hardhat compile into the build directory. Resolves when done; rejects with its output. */
async function compile(logFile) {
  const { child, output } = hardhat(["compile", "--quiet"], logFile);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`hardhat compile failed (exit ${code}):\n${output().slice(-4000)}`);
}

function artifact(source, name) {
  const file = path.join(BUILD, "artifacts", "contracts", source, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Starts `hardhat node` on a free port and resolves once it answers eth_chainId. */
async function startNode(logFile) {
  const port = await freePort();
  const { child, output } = hardhat(["node", "--hostname", "127.0.0.1", "--port", String(port)], logFile);
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 90000;
  for (;;) {
    if (exited !== null) throw new Error(`hardhat node exited (${exited}) before answering:\n${output().slice(-4000)}`);
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body = await res.json();
      if (body.result) break;
    } catch {
      // not up yet
    }
    if (Date.now() > end) {
      child.kill();
      throw new Error(`hardhat node did not answer on ${url} within 90 s:\n${output().slice(-4000)}`);
    }
    await sleep(250);
  }
  return {
    url, port, child,
    stop: () => new Promise((resolve) => {
      if (exited !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(resolve, 5000);
    }),
  };
}

/** One JSON-RPC call to the node, returning { result } or { error } exactly as the node sent it. */
async function rawRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) return { error: body.error };
  return { result: body.result };
}

class Chain {
  constructor(url) {
    this.url = url;
    // No request cache: a scenario reads right after it moves the clock or mines.
    this.provider = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  }

  async send(method, params = []) {
    const reply = await rawRpc(this.url, method, params);
    if (reply.error) {
      const error = new Error(`${method}: ${reply.error.message}`);
      error.rpc = reply.error;
      throw error;
    }
    return reply.result;
  }

  /** A signer the node signs for: a default account, or an impersonated one. */
  signer(address) {
    return new ethers.JsonRpcSigner(this.provider, ethers.getAddress(address));
  }

  async impersonate(address, ether = "1000") {
    await this.send("hardhat_impersonateAccount", [address]);
    await this.setBalance(address, ether);
  }

  async setBalance(address, ether) {
    await this.send("hardhat_setBalance", [address, ethers.toQuantity(ethers.parseEther(ether))]);
  }

  async now() {
    const block = await this.provider.getBlock("latest");
    return Number(block.timestamp);
  }

  async blockNumber() {
    return Number(await this.send("eth_blockNumber"));
  }

  /** Moves chain time forward by `seconds` and mines a block there. */
  async travel(seconds) {
    await this.send("evm_increaseTime", [Math.floor(seconds)]);
    await this.send("evm_mine");
    return this.now();
  }

  /** Mines the next block at `timestamp` (seconds), which must be later than the latest one. */
  async travelTo(timestamp) {
    await this.send("evm_mine", [Math.floor(timestamp)]);
    return this.now();
  }

  async setAutomine(on) {
    await this.send("evm_setAutomine", [on]);
  }

  async mine() {
    await this.send("evm_mine");
  }

  async snapshot() {
    return this.send("evm_snapshot");
  }

  async revert(id) {
    const ok = await this.send("evm_revert", [id]);
    if (!ok) throw new Error(`evm_revert(${id}) failed`);
  }

  async deploy(art, from, args = []) {
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, this.signer(from));
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }

  contract(address, abi, from) {
    return new ethers.Contract(address, abi, from ? this.signer(from) : this.provider);
  }

  /** Sends a contract call as `from` and waits for it to be mined; fails on a revert. */
  static async mined(txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} reverted`);
    return receipt;
  }
}

module.exports = { REPO, BUILD, CONFIG, freePort, compile, artifact, startNode, rawRpc, Chain };
