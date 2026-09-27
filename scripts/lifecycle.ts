/**
 * The Base Sepolia full-lifecycle test of a deployed v2 InheritanceVault: a stateful, resumable runner.
 *
 *   npx ts-node scripts/lifecycle.ts            Base Sepolia (chain 84532). Does every step that is due by
 *                                               chain time, asserts it, and prints what is next and when.
 *   npx ts-node scripts/lifecycle.ts --status   Progress and the next step. Sends nothing, needs no keys.
 *   npx ts-node scripts/lifecycle.ts --local    The same steps on a local hardhat node (npm run node), with
 *                                               time travel: each run ends by moving the chain clock to the
 *                                               next due step, so a few runs cover the whole lifecycle.
 *
 * deployments/README.md is the operator's guide (keys, faucets, the Base Sepolia deployment).
 *
 * KEYS. OWNER_KEY, HEIR_KEY and KEEPER_KEY, three distinct TESTNET keys, come from the environment. They
 * are never printed, logged or written anywhere: only their addresses are recorded. --local falls back to
 * hardhat's public development accounts 1-3, which are refused on any other chain.
 *
 * STATE lives in deployments/baseSepolia-lifecycle.json (with --local: cache/localnode-lifecycle.json;
 * --state overrides). Every transaction is signed, and its hash and signed bytes written to the state file,
 * BEFORE it is broadcast, so a run killed at any point resumes without sending anything twice: the next run
 * finds the receipt, or re-broadcasts the same signed bytes. A lock file stops two runs overlapping.
 *
 * THE SCENARIO. Three ETH vaults and, when the owner holds testnet USDC, one USDC vault, all with the
 * contract's minimum inactivity period and challenge window (7 days each), the horizon a year out:
 *   day 0    the owner creates A, B, C (and D in USDC) and checks in on A; the keeper tops A up.
 *   day 7+   the heir claims A (no veto: it must settle); claims B, which the owner vetoes (B is ACTIVE
 *            again); claims C to a mistyped address, cancels, and re-files to a receive-only address.
 *            The owner's batch keeper runs checkInMany over A, B, C, D and an unknown id: A and C are
 *            skipped (claim pending), the unknown id is skipped, B and D are refreshed.
 *   day 14+  the keeper finalizes A and C; the heir withdraws a third of its credit to another address,
 *            then the rest; the owner closes B and D and pulls their credits.
 *   day 44+  (settlement + PUSH_GRACE) the keeper pushes the receive-only recipient's credit, and the fee
 *            recipient's, which no third party could push before the grace ran out.
 * checkInMany only refreshes the CALLER's own vaults, so the batch keeper signs with the owner key (a real
 * keeper holds the owner's check-in authority). The keeper key plays the stranger: finalizing, pushing and
 * topping up are permissionless, and every run proves a stranger's check-in moves nothing.
 *
 * ASSERTIONS. Before each transaction the runner snapshots every balance, credit, push-grace clock, lane
 * (totalLocked / totalCredited / surplus), vault (every getVault field) and counter it tracks. It applies
 * the step's effects to that snapshot with a model written from the contract's rules, then compares the
 * whole model, field by field, with a snapshot read at the transaction's block. The vault's events are
 * compared in order, with their arguments. After every step each token's lanes must add up to the vault's
 * balance, with surplus unchanged from the start. Wrong turns are asserted too, by eth_call: claiming
 * early, a stranger's check-in, finalizing inside the window, pushing inside the grace, over-withdrawing.
 * A failed assertion stops the lifecycle; the next run re-checks it (a flaky read heals, a real mismatch
 * does not). --accept-failed marks a failed step done after a human has looked at it.
 */
import * as fs from "fs";
import * as path from "path";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  parseEther,
  parseUnits,
  toQuantity,
} from "ethers";
import type { InterfaceAbi, TransactionReceipt } from "ethers";

// ------------------------------------------------------------------ constants

const ROOT = path.resolve(__dirname, "..");
const BASE_SEPOLIA = 84532n;
const HARDHAT_LOCAL = 31337n;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const ETH = ZeroAddress;
const ZERO32 = "0x" + "00".repeat(32);
const DAY = 86_400n;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function mint(address,uint256)",
];
const STATE_NAMES: Record<string, string> = { "1": "ACTIVE", "2": "CLAIM_PENDING", "3": "SETTLED", "4": "CLOSED" };

type Role = "owner" | "heir" | "keeper";
type Letter = "A" | "B" | "C" | "D";

/** A flat map of everything tracked, read at one block. Values are decimal strings, "true"/"false" or lowercase hex. */
interface Snap {
  block: number;
  ts: number;
  v: Record<string, string>;
}
interface Pending {
  hash: string;
  raw: string;
  from: string;
  nonce: number;
  before: Snap;
  sentAt: string;
}
interface TxRecord {
  hash: string;
  block: number;
  ts: number;
  gasUsed: string;
  cost: string;
}
interface StepRecord {
  status?: "done" | "skipped" | "failed";
  at?: string;
  note?: string;
  checks?: number;
  txs?: TxRecord[];
  pending?: Pending;
  failures?: string[];
}
interface State {
  version: 1;
  chainId: string;
  vault: string;
  local: boolean;
  startedAt: string;
  roles: Record<Role, string>;
  /** Fresh addresses nobody holds a key for, so every payment to them is visible to the wei. */
  addrs: { heirPayout: string; cold: string; wrong: string };
  params: {
    eth: string;
    topUp: string;
    usdc: string | null;
    usdcAmount: string | null;
    usdcDecimals: number | null;
    inactivity: string;
    window: string;
    horizon: string;
    pushGrace: string;
  };
  ids: Partial<Record<Letter, string>>;
  baseline: Record<string, string>;
  steps: Record<string, StepRecord>;
  localDeployment?: { admin: string; weth: string; usdc: string; tx: string[] };
}
interface Opts {
  local: boolean;
  status: boolean;
  warp: boolean;
  acceptFailed: boolean;
  rpc?: string;
  state?: string;
  vault?: string;
}

// ------------------------------------------------------------------ small helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string =>
  (e as { shortMessage?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));
const lc = (a: string) => a.toLowerCase();

function norm(x: unknown): string {
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "boolean") return x ? "true" : "false";
  if (typeof x === "number") return String(x);
  if (typeof x === "string") return x.toLowerCase();
  return String(x);
}

function when(ts: bigint | number): string {
  return new Date(Number(ts) * 1000).toISOString().replace(".000Z", " UTC").replace("T", " ");
}

function span(sec: bigint): string {
  const s = sec < 0n ? 0n : sec;
  const d = s / DAY;
  const h = (s % DAY) / 3600n;
  const m = (s % 3600n) / 60n;
  return d > 0n ? `${d} d ${h} h` : h > 0n ? `${h} h ${m} min` : `${m} min ${s % 60n} s`;
}

/**
 * A real revert: ethers says CALL_EXCEPTION and there is revert data (every revert of this contract carries
 * a custom error or a panic). A node that fails a call ("header not found" from a lagging backend) also
 * surfaces as CALL_EXCEPTION, but with "missing revert data": that one is worth a retry.
 */
function isRevert(e: unknown): boolean {
  const x = e as { code?: string; data?: unknown };
  return x?.code === "CALL_EXCEPTION" && typeof x.data === "string" && x.data.length >= 10;
}

/** A read that a flaky public RPC may fail: retried; a revert is not retried. */
async function retry<T>(f: () => Promise<T>, what = "read"): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      if (isRevert(e)) throw e;
      await sleep(750 * (i + 1));
    }
  }
  throw new Error(`${what} failed after 6 attempts: ${errText(last)}`);
}

async function pool<T>(thunks: (() => Promise<T>)[], width = 6): Promise<T[]> {
  const out: T[] = new Array(thunks.length);
  let next = 0;
  const lane = async () => {
    while (next < thunks.length) {
      const i = next++;
      out[i] = await thunks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, thunks.length) }, lane));
  return out;
}

function artifact(rel: string): { abi: InterfaceAbi; bytecode: string; deployedBytecode: string } {
  const p = path.join(ROOT, "artifacts", rel);
  if (!fs.existsSync(p)) throw new Error(`${p} is missing: run "npx hardhat compile" first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * The deployed runtime is this checkout's compiled code: equal outside the CBOR metadata (which a comment
 * edit changes) and outside immutables (zero in the artifact, filled in at deployment).
 */
function sameCode(deployed: string, compiled: string): boolean {
  const strip = (hex: string) => {
    const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (b.length < 2) return b;
    const n = b.readUInt16BE(b.length - 2);
    return n + 2 <= b.length ? b.subarray(0, b.length - n - 2) : b;
  };
  const a = strip(deployed);
  const c = strip(compiled);
  if (a.length !== c.length || a.length === 0) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== c[i] && c[i] !== 0) return false;
  return true;
}

function devWallet(i: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { local: false, status: false, warp: true, acceptFailed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--local") o.local = true;
    else if (a === "--status") o.status = true;
    else if (a === "--no-warp") o.warp = false;
    else if (a === "--accept-failed") o.acceptFailed = true;
    else if (a === "--rpc") o.rpc = val();
    else if (a === "--state") o.state = val();
    else if (a === "--vault") o.vault = val();
    else if (a === "--help" || a === "-h") {
      console.log("usage: npx ts-node scripts/lifecycle.ts [--local] [--status] [--rpc URL] [--vault 0x..] [--state FILE] [--no-warp] [--accept-failed]");
      console.log("see deployments/README.md");
      process.exit(0);
    } else throw new Error(`unknown argument ${a} (try --help)`);
  }
  return o;
}

// ------------------------------------------------------------------ the model

/**
 * Expected state after one transaction, derived from the state before it by the contract's own rules.
 * Every method mirrors one piece of InheritanceVault.sol; events are collected in emission order.
 */
class Model {
  events: [string, string[]][] = [];
  constructor(
    public v: Record<string, string>,
    public ts: bigint,
    private vault: string
  ) {}
  g(k: string): bigint {
    const x = this.v[k];
    return x === undefined || x === "" ? 0n : BigInt(x);
  }
  s(k: string, x: bigint | string | boolean) {
    this.v[k] = norm(x);
  }
  add(k: string, d: bigint) {
    this.s(k, this.g(k) + d);
  }
  ev(name: string, ...args: unknown[]) {
    this.events.push([name, args.map(norm)]);
  }
  vk(id: string, f: string) {
    return `vault:${id}:${f}`;
  }
  /** What a transaction's sender pays: value sent plus the fee from its receipt. */
  paid(from: string, value: bigint, cost: bigint) {
    this.add(`eth:${lc(from)}`, -(value + cost));
  }
  claimFeeBps(): bigint {
    const at = this.g("fee:pendingAt");
    return at !== 0n && this.ts >= at ? this.g("fee:pendingBps") : this.g("fee:bps");
  }
  feeRecipientInForce(): boolean {
    return this.v["fee:recipient"] !== lc(ZeroAddress) && this.ts >= this.g("fee:activeAt");
  }
  nextDeadline(id: string): bigint {
    const n = this.ts + this.g(this.vk(id, "inactivityPeriod"));
    const cap = this.g(this.vk(id, "absoluteDeadline"));
    return n < cap ? n : cap;
  }
  resetClock(owner: string, id: string) {
    const n = this.nextDeadline(id);
    this.s(this.vk(id, "deadline"), n);
    this.ev("DeadlineReset", owner, BigInt(id), n, this.g(this.vk(id, "absoluteDeadline")));
  }
  bal(token: string, who: string) {
    return token === ETH ? `eth:${lc(who)}` : `tok:${lc(token)}:${lc(who)}`;
  }
  credit(token: string, to: string, amount: bigint) {
    const k = `credit:${lc(token)}:${lc(to)}`;
    const owed = this.g(k);
    if (amount >= owed) this.s(`since:${lc(token)}:${lc(to)}`, this.ts);
    this.s(k, owed + amount);
    this.add(`lane:${lc(token)}:credited`, amount);
  }
  payCredit(token: string, account: string, to: string, amount: bigint) {
    const k = `credit:${lc(token)}:${lc(account)}`;
    const owed = this.g(k);
    this.s(k, owed - amount);
    if (amount === owed) this.s(`since:${lc(token)}:${lc(account)}`, 0n);
    this.add(`lane:${lc(token)}:credited`, -amount);
    this.add(this.bal(token, this.vault), -amount);
    this.add(this.bal(token, to), amount);
    this.ev("CreditPaid", token, account, to, amount);
  }
  removeFromOpen(id: string) {
    const open = this.v["count:open"] ? this.v["count:open"].split(",") : [];
    const i = open.indexOf(id);
    const last = open.length - 1;
    if (i !== last) open[i] = open[last];
    open.pop();
    this.v["count:open"] = open.join(",");
  }
  /** getVault's time-dependent fields, recomputed for this block's timestamp. */
  derive() {
    const ids = Object.keys(this.v)
      .filter((k) => k.startsWith("vault:") && k.endsWith(":state"))
      .map((k) => k.split(":")[1]);
    for (const id of ids) {
      const k = (f: string) => this.vk(id, f);
      const st = this.g(k("state"));
      const dl = this.g(k("deadline"));
      const abs = this.g(k("absoluteDeadline"));
      if (st === 2n) this.s(k("finalizableAt"), this.g(k("claimInitiatedAt")) + this.g(k("challengeWindow")));
      else {
        this.s(k("finalizableAt"), 0n);
        this.s(k("lockedFeeBps"), 0n);
      }
      this.s(k("guaranteedInheritanceAt"), abs + this.g(k("challengeWindow")));
      this.s(k("expired"), this.ts >= dl);
      this.s(k("horizonReached"), this.ts >= abs);
      this.s(k("finalizable"), st === 2n && this.ts >= this.g(k("finalizableAt")));
      let w = 0n;
      if (st === 3n || st === 4n) w = 128n;
      else {
        if (this.ts >= dl) w |= 1n;
        if (this.ts >= abs) w |= 2n;
        if (st === 2n) w |= 4n;
        if (this.v[k("hbAnchor")] !== ZERO32 && this.g(k("hbLeft")) === 0n) w |= 8n;
        if (dl >= abs && this.ts < abs) w |= 16n;
      }
      this.s(k("warnings"), w);
    }
    this.s("fee:bps", this.claimFeeBps());
  }
}

/** One transaction of a step: its call, and its expected effects on the snapshot taken just before it. */
interface TxPlan {
  role: Role;
  to: string;
  data: string;
  value?: bigint;
  /** Vault ids the transaction creates, so the snapshot after it reads them. */
  newIds?: string[];
  model: (m: Model, cost: bigint) => void;
  /** Runs once the transaction is mined and verified. */
  commit?: () => void;
}

interface Step {
  id: string;
  phase: string;
  title: string;
  /** Chain timestamp from which the step may run (0 = at once). */
  due?: (r: Runner) => Promise<bigint>;
  /** A reason not to run the step at all. */
  skip?: (r: Runner) => Promise<string | null>;
  run: (r: Runner) => Promise<void>;
}

// ------------------------------------------------------------------ the runner

class Runner {
  provider!: JsonRpcProvider;
  chainId!: bigint;
  iface!: Interface;
  vault!: Contract;
  usdc: Contract | null = null;
  wallets: Record<Role, Wallet | HDNodeWallet> | null = null;
  state!: State;
  statePath!: string;
  lockPath = "";
  private checks = 0;
  private failures: string[] = [];
  private vaultViewFields: string[] = [];
  /** The newest block this runner has seen its own work in: a load-balanced RPC may answer "latest" from behind it. */
  private lastBlock = 0;
  /** The next nonce per sender, as far as this runner knows: a lagging node may report an older "pending" count. */
  private nextNonce = new Map<string, number>();

  constructor(public opts: Opts) {}

  // ---------------------------------------------------------------- setup

  async open() {
    const rpc =
      this.opts.rpc ??
      (this.opts.local
        ? process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8547"
        : process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org");
    this.provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
    if (this.opts.local) this.provider.pollingInterval = 250;
    this.chainId = (await retry(() => this.provider.getNetwork(), "eth_chainId")).chainId;
    // The runner creates vaults and moves value: only the testnet, or a local chain with --local.
    if (this.opts.local && this.chainId !== HARDHAT_LOCAL) {
      throw new Error(`--local needs a local hardhat node (chain 31337), but ${rpc} is chain ${this.chainId}`);
    }
    if (!this.opts.local && this.chainId !== BASE_SEPOLIA) {
      throw new Error(
        `refusing chain ${this.chainId}: this runner is for Base Sepolia (84532) and never runs on a mainnet ` +
          `(for a local hardhat node, add --local)`
      );
    }
    this.statePath = path.resolve(
      this.opts.state ??
        (this.opts.local
          ? path.join(ROOT, "cache", "localnode-lifecycle.json")
          : path.join(ROOT, "deployments", "baseSepolia-lifecycle.json"))
    );
    const art = artifact("contracts/InheritanceVault.sol/InheritanceVault.json");
    this.iface = new Interface(art.abi);
    const gv = this.iface.getFunction("getVault");
    this.vaultViewFields = (gv?.outputs[0].components ?? []).map((c) => c.name);
    if (!this.opts.status) this.lock();
  }

  lock() {
    this.lockPath = this.statePath + ".lock";
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    try {
      const fd = fs.openSync(this.lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
    } catch {
      this.lockPath = "";
      throw new Error(
        `${path.relative(process.cwd(), this.statePath)}.lock exists: another run is active, or one was killed. ` +
          `If no other run is active, delete that file and run again.`
      );
    }
  }

  unlock() {
    if (this.lockPath) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // already gone
      }
      this.lockPath = "";
    }
  }

  save() {
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  loadState(): State | null {
    if (!fs.existsSync(this.statePath)) return null;
    return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as State;
  }

  /**
   * The vault to test: --vault, VAULT_ADDRESS, the state file, or the Base Sepolia deploy record,
   * deployments/baseSepolia-v2.json (DEPLOY.md's name) or else deployments/baseSepolia.json (deploy.ts's default).
   */
  vaultAddress(existing: State | null): string | null {
    const given = this.opts.vault ?? process.env.VAULT_ADDRESS;
    if (given) return getAddress(given);
    if (existing) return existing.vault;
    if (this.opts.local) return null;
    const rec = ["baseSepolia-v2.json", "baseSepolia.json"].map((n) => path.join(ROOT, "deployments", n)).find((p) => fs.existsSync(p));
    if (!rec) {
      throw new Error(`no vault: deploy one to Base Sepolia first (deployments/README.md), or pass --vault`);
    }
    const r = JSON.parse(fs.readFileSync(rec, "utf8"));
    if (String(r.chainId) !== "84532" || r.version !== "v2" || !r.contracts?.InheritanceVault) {
      throw new Error(`${path.relative(process.cwd(), rec)} is not a v2 Base Sepolia record from scripts/deploy.ts`);
    }
    console.log(`vault from ${path.relative(process.cwd(), rec)}`);
    return getAddress(r.contracts.InheritanceVault);
  }

  loadKeys() {
    const dev = new Set(Array.from({ length: 20 }, (_, i) => lc(devWallet(i).address)));
    const load = (name: string, devIndex: number): Wallet | HDNodeWallet => {
      const raw = process.env[name]?.trim();
      if (!raw) {
        if (!this.opts.local) throw new Error(`${name} is not set (see deployments/README.md)`);
        return devWallet(devIndex).connect(this.provider);
      }
      const hex = raw.startsWith("0x") ? raw : "0x" + raw;
      // The value is never echoed, not even in an error.
      if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not a 32-byte hex private key`);
      const w = new Wallet(hex, this.provider);
      if (!this.opts.local && dev.has(lc(w.address))) {
        throw new Error(`${name} is one of hardhat's public development keys: anyone can take what it holds. Use a fresh key.`);
      }
      return w;
    };
    const w = { owner: load("OWNER_KEY", 1), heir: load("HEIR_KEY", 2), keeper: load("KEEPER_KEY", 3) };
    const addrs = Object.values(w).map((x) => lc(x.address));
    if (new Set(addrs).size !== 3) throw new Error("OWNER_KEY, HEIR_KEY and KEEPER_KEY must be three different keys");
    this.wallets = w;
  }

  addr(role: Role): string {
    return this.state.roles[role];
  }

  async latestTs(): Promise<bigint> {
    const b = await retry(() => this.provider.getBlock("latest"), "latest block");
    return BigInt(b!.timestamp);
  }

  /** --local only: the vault, a WETH stand-in and a USDC stand-in, as scripts/deploy.ts would list them on Base Sepolia. */
  async localDeploy(): Promise<State["localDeployment"]> {
    const funder = await this.provider.getSigner(0);
    const admin = await funder.getAddress();
    const tx: string[] = [];
    const deploy = async (rel: string, args: unknown[]) => {
      const a = artifact(rel);
      const c = await new ContractFactory(a.abi, a.bytecode, funder).deploy(...args);
      await c.waitForDeployment();
      tx.push(c.deploymentTransaction()!.hash);
      return getAddress(await c.getAddress());
    };
    const weth = await deploy("contracts/test/TestHelpers.sol/WrappedNativeMock.json", []);
    const usdc = await deploy("contracts/test/TestHelpers.sol/MintableToken.json", []);
    const vault = await deploy("contracts/InheritanceVault.sol/InheritanceVault.json", [admin, 50, admin, [weth, usdc], weth]);
    console.log(`local: deployed InheritanceVault ${vault} (admin and fee recipient ${admin}, 50 bps; tokens: WETH stand-in ${weth}, USDC stand-in ${usdc})`);
    this.opts.vault = vault;
    return { admin, weth, usdc, tx };
  }

  /** --local only: fund the three roles from the node's account 0, and mint USDC stand-ins to the owner. */
  async localFund() {
    const funder = await this.provider.getSigner(0);
    for (const role of ["owner", "heir", "keeper"] as Role[]) {
      const a = this.addr(role);
      if ((await this.provider.getBalance(a)) < parseEther("1")) {
        await (await funder.sendTransaction({ to: a, value: parseEther("10") })).wait();
      }
    }
    const p = this.state.params;
    if (p.usdc && this.state.localDeployment && lc(p.usdc) === lc(this.state.localDeployment.usdc)) {
      const t = new Contract(p.usdc, ERC20_ABI, funder);
      if ((await t.balanceOf(this.addr("owner"))) < BigInt(p.usdcAmount ?? "0")) {
        await (await t.mint(this.addr("owner"), BigInt(p.usdcAmount ?? "0") * 10n)).wait();
      }
    }
  }

  async prepare() {
    let st = this.loadState();
    if (st && String(st.chainId) !== this.chainId.toString()) {
      throw new Error(`${this.statePath} is for chain ${st.chainId}, not ${this.chainId}. Use --state for another file.`);
    }
    if (st && this.opts.local && (await this.provider.getCode(st.vault)) === "0x") {
      if (this.opts.status) {
        console.log(`local: the recorded vault ${st.vault} has no code on this node (restarted?); a normal run starts afresh`);
        return false;
      }
      // A restarted local node: the recorded chain is gone. Keep the old file, start afresh.
      const moved = `${this.statePath}.${Date.now()}.old`;
      fs.renameSync(this.statePath, moved);
      console.log(`local: the recorded vault ${st.vault} has no code on this node (restarted?); old state kept as ${moved}`);
      st = null;
    }
    if (this.opts.status && !st) {
      console.log(`no lifecycle state at ${this.statePath}: not started. Run without --status to begin.`);
      return false;
    }
    let localDeployment: State["localDeployment"];
    if (!st && this.opts.local && !this.opts.vault && !process.env.VAULT_ADDRESS) localDeployment = await this.localDeploy();
    const vaultAddr = this.vaultAddress(st);
    if (!vaultAddr) throw new Error("no vault address");
    if (st && lc(st.vault) !== lc(vaultAddr)) {
      throw new Error(`${this.statePath} records the lifecycle of ${st.vault}, not ${vaultAddr}. Use --state for another file.`);
    }
    const code = await retry(() => this.provider.getCode(vaultAddr), "eth_getCode");
    if (code === "0x") throw new Error(`no contract at ${vaultAddr} on chain ${this.chainId}`);
    const art = artifact("contracts/InheritanceVault.sol/InheritanceVault.json");
    if (!sameCode(code, art.deployedBytecode)) {
      const msg =
        `the code at ${vaultAddr} is not the InheritanceVault compiled from this checkout: the lifecycle would ` +
        `test other code than the one about to ship, and this runner's model may not fit it`;
      if (process.env.LIFECYCLE_ALLOW_CODE_MISMATCH !== "yes") {
        throw new Error(`${msg}. Redeploy, or set LIFECYCLE_ALLOW_CODE_MISMATCH=yes to go on knowingly.`);
      }
      console.log(`WARNING: ${msg} (LIFECYCLE_ALLOW_CODE_MISMATCH=yes)`);
    }
    this.vault = new Contract(vaultAddr, this.iface, this.provider);

    if (this.opts.status && st) {
      this.state = st;
      if (st.params.usdc) this.usdc = new Contract(st.params.usdc, ERC20_ABI, this.provider);
      return true;
    }

    this.loadKeys();
    const w = this.wallets!;
    if (st) {
      for (const role of ["owner", "heir", "keeper"] as Role[]) {
        if (lc(st.roles[role]) !== lc(w[role].address)) {
          throw new Error(`${role.toUpperCase()}_KEY is not the key this lifecycle started with (${st.roles[role]})`);
        }
      }
      this.state = st;
      for (const r of Object.values(st.steps)) for (const t of r.txs ?? []) if (t && t.block > this.lastBlock) this.lastBlock = t.block;
    } else {
      const now = await this.latestTs();
      const usdcAddr = process.env.LIFECYCLE_USDC
        ? getAddress(process.env.LIFECYCLE_USDC)
        : localDeployment
          ? localDeployment.usdc
          : this.opts.local
            ? null
            : USDC_BASE_SEPOLIA;
      let usdc: string | null = null;
      let usdcDecimals: number | null = null;
      let usdcAmount: string | null = null;
      if (usdcAddr && (await this.vault.isSupportedToken(usdcAddr))) {
        const t = new Contract(usdcAddr, ERC20_ABI, this.provider);
        usdcDecimals = Number(await t.decimals());
        usdc = usdcAddr;
        usdcAmount = parseUnits(process.env.LIFECYCLE_USDC_AMOUNT ?? "1", usdcDecimals).toString();
      } else if (usdcAddr) {
        console.log(`note: ${usdcAddr} is not a supported token of this vault; no USDC vault`);
      }
      const eth = parseEther(process.env.LIFECYCLE_ETH ?? "0.0001");
      if (eth < 1000n) throw new Error("LIFECYCLE_ETH is too small");
      const [inactivity, window, pushGrace] = await Promise.all([
        this.vault.MIN_INACTIVITY(),
        this.vault.MIN_CHALLENGE(),
        this.vault.PUSH_GRACE(),
      ]);
      this.state = {
        version: 1,
        chainId: this.chainId.toString(),
        vault: vaultAddr,
        local: this.opts.local,
        startedAt: new Date().toISOString(),
        roles: { owner: w.owner.address, heir: w.heir.address, keeper: w.keeper.address },
        addrs: {
          heirPayout: Wallet.createRandom().address,
          cold: Wallet.createRandom().address,
          wrong: Wallet.createRandom().address,
        },
        params: {
          eth: eth.toString(),
          topUp: (eth / 2n).toString(),
          usdc,
          usdcAmount,
          usdcDecimals,
          inactivity: inactivity.toString(),
          window: window.toString(),
          horizon: (now + 365n * DAY).toString(),
          pushGrace: pushGrace.toString(),
        },
        ids: {},
        baseline: {},
        steps: {},
        localDeployment,
      };
      if (usdc) this.usdc = new Contract(usdc, ERC20_ABI, this.provider);
      // Written to disk only once the accounts can pay for the lifecycle.
      if (this.opts.local) await this.localFund();
      await this.checkFunding();
      const snap = await this.snapshot("latest");
      for (const t of this.tokens()) {
        for (const f of ["locked", "credited", "surplus"]) this.state.baseline[`lane:${lc(t)}:${f}`] = snap.v[`lane:${lc(t)}:${f}`];
      }
      this.save();
      console.log(`started a new lifecycle: state in ${path.relative(process.cwd(), this.statePath)}`);
      return true;
    }
    if (this.state.params.usdc) this.usdc = new Contract(this.state.params.usdc, ERC20_ABI, this.provider);
    if (this.opts.local) await this.localFund();
    await this.checkFunding();
    return true;
  }

  /** Refuses to start a phase the three accounts cannot pay for. */
  async checkFunding() {
    const p = this.state.params;
    const doneOrSkipped = (id: string) => ["done", "skipped"].includes(this.state.steps[id]?.status ?? "");
    const gas = parseEther("0.0005");
    const need: Record<Role, bigint> = { owner: gas, heir: gas / 2n, keeper: gas / 2n };
    for (const id of ["d0-01-create-A", "d0-02-create-B", "d0-03-create-C"]) if (!doneOrSkipped(id)) need.owner += BigInt(p.eth);
    if (!doneOrSkipped("d0-07-topup-A")) need.keeper += BigInt(p.topUp);
    const short: string[] = [];
    for (const role of ["owner", "heir", "keeper"] as Role[]) {
      const have = await retry(() => this.provider.getBalance(this.addr(role)));
      if (have < need[role]) {
        short.push(`${role} ${this.addr(role)} holds ${formatEther(have)} ETH; it needs at least ${formatEther(need[role])}`);
      }
    }
    if (short.length) throw new Error(`fund the testnet accounts first (deployments/README.md):\n  ${short.join("\n  ")}`);
  }

  tokens(): string[] {
    return this.state.params.usdc ? [ETH, this.state.params.usdc] : [ETH];
  }

  // ---------------------------------------------------------------- snapshots

  /** Everything the model tracks, read at one block. */
  async snapshot(tag: number | "latest", extraIds: string[] = []): Promise<Snap> {
    const n = tag === "latest" ? Math.max(await retry(() => this.provider.getBlockNumber(), "block number"), this.lastBlock) : tag;
    const blk = await retry(async () => {
      const b = await this.provider.getBlock(n);
      if (!b) throw new Error(`block ${n} is not visible yet`);
      return b;
    }, `block ${n}`);
    const o = { blockTag: blk.number };
    const V = this.vault;
    const v: Record<string, string> = {};
    const [bps, pBps, pAt, rec, activeAt] = await pool([
      () => retry(() => V.claimFeeBps(o)),
      () => retry(() => V.pendingClaimFeeBps(o)),
      () => retry(() => V.pendingClaimFeeAt(o)),
      () => retry(() => V.feeRecipient(o)),
      () => retry(() => V.feeRecipientActiveAt(o)),
    ]);
    Object.assign(v, { "fee:bps": norm(bps), "fee:pendingBps": norm(pBps), "fee:pendingAt": norm(pAt), "fee:recipient": norm(rec), "fee:activeAt": norm(activeAt) });
    const s = this.state;
    const accounts = [...new Set([s.roles.owner, s.roles.heir, s.roles.keeper, s.addrs.heirPayout, s.addrs.cold, s.addrs.wrong, String(rec)].map(lc))].filter(
      (a) => a !== lc(ZeroAddress)
    );
    const vaultAddr = lc(this.vault.target as string);
    const reads: [string, () => Promise<unknown>][] = [];
    for (const a of [...accounts, vaultAddr]) reads.push([`eth:${a}`, () => this.provider.getBalance(a, blk.number)]);
    for (const t of this.tokens()) {
      const tk = lc(t);
      if (t !== ETH) {
        const erc = new Contract(t, ERC20_ABI, this.provider);
        for (const a of [...accounts, vaultAddr]) reads.push([`tok:${tk}:${a}`, () => erc.balanceOf(a, o)]);
      }
      reads.push([`lane:${tk}:locked`, () => V.totalLocked(t, o)]);
      reads.push([`lane:${tk}:credited`, () => V.totalCredited(t, o)]);
      reads.push([`lane:${tk}:surplus`, () => V.surplus(t, o)]);
      for (const a of accounts) {
        reads.push([`credit:${tk}:${a}`, () => V.creditOf(t, a, o)]);
        reads.push([`since:${tk}:${a}`, () => V.creditedSince(t, a, o)]);
      }
    }
    const owner = s.roles.owner;
    reads.push(["count:vaultCount", () => V.vaultCount(owner, o)]);
    reads.push(["count:created", () => V.vaultsCreated(o)]);
    reads.push(["count:settled", () => V.vaultsSettled(o)]);
    reads.push(["count:closed", () => V.vaultsClosed(o)]);
    reads.push(["count:open", async () => ((await V.openVaultIds(owner, o)) as bigint[]).map(String).join(",")]);
    const ids = [...new Set([...Object.values(s.ids), ...extraIds])] as string[];
    for (const id of ids) {
      reads.push([
        `vault:${id}`,
        async () => {
          const r = await V.getVault(owner, id, o);
          return this.vaultViewFields.map((f) => [f, norm(r[f])] as const);
        },
      ]);
    }
    const values = await pool(reads.map(([k, f]) => () => retry(f, k)));
    reads.forEach(([k], i) => {
      const x = values[i];
      if (k.startsWith("vault:")) for (const [f, val] of x as [string, string][]) v[`${k}:${f}`] = val;
      else v[k] = norm(x);
    });
    return { block: blk.number, ts: blk.timestamp, v };
  }

  /** Each token's lanes add up to what the vault holds, and surplus is where it started. */
  invariants(snap: Snap) {
    const vaultAddr = lc(this.vault.target as string);
    for (const t of this.tokens()) {
      const tk = lc(t);
      const name = t === ETH ? "ETH" : "USDC";
      const bal = BigInt(t === ETH ? snap.v[`eth:${vaultAddr}`] : snap.v[`tok:${tk}:${vaultAddr}`]);
      const locked = BigInt(snap.v[`lane:${tk}:locked`]);
      const credited = BigInt(snap.v[`lane:${tk}:credited`]);
      const surplus = BigInt(snap.v[`lane:${tk}:surplus`]);
      const base = BigInt(this.state.baseline[`lane:${tk}:surplus`] ?? "0");
      const ok = bal >= locked + credited && surplus === bal - locked - credited && surplus === base;
      this.check(
        `lanes ${name}: locked ${locked} + credited ${credited} + surplus ${surplus} = balance ${bal}; surplus as at the start`,
        ok,
        `balance ${bal}, locked ${locked}, credited ${credited}, surplus ${surplus} (start ${base})`
      );
    }
  }

  // ---------------------------------------------------------------- checks

  check(label: string, ok: boolean, got?: string, want?: string) {
    this.checks++;
    if (ok) console.log(`    ok   ${label}`);
    else {
      const why = want === undefined ? (got ?? "") : `got ${got}, expected ${want}`;
      console.log(`    FAIL ${label}${why ? `: ${why}` : ""}`);
      this.failures.push(`${label}${why ? `: ${why}` : ""}`);
    }
  }

  decodeRevert(e: unknown): string {
    const cands = [
      (e as { data?: unknown })?.data,
      (e as { info?: { error?: { data?: unknown } } })?.info?.error?.data,
      (e as { error?: { data?: unknown } })?.error?.data,
    ];
    for (const c of cands) {
      const d = typeof c === "string" ? c : (c as { data?: string })?.data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
        try {
          const p = this.iface.parseError(d);
          if (p) return `${p.name}(${p.args.map(norm).join(",")})`;
        } catch {
          return `revert ${d.slice(0, 10)}`;
        }
      }
    }
    return `error: ${errText(e)}`;
  }

  /** A wrong turn, tried by eth_call only: it must revert with exactly this error. */
  async expectRevert(label: string, role: Role, method: string, args: unknown[], want: string) {
    let got = "no revert";
    const blockTag = Math.max(await retry(() => this.provider.getBlockNumber(), "block number"), this.lastBlock);
    try {
      await retry(() => this.provider.call({ from: this.addr(role), to: this.vault.target as string, data: this.iface.encodeFunctionData(method, args), blockTag }), "eth_call");
    } catch (e) {
      got = this.decodeRevert(e);
    }
    this.check(`${label}: ${want}`, got === lc(want) || got === want, got, want);
  }

  // ---------------------------------------------------------------- transactions

  /**
   * Sends the step's transaction number `index` once (resuming a pending one), then verifies it against
   * the model. A transaction already recorded for this step is never sent again.
   */
  async tx(stepId: string, build: (before: Snap) => TxPlan, index = 0): Promise<{ before: Snap; after: Snap; rc: TransactionReceipt | null }> {
    const rec = (this.state.steps[stepId] ??= {});
    const done = rec.txs?.[index];
    if (done && !rec.pending) {
      console.log(`    (transaction ${done.hash} already verified)`);
      return { before: { block: 0, ts: 0, v: {} }, after: { block: done.block, ts: done.ts, v: {} }, rc: null };
    }
    let before: Snap;
    let plan: TxPlan;
    if (rec.pending) {
      before = rec.pending.before;
      plan = build(before);
      console.log(`    resuming ${rec.pending.hash}, signed ${rec.pending.sentAt}`);
    } else {
      before = await this.snapshot("latest");
      plan = build(before);
      const w = this.wallets![plan.role];
      // Simulated at the snapshot's block first, so a transaction that would revert is never sent and the
      // reason is readable. (Not at "latest": a load-balanced RPC may answer that from an older block.)
      const call = { from: w.address, to: plan.to, data: plan.data, value: plan.value ?? 0n, blockTag: before.block };
      try {
        await retry(() => this.provider.call(call), "simulation");
      } catch (e) {
        if (!isRevert(e)) throw e;
        throw new Error(`the ${plan.role}'s transaction would revert: ${this.decodeRevert(e)}`);
      }
      // ethers' estimateGas drops the block tag; eth_estimateGas takes one.
      const gas = BigInt(
        await retry(
          () =>
            this.provider.send("eth_estimateGas", [
              { from: w.address, to: plan.to, data: plan.data, value: toQuantity(plan.value ?? 0n) },
              toQuantity(before.block),
            ]),
          "gas estimate"
        )
      );
      const pendingNonce = await retry(() => this.provider.getTransactionCount(w.address, "pending"), "nonce");
      const nonce = Math.max(pendingNonce, this.nextNonce.get(lc(w.address)) ?? 0);
      const req = await w.populateTransaction({ to: plan.to, data: plan.data, value: plan.value ?? 0n, nonce, gasLimit: (gas * 12n) / 10n });
      const raw = await w.signTransaction(req);
      rec.pending = { hash: keccak256(raw), raw, from: w.address, nonce: Number(req.nonce), before, sentAt: new Date().toISOString() };
      this.save();
      if (this.opts.local && process.env.LIFECYCLE_TEST_CRASH_AFTER_SIGN === stepId) {
        // Test hook, honoured with --local only: die after the hash is recorded, before the broadcast.
        console.log(`    (test hook: exiting after signing ${rec.pending.hash}, before broadcasting it)`);
        this.unlock();
        process.exit(97);
      }
      await this.broadcast(rec.pending.raw, false);
      if (this.opts.local && process.env.LIFECYCLE_TEST_CRASH_AFTER_SEND === stepId) {
        console.log(`    (test hook: exiting after broadcasting ${rec.pending.hash}, before its receipt)`);
        this.unlock();
        process.exit(98);
      }
    }
    const p = rec.pending!;
    const rc = await this.receipt(p);
    if (rc.status !== 1) throw new Error(`${p.hash} was mined but reverted`);
    this.lastBlock = Math.max(this.lastBlock, rc.blockNumber);
    this.nextNonce.set(lc(p.from), Math.max(this.nextNonce.get(lc(p.from)) ?? 0, p.nonce + 1));
    const raw = await retry(() => this.provider.send("eth_getTransactionReceipt", [p.hash]));
    const l1Fee = raw?.l1Fee ? BigInt(raw.l1Fee) : 0n;
    const opFee = (raw?.operatorFeeScalar && BigInt(raw.operatorFeeScalar) !== 0n) || (raw?.operatorFeeConstant && BigInt(raw.operatorFeeConstant) !== 0n);
    const cost = rc.gasUsed * rc.gasPrice + l1Fee;
    const after = await this.snapshot(rc.blockNumber, plan.newIds ?? []);
    console.log(`    tx ${p.hash}  block ${rc.blockNumber}  ${plan.role}  gas ${rc.gasUsed}  fee ${formatEther(cost)} ETH`);

    // ---- the model against the chain, every field
    const m = new Model(structuredClone(before.v), BigInt(after.ts), this.vault.target as string);
    plan.model(m, cost);
    m.derive();
    const sender = `eth:${lc(p.from)}`;
    const keys = [...new Set([...Object.keys(m.v), ...Object.keys(after.v)])].sort();
    const bad: string[] = [];
    for (const k of keys) {
      const want = m.v[k];
      const got = after.v[k];
      if (want === got) continue;
      // With an operator fee in the receipt the exact fee is not modelled: the sender paid at least the rest.
      if (k === sender && opFee && want !== undefined && got !== undefined && BigInt(got) <= BigInt(want)) continue;
      bad.push(`${k}: got ${got ?? "(missing)"}, expected ${want ?? "(missing)"}`);
    }
    this.check(`${keys.length} tracked fields as modelled`, bad.length === 0, bad.slice(0, 12).join("; ") + (bad.length > 12 ? `; (+${bad.length - 12} more)` : ""));

    // ---- events, in order, with their arguments
    const logs = rc.logs
      .filter((l) => lc(l.address) === lc(this.vault.target as string))
      .map((l) => {
        const d = this.iface.parseLog(l);
        return d ? `${d.name}(${d.args.map(norm).join(",")})` : `unparsed ${l.topics[0]}`;
      });
    const wantLogs = m.events.map(([n, a]) => `${n}(${a.join(",")})`);
    this.check(
      `events ${m.events.map(([n]) => n).join(", ") || "(none from the vault)"}`,
      logs.join(" ") === wantLogs.join(" "),
      logs.join(" "),
      wantLogs.join(" ")
    );
    this.invariants(after);

    (rec.txs ??= [])[index] = { hash: p.hash, block: rc.blockNumber, ts: after.ts, gasUsed: rc.gasUsed.toString(), cost: cost.toString() };
    if (this.failures.length === 0) {
      delete rec.pending;
      plan.commit?.();
    }
    this.save();
    return { before, after, rc };
  }

  /** A first broadcast tolerates only "already known"; a re-broadcast also tolerates a used nonce (it may be ours, mined). */
  async broadcast(raw: string, again: boolean) {
    try {
      await this.provider.broadcastTransaction(raw);
    } catch (e) {
      const t = errText(e);
      if (/already known|known transaction|already imported|already exists/i.test(t)) return;
      if (again && /nonce too low|nonce has already been used/i.test(t)) return;
      throw e;
    }
  }

  /** The receipt of a recorded transaction: waits, re-broadcasts the same bytes, or reports it dead. */
  async receipt(p: Pending): Promise<TransactionReceipt> {
    for (let round = 0; round < 10; round++) {
      const rc = await retry(() => this.provider.getTransactionReceipt(p.hash), "receipt");
      if (rc) return rc;
      const mined = await retry(() => this.provider.getTransactionCount(p.from, "latest"), "nonce");
      if (mined > p.nonce && round >= 3) {
        const seen = await retry(() => this.provider.getTransaction(p.hash), "transaction");
        if (!seen) {
          throw new Error(
            `${p.hash} can never be mined: nonce ${p.nonce} of ${p.from} was used by another transaction. ` +
              `Check that account's history, then delete this step's "pending" entry from the state file to redo it.`
          );
        }
      }
      if (mined <= p.nonce) await this.broadcast(p.raw, true);
      const r = await this.provider.waitForTransaction(p.hash, 1, this.opts.local ? 10_000 : 60_000).catch(() => null);
      if (r) return r;
      console.log(`    waiting for ${p.hash}…`);
    }
    throw new Error(`${p.hash} is not mined yet; run again later (it is recorded, and will not be sent twice)`);
  }

  // ---------------------------------------------------------------- the run

  async advance() {
    const s = this.state;
    const net = this.opts.local ? "local hardhat node" : "Base Sepolia";
    console.log(`lifecycle of ${s.vault} on ${net} (chain ${s.chainId})`);
    console.log(`owner ${s.roles.owner}   heir ${s.roles.heir}   keeper ${s.roles.keeper}`);
    for (const step of STEPS) {
      const rec = s.steps[step.id];
      if (rec?.status === "done" || rec?.status === "skipped") continue;
      if (rec?.status === "failed" && this.opts.acceptFailed) {
        rec.status = "done";
        rec.note = `accepted by the operator (--accept-failed) after: ${(rec.failures ?? []).join("; ")}`;
        delete rec.pending;
        this.save();
        console.log(`\n${step.id}: failure accepted by the operator; moving on`);
        continue;
      }
      let reason: string | null = null;
      let due = 0n;
      try {
        reason = step.skip && !rec?.pending ? await step.skip(this) : null;
        due = !reason && step.due && !rec?.pending ? await step.due(this) : 0n;
      } catch (e) {
        const r0 = (s.steps[step.id] ??= {});
        r0.status = "failed";
        r0.failures = [`cannot schedule: ${errText(e)}`];
        this.save();
        throw new Error(`step ${step.id} cannot be scheduled: ${errText(e)}`);
      }
      if (reason) {
        s.steps[step.id] = { status: "skipped", at: new Date().toISOString(), note: reason };
        this.save();
        console.log(`\n[${step.phase}] ${step.id}  ${step.title}\n    skipped: ${reason}`);
        continue;
      }
      let now = await this.latestTs();
      // A step due within a few minutes (C's claim trails A's by the seconds between them) is waited for,
      // a bounded number of times: chain time only moves when blocks are made.
      for (let i = 0; i < 3 && !this.opts.local && due > now && due - now <= 300n; i++) {
        console.log(`\n[${step.phase}] ${step.id} is due in ${span(due - now)}: waiting`);
        await sleep(Number(due - now + 4n) * 1000);
        now = await this.latestTs();
      }
      if (due > now) {
        this.printNext(step, due, now);
        if (this.opts.local && this.opts.warp) {
          await this.provider.send("evm_setNextBlockTimestamp", [Number(due)]);
          await this.provider.send("evm_mine", []);
          console.log(`local: moved the chain clock to ${when(due)}; run again to continue`);
        }
        return;
      }
      console.log(`\n[${step.phase}] ${step.id}  ${step.title}`);
      this.checks = 0;
      this.failures = [];
      try {
        await step.run(this);
      } catch (e) {
        this.failures.push(errText(e));
        console.log(`    FAIL ${errText(e)}`);
      }
      const r = (s.steps[step.id] ??= {});
      r.checks = (r.checks ?? 0) + this.checks;
      if (this.failures.length) {
        r.status = "failed";
        r.failures = this.failures;
        this.save();
        throw new Error(
          `step ${step.id} failed (${this.failures.length} check(s)). Nothing further runs until it passes: ` +
            `run again to re-check it, or --accept-failed once a human has looked.`
        );
      }
      r.status = "done";
      r.at = new Date().toISOString();
      delete r.failures;
      this.save();
    }
    console.log(`\nLIFECYCLE COMPLETE: every step done and asserted (${path.relative(process.cwd(), this.statePath)}).`);
  }

  printNext(step: Step, due: bigint, now: bigint) {
    console.log(`\nnext: [${step.phase}] ${step.id}  ${step.title}`);
    console.log(`      due at chain time ${when(due)}, in about ${span(due - now)} (chain time now ${when(now)})`);
    console.log(`      nothing else is due: run this again then`);
  }

  async status() {
    const s = this.state;
    const now = await this.latestTs();
    console.log(`lifecycle of ${s.vault} (chain ${s.chainId}), started ${s.startedAt}; chain time ${when(now)}`);
    let nextShown = false;
    for (const step of STEPS) {
      const rec = s.steps[step.id];
      const tx = rec?.txs?.map((t) => t.hash).join(" ") ?? "";
      const st = rec?.pending ? "SENT, unconfirmed" : rec?.status ?? "to do";
      console.log(`  ${st.padEnd(18)} [${step.phase}] ${step.id}  ${step.title}${tx ? `  ${tx}` : ""}${rec?.note ? `  (${rec.note})` : ""}`);
      if (!nextShown && !rec?.status) {
        nextShown = true;
        if (step.due && !rec?.pending) {
          try {
            const due = await step.due(this);
            console.log(`  ${"".padEnd(18)} due ${due > now ? `at ${when(due)}, in about ${span(due - now)}` : "now"}`);
          } catch (e) {
            console.log(`  ${"".padEnd(18)} (due time unknown: ${errText(e)})`);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- step building blocks

  id(x: Letter): string {
    const id = this.state.ids[x];
    if (id === undefined) throw new Error(`vault ${x} was never created`);
    return id;
  }

  async view(x: Letter) {
    return retry(() => this.vault.getVault(this.addr("owner"), this.id(x)));
  }

  data(method: string, args: unknown[]) {
    return this.iface.encodeFunctionData(method, args);
  }

  async createVault(x: Letter, token: string, amount: bigint) {
    const p = this.state.params;
    const owner = this.addr("owner");
    const heir = this.addr("heir");
    const inact = BigInt(p.inactivity);
    const win = BigInt(p.window);
    const horizon = BigInt(p.horizon);
    await this.tx(`${STEP_OF[x]}`, (before) => {
      const id = before.v["count:vaultCount"];
      return {
        role: "owner",
        to: this.vault.target as string,
        data: this.data("createVault", [token, amount, heir, inact, win, horizon]),
        value: token === ETH ? amount : 0n,
        newIds: [id],
        model: (m, cost) => {
          m.paid(owner, token === ETH ? amount : 0n, cost);
          if (token === ETH) m.add(m.bal(ETH, this.vault.target as string), amount);
          else {
            m.add(m.bal(token, owner), -amount);
            m.add(m.bal(token, this.vault.target as string), amount);
          }
          const k = (f: string) => m.vk(id, f);
          const fee = m.claimFeeBps();
          const dl = m.ts + inact < horizon ? m.ts + inact : horizon;
          const fields: Record<string, string | bigint> = {
            owner, vaultId: BigInt(id), state: 1n, beneficiary: heir, token, balance: amount, feeBps: fee, lockedFeeBps: 0n,
            createdAt: m.ts, deadline: dl, absoluteDeadline: horizon, inactivityPeriod: inact, challengeWindow: win,
            claimRecipient: ZeroAddress, claimInitiatedAt: 0n, hbAnchor: ZERO32, hbLeft: 0n, hbEpoch: 0n,
          };
          for (const [f, val] of Object.entries(fields)) m.s(k(f), val);
          m.add(`lane:${lc(token)}:locked`, amount);
          m.add("count:vaultCount", 1n);
          m.add("count:created", 1n);
          m.v["count:open"] = m.v["count:open"] ? `${m.v["count:open"]},${id}` : id;
          m.ev("DeadlineReset", owner, BigInt(id), dl, horizon);
          m.ev("VaultCreated", owner, BigInt(id), heir, token, amount, dl, horizon, inact, win, fee);
        },
        commit: () => {
          this.state.ids[x] = id;
        },
      };
    });
    const v = await this.view(x);
    console.log(`    vault ${x} = id ${this.id(x)}: ${token === ETH ? formatEther(amount) + " ETH" : formatUnits(amount, p.usdcDecimals ?? 6) + " USDC"}, deadline ${when(v.deadline)}, horizon ${when(v.absoluteDeadline)}`);
  }

  async claim(stepId: string, x: Letter, recipient: string) {
    const owner = this.addr("owner");
    const heir = this.addr("heir");
    await this.tx(stepId, () => {
      const id = this.id(x);
      return {
        role: "heir",
        to: this.vault.target as string,
        data: this.data("initiateClaim", [owner, id, recipient]),
        model: (m, cost) => {
          m.paid(heir, 0n, cost);
          const k = (f: string) => m.vk(id, f);
          const ceiling = m.g(k("feeBps"));
          const cur = m.claimFeeBps();
          const locked = m.feeRecipientInForce() ? (cur < ceiling ? cur : ceiling) : 0n;
          m.s(k("state"), 2n);
          m.s(k("claimRecipient"), recipient);
          m.s(k("claimInitiatedAt"), m.ts);
          m.s(k("lockedFeeBps"), locked);
          m.ev("ClaimInitiated", owner, BigInt(id), recipient, m.ts + m.g(k("challengeWindow")), locked);
        },
      };
    });
    const v = await this.view(x);
    console.log(`    vault ${x}: ${STATE_NAMES[String(v.state)]}, payout to ${v.claimRecipient}, fee locked at ${v.lockedFeeBps} bps, finalizable from ${when(v.finalizableAt)}`);
  }

  async finalize(stepId: string, x: Letter) {
    const owner = this.addr("owner");
    const keeper = this.addr("keeper");
    await this.tx(stepId, () => {
      const id = this.id(x);
      return {
        role: "keeper",
        to: this.vault.target as string,
        data: this.data("finalizeClaim", [owner, id]),
        model: (m, cost) => {
          m.paid(keeper, 0n, cost);
          const k = (f: string) => m.vk(id, f);
          const amt = m.g(k("balance"));
          const token = m.v[k("token")];
          const to = m.v[k("claimRecipient")];
          let bps = m.g(k("lockedFeeBps"));
          const cur = m.claimFeeBps();
          if (cur < bps) bps = cur;
          const feeTo = m.v["fee:recipient"];
          const fee = !m.feeRecipientInForce() ? 0n : (amt * bps) / 10_000n;
          m.s(k("balance"), 0n);
          m.add(`lane:${token}:locked`, -amt);
          m.credit(token, to, amt - fee);
          if (fee !== 0n) m.credit(token, feeTo, fee);
          m.s(k("state"), 3n);
          m.add("count:settled", 1n);
          m.removeFromOpen(id);
          m.ev("ClaimSettled", owner, BigInt(id), to, amt - fee, fee);
        },
      };
    });
  }

  async withdrawCredit(stepId: string, role: Role, token: string, to: string, amount: (before: Snap) => bigint | null) {
    const who = this.addr(role);
    await this.tx(stepId, (before) => {
      const a = amount(before);
      const owed = BigInt(before.v[`credit:${lc(token)}:${lc(who)}`] ?? "0");
      const pay = a === null ? owed : a;
      return {
        role,
        to: this.vault.target as string,
        data: a === null
          ? this.data("withdrawCredit(address,address)", [token, to])
          : this.data("withdrawCredit(address,address,uint256)", [token, to, a]),
        model: (m, cost) => {
          m.paid(who, 0n, cost);
          m.payCredit(token, who, to, pay);
        },
      };
    });
  }

  async closeVault(stepId: string, x: Letter) {
    const owner = this.addr("owner");
    await this.tx(stepId, () => {
      const id = this.id(x);
      return {
        role: "owner",
        to: this.vault.target as string,
        data: this.data("withdraw", [id, 2n ** 256n - 1n, owner]),
        model: (m, cost) => {
          m.paid(owner, 0n, cost);
          const k = (f: string) => m.vk(id, f);
          const amount = m.g(k("balance"));
          const token = m.v[k("token")];
          m.s(k("balance"), 0n);
          m.add(`lane:${token}:locked`, -amount);
          m.credit(token, owner, amount);
          m.resetClock(owner, id);
          m.s(k("state"), 4n);
          m.s(k("claimInitiatedAt"), 0n);
          m.s(k("claimRecipient"), ZeroAddress);
          m.add("count:closed", 1n);
          m.removeFromOpen(id);
          m.ev("Withdrawn", owner, BigInt(id), owner, amount, true);
        },
      };
    });
  }

  async push(stepId: string, token: string, account: string) {
    const keeper = this.addr("keeper");
    await this.tx(stepId, (before) => {
      const owed = BigInt(before.v[`credit:${lc(token)}:${lc(account)}`] ?? "0");
      return {
        role: "keeper",
        to: this.vault.target as string,
        data: this.data("pushCredit", [token, account]),
        model: (m, cost) => {
          m.paid(keeper, 0n, cost);
          m.payCredit(token, account, account, owed);
        },
      };
    });
  }

  async pushDue(account: string): Promise<bigint> {
    const since = await retry(() => this.vault.creditedSince(ETH, account));
    return BigInt(since) + BigInt(this.state.params.pushGrace);
  }
}

// ------------------------------------------------------------------ the steps

const STEP_OF: Record<Letter, string> = { A: "d0-01-create-A", B: "d0-02-create-B", C: "d0-03-create-C", D: "d0-05-create-D" };

async function usdcSkip(r: Runner): Promise<string | null> {
  const p = r.state.params;
  if (!p.usdc || !r.usdc) return "no USDC: the vault does not list the testnet USDC";
  const have = BigInt(await retry(() => r.usdc!.balanceOf(r.addr("owner"))));
  if (have < BigInt(p.usdcAmount ?? "0")) {
    return `the owner holds ${formatUnits(have, p.usdcDecimals ?? 6)} USDC, less than the ${formatUnits(BigInt(p.usdcAmount ?? "0"), p.usdcDecimals ?? 6)} a USDC vault needs (a faucet's USDC is enough; see deployments/README.md)`;
  }
  return null;
}
const noVaultD = async (r: Runner) => (r.state.ids.D === undefined ? "there is no USDC vault (D)" : null);

const STEPS: Step[] = [
  {
    id: "d0-01-create-A",
    phase: "day 0",
    title: "the owner creates vault A (ETH); nobody will veto its claim",
    run: (r) => r.createVault("A", ETH, BigInt(r.state.params.eth)),
  },
  {
    id: "d0-02-create-B",
    phase: "day 0",
    title: "the owner creates vault B (ETH); its claim will be vetoed",
    run: (r) => r.createVault("B", ETH, BigInt(r.state.params.eth)),
  },
  {
    id: "d0-03-create-C",
    phase: "day 0",
    title: "the owner creates vault C (ETH); its claim will be cancelled and re-filed",
    run: (r) => r.createVault("C", ETH, BigInt(r.state.params.eth)),
  },
  {
    id: "d0-04-approve-usdc",
    phase: "day 0",
    title: "the owner approves the vault to take the USDC deposit",
    skip: usdcSkip,
    run: async (r) => {
      const p = r.state.params;
      const owner = r.addr("owner");
      await r.tx("d0-04-approve-usdc", () => ({
        role: "owner",
        to: p.usdc!,
        data: new Interface(ERC20_ABI).encodeFunctionData("approve", [r.vault.target, BigInt(p.usdcAmount!)]),
        model: (m, cost) => m.paid(owner, 0n, cost),
      }));
      const allowance = await retry(() => r.usdc!.allowance(owner, r.vault.target));
      r.check(`allowance ${allowance}`, BigInt(allowance) === BigInt(p.usdcAmount!), String(allowance), p.usdcAmount!);
    },
  },
  {
    id: "d0-05-create-D",
    phase: "day 0",
    title: "the owner creates vault D (USDC); kept alive by the batch keeper, then closed",
    skip: async (r) => (r.state.steps["d0-04-approve-usdc"]?.status === "skipped" ? "no USDC approval (step d0-04 skipped)" : usdcSkip(r)),
    run: (r) => r.createVault("D", r.state.params.usdc!, BigInt(r.state.params.usdcAmount!)),
  },
  {
    id: "d0-06-checkin-A",
    phase: "day 0",
    title: "the owner checks in on vault A",
    run: async (r) => {
      const owner = r.addr("owner");
      await r.tx("d0-06-checkin-A", () => {
        const id = r.id("A");
        return {
          role: "owner",
          to: r.vault.target as string,
          data: r.data("checkIn", [id]),
          model: (m, cost) => {
            m.paid(owner, 0n, cost);
            m.resetClock(owner, id);
            m.ev("CheckedIn", owner, BigInt(id), m.g(m.vk(id, "deadline")), false);
          },
        };
      });
      const a = await r.view("A");
      await r.expectRevert("the heir cannot claim A yet", "heir", "initiateClaim", [owner, r.id("A"), r.addr("heir")], `NotYetExpired(${a.deadline})`);
      // A stranger's check-in is resolved against the STRANGER's own vaults, so it can never refresh the owner's.
      const keeperVaults = BigInt(await retry(() => r.vault.vaultCount(r.addr("keeper"))));
      if (keeperVaults === 0n) {
        await r.expectRevert("a stranger cannot check in on A", "keeper", "checkIn", [r.id("A")], `NoSuchVault(${lc(r.addr("keeper"))},${r.id("A")})`);
        await r.expectRevert("a stranger's batch check-in moves nothing", "keeper", "checkInMany", [[r.id("A"), r.id("B"), r.id("C")]], "NothingCheckedIn(2)");
      } else console.log(`    note: the keeper owns ${keeperVaults} vault(s) of its own; the stranger checks are skipped`);
    },
  },
  {
    id: "d0-07-topup-A",
    phase: "day 0",
    title: "the keeper tops up vault A (a gift: it must not move the deadline)",
    run: async (r) => {
      const owner = r.addr("owner");
      const keeper = r.addr("keeper");
      const t = BigInt(r.state.params.topUp);
      await r.tx("d0-07-topup-A", () => {
        const id = r.id("A");
        return {
          role: "keeper",
          to: r.vault.target as string,
          data: r.data("topUp", [owner, id, t]),
          value: t,
          model: (m, cost) => {
            m.paid(keeper, t, cost);
            m.add(m.vk(id, "balance"), t);
            m.add(`lane:${lc(ETH)}:locked`, t);
            m.add(m.bal(ETH, r.vault.target as string), t);
            m.ev("ToppedUp", owner, BigInt(id), keeper, t);
          },
        };
      });
    },
  },
  {
    id: "d7-10-claim-A",
    phase: "day 7+",
    title: "the heir claims vault A, to the heir's own address",
    due: async (r) => BigInt((await r.view("A")).deadline),
    run: (r) => r.claim("d7-10-claim-A", "A", r.addr("heir")),
  },
  {
    id: "d7-11-claim-B",
    phase: "day 7+",
    title: "the heir claims vault B",
    due: async (r) => BigInt((await r.view("B")).deadline),
    run: (r) => r.claim("d7-11-claim-B", "B", r.addr("heir")),
  },
  {
    id: "d7-12-veto-B",
    phase: "day 7+",
    title: "the owner vetoes the claim on B: B is ACTIVE again, its clock reset",
    run: async (r) => {
      const owner = r.addr("owner");
      await r.tx("d7-12-veto-B", () => {
        const id = r.id("B");
        return {
          role: "owner",
          to: r.vault.target as string,
          data: r.data("abortClaim", [id]),
          model: (m, cost) => {
            m.paid(owner, 0n, cost);
            m.s(m.vk(id, "claimInitiatedAt"), 0n);
            m.s(m.vk(id, "claimRecipient"), ZeroAddress);
            m.s(m.vk(id, "state"), 1n);
            m.resetClock(owner, id);
            m.ev("ClaimAborted", owner, BigInt(id), m.g(m.vk(id, "deadline")));
          },
        };
      });
      const b = await r.view("B");
      r.check(`vault B is ${STATE_NAMES[String(b.state)]}`, BigInt(b.state) === 1n, String(b.state), "1");
      await r.expectRevert("the heir cannot re-claim B until its reset deadline", "heir", "initiateClaim", [owner, r.id("B"), r.addr("heir")], `NotYetExpired(${b.deadline})`);
    },
  },
  {
    id: "d7-13-claim-C",
    phase: "day 7+",
    title: "the heir claims vault C, to a mistyped payout address",
    due: async (r) => BigInt((await r.view("C")).deadline),
    run: (r) => r.claim("d7-13-claim-C", "C", r.state.addrs.wrong),
  },
  {
    id: "d7-14-cancel-C",
    phase: "day 7+",
    title: "the heir cancels the claim on C (the undo for a mistyped address)",
    run: async (r) => {
      const owner = r.addr("owner");
      const heir = r.addr("heir");
      await r.tx("d7-14-cancel-C", () => {
        const id = r.id("C");
        return {
          role: "heir",
          to: r.vault.target as string,
          data: r.data("beneficiaryCancelClaim", [owner, id]),
          model: (m, cost) => {
            m.paid(heir, 0n, cost);
            m.s(m.vk(id, "state"), 1n);
            m.s(m.vk(id, "claimInitiatedAt"), 0n);
            m.s(m.vk(id, "claimRecipient"), ZeroAddress);
            m.ev("ClaimCancelled", owner, BigInt(id), heir);
          },
        };
      });
    },
  },
  {
    id: "d7-15-refile-C",
    phase: "day 7+",
    title: "the heir re-files the claim on C, to a receive-only address (no key: only a push can pay it)",
    run: (r) => r.claim("d7-15-refile-C", "C", r.state.addrs.cold),
  },
  {
    id: "d7-16-batch-checkin",
    phase: "day 7+",
    title: "the owner's batch keeper runs checkInMany over A, B, C, D and an unknown id",
    run: async (r) => {
      const owner = r.addr("owner");
      await r.tx("d7-16-batch-checkin", (before) => {
        const known = (["A", "B", "C", "D"] as Letter[]).filter((x) => r.state.ids[x] !== undefined).map((x) => r.id(x));
        const ids = [...known, before.v["count:vaultCount"]];
        return {
          role: "owner",
          to: r.vault.target as string,
          data: r.data("checkInMany", [ids]),
          model: (m, cost) => {
            m.paid(owner, 0n, cost);
            const owned = m.g("count:vaultCount");
            for (const id of ids) {
              const k = (f: string) => m.vk(id, f);
              let skip = 0n;
              if (BigInt(id) >= owned) skip = 1n;
              else {
                const st = m.g(k("state"));
                const abs = m.g(k("absoluteDeadline"));
                const dl = m.g(k("deadline"));
                if (st === 2n) skip = m.ts < abs ? 3n : 7n;
                else if (st !== 1n) skip = 2n;
                else if (m.ts >= abs) skip = 4n;
                else if (dl >= abs) skip = 5n;
                else if (m.nextDeadline(id) <= dl) skip = 6n;
              }
              if (skip === 0n) {
                m.resetClock(owner, id);
                m.ev("CheckedIn", owner, BigInt(id), m.g(k("deadline")), false);
              } else m.ev("CheckInSkipped", owner, BigInt(id), skip);
            }
          },
        };
      });
      const a = await r.view("A");
      await r.expectRevert("the keeper cannot finalize A inside the challenge window", "keeper", "finalizeClaim", [owner, r.id("A")], `ChallengeWindowOpen(${a.finalizableAt})`);
    },
  },
  {
    id: "d14-20-finalize-A",
    phase: "day 14+",
    title: "the keeper finalizes vault A: the owner did not veto, so it settles",
    due: async (r) => {
      const a = await r.view("A");
      if (BigInt(a.state) !== 2n) throw new Error(`vault A is ${STATE_NAMES[String(a.state)]}, not CLAIM_PENDING`);
      return BigInt(a.finalizableAt);
    },
    run: async (r) => {
      await r.finalize("d14-20-finalize-A", "A");
      await r.expectRevert("the heir cannot claim a settled vault", "heir", "initiateClaim", [r.addr("owner"), r.id("A"), r.addr("heir")], `VaultNotActive(${r.id("A")},3)`);
    },
  },
  {
    id: "d14-21-finalize-C",
    phase: "day 14+",
    title: "the keeper finalizes vault C, to the re-filed address",
    due: async (r) => {
      const c = await r.view("C");
      if (BigInt(c.state) !== 2n) throw new Error(`vault C is ${STATE_NAMES[String(c.state)]}, not CLAIM_PENDING`);
      return BigInt(c.finalizableAt);
    },
    run: async (r) => {
      await r.finalize("d14-21-finalize-C", "C");
      const due = await r.pushDue(r.state.addrs.cold);
      await r.expectRevert("the keeper cannot push C's credit inside the grace", "keeper", "pushCredit", [ETH, r.state.addrs.cold], `PushTooEarly(${due})`);
    },
  },
  {
    id: "d14-22-partial",
    phase: "day 14+",
    title: "the heir withdraws a third of its credit, to another address",
    run: async (r) => {
      const heir = r.addr("heir");
      await r.withdrawCredit("d14-22-partial", "heir", ETH, r.state.addrs.heirPayout, (b) => BigInt(b.v[`credit:${lc(ETH)}:${lc(heir)}`]) / 3n);
      const owed = BigInt(await retry(() => r.vault.creditOf(ETH, heir)));
      await r.expectRevert("the heir cannot withdraw more than it is owed", "heir", "withdrawCredit(address,address,uint256)", [ETH, heir, owed + 1n], `InsufficientBalance(${owed},${owed + 1n})`);
    },
  },
  {
    id: "d14-23-full",
    phase: "day 14+",
    title: "the heir withdraws the rest of its credit, to itself",
    run: async (r) => {
      const heir = r.addr("heir");
      await r.withdrawCredit("d14-23-full", "heir", ETH, heir, () => null);
      await r.expectRevert("nothing is left to withdraw", "heir", "withdrawCredit(address,address)", [ETH, heir], `NothingCredited(${lc(ETH)},${lc(heir)})`);
    },
  },
  {
    id: "d14-24-close-B",
    phase: "day 14+",
    title: "the owner closes vault B (withdraws everything)",
    run: async (r) => {
      await r.closeVault("d14-24-close-B", "B");
      await r.expectRevert("a closed vault takes no check-in", "owner", "checkIn", [r.id("B")], `VaultNotActive(${r.id("B")},4)`);
    },
  },
  {
    id: "d14-25-pull-B",
    phase: "day 14+",
    title: "the owner pulls vault B's credit",
    run: async (r) => {
      const eth = BigInt(r.state.params.eth);
      await r.withdrawCredit("d14-25-pull-B", "owner", ETH, r.addr("owner"), () => eth);
    },
  },
  {
    id: "d14-26-close-D",
    phase: "day 14+",
    title: "the owner closes vault D (USDC)",
    skip: noVaultD,
    run: (r) => r.closeVault("d14-26-close-D", "D"),
  },
  {
    id: "d14-27-pull-D",
    phase: "day 14+",
    title: "the owner pulls vault D's USDC credit",
    skip: noVaultD,
    run: (r) => r.withdrawCredit("d14-27-pull-D", "owner", r.state.params.usdc!, r.addr("owner"), () => null),
  },
  {
    id: "d44-30-push-cold",
    phase: "day 44+",
    title: "the keeper pushes the receive-only recipient's credit, now that the grace has run out",
    due: (r) => r.pushDue(r.state.addrs.cold),
    run: (r) => r.push("d44-30-push-cold", ETH, r.state.addrs.cold),
  },
  {
    id: "d44-31-push-fee",
    phase: "day 44+",
    title: "the keeper pushes the fee recipient's credit, where one is owed",
    skip: async (r) => {
      const fr = await retry(() => r.vault.feeRecipient());
      if (lc(fr) === lc(ZeroAddress)) return "no fee recipient: no fee was charged";
      const owed = BigInt(await retry(() => r.vault.creditOf(ETH, fr)));
      return owed === 0n ? `the fee recipient ${fr} is owed nothing (already withdrawn)` : null;
    },
    due: async (r) => r.pushDue(await retry(() => r.vault.feeRecipient())),
    run: async (r) => r.push("d44-31-push-fee", ETH, await retry(() => r.vault.feeRecipient())),
  },
  {
    id: "d44-32-final",
    phase: "day 44+",
    title: "final state: every lifecycle vault terminal, every credit paid, lanes back where they started",
    run: async (r) => {
      const s = r.state;
      for (const x of ["A", "B", "C", "D"] as Letter[]) {
        if (s.ids[x] === undefined) continue;
        const v = await r.view(x);
        const want = x === "A" || x === "C" ? 3n : 4n;
        r.check(`vault ${x} is ${STATE_NAMES[want.toString()]}`, BigInt(v.state) === want, String(v.state), want.toString());
        r.check(`vault ${x} holds nothing`, BigInt(v.balance) === 0n, String(v.balance), "0");
      }
      const snap = await r.snapshot("latest");
      for (const t of r.tokens()) {
        const tk = lc(t);
        r.check(`nothing locked by this lifecycle in ${t === ETH ? "ETH" : "USDC"}`, snap.v[`lane:${tk}:locked`] === s.baseline[`lane:${tk}:locked`], snap.v[`lane:${tk}:locked`], s.baseline[`lane:${tk}:locked`]);
        for (const [label, a] of [["heir", s.roles.heir], ["owner", s.roles.owner], ["keeper", s.roles.keeper], ["receive-only recipient", s.addrs.cold], ["heir's other address", s.addrs.heirPayout], ["mistyped address", s.addrs.wrong]]) {
          const c = snap.v[`credit:${tk}:${lc(a)}`] ?? "0";
          r.check(`${label} is owed nothing in ${t === ETH ? "ETH" : "USDC"}`, c === "0", c, "0");
        }
      }
      r.invariants(snap);
      const cold = snap.v[`eth:${lc(s.addrs.cold)}`];
      const payout = snap.v[`eth:${lc(s.addrs.heirPayout)}`];
      console.log(`    the receive-only address holds ${formatEther(BigInt(cold))} ETH; the heir's other address ${formatEther(BigInt(payout))} ETH`);
    },
  },
];

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = new Runner(opts);
  const onSignal = () => {
    r.unlock();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await r.open();
    if (!(await r.prepare())) return;
    if (opts.status) await r.status();
    else await r.advance();
  } finally {
    r.unlock();
  }
}

// exitCode, not process.exit(): exiting with an RPC handle still open aborts libuv on Windows.
main().catch((e) => {
  console.error(`\n${errText(e)}`);
  process.exitCode = 1;
});
