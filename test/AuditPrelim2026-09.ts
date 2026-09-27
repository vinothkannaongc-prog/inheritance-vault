/**
 * Regression tests for the preliminary security audit of 2026-09, against the v2 source.
 *
 * One describe block per finding fixed in contracts/InheritanceVault.sol. v1 is the contract
 * deployed, immutable, on Base; these tests are about v2 and say nothing about the live contract.
 *
 * Every test here FAILS against v1, except the ones whose title starts with "(control)" (they
 * prove a fix did not break the legitimate path and pass on both), "(guard)" (a check on v2's
 * own ABI, source, NatSpec or tooling, such as the reference check-in chain generator; a guard
 * may fail on v1 too, but never because of the finding) or "(pin)" (review round 3: it records a
 * cost v2 accepts and documents, so it is not regression evidence; on v1 it asserts what v1 does
 * instead where v1 lacks the cost, or fails only because the v2 function it exercises is
 * absent). Most fail for the reason their finding describes. Tests of API that v2 adds as the fix
 * itself (HB_DOMAIN, hbStep, the epoch-checked setCheckInChain, hbEpoch, applyClaimFee,
 * pendingClaimFeeAt, ClaimFeeRaiseCancelled, beneficiaryCancelClaim, the three-argument
 * withdrawCredit, supportedTokens, creditedSince, feeRecipientActiveAt, NothingCheckedIn's
 * argument, SKIP_CLAIM_PENDING_PAST_HORIZON, and the constructor's supported and wrappedNative
 * arguments, which v1 does not take) may fail on v1 only because the function, getter or
 * argument is absent: there the missing function IS the fix. To see the failures:
 *
 *   VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts
 *
 * which deploys contracts/v1/InheritanceVaultV1.sol through the same helper (test/helpers/deploy.ts).
 *
 * The mocks live in contracts/test/TestHelpers.sol.
 */
import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import { loadFixture, mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyUint } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { VAULT_IMPL, deployVault, vaultFactory } from "./helpers/deploy";
import * as chain from "../scripts/checkin-chain";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const HORIZON = 730 * DAY;
const NATIVE = ethers.ZeroAddress;
const ONE = ethers.parseEther("1");
const DEPOSIT = ethers.parseEther("100");
const FEE_BPS = 50;
const REENTRANT_VIEW = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
// Pass 2. Kept as test-side constants (not read from the contract) so a v1 run fails on the
// defect, not on a missing getter. One test per block checks the contract agrees.
const CAP = ethers.parseEther("100"); // MaxTxToken's per-transfer cap
const FEE_RAISE_DELAY = 30 * DAY;
const PUSH_GRACE = 30 * DAY;
const ACT_WITHDRAW = 1;
const ACT_SET_INACTIVITY = 4;
const ACT_CLOSE = 6;
const STATE_ACTIVE = 1n;
const STATE_CLAIM_PENDING = 2n;
const STATE_SETTLED = 3n;
const STATE_CLOSED = 4n;
const GWEI = 1_000_000_000n;
// Review round 2. The OP-stack L2ToL1MessagePasser predeploy (Base), and the most gas one
// transaction may use (EIP-7825; hardhat enforces it), so "fails at any gas limit" is literal.
const PASSER = "0x4200000000000000000000000000000000000016";
const TX_GAS_CAP = 16_777_216n;
// Review round 4. The canonical ERC-4337 EntryPoints v0.6, v0.7, v0.8 and v0.9, at the same
// addresses on Base and BNB. Each one's receive() books the value as a deposit owned by msg.sender.
const ENTRYPOINTS = [
  "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
];
// Pre-launch finalization (R5-3). Venus vBNB on BNB Chain: a plain native transfer mints vBNB to
// msg.sender. The address has no code on Base.
const VENUS_VBNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
// Explicit gas and tips for same-block ordering: with automine off, a higher tip is mined first.
const FRONT = { gasLimit: 600_000n, maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 100n * GWEI };
const USER = { gasLimit: 600_000n, maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
const BACK = { gasLimit: 600_000n, maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 1n * GWEI };
// Pass 3 (F27): every write of a vault's deadline logs DeadlineReset first, which v1 never
// emits. Exact log-order assertions written before pass 3 include it only in v2, so under
// VAULT_IMPL=v1 they still fail on their own finding's defect, not on this one.
const RESET: string[] = VAULT_IMPL === "v1" ? [] : ["DeadlineReset"];
/** VaultCreated's arguments; v2 added inactivityPeriod (F27), which v1's event does not have. */
const createdArgs = (
  owner: string, id: number, heir: string, token: string, amount: unknown, deadline: unknown, horizon: unknown,
  period: number, window: number, fee: number
) =>
  VAULT_IMPL === "v1"
    ? [owner, id, heir, token, amount, deadline, horizon, window, fee]
    : [owner, id, heir, token, amount, deadline, horizon, period, window, fee];

describe("Preliminary audit 2026-09 regressions (v2)", () => {
  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const deploy = async (name: string, ...args: unknown[]) => {
      const c = await (await ethers.getContractFactory(name, admin)).deploy(...args);
      await c.waitForDeployment();
      return c as any;
    };

    // Listed tokens. Some are hostile on purpose: the list is test configuration, and F10/F33/F42
    // are about what the contract still enforces for a listed token that misbehaves.
    const token = await deploy("MintableToken");
    const fotToken = await deploy("FeeOnTransferToken"); // debits the sender exactly `value`
    const dbl = await deploy("DoubleEntryToken");
    const fot = await deploy("FeeOnTopToken"); // debits the sender value + 1%
    const dwt = await deploy("DepositWindowToken");
    const probe = await deploy("ViewProbeToken");
    const capped = await deploy("MaxTxToken", CAP); // F04: refuses any single transfer above CAP
    const usdt = await deploy("SenderBlocklistToken"); // F08: TetherToken blocklist semantics; issuer = admin
    // Review round 2: the wrapped-native token must be listed (the constructor refuses it otherwise).
    const weth = await deploy("WrappedNativeMock");
    // Not listed.
    const fwd = await deploy("DoubleEntryForwarder", await dbl.getAddress());
    await dbl.setForwarder(await fwd.getAddress());
    const facade = await deploy("NativeFacadeRecorder");
    const unlisted = await deploy("MintableToken");
    const yieldToken = await deploy("DepositWindowToken");

    const supported = [token, fotToken, dbl, fot, dwt, probe, capped, usdt, weth];
    const vault = await deployVault({
      deployer: admin,
      admin: admin.address,
      feeBps: FEE_BPS,
      feeRecipient: feeSink.address,
      supported: await Promise.all(supported.map((t: any) => t.getAddress())),
      wrappedNative: await weth.getAddress(),
    });
    const vaultAddr = await vault.getAddress();

    for (const t of [token, fotToken, dbl, fot, dwt, probe, capped, usdt, unlisted, yieldToken]) {
      for (const who of [alice, dave]) {
        await t.mint(who.address, ethers.parseEther("1000"));
        await t.connect(who).approve(vaultAddr, ethers.MaxUint256);
      }
    }

    return {
      vault, vaultAddr, admin, alice, bob, carol, dave, feeSink,
      token, fotToken, dbl, fwd, fot, dwt, probe, capped, usdt, facade, unlisted, yieldToken, weth, supported,
    };
  }
  type F = Awaited<ReturnType<typeof fixture>>;

  async function create(f: F, who: any, token: string, amount: bigint, heir: string = f.bob.address) {
    const horizon = (await time.latest()) + HORIZON;
    return f.vault
      .connect(who)
      .createVault(token, amount, heir, PERIOD, WINDOW, horizon, token === NATIVE ? { value: amount } : {});
  }

  /** Runs a call that a fixed contract may refuse; reports whether it went through. */
  async function attempt(p: Promise<any>): Promise<boolean> {
    try {
      await (await p).wait?.();
      return true;
    } catch {
      return false;
    }
  }

  /** The accounting identity every lane must keep: the ledger covers what is owed. */
  async function expectSolvent(f: F, t: any) {
    const addr = await t.getAddress();
    const owed = (await f.vault.totalLocked(addr)) + (await f.vault.totalCredited(addr));
    expect(await t.balanceOf(f.vaultAddr), "vault balance must cover totalLocked + totalCredited").to.be.gte(owed);
  }

  /**
   * Sends transactions with automine off and mines them in ONE block. Explicit gas limits (see
   * FRONT/USER/BACK) keep each from being estimated against the others; the tips set the order.
   */
  async function oneBlock<T extends any[]>(send: () => Promise<T>): Promise<T> {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      const txs = await send();
      await mine();
      return txs;
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  }

  async function statusOf(tx: any): Promise<number> {
    return Number((await ethers.provider.getTransactionReceipt(tx.hash))!.status);
  }

  async function blockTimeOf(tx: any): Promise<number> {
    const rc = await ethers.provider.getTransactionReceipt(tx.hash);
    return (await ethers.provider.getBlock(rc!.blockNumber))!.timestamp;
  }

  /** Names of the vault's own logs in a receipt, in order. */
  function vaultLogNames(f: F, rc: any): string[] {
    return rc.logs
      .filter((l: any) => l.address.toLowerCase() === f.vaultAddr.toLowerCase())
      .map((l: any) => f.vault.interface.parseLog(l)?.name ?? "?");
  }

  /** The fee a settlement of `amount` takes at `bps`. */
  const feeOf = (amount: bigint, bps: number | bigint) => (amount * BigInt(bps)) / 10_000n;

  /**
   * Review round 3: a file's text with comment markers and line breaks removed, so NatSpec
   * guards can match a sentence wherever its lines happen to wrap.
   */
  function prose(...rel: string[]): string {
    return fs
      .readFileSync(path.join(__dirname, "..", ...rel), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/^[ \t]*(?:\/\/\/|\/\*\*|\*\/|\*)?[ \t]?/gm, "")
      .replace(/\s+/g, " ");
  }
  const VAULT_SOL = ["contracts", "InheritanceVault.sol"];

  /**
   * Pre-launch finalization: the comment block directly above `marker` in the v2 source (a
   * NatSpec block, or a run of `///` or `//` lines), as prose. A guard that must hold for one
   * function's documentation reads this, not the whole file, so the same sentence elsewhere
   * cannot satisfy it.
   */
  function docAbove(marker: string): string {
    const src = fs.readFileSync(path.join(__dirname, "..", ...VAULT_SOL), "utf8").replace(/\r\n/g, "\n");
    const at = src.indexOf(marker);
    expect(at, `${marker.trim()} found in the v2 source`).to.be.greaterThan(0);
    expect(src.indexOf(marker, at + 1), `${marker.trim()} is unique`).to.equal(-1);
    const lines = src.slice(0, at).replace(/[ \t]+$/, "").replace(/\n$/, "").split("\n");
    const doc: string[] = [];
    let j = lines.length - 1;
    if (lines[j].trim().endsWith("*/")) {
      for (; j >= 0; j--) {
        doc.unshift(lines[j]);
        if (lines[j].trim().startsWith("/**")) break;
      }
    } else {
      for (; j >= 0 && lines[j].trim().startsWith("//"); j--) doc.unshift(lines[j]);
    }
    expect(doc.length, `a comment block above ${marker.trim()}`).to.be.greaterThan(0);
    return doc
      .join("\n")
      .replace(/^[ \t]*(?:\/\/\/|\/\/|\/\*\*|\*\/|\*)?[ \t]?/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Review round 4: source guards that match text can always be dodged by a spelling the pattern
   * did not foresee (a parenthesised delete, a local alias of address(this)). These walk the
   * compiler's own AST of the v2 source instead, from the build Hardhat just ran. `visit` gets
   * every node, its parent, and the name of the function, modifier or constructor around it.
   */
  async function vaultAst(): Promise<any> {
    const bi = await artifacts.getBuildInfo("contracts/InheritanceVault.sol:InheritanceVault");
    expect(bi, "build info for the v2 source").to.not.equal(undefined);
    return bi!.output.sources["contracts/InheritanceVault.sol"].ast;
  }
  function walkAst(node: any, visit: (n: any, parent: any, fn: string) => void, parent: any = null, fn = "<file>") {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walkAst(c, visit, parent, fn);
      return;
    }
    if (node.nodeType === "FunctionDefinition") fn = node.kind === "function" ? node.name : node.kind;
    else if (node.nodeType === "ModifierDefinition") fn = `modifier ${node.name}`;
    if (node.nodeType) visit(node, parent, fn);
    for (const [k, v] of Object.entries(node)) {
      if (k !== "typeDescriptions" && v && typeof v === "object") walkAst(v, visit, node.nodeType ? node : parent, fn);
    }
  }

  // ------------------------------------------------------------------------------------ F01

  describe("F01 immutable token allowlist: no sweep through a second address of a ledger", () => {
    it("sweepSurplus refuses the unlisted second address of a listed token's ledger", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, await f.dbl.getAddress(), DEPOSIT);
      const fwd = await f.fwd.getAddress();
      // The same ledger, read through the forwarder, prices Alice's principal as surplus...
      expect(await f.fwd.balanceOf(f.vaultAddr)).to.equal(DEPOSIT);
      // ...so the sweep must be refused outright.
      await expect(f.vault.connect(f.admin).sweepSurplus(fwd, f.admin.address))
        .to.be.revertedWithCustomError(f.vault, "UnsupportedToken")
        .withArgs(fwd);
      // The revert assertion above carries this test. The two reads below only restate it (a
      // reverted call leaves no state); they are what a v1 run measures, where the sweep goes
      // through and moves Alice's principal to the admin.
      expect(await f.dbl.balanceOf(f.vaultAddr)).to.equal(DEPOSIT);
      expect(await f.dbl.balanceOf(f.admin.address)).to.equal(0);
    });

    it("a settled inheritance in the listed token stays payable after the admin tries", async () => {
      const f = await loadFixture(fixture);
      const dbl = await f.dbl.getAddress();
      await create(f, f.alice, dbl, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      const fee = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;

      await attempt(f.vault.connect(f.admin).sweepSurplus(await f.fwd.getAddress(), f.admin.address));

      expect(await f.dbl.balanceOf(f.admin.address), "admin gain").to.equal(0);
      await expectSolvent(f, f.dbl);
      await f.vault.connect(f.bob).withdrawCredit(dbl, f.bob.address);
      expect(await f.dbl.balanceOf(f.bob.address)).to.equal(DEPOSIT - fee);
    });

    it("createVault refuses any ERC20 that is not listed, including a listed ledger's second address", async () => {
      const f = await loadFixture(fixture);
      for (const t of [f.fwd, f.unlisted]) {
        const addr = await t.getAddress();
        await expect(create(f, f.alice, addr, DEPOSIT))
          .to.be.revertedWithCustomError(f.vault, "UnsupportedToken")
          .withArgs(addr);
      }
      expect(await f.vault.vaultCount(f.alice.address)).to.equal(0);
    });

    it("an ERC20 facade over the native coin cannot be swept, so native-lane value never moves", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const facade = await f.facade.getAddress();
      expect(await f.facade.balanceOf(f.vaultAddr)).to.equal(DEPOSIT); // the facade prices the native TVL
      await expect(f.vault.connect(f.admin).sweepSurplus(facade, f.admin.address))
        .to.be.revertedWithCustomError(f.vault, "UnsupportedToken")
        .withArgs(facade);
      // Restates the revert on v2 (a reverted call leaves no state). On v1 the sweep goes
      // through, and this is where it shows: the vault asks the facade to move the native TVL.
      expect(await f.facade.lastAmount(), "amount the vault asked the facade to move").to.equal(0);
    });

    it("an unlisted ERC20 sent here directly is stranded, not sweepable (the disclosed cost)", async () => {
      const f = await loadFixture(fixture);
      const addr = await f.unlisted.getAddress();
      await f.unlisted.connect(f.alice).transfer(f.vaultAddr, ONE);
      await expect(f.vault.connect(f.admin).sweepSurplus(addr, f.admin.address))
        .to.be.revertedWithCustomError(f.vault, "UnsupportedToken")
        .withArgs(addr);
      expect(await f.unlisted.balanceOf(f.vaultAddr)).to.equal(ONE);
    });

    it("(control) force-fed native coin and force-fed listed tokens are still swept, and only the surplus", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await create(f, f.alice, await f.token.getAddress(), DEPOSIT);
      await setBalance(f.vaultAddr, DEPOSIT + ONE); // SELFDESTRUCT-style force-feed
      await f.token.connect(f.dave).transfer(f.vaultAddr, ONE);

      await expect(f.vault.connect(f.admin).sweepSurplus(NATIVE, f.carol.address)).to.changeEtherBalance(
        f.carol,
        ONE
      );
      await expect(
        f.vault.connect(f.admin).sweepSurplus(await f.token.getAddress(), f.carol.address)
      ).to.changeTokenBalance(f.token, f.carol, ONE);
      expect(await f.vault.totalLocked(NATIVE)).to.equal(DEPOSIT);
      expect(await f.vault.totalLocked(await f.token.getAddress())).to.equal(DEPOSIT);
    });

    it("the list is fixed at deployment and readable; the native coin is accepted without being listed", async () => {
      const f = await loadFixture(fixture);
      const listed = await Promise.all(f.supported.map((t: any) => t.getAddress()));
      expect(await f.vault.supportedTokens()).to.deep.equal(listed);
      for (const a of listed) expect(await f.vault.isSupportedToken(a)).to.equal(true);
      expect(await f.vault.isSupportedToken(await f.fwd.getAddress())).to.equal(false);
      expect(await f.vault.isSupportedToken(NATIVE)).to.equal(false);
      expect(await f.vault.wrappedNative()).to.equal(await f.weth.getAddress());
      await create(f, f.alice, NATIVE, ONE); // native needs no listing
    });

    it("(guard) the list is written only in the constructor: outside it the source only reads the list, in known read forms", async () => {
      // Review round 1: a guard on function NAMES alone let `addAsset(address)` through. This
      // one looks at the storage writes themselves, wherever they sit and whatever the function
      // is called.
      const src = fs
        .readFileSync(path.join(__dirname, "..", "contracts", "InheritanceVault.sol"), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const start = src.indexOf("    constructor(");
      const end = src.indexOf("\n    }\n", start) + "\n    }\n".length;
      expect(start, "constructor found").to.be.greaterThan(0);
      const writes = (s: string) =>
        s.match(
          /isSupportedToken\s*\[[^\]]*\]\s*(?:[-+*\/%|&^]|<<|>>)?=(?!=)|delete\s+isSupportedToken\b|_supportedTokens\s*\.\s*(?:push|pop)\s*\(|_supportedTokens\s*(?:\[[^\]]*\])?\s*=(?!=)|delete\s+_supportedTokens\b|_supportedTokens\s*\.\s*length\s*=(?!=)/g
        ) ?? [];
      expect(writes(src.slice(start, end)), "the constructor's own writes are what the pattern sees").to.have.length(2);
      expect(writes(src.slice(0, start) + src.slice(end)), "writes to the list outside the constructor").to.deep.equal([]);

      // Review round 3: a list of WRITE forms is never complete. A storage alias
      // (`mapping(address => bool) storage m = isSupportedToken; m[t] = true;`), a storage
      // argument, a storage-returning getter, a tuple assignment or an assembly .slot all write
      // the list without matching the pattern above. So outside the constructor this whitelists
      // the READS: every mention of either variable must be one of the read forms below.
      const DECL_MAP = "mapping(address => bool) public isSupportedToken;";
      const DECL_ARR = "address[] private _supportedTokens;";
      const GETTER =
        /function supportedTokens\(\) external view returns \(address\[\] memory\) \{\s*return _supportedTokens;\s*\}/;
      let rest = src.slice(0, start) + src.slice(end);
      for (const d of [DECL_MAP, DECL_ARR]) {
        expect(rest.split(d).length - 1, `declared once: ${d}`).to.equal(1);
        rest = rest.replace(d, "");
      }
      // The one whole-array read: supportedTokens() returns a MEMORY copy.
      expect(GETTER.test(rest), "supportedTokens() returns a memory copy of the list").to.equal(true);
      rest = rest.replace(GETTER, "");
      const isWrite = (after: string) => /^(?:(?:[-+*\/%|&^]|<<|>>)?=(?![=>])|\+\+|--)/.test(after);
      // Review round 4: `delete (x[i])` put a parenthesis between the operator and the name, and
      // `(x[i]) = v` one between the name and the operator. Both sides now look through them.
      const skipParensAfter = (s: string) => s.replace(/^[\s)]+/, "");
      const skipParensBefore = (s: string) => s.replace(/[\s(]+$/, "");
      const offending: string[] = [];
      for (const m of rest.matchAll(/\b(isSupportedToken|_supportedTokens)\b/g)) {
        const at = m.index!;
        let i = at + m[1].length;
        while (/\s/.test(rest[i])) i++;
        let read = false;
        if (rest[i] === "[") {
          // isSupportedToken[x] or _supportedTokens[i], read as a value, never assigned.
          let depth = 0;
          let j = i;
          for (; j < rest.length; j++) {
            if (rest[j] === "[") depth++;
            else if (rest[j] === "]" && --depth === 0) break;
          }
          read = !isWrite(skipParensAfter(rest.slice(j + 1)));
        } else if (m[1] === "_supportedTokens" && rest[i] === ".") {
          const after = rest.slice(i + 1).trimStart();
          read = /^length\b/.test(after) && !isWrite(skipParensAfter(after.slice("length".length)));
        }
        if (/(?:\bdelete|\+\+|--)$/.test(skipParensBefore(rest.slice(0, at)))) read = false;
        if (!read) offending.push(rest.slice(Math.max(0, at - 40), at + 50).replace(/\s+/g, " "));
      }
      // And whatever the spelling, no `delete` outside the constructor may name the list.
      for (const m of rest.matchAll(/\bdelete\b([^;]*);/g)) {
        if (/\b(?:isSupportedToken|_supportedTokens)\b/.test(m[1])) offending.push(`delete${m[1]}`);
      }
      // A tuple assignment writes whatever its left-hand side names: (isSupportedToken[t], x) = (true, 1).
      for (const m of rest.matchAll(/\)\s*=(?![=>])/g)) {
        let depth = 0;
        let j = m.index!;
        for (; j >= 0; j--) {
          if (rest[j] === ")") depth++;
          else if (rest[j] === "(" && --depth === 0) break;
        }
        const lhs = rest.slice(j, m.index! + 1);
        if (/\b(?:isSupportedToken|_supportedTokens)\b/.test(lhs)) offending.push(`tuple assignment ${lhs}`);
      }
      expect(offending, "mentions of the list outside the constructor that are not plain reads").to.deep.equal([]);
      // Raw storage access could write it without naming it at all; this contract uses none.
      expect(src.match(/\bsstore\b|\.slot\b/g) ?? [], "sstore or .slot in the source").to.deep.equal([]);

      // Review round 4: the same whitelist on the compiler's AST, which has no spelling to dodge.
      // Outside the constructor every reference to either declaration must be an index read of a
      // value (IndexAccess with lValueRequested false: a delete, an assignment or a tuple target
      // requests an lvalue, parentheses or not), `.length`, or supportedTokens()'s return of a
      // memory copy; and no inline assembly may name either.
      const ast = await vaultAst();
      const contract = ast.nodes.find((n: any) => n.nodeType === "ContractDefinition" && n.name === "InheritanceVault");
      const decls = new Map<number, string>(
        contract.nodes
          .filter((n: any) => n.nodeType === "VariableDeclaration" && /^(?:isSupportedToken|_supportedTokens)$/.test(n.name))
          .map((n: any) => [n.id, n.name])
      );
      expect([...decls.values()].sort(), "both declarations found in the AST").to.deep.equal(["_supportedTokens", "isSupportedToken"]);
      const getter = contract.nodes.find((n: any) => n.nodeType === "FunctionDefinition" && n.name === "supportedTokens");
      expect(getter.returnParameters.parameters.map((p: any) => p.storageLocation)).to.deep.equal(["memory"]);
      const astOffending: string[] = [];
      walkAst(contract, (n, parent, fn) => {
        if (fn === "constructor") return; // its two writes are counted above
        if (n.nodeType === "InlineAssembly") {
          for (const r of n.externalReferences ?? []) {
            if (decls.has(r.declaration)) astOffending.push(`${fn}: inline assembly names ${decls.get(r.declaration)}`);
          }
          return;
        }
        if (n.nodeType !== "Identifier" || !decls.has(n.referencedDeclaration)) return;
        const indexRead =
          parent?.nodeType === "IndexAccess" && parent.baseExpression === n && parent.lValueRequested === false &&
          /^(?:bool|address)$/.test(parent.typeDescriptions?.typeString ?? "");
        const lengthRead =
          parent?.nodeType === "MemberAccess" && parent.expression === n && parent.memberName === "length" && !parent.lValueRequested;
        const getterRead = parent?.nodeType === "Return" && fn === "supportedTokens";
        if (!(indexRead || lengthRead || getterRead)) {
          astOffending.push(`${fn}: ${decls.get(n.referencedDeclaration)} under ${parent?.nodeType}` +
            (parent?.lValueRequested ? " (an lvalue)" : ""));
        }
      });
      expect(astOffending, "AST: references to the list outside the constructor that are not plain reads").to.deep.equal([]);
      // Second layer: no state-changing function is even named for it.
      const iface = (await vaultFactory()).interface;
      const writers: string[] = [];
      iface.forEachFunction((fn) => {
        if (fn.stateMutability !== "view" && fn.stateMutability !== "pure") writers.push(fn.name);
      });
      expect(writers.filter((n) => /support|allow|list|token|asset/i.test(n))).to.deep.equal([]);
    });

    it("the constructor logs TokenSupported once per listed token, in list order", async () => {
      // Review round 1: the deployment receipt is the only on-chain record of the list's history.
      const f = await loadFixture(fixture);
      const vault: any = await deployVault({
        deployer: f.admin, admin: f.admin.address, feeBps: FEE_BPS, feeRecipient: f.feeSink.address,
        supported: [await f.token.getAddress(), await f.usdt.getAddress()],
      });
      const rc = await vault.deploymentTransaction()!.wait();
      const listed = rc.logs
        .map((l: any) => vault.interface.parseLog(l))
        .filter((e: any) => e?.name === "TokenSupported")
        .map((e: any) => e.args.token);
      expect(listed).to.deep.equal([await f.token.getAddress(), await f.usdt.getAddress()]);
      const all = await ethers.provider.getLogs({
        address: f.vaultAddr, fromBlock: 0, toBlock: "latest",
        topics: [vault.interface.getEvent("TokenSupported")!.topicHash],
      });
      expect(all.length, "the fixture vault logged exactly its listed tokens").to.equal(f.supported.length);
    });

    it("the constructor refuses address(0), duplicates and the vault's own address in the list", async () => {
      const f = await loadFixture(fixture);
      const Factory = await vaultFactory(f.admin);
      const token = await f.token.getAddress();
      const nextAddr = async () =>
        ethers.getCreateAddress({ from: f.admin.address, nonce: await f.admin.getNonce() });
      const d = (supported: string[], wrappedNative = ethers.ZeroAddress, feeRecipient = f.feeSink.address) =>
        deployVault({ deployer: f.admin, admin: f.admin.address, feeBps: FEE_BPS, feeRecipient, supported, wrappedNative });

      await expect(d([token, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(Factory, "InvalidTokenConfig")
        .withArgs(ethers.ZeroAddress);
      await expect(d([token, token])).to.be.revertedWithCustomError(Factory, "InvalidTokenConfig").withArgs(token);
      let self = await nextAddr();
      await expect(d([token, self])).to.be.revertedWithCustomError(Factory, "InvalidTokenConfig").withArgs(self);
      self = await nextAddr();
      await expect(d([token], self)).to.be.revertedWithCustomError(Factory, "InvalidTokenConfig").withArgs(self);
      // A clean list deploys. (Review round 2: the wrapped-native token must be on it.)
      const weth = await f.weth.getAddress();
      const ok = await d([token, weth], weth);
      expect(await ok.supportedTokens()).to.deep.equal([token, weth]);
    });
  });

  // ------------------------------------------------------------------------------------ F09

  describe("F09 payouts never go to this contract, the wrapped-native token or a listed token", () => {
    it("the WETH round trip cannot turn an heir's inheritance into admin-sweepable surplus", async () => {
      const f = await loadFixture(fixture);
      const weth = await f.weth.getAddress();
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);

      // The heir pastes the WETH address as "pay me in WETH". v1 accepts it; then a push wraps
      // the coin into WETH owned by the vault, outside every lane, and the admin sweeps it.
      if (await attempt(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, weth))) {
        await time.increase(WINDOW + 1);
        await f.vault.finalizeClaim(f.alice.address, 0);
        await f.vault.pushCredit(NATIVE, weth);
        await attempt(f.vault.connect(f.admin).sweepSurplus(weth, f.admin.address));
      }
      expect(await f.weth.balanceOf(f.admin.address), "WETH the admin took").to.equal(0);
      expect(await f.weth.balanceOf(f.vaultAddr), "WETH held outside every lane").to.equal(0);
    });

    it("initiateClaim refuses the wrapped-native token and every listed token as the recipient", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      for (const t of [f.weth, f.token]) {
        const addr = await t.getAddress();
        await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, addr))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(addr);
      }
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(1); // still ACTIVE
    });

    it("withdraw refuses them as `to`", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      for (const t of [f.weth, f.token]) {
        const addr = await t.getAddress();
        await expect(f.vault.connect(f.alice).withdraw(0, ONE, addr))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(addr);
      }
      expect(await f.vault.totalCredited(NATIVE)).to.equal(0);
    });

    it("withdrawCredit refuses them as the destination and keeps the credit", async () => {
      const f = await loadFixture(fixture);
      const weth = await f.weth.getAddress();
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(f.vault.connect(f.carol).withdrawCredit(NATIVE, weth))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(weth);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(ONE);
      expect(await f.weth.balanceOf(f.vaultAddr)).to.equal(0);
    });

    it("the fee recipient and a sweep target follow the same rule", async () => {
      const f = await loadFixture(fixture);
      const weth = await f.weth.getAddress();
      const token = await f.token.getAddress();
      for (const addr of [weth, token]) {
        await expect(f.vault.connect(f.admin).setFeeRecipient(addr))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(addr);
      }
      await setBalance(f.vaultAddr, ONE); // force-fed native surplus
      await expect(f.vault.connect(f.admin).sweepSurplus(NATIVE, weth))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(weth);
      expect(await f.weth.balanceOf(f.vaultAddr)).to.equal(0);
    });

    it("the constructor applies the rule to the initial fee recipient", async () => {
      const f = await loadFixture(fixture);
      const Factory = await vaultFactory(f.admin);
      const token = await f.token.getAddress();
      const weth = await f.weth.getAddress();
      for (const feeRecipient of [weth, token, PASSER]) {
        await expect(
          deployVault({ deployer: f.admin, feeBps: FEE_BPS, feeRecipient, supported: [token, weth], wrappedNative: weth })
        )
          .to.be.revertedWithCustomError(Factory, "ForbiddenPayoutAddress")
          .withArgs(feeRecipient);
      }
    });

    // ---- review round 2

    it("(control) the constructor still refuses the vault's own address as the initial fee recipient", async () => {
      // Inherited from v1, and re-written in v2's constructor; nothing tested it until round 2.
      const f = await loadFixture(fixture);
      const Factory = await vaultFactory(f.admin);
      const self = ethers.getCreateAddress({ from: f.admin.address, nonce: await f.admin.getNonce() });
      await expect(
        deployVault({ deployer: f.admin, admin: f.admin.address, feeBps: FEE_BPS, feeRecipient: self })
      ).to.be.revertedWithCustomError(Factory, "CannotPayToSelf");
    });

    it("the constructor refuses a wrapped-native token that is not listed, so a native payout's measurement always covers it", async () => {
      // A wrap-and-return payee hands a native payout back as wrappedNative. Were it unlisted, no
      // measurement would see it: the credit would be retired and the wrapped coin stranded here,
      // unsweepable, instead of the payout reverting PayoutReturned with the credit kept.
      const f = await loadFixture(fixture);
      const Factory = await vaultFactory(f.admin);
      const weth = await f.weth.getAddress();
      const token = await f.token.getAddress();
      await expect(deployVault({ deployer: f.admin, supported: [token], wrappedNative: weth }))
        .to.be.revertedWithCustomError(Factory, "InvalidTokenConfig")
        .withArgs(weth);
      await expect(deployVault({ deployer: f.admin, supported: [], wrappedNative: weth }))
        .to.be.revertedWithCustomError(Factory, "InvalidTokenConfig")
        .withArgs(weth);
      // Listed, it deploys, and the wrap-and-return payee is caught.
      const vault: any = await deployVault({ deployer: f.admin, supported: [weth], wrappedNative: weth });
      const gw: any = await (await ethers.getContractFactory("WrapAndReturnGateway", f.admin)).deploy(weth);
      const gwAddr = await gw.getAddress();
      await vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, { value: DEPOSIT });
      await vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(vault.connect(f.carol).withdrawCredit(NATIVE, gwAddr))
        .to.be.revertedWithCustomError(vault, "PayoutReturned")
        .withArgs(gwAddr);
      expect(await vault.creditOf(NATIVE, f.carol.address)).to.equal(ONE);
    });

    it("an OP-stack predeploy is refused as a payee: native coin paid to the L2ToL1MessagePasser would be withdrawn to this contract's own address on L1", async () => {
      // Base's 0x4200...0016 starts a withdrawal of msg.value to msg.sender on L1. msg.sender is
      // the vault, whose L1 address only the deployer key could ever put code at. An heir who
      // pastes it as "withdraw my inheritance to L1" would lose the whole payout.
      const f = await loadFixture(fixture);
      const passer: any = await (await ethers.getContractFactory("WithdrawalPasserMock", f.admin)).deploy();
      await network.provider.send("hardhat_setCode", [PASSER, await ethers.provider.getCode(await passer.getAddress())]);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);

      const paid = await attempt(f.vault.connect(f.carol).withdrawCredit(NATIVE, PASSER));
      expect(await ethers.provider.getBalance(PASSER), "coin handed to the message passer").to.equal(0);
      expect(paid, "a payout to the message passer was accepted").to.equal(false);
      await expect(f.vault.connect(f.carol).withdrawCredit(NATIVE, PASSER))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(PASSER);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(ONE);
      await expect(f.vault.connect(f.alice).withdraw(0, ONE, PASSER))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(PASSER);
      await expect(f.vault.connect(f.admin).setFeeRecipient(PASSER))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(PASSER);
      await time.increase(PERIOD + 1);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, PASSER))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(PASSER);
      // The whole namespace 0x4200...0000 to 0x4200...07FF, and nothing either side of it.
      const inRange = ["0x4200000000000000000000000000000000000000", "0x42000000000000000000000000000000000007ff"];
      const outside = ["0x4200000000000000000000000000000000000800", "0x41ffffffffffffffffffffffffffffffffffffff"];
      for (const a of inRange) {
        await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, a))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(ethers.getAddress(a));
      }
      for (const a of outside) {
        await expect(f.vault.connect(f.alice).withdraw(0, 1n, a)).to.emit(f.vault, "Withdrawn");
      }
    });

    // ---- review round 4

    it("the ERC-4337 EntryPoints are refused as a payee: native coin paid to one is booked as a deposit owned by this contract, which can never withdraw it", async () => {
      // Each canonical EntryPoint credits msg.sender on receive(). The address rule passed it, and
      // so did the measurement: the native balance fell by exactly the amount paid and no listed
      // token moved. The payout became a deposit only the vault could withdraw, with a call it
      // has no function to make. Lost for good, though never sweepable.
      const f = await loadFixture(fixture);
      const code = await ethers.provider.getCode(
        await (await (await ethers.getContractFactory("EntryPointDepositMock", f.admin)).deploy()).getAddress()
      );
      for (const ep of ENTRYPOINTS) await network.provider.send("hardhat_setCode", [ep, code]);
      const ledger = (ep: string) => ethers.getContractAt("EntryPointDepositMock", ep);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);

      const paid = await attempt(f.vault.connect(f.carol).withdrawCredit(NATIVE, ENTRYPOINTS[1]));
      expect(await (await ledger(ENTRYPOINTS[1])).balanceOf(f.vaultAddr), "a deposit booked to the vault").to.equal(0);
      expect(paid, "a payout to an EntryPoint was accepted").to.equal(false);
      await time.increase(PERIOD + 1);
      await setBalance(f.vaultAddr, (await ethers.provider.getBalance(f.vaultAddr)) + ONE); // force-fed surplus
      for (const ep of ENTRYPOINTS) {
        await expect(f.vault.connect(f.carol).withdrawCredit(NATIVE, ep))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(ep);
        await expect(f.vault.connect(f.alice).withdraw(0, ONE, ep))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(ep);
        await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, ep))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(ep);
        await expect(f.vault.connect(f.admin).setFeeRecipient(ep))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(ep);
        await expect(f.vault.connect(f.admin).sweepSurplus(NATIVE, ep))
          .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
          .withArgs(ep);
        await expect(
          deployVault({ deployer: f.admin, feeBps: FEE_BPS, feeRecipient: ep, supported: [await f.weth.getAddress()], wrappedNative: await f.weth.getAddress() })
        )
          .to.be.revertedWithCustomError(await vaultFactory(f.admin), "ForbiddenPayoutAddress")
          .withArgs(ep);
        expect(await (await ledger(ep)).balanceOf(f.vaultAddr)).to.equal(0);
      }
      expect(await f.vault.creditOf(NATIVE, f.carol.address), "the credit is kept").to.equal(ONE);
    });

    // ---- pre-launch finalization (review round 5)

    it("Venus vBNB is refused as a payee: native coin paid to it mints vBNB to this contract, which can neither redeem nor sweep it", async () => {
      // R5-3. The EntryPoints' shape on BNB Chain: the payee keeps the value, so the measurement
      // passes it, and books it to msg.sender, the vault. The heir's payout would be lost for
      // good. The address has no code on Base.
      const f = await loadFixture(fixture);
      const code = await ethers.provider.getCode(
        await (await (await ethers.getContractFactory("NativeMarketMintMock", f.admin)).deploy()).getAddress()
      );
      await network.provider.send("hardhat_setCode", [VENUS_VBNB, code]);
      const vbnb = await ethers.getContractAt("NativeMarketMintMock", VENUS_VBNB);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);

      const paid = await attempt(f.vault.connect(f.carol).withdrawCredit(NATIVE, VENUS_VBNB));
      expect(await vbnb.balanceOf(f.vaultAddr), "vBNB minted to the vault").to.equal(0);
      expect(paid, "a payout to vBNB was accepted").to.equal(false);
      await expect(f.vault.connect(f.carol).withdrawCredit(NATIVE, VENUS_VBNB))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(VENUS_VBNB);
      await expect(f.vault.connect(f.alice).withdraw(0, ONE, VENUS_VBNB))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(VENUS_VBNB);
      await expect(f.vault.connect(f.admin).setFeeRecipient(VENUS_VBNB))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(VENUS_VBNB);
      await setBalance(f.vaultAddr, (await ethers.provider.getBalance(f.vaultAddr)) + ONE); // force-fed surplus
      await expect(f.vault.connect(f.admin).sweepSurplus(NATIVE, VENUS_VBNB))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(VENUS_VBNB);
      await expect(
        deployVault({
          deployer: f.admin, feeBps: FEE_BPS, feeRecipient: VENUS_VBNB,
          supported: [await f.weth.getAddress()], wrappedNative: await f.weth.getAddress(),
        })
      )
        .to.be.revertedWithCustomError(await vaultFactory(f.admin), "ForbiddenPayoutAddress")
        .withArgs(VENUS_VBNB);
      await time.increase(PERIOD + 1);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, VENUS_VBNB))
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(VENUS_VBNB);
      // Were vBNB ever held here, the admin could not sweep it either: it is not listed.
      await expect(f.vault.connect(f.admin).sweepSurplus(VENUS_VBNB, f.admin.address))
        .to.be.revertedWithCustomError(f.vault, "UnsupportedToken")
        .withArgs(VENUS_VBNB);
      expect(await vbnb.balanceOf(f.vaultAddr)).to.equal(0);
      expect(await f.vault.creditOf(NATIVE, f.carol.address), "the credit is kept").to.equal(ONE);
    });

    it("(pin) the documented residual: a payee at any other address that books the value to its sender, where only the booking's owner can move it, takes the payout; the vault is left with a booking it can never withdraw, and nothing is sweepable", async () => {
      // No rule can see this class in general (a staking or deposit contract that credits its
      // sender, an EntryPoint deployed elsewhere): the value leaves, exactly, and nothing comes
      // back. Pre-launch finalization (R5-1): retitled. "Nothing is sweepable" holds only for a
      // booking nobody but its owner can move, like an EntryPoint deposit; the next pin shows
      // a ledger that lets anyone release one.
      const f = await loadFixture(fixture);
      const other: any = await (await ethers.getContractFactory("EntryPointDepositMock", f.admin)).deploy();
      const otherAddr = await other.getAddress();
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(f.vault.connect(f.carol).withdrawCredit(NATIVE, otherAddr)).to.changeEtherBalance(other, ONE);
      expect(await other.balanceOf(f.vaultAddr), "booked to the vault").to.equal(ONE);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(0);
      await expect(f.vault.connect(f.admin).sweepSurplus(NATIVE, f.admin.address)).to.be.revertedWithCustomError(
        f.vault,
        "NoSurplus"
      );
      const src = prose(...VAULT_SOL);
      expect(src).to.include(
        "These refusals are by address, and no rule can see such payees in general: one that forwards value to " +
          "this contract's address on ANOTHER chain, or one that books the value to msg.sender in a ledger of its own"
      );
      expect(src).to.include(
        "A payout to such a payee is lost to whoever named it. Whether the admin can ever reach it depends on the " +
          "payee: it stays out of reach only while nothing but its owner, this contract, can move the booking."
      );
      expect(src, "the round-4 claim R5-1 disproved").to.not.include("the payout is lost, though never sweepable");
    });

    it("(pin) the documented residual, other side: a ledger that lets anyone release a booking to its owner hands a mis-routed payout back here as surplus, in a listed token or in native coin, and the admin can sweep it", async () => {
      // Pre-launch finalization (R5-1). The heir lost the payout when he named the ledger; what
      // the ledger decides is whether it can later reach the admin. The release comes in a
      // transaction of its own, which no rule can tell from any other force-feed.
      const f = await loadFixture(fixture);
      const b = await baseLike(f);
      const ledger: any = await (await ethers.getContractFactory("ReleasableLedgerMock", f.admin)).deploy(b.wethAddr);
      const L = await ledger.getAddress();
      // "ETH, else WETH": the heir names the ledger as the claim recipient, and a stranger pushes.
      const credit = await settleNativeTo(f, b.vault, L);
      await expect(b.vault.connect(f.dave).pushCredit(NATIVE, L)).to.changeEtherBalance(L, credit);
      expect(await ledger.booked(b.vaultAddr), "booked to the vault").to.equal(credit);
      expect(await b.vault.surplus(b.wethAddr)).to.equal(0);
      await ledger.connect(f.dave).release(b.vaultAddr); // the vault refuses the coin, so WETH comes
      expect(await b.vault.surplus(b.wethAddr), "returned as listed WETH").to.equal(credit);
      await expect(b.vault.connect(f.admin).sweepSurplus(b.wethAddr, f.admin.address)).to.changeTokenBalance(
        b.weth,
        f.admin,
        credit
      );
      // Force-sent native coin: a credit paid to the ledger by withdrawCredit, released by SELFDESTRUCT.
      await b.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, { value: DEPOSIT });
      await b.vault.connect(f.alice).withdraw(1, ONE, f.carol.address);
      await b.vault.connect(f.carol).withdrawCredit(NATIVE, L);
      expect(await b.vault.surplus(NATIVE)).to.equal(0);
      await ledger.connect(f.dave).forceRelease(b.vaultAddr);
      expect(await b.vault.surplus(NATIVE), "returned as native coin").to.equal(ONE);
      await expect(b.vault.connect(f.admin).sweepSurplus(NATIVE, f.admin.address)).to.changeEtherBalance(f.admin, ONE);
      expect(prose(...VAULT_SOL)).to.include(
        "A ledger that lets anyone release a booking to its owner, in a listed token (an \"ETH, else WETH\" refund) " +
          "or by force-sending the native coin, returns the value here in a later transaction, as surplus that " +
          "sweepSurplus can take."
      );
    });

    it("(control) ordinary payout addresses still work, and a zero fee recipient still means no fee", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.dave.address);
      await expect(f.vault.connect(f.dave).withdrawCredit(NATIVE, f.carol.address)).to.changeEtherBalance(f.carol, ONE);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.carol.address);
      expect((await f.vault.getVault(f.alice.address, 0)).claimRecipient).to.equal(f.carol.address);
      // Review round 1: the title's second half, asserted at settlement.
      await time.increase(WINDOW + 1);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.carol.address, DEPOSIT - ONE, 0);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(DEPOSIT - ONE);
    });

    // ---- review round 1: the payee rule is enforced by measurement, not only by address

    /** A Base-like deployment: WETH is both the wrapped-native token and a listed token. */
    async function baseLike(f: F) {
      const weth: any = await (await ethers.getContractFactory("WrappedNativeMock", f.admin)).deploy();
      const wethAddr = await weth.getAddress();
      const vault: any = await deployVault({
        deployer: f.admin, admin: f.admin.address, feeBps: FEE_BPS, feeRecipient: f.feeSink.address,
        supported: [wethAddr], wrappedNative: wethAddr,
      });
      return { vault, vaultAddr: await vault.getAddress(), weth, wethAddr };
    }

    /** A native inheritance settled to `payee` (which the address rule accepts), past PUSH_GRACE. */
    async function settleNativeTo(f: F, vault: any, payee: string): Promise<bigint> {
      await vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, { value: DEPOSIT });
      await time.increase(PERIOD + 1);
      await vault.connect(f.bob).initiateClaim(f.alice.address, 0, payee);
      await time.increase(WINDOW + 1);
      await vault.finalizeClaim(f.alice.address, 0);
      await time.increase(PUSH_GRACE + 1);
      return vault.creditOf(NATIVE, payee);
    }

    it("a wrap-and-return helper that is not wrappedNative cannot hand an heir's native payout back as admin-sweepable WETH", async () => {
      const f = await loadFixture(fixture);
      const b = await baseLike(f);
      const gw: any = await (await ethers.getContractFactory("WrapAndReturnGateway", f.admin)).deploy(b.wethAddr);
      const gwAddr = await gw.getAddress();
      const credit = await settleNativeTo(f, b.vault, gwAddr);
      expect(credit).to.equal(DEPOSIT - feeOf(DEPOSIT, FEE_BPS));

      // A stranger pushes; on v1 (and on v2 before review round 1) the gateway wraps the coin
      // and sends the WETH back to the vault, the credit is retired, and the admin sweeps it.
      const pushed = await attempt(b.vault.connect(f.dave).pushCredit(NATIVE, gwAddr));
      await attempt(b.vault.connect(f.admin).sweepSurplus(b.wethAddr, f.admin.address));
      expect(await b.weth.balanceOf(f.admin.address), "the admin swept the heir's credited payout").to.equal(0);
      expect(pushed, "a payout that came straight back was accepted").to.equal(false);
      expect(await b.vault.creditOf(NATIVE, gwAddr), "the credit is kept").to.equal(credit);
      expect(await b.weth.balanceOf(b.vaultAddr)).to.equal(0);
      await expect(b.vault.connect(f.dave).pushCredit(NATIVE, gwAddr))
        .to.be.revertedWithCustomError(b.vault, "PayoutReturned")
        .withArgs(gwAddr);
    });

    it("a payee that bounces native coin back with SELFDESTRUCT cannot turn the payout into native surplus", async () => {
      const f = await loadFixture(fixture);
      const b = await baseLike(f);
      const bouncer: any = await (await ethers.getContractFactory("SelfdestructBouncer", f.admin)).deploy();
      const bAddr = await bouncer.getAddress();
      const credit = await settleNativeTo(f, b.vault, bAddr);
      const sink = ethers.Wallet.createRandom().address;

      const pushed = await attempt(b.vault.connect(f.dave).pushCredit(NATIVE, bAddr));
      await attempt(b.vault.connect(f.admin).sweepSurplus(NATIVE, sink));
      expect(await ethers.provider.getBalance(sink), "the admin swept the heir's credited payout").to.equal(0);
      expect(pushed, "a payout that came straight back was accepted").to.equal(false);
      expect(await b.vault.creditOf(NATIVE, bAddr), "the credit is kept").to.equal(credit);
      expect(await b.vault.surplus(NATIVE)).to.equal(0);
      await expect(b.vault.connect(f.dave).pushCredit(NATIVE, bAddr))
        .to.be.revertedWithCustomError(b.vault, "PayoutReturned")
        .withArgs(bAddr);
    });

    it("(control) the same deployment still pays a contract payee that keeps the coin, and still sweeps real surplus", async () => {
      const f = await loadFixture(fixture);
      const b = await baseLike(f);
      const keeper: any = await (await ethers.getContractFactory("LoggingReceiver", f.admin)).deploy();
      const kAddr = await keeper.getAddress();
      const credit = await settleNativeTo(f, b.vault, kAddr);
      await expect(b.vault.connect(f.dave).pushCredit(NATIVE, kAddr)).to.changeEtherBalance(kAddr, credit);
      await b.weth.connect(f.dave).deposit({ value: ONE });
      await b.weth.connect(f.dave).transfer(b.vaultAddr, ONE); // force-fed, not a payout
      await expect(b.vault.connect(f.admin).sweepSurplus(b.wethAddr, f.carol.address)).to.changeTokenBalance(
        b.weth,
        f.carol,
        ONE
      );
    });

    // ---- review round 2: a listed token's balanceOf cannot hold up native payouts
    //
    // Round 1 made every native payout read balanceOf on every listed token, twice, copying the
    // whole returndata and forwarding 63/64 of the gas. A listed token upgraded to burn that gas
    // or return a returndata bomb then froze every native payout at any gas limit, and one that
    // answered differently on each read made them all revert PayoutReturned: an issuer of one
    // token held up every ETH/BNB heir. v1 native payouts read no token.

    /** A deployment listing a token whose balanceOf its issuer can change (see BalanceModeToken). */
    async function modeListed(f: F) {
      const tok: any = await (await ethers.getContractFactory("BalanceModeToken", f.admin)).deploy();
      const tokAddr = await tok.getAddress();
      const vault: any = await deployVault({
        deployer: f.admin, admin: f.admin.address, feeBps: FEE_BPS, feeRecipient: f.feeSink.address,
        supported: [tokAddr],
      });
      const vaultAddr = await vault.getAddress();
      await tok.mint(f.alice.address, DEPOSIT);
      await tok.connect(f.alice).approve(vaultAddr, ethers.MaxUint256);
      const horizon = (await time.latest()) + HORIZON;
      await vault.connect(f.alice).createVault(tokAddr, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon); // 0
      await vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT }); // 1
      return { tok, vault, vaultAddr };
    }
    const BALANCE_MODES: [string, number][] = [
      ["reverts", 1],
      ["burns its gas", 2],
      ["returns a returndata bomb", 3],
      ["answers differently on each read", 4],
    ];
    const CAPPED = { gasLimit: TX_GAS_CAP };

    it("(control) whatever a listed token's balanceOf does, a native payout to a wallet goes through: withdrawCredit, pushCredit by the account and by a stranger, and sweepSurplus", async () => {
      const f = await loadFixture(fixture);
      const m = await modeListed(f);
      for (const [label, mode] of BALANCE_MODES) {
        await m.vault.connect(f.alice).withdraw(1, ONE, f.carol.address);
        await m.tok.setMode(mode);
        await expect(
          m.vault.connect(f.carol)["withdrawCredit(address,address)"](NATIVE, f.carol.address, CAPPED),
          `withdrawCredit while balanceOf ${label}`
        ).to.changeEtherBalance(f.carol, ONE);
        await m.tok.setMode(0);

        await m.vault.connect(f.alice).withdraw(1, ONE, f.carol.address);
        await m.vault.connect(f.alice).withdraw(1, ONE, f.dave.address);
        await time.increase(PUSH_GRACE + 1);
        await m.tok.setMode(mode);
        await expect(
          m.vault.connect(f.carol).pushCredit(NATIVE, f.carol.address, CAPPED),
          `the account's pushCredit while balanceOf ${label}`
        ).to.changeEtherBalance(f.carol, ONE);
        await expect(
          m.vault.connect(f.carol).pushCredit(NATIVE, f.dave.address, CAPPED),
          `a stranger's pushCredit while balanceOf ${label}`
        ).to.changeEtherBalance(f.dave, ONE);
        await setBalance(m.vaultAddr, (await ethers.provider.getBalance(m.vaultAddr)) + ONE); // force-fed
        await expect(
          m.vault.connect(f.admin).sweepSurplus(NATIVE, f.dave.address, CAPPED),
          `sweepSurplus(NATIVE) while balanceOf ${label}`
        ).to.changeEtherBalance(f.dave, ONE);
        await m.tok.setMode(0);
      }
    });

    it("(control) a contract payee is still paid while a listed token's balanceOf reverts, burns its gas or returns a returndata bomb: each read is capped", async () => {
      const f = await loadFixture(fixture);
      const m = await modeListed(f);
      const keeper: any = await (await ethers.getContractFactory("LoggingReceiver", f.admin)).deploy();
      const kAddr = await keeper.getAddress();
      for (const [label, mode] of BALANCE_MODES.slice(0, 3)) {
        await m.vault.connect(f.alice).withdraw(1, ONE, f.carol.address);
        await m.tok.setMode(mode);
        const tx = m.vault.connect(f.carol)["withdrawCredit(address,address)"](NATIVE, kAddr, CAPPED);
        await expect(tx, `a contract payee while balanceOf ${label}`).to.changeEtherBalance(kAddr, ONE);
        // Two capped reads: a hostile token costs the payout gas, never the payout.
        expect((await (await tx).wait()).gasUsed, `gas while balanceOf ${label}`).to.be.lt(400_000n);
        await m.tok.setMode(0);
      }
    });

    it("(pin) the documented residual: a listed token that answers balanceOf differently on each read blocks native payouts to payees with code, keeps the credit, and the account routes through its wallet", async () => {
      const f = await loadFixture(fixture);
      const m = await modeListed(f);
      const keeper: any = await (await ethers.getContractFactory("LoggingReceiver", f.admin)).deploy();
      const kAddr = await keeper.getAddress();
      await m.vault.connect(f.alice).withdraw(1, ONE, f.carol.address);
      await m.tok.setMode(4);
      if (VAULT_IMPL === "v1") {
        // Review round 3: v1 measures no payout, so it pays. That is the regression v2 accepts.
        await expect(m.vault.connect(f.carol)["withdrawCredit(address,address)"](NATIVE, kAddr)).to.changeEtherBalance(
          kAddr,
          ONE
        );
        return;
      }
      await expect(m.vault.connect(f.carol)["withdrawCredit(address,address)"](NATIVE, kAddr))
        .to.be.revertedWithCustomError(m.vault, "PayoutReturned")
        .withArgs(kAddr);
      expect(await m.vault.creditOf(NATIVE, f.carol.address)).to.equal(ONE);
      await expect(
        m.vault.connect(f.carol)["withdrawCredit(address,address)"](NATIVE, f.carol.address)
      ).to.changeEtherBalance(f.carol, ONE);
    });

    it("an EIP-7702 delegated wallet is measured like a contract: delegated to a wrap-and-return helper, it cannot hand the payout back as sweepable WETH", async () => {
      // Wallets skip the measurement because they run no code when paid. A delegated account
      // does run code, and has some (the 0xef0100 designator), so it must not be skipped.
      const f = await loadFixture(fixture);
      const b = await baseLike(f);
      const gw: any = await (await ethers.getContractFactory("WrapAndReturnGateway", f.admin)).deploy(b.wethAddr);
      const eoa = ethers.Wallet.createRandom().connect(ethers.provider);
      const sponsor = ethers.Wallet.createRandom().connect(ethers.provider);
      await setBalance(sponsor.address, ONE);
      const auth = await eoa.authorize({ address: await gw.getAddress(), nonce: 0 });
      await (await sponsor.sendTransaction({ type: 4, to: eoa.address, authorizationList: [auth], gasLimit: 200_000n })).wait();
      expect(await ethers.provider.getCode(eoa.address), "the account is delegated").to.match(/^0xef0100/i);

      await b.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, { value: DEPOSIT });
      await b.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      const paid = await attempt(b.vault.connect(f.carol).withdrawCredit(NATIVE, eoa.address));
      await attempt(b.vault.connect(f.admin).sweepSurplus(b.wethAddr, f.admin.address));
      expect(await b.weth.balanceOf(f.admin.address), "the admin swept the payout").to.equal(0);
      expect(paid, "a payout that came straight back was accepted").to.equal(false);
      expect(await b.vault.creditOf(NATIVE, f.carol.address), "the credit is kept").to.equal(ONE);
      await expect(b.vault.connect(f.carol).withdrawCredit(NATIVE, eoa.address))
        .to.be.revertedWithCustomError(b.vault, "PayoutReturned")
        .withArgs(eoa.address);
    });

    it("(guard) the ACCOUNTING header names every place a live balance is read: surplus() and three measurement paths, native payouts to payees with code among them", async () => {
      // Review round 3: the header, "verifiable without reading the state machine", still said
      // two paths after review round 1 made native payouts to payees with code a third.
      const src = prose(...VAULT_SOL);
      expect(src).to.not.include("the two measurement paths");
      expect(src).to.include("Accounting never reads live balances except in surplus() and three measurement paths:");
      expect(src).to.include(
        "native payouts to an address with code (_holdings), which must lower the native balance by exactly the " +
          "amount paid and leave every listed token's balance unchanged"
      );
      // And the code agrees: the functions that read a live balance are exactly those four (_pull
      // for deposits, _payout for ERC20 payouts, _holdings, _surplus). Review round 4: read from
      // the compiler's AST, not the text, so a read through a local alias of address(this)
      // (`address me = address(this); me.balance`) or in assembly (selfbalance(), balance(),
      // the balanceOf selector) counts too. Vault.balance, a struct field, is not a live balance.
      const readers = new Set<string>();
      walkAst(await vaultAst(), (n, _parent, fn) => {
        const addressBalance =
          n.nodeType === "MemberAccess" && n.memberName === "balance" &&
          /^address\b/.test(n.expression?.typeDescriptions?.typeString ?? "");
        const tokenBalance = n.nodeType === "MemberAccess" && n.memberName === "balanceOf";
        const yulBalance = n.nodeType === "YulFunctionCall" && /^(?:selfbalance|balance)$/.test(n.functionName?.name ?? "");
        // The selector, as a number (Solidity or Yul) or as the signature a selector is hashed from.
        const selector =
          (n.nodeType === "YulLiteral" || n.nodeType === "Literal") &&
          (/^0x0*70a08231$/i.test(n.value ?? "") || /balanceOf\s*\(/.test(n.value ?? ""));
        if (addressBalance || tokenBalance || yulBalance || selector) readers.add(fn);
      });
      expect([...readers].sort()).to.deep.equal(["_holdings", "_payout", "_pull", "_surplus"]);
    });
  });

  // ------------------------------------------------------------------------------------ F10

  describe("F10 an ERC20 payout cannot debit the pool by more than it pays", () => {
    async function twoVaults() {
      const f = await loadFixture(fixture);
      const fot = await f.fot.getAddress();
      await create(f, f.alice, fot, DEPOSIT);
      await create(f, f.dave, fot, DEPOSIT);
      expect(await f.fot.balanceOf(f.vaultAddr)).to.equal(2n * DEPOSIT); // deposits are measured
      return { f, fot };
    }

    it("a fee-on-top payout reverts instead of charging the difference to other users' lanes", async () => {
      const { f, fot } = await twoVaults();
      await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
      await expect(f.vault.connect(f.alice).withdrawCredit(fot, f.alice.address))
        .to.be.revertedWithCustomError(f.vault, "PayoutOverdebited")
        .withArgs(fot, DEPOSIT + DEPOSIT / 100n, DEPOSIT);
      expect(await f.vault.creditOf(fot, f.alice.address)).to.equal(DEPOSIT);
      await expectSolvent(f, f.fot);
    });

    it("the last withdrawer is never left short by an earlier payout", async () => {
      const { f, fot } = await twoVaults();
      await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
      await attempt(f.vault.connect(f.alice).withdrawCredit(fot, f.alice.address));
      // Dave did nothing. His vault must still be fully backed.
      expect((await f.vault.getVault(f.dave.address, 0)).balance).to.equal(DEPOSIT);
      await expectSolvent(f, f.fot);
    });

    it("a sweep of such a token cannot overdraw into the locked lane", async () => {
      const { f, fot } = await twoVaults();
      const fed = ethers.parseEther("10");
      await f.fot.connect(f.alice).transfer(f.vaultAddr, fed); // force-fed surplus
      expect(await f.vault.surplus(fot)).to.equal(fed);
      await expect(f.vault.connect(f.admin).sweepSurplus(fot, f.admin.address))
        .to.be.revertedWithCustomError(f.vault, "PayoutOverdebited")
        .withArgs(fot, fed + fed / 100n, fed);
      await expectSolvent(f, f.fot);
    });

    it("(control) a fee-on-transfer payout, which debits the vault exactly `amount`, still pays", async () => {
      const f = await loadFixture(fixture);
      const t = await f.fotToken.getAddress();
      await create(f, f.alice, t, DEPOSIT);
      const received = DEPOSIT - DEPOSIT / 100n;
      await f.vault.connect(f.alice).withdraw(0, received, f.alice.address);
      await expect(f.vault.connect(f.alice).withdrawCredit(t, f.carol.address)).to.changeTokenBalances(
        f.fotToken,
        [f.vaultAddr, f.carol],
        [-received, received - received / 100n]
      );
      await expectSolvent(f, f.fotToken);
    });
  });

  // ------------------------------------------------------------------------------------ F42

  describe("F42 a deposit records at most what the depositor sent", () => {
    async function withAliceVault() {
      const f = await loadFixture(fixture);
      const dwt = await f.dwt.getAddress();
      await create(f, f.alice, dwt, DEPOSIT);
      return { f, dwt };
    }

    it("a pool-wide gain inside the deposit window is not written into the depositor's new vault", async () => {
      const { f, dwt } = await withAliceVault();
      const gain = ethers.parseEther("10"); // e.g. a 10% rebase the transfer triggers
      await f.dwt.arm(f.vaultAddr, gain);
      await expect(create(f, f.dave, dwt, ONE))
        .to.emit(f.vault, "VaultCreated")
        .withArgs(...createdArgs(f.dave.address, 0, f.bob.address, dwt, ONE, anyUint, anyUint, PERIOD, WINDOW, FEE_BPS));
      expect((await f.vault.getVault(f.dave.address, 0)).balance).to.equal(ONE);
      expect(await f.vault.totalLocked(dwt)).to.equal(DEPOSIT + ONE);
      expect(await f.vault.surplus(dwt)).to.equal(gain); // not the depositor's
    });

    it("topUp is capped the same way", async () => {
      const { f, dwt } = await withAliceVault();
      await f.dwt.arm(f.vaultAddr, ethers.parseEther("10"));
      await expect(f.vault.connect(f.dave).topUp(f.alice.address, 0, ONE))
        .to.emit(f.vault, "ToppedUp")
        .withArgs(f.alice.address, 0, f.dave.address, ONE);
      expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(DEPOSIT + ONE);
    });

    it("a pool-wide loss larger than the deposit reverts NothingReceived, not an arithmetic panic", async () => {
      const { f, dwt } = await withAliceVault();
      await f.dwt.arm(f.vaultAddr, -ethers.parseEther("5"));
      await expect(create(f, f.dave, dwt, ONE)).to.be.revertedWithCustomError(f.vault, "NothingReceived");
    });

    it("(control) a loss exactly equal to the deposit reverts NothingReceived", async () => {
      const { f, dwt } = await withAliceVault();
      await f.dwt.arm(f.vaultAddr, -ONE);
      await expect(create(f, f.dave, dwt, ONE)).to.be.revertedWithCustomError(f.vault, "NothingReceived");
    });
  });

  // ------------------------------------------------------------------------------------ F33

  describe("F33 views refuse to answer while a transaction is half-applied", () => {
    it("a token callback inside the deposit window cannot read surplus, getVault, getOpenVaults or creditOf", async () => {
      const f = await loadFixture(fixture);
      const probe = await f.probe.getAddress();
      await create(f, f.alice, probe, DEPOSIT);
      await f.probe.arm(f.vaultAddr, f.alice.address);

      // The deposit itself goes through: only the reads made from inside it are refused.
      await f.vault.connect(f.dave).topUp(f.alice.address, 0, ONE);
      expect(await f.probe.armed()).to.equal(false); // the probe really ran

      // On v1 surplus() answered here with the whole in-flight deposit counted as surplus.
      expect(await f.probe.surplusOk(), "surplus answered mid-deposit").to.equal(false);
      expect(await f.probe.getVaultOk(), "getVault answered mid-deposit").to.equal(false);
      expect(await f.probe.openVaultsOk(), "getOpenVaults answered mid-deposit").to.equal(false);
      expect(await f.probe.creditOfOk(), "creditOf answered mid-deposit").to.equal(false);
      for (const sel of [
        await f.probe.surplusError(),
        await f.probe.getVaultError(),
        await f.probe.openVaultsError(),
        await f.probe.creditOfError(),
      ]) {
        expect(sel).to.equal(REENTRANT_VIEW);
      }
      expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(DEPOSIT + ONE);
    });

    it("the lane getters are guarded too: mid-deposit, totalLocked and totalCredited cannot be read next to the balance as a phantom surplus", async () => {
      // Review round 1. A proof-of-reserve computes balanceOf(vault) - totalLocked - totalCredited,
      // which is surplus() by hand; as public mapping getters the lanes answered mid-deposit, and
      // that sum showed the in-flight deposit as surplus.
      const f = await loadFixture(fixture);
      const probe = await f.probe.getAddress();
      await create(f, f.alice, probe, DEPOSIT);
      await f.probe.arm(f.vaultAddr, f.alice.address);
      await f.vault.connect(f.dave).topUp(f.alice.address, 0, ONE);
      expect(await f.probe.armed()).to.equal(false); // the probe really ran
      const answered = [await f.probe.lockedOk(), await f.probe.creditedOk()];
      if (answered[0] && answered[1]) {
        const phantom = (await f.probe.seenBalance()) - (await f.probe.seenLocked()) - (await f.probe.seenCredited());
        expect(phantom, "phantom surplus read from the lanes mid-deposit").to.equal(0);
      }
      expect(answered, "[totalLocked, totalCredited] answered mid-deposit").to.deep.equal([false, false]);
      expect([await f.probe.lockedError(), await f.probe.creditedError()]).to.deep.equal([REENTRANT_VIEW, REENTRANT_VIEW]);
      // Outside a transaction they answer, and the lanes cover the balance exactly.
      expect(await f.vault.totalLocked(probe)).to.equal(DEPOSIT + ONE);
      expect(await f.vault.totalCredited(probe)).to.equal(0);
      expect(await f.probe.balanceOf(f.vaultAddr)).to.equal(DEPOSIT + ONE);
    });

    it("(control) outside a transaction the views answer, and sweepSurplus still works", async () => {
      const f = await loadFixture(fixture);
      const token = await f.token.getAddress();
      await create(f, f.alice, token, DEPOSIT);
      await f.token.connect(f.dave).transfer(f.vaultAddr, ONE);
      expect(await f.vault.surplus(token)).to.equal(ONE);
      expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(DEPOSIT);
      expect((await f.vault.getOpenVaults(f.alice.address)).length).to.equal(1);
      expect(await f.vault.creditOf(token, f.alice.address)).to.equal(0);
      // sweepSurplus holds the lock and reads the unguarded internal _surplus.
      await expect(f.vault.connect(f.admin).sweepSurplus(token, f.carol.address)).to.changeTokenBalance(
        f.token,
        f.carol,
        ONE
      );
    });

    it("(pin) the documented cost: a recipient whose receive() reads a guarded view is not paid by push, and keeps its credit", async () => {
      const f = await loadFixture(fixture);
      const receiver = await (await ethers.getContractFactory("ViewReadingReceiver", f.admin)).deploy(f.vaultAddr);
      const r = await receiver.getAddress();
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, r);
      // Past the F08 push grace, so the push reaches the payout (a no-op wait on v1).
      await time.increase(30 * DAY);
      if (VAULT_IMPL === "v1") {
        // Review round 3: v1's views are unguarded, so it pays. That is the cost v2 accepts.
        await expect(f.vault.connect(f.dave).pushCredit(NATIVE, r)).to.changeEtherBalance(r, ONE);
        expect(await f.vault.creditOf(NATIVE, r)).to.equal(0);
        return;
      }
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, r))
        .to.be.revertedWithCustomError(f.vault, "NativeTransferFailed")
        .withArgs(r, ONE);
      expect(await f.vault.creditOf(NATIVE, r)).to.equal(ONE);
    });
  });

  // ------------------------------------------------------------------------------------ F11

  describe("F11 (covered by F01) a yield-bearing token cannot enter, so no depositor's yield becomes surplus", () => {
    it("an unlisted yield token is refused at the door, so there is no yield for the admin to sweep", async () => {
      const f = await loadFixture(fixture);
      const y = await f.yieldToken.getAddress();
      await expect(create(f, f.alice, y, DEPOSIT))
        .to.be.revertedWithCustomError(f.vault, "UnsupportedToken")
        .withArgs(y);
    });

    it("the heir's yield cannot reach the admin", async () => {
      const f = await loadFixture(fixture);
      const y = await f.yieldToken.getAddress();
      if (await attempt(create(f, f.alice, y, DEPOSIT))) {
        await f.yieldToken.mint(f.vaultAddr, ethers.parseEther("5")); // a year of 5% yield
        await attempt(f.vault.connect(f.admin).sweepSurplus(y, f.admin.address));
      }
      expect(await f.yieldToken.balanceOf(f.admin.address), "yield taken by the admin").to.equal(0);
    });
  });

  // ==================================================================== pass 2: credits, claims, fees

  // ------------------------------------------------------------------------------------ F04

  describe("F04 a credit can be withdrawn in parts, so a transfer-capped token cannot freeze it", () => {
    const PART = "withdrawCredit(address,address,uint256)";
    const WHOLE = "withdrawCredit(address,address)";

    /**
     * Every exit open to `holder`: the whole credit to itself, the whole credit to a fresh
     * address, then the partial exit in cap-sized pieces. Reports what reached either address.
     */
    async function recover(f: F, holder: any, fresh: any) {
      const t = await f.capped.getAddress();
      const bal = async () => (await f.capped.balanceOf(holder.address)) + (await f.capped.balanceOf(fresh.address));
      const credit = async (): Promise<bigint> => f.vault.creditOf(t, holder.address);
      const before = await bal();
      const owed = await credit();
      await attempt(f.vault.connect(holder)[WHOLE](t, holder.address));
      if ((await credit()) > 0n) await attempt(f.vault.connect(holder)[WHOLE](t, fresh.address));
      for (let i = 0; i < 16 && (await credit()) > 0n; i++) {
        const left = await credit();
        if (!(await attempt(f.vault.connect(holder)[PART](t, holder.address, left < CAP ? left : CAP)))) break;
      }
      return { owed, recovered: (await bal()) - before, left: await credit() };
    }

    async function settleCapped(f: F) {
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
    }

    it("an estate that settles above the token's per-transfer cap reaches the heir in cap-sized parts", async () => {
      const f = await loadFixture(fixture);
      const t = await f.capped.getAddress();
      await create(f, f.alice, t, CAP); // each deposit obeys the cap...
      await f.vault.connect(f.alice).topUp(f.alice.address, 0, CAP);
      await settleCapped(f); // ...but the settled credit, 199, does not
      const owed = 2n * CAP - feeOf(2n * CAP, FEE_BPS);
      expect(await f.vault.creditOf(t, f.bob.address)).to.equal(owed);
      // The whole-credit exit is refused by the token: one transfer of 199 is over the cap.
      await expect(f.vault.connect(f.bob)[WHOLE](t, f.bob.address)).to.be.revertedWith("maxTx");

      const r = await recover(f, f.bob, f.carol);
      expect(r.recovered, "inheritance that reached the heir").to.equal(owed);
      expect(r.left).to.equal(0);
      expect(await f.vault.totalCredited(t)).to.equal(feeOf(2n * CAP, FEE_BPS)); // only the fee is left
      await expectSolvent(f, f.capped);
    });

    it("a stranger's topUp that lifts the estate over the cap cannot freeze the inheritance", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, await f.capped.getAddress(), ethers.parseEther("90")); // alone: under the cap
      await f.vault.connect(f.dave).topUp(f.alice.address, 0, ethers.parseEther("20")); // permissionless
      await settleCapped(f);
      const r = await recover(f, f.bob, f.carol);
      expect(r.owed).to.equal(ethers.parseEther("109.45"));
      expect(r.recovered, "inheritance that reached the heir").to.equal(r.owed);
    });

    it("a stranger's credit merged onto the heir's cannot freeze the heir's own inheritance", async () => {
      const f = await loadFixture(fixture);
      const t = await f.capped.getAddress();
      await create(f, f.alice, t, ethers.parseEther("99")); // settles to 98.505, under the cap
      await create(f, f.dave, t, ethers.parseEther("1.5"), f.carol.address);
      await settleCapped(f);
      await f.vault.connect(f.dave).withdraw(0, ethers.parseEther("1.5"), f.bob.address); // merges: 100.005
      const r = await recover(f, f.bob, f.carol);
      expect(r.owed).to.equal(ethers.parseEther("100.005"));
      expect(r.recovered, "credit that reached the heir").to.equal(r.owed);
    });

    it("the partial exit debits exactly `amount` from the credit and the lane, and refuses 0 or more than is owed", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, 3n * ONE, f.carol.address);

      const paid = f.vault.connect(f.carol)[PART](NATIVE, f.dave.address, ONE);
      await expect(paid).to.changeEtherBalances([f.dave, f.vaultAddr], [ONE, -ONE]);
      await expect(paid).to.emit(f.vault, "CreditPaid").withArgs(NATIVE, f.carol.address, f.dave.address, ONE);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(2n * ONE);
      expect(await f.vault.totalCredited(NATIVE)).to.equal(2n * ONE);

      await expect(f.vault.connect(f.carol)[PART](NATIVE, f.dave.address, 0)).to.be.revertedWithCustomError(
        f.vault,
        "ZeroAmount"
      );
      await expect(f.vault.connect(f.carol)[PART](NATIVE, f.dave.address, 3n * ONE))
        .to.be.revertedWithCustomError(f.vault, "InsufficientBalance")
        .withArgs(2n * ONE, 3n * ONE);
      await expect(f.vault.connect(f.carol)[PART](NATIVE, ethers.ZeroAddress, ONE)).to.be.revertedWithCustomError(
        f.vault,
        "ZeroAddress"
      );
      const weth = await f.weth.getAddress();
      await expect(f.vault.connect(f.carol)[PART](NATIVE, weth, ONE)) // the F09 payout rule holds here too
        .to.be.revertedWithCustomError(f.vault, "ForbiddenPayoutAddress")
        .withArgs(weth);
      await expect(f.vault.connect(f.dave)[PART](NATIVE, f.dave.address, ONE))
        .to.be.revertedWithCustomError(f.vault, "NothingCredited")
        .withArgs(NATIVE, f.dave.address);

      await f.vault.connect(f.carol)[PART](NATIVE, f.carol.address, 2n * ONE);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(0);
      expect(await f.vault.totalCredited(NATIVE)).to.equal(0);
    });

    it("(control) the two-argument withdrawCredit still pays the whole credit in one transfer", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, 3n * ONE, f.carol.address);
      await expect(f.vault.connect(f.carol)[WHOLE](NATIVE, f.carol.address)).to.changeEtherBalance(f.carol, 3n * ONE);
      expect(await f.vault.creditOf(NATIVE, f.carol.address)).to.equal(0);
    });
  });

  // ------------------------------------------------------------------------------------ F05

  describe("F05 a claim begun with no fee recipient in force stays fee-free", () => {
    it("a recipient set during the challenge window takes nothing", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // ceiling 50 bps
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress); // "no fee is taken"
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW - DAY);
      await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address); // fees back on mid-window
      await time.increase(DAY + 1);
      await expect(f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
      expect(await f.vault.creditOf(NATIVE, f.feeSink.address)).to.equal(0);
    });

    it("the recipient cannot be switched on around the settlement inside one block", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      const before = await ethers.provider.getBlockNumber();
      const txs = await oneBlock(async () => [
        await f.vault.connect(f.admin).setFeeRecipient(f.admin.address, FRONT),
        await f.vault.connect(f.admin).finalizeClaim(f.alice.address, 0, FRONT),
        await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress, FRONT),
      ]);
      for (const tx of txs) expect(await statusOf(tx)).to.equal(1);
      expect(await f.vault.feeRecipient({ blockTag: before })).to.equal(ethers.ZeroAddress); // reads "none"...
      expect(await f.vault.feeRecipient()).to.equal(ethers.ZeroAddress); // ...before and after
      expect(await f.vault.creditOf(NATIVE, f.admin.address), "fee skimmed in the bundle").to.equal(0);
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(DEPOSIT);
    });

    it("a deployment that starts with no recipient charges nothing on a claim already in flight", async () => {
      const f = await loadFixture(fixture);
      const vault: any = await deployVault({ deployer: f.admin, feeBps: 100, feeRecipient: ethers.ZeroAddress });
      const big = ethers.parseEther("100");
      const horizon = (await time.latest()) + HORIZON;
      await vault.connect(f.alice).createVault(NATIVE, big, f.bob.address, PERIOD, WINDOW, horizon, { value: big });
      await time.increase(PERIOD + 1);
      await vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
      await time.increase(WINDOW + 1);
      await vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      expect(await vault.creditOf(NATIVE, f.feeSink.address), "fee on a claim begun fee-free").to.equal(0);
      expect(await vault.creditOf(NATIVE, f.bob.address)).to.equal(big);
    });

    it("a recipient switched on in the block before the heir's initiateClaim locks no fee either", async () => {
      // Beyond the plan (CHANGELOG-v2.md, F05): switching fees back on is a raise from zero, so
      // it too waits FEE_RAISE_DELAY. Without that, the lock above could be front-run.
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress); // a fee holiday
      await time.increase(PERIOD + 1);
      const [claim, front] = await oneBlock(async () => [
        await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address, USER),
        await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address, FRONT),
      ]);
      expect((await ethers.provider.getBlock("latest"))!.transactions).to.deep.equal([front.hash, claim.hash]);
      expect(await statusOf(claim)).to.equal(1);
      await time.increase(WINDOW + 1);
      await expect(f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
      expect(await f.vault.feeRecipientActiveAt()).to.equal((await blockTimeOf(front)) + FEE_RAISE_DELAY);
    });

    it("(control) once a recipient has been in force for FEE_RAISE_DELAY, claims pay the normal fee again", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
      await time.increase(Math.max(PERIOD + 1, FEE_RAISE_DELAY));
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      const fee = feeOf(DEPOSIT, FEE_BPS);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
    });

    it("(control) a recipient removed after the claim began means no fee at settlement", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      await time.increase(WINDOW + 1);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
    });

    // ---- review round 1: the recipient switch-on rules, at settlement and at their boundaries

    it("a cut to zero (recipient removed) during the window cannot be undone in the settlement block, just before finalizeClaim", async () => {
      // The claim locked 50 bps while a recipient was in force. Removing the recipient is a cut
      // that reaches it; switching one back on is a raise from zero, which must wait
      // FEE_RAISE_DELAY at settlement as it does at initiateClaim.
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress); // fees publicly off
      await time.increase(WINDOW + 1);
      const [on, fin] = await oneBlock(async () => [
        await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address, FRONT),
        await f.vault.connect(f.admin).finalizeClaim(f.alice.address, 0, USER), // permissionless
      ]);
      expect([await statusOf(on), await statusOf(fin)]).to.deep.equal([1, 1]);
      expect((await ethers.provider.getBlock("latest"))!.transactions).to.deep.equal([on.hash, fin.hash]);
      expect(await f.vault.creditOf(NATIVE, f.feeSink.address), "fee re-imposed in the settlement block").to.equal(0);
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(DEPOSIT);
    });

    it("a recipient switched back on reaches claims already pending exactly at feeRecipientActiveAt: nothing a second before, the locked rate at it", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // 0
      await create(f, f.alice, NATIVE, DEPOSIT); // 1
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // both lock 50
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      const on = await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
      const at = (await blockTimeOf(on)) + FEE_RAISE_DELAY; // later than both claims' finalizableAt
      await time.setNextBlockTimestamp(at - 1);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
      await time.setNextBlockTimestamp(at);
      const fee = feeOf(DEPOSIT, FEE_BPS);
      await expect(f.vault.finalizeClaim(f.alice.address, 1))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 1, f.bob.address, DEPOSIT - fee, fee);
    });

    it("replacing one live recipient with another starts no fee holiday: a claim right after locks the normal rate", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.admin).setFeeRecipient(f.carol.address); // live -> live
      expect(await f.vault.feeRecipientActiveAt()).to.equal(0);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
        .to.emit(f.vault, "ClaimInitiated")
        .withArgs(f.alice.address, 0, f.bob.address, anyUint, FEE_BPS);
    });

    it("a recipient switched on is in force AT feeRecipientActiveAt, not a second later", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      const on = await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
      const at = (await blockTimeOf(on)) + FEE_RAISE_DELAY; // after the vault's deadline
      expect(await f.vault.feeRecipientActiveAt()).to.equal(at);
      await time.setNextBlockTimestamp(at);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
        .to.emit(f.vault, "ClaimInitiated")
        .withArgs(f.alice.address, 0, f.bob.address, anyUint, FEE_BPS);
    });

    it("a SECOND fee holiday also delays the switch-on by FEE_RAISE_DELAY", async () => {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress); // holiday 1
      await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
      await time.increase(FEE_RAISE_DELAY + DAY); // holiday 1 is over
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress); // holiday 2
      const on = await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
      expect(await f.vault.feeRecipientActiveAt()).to.equal((await blockTimeOf(on)) + FEE_RAISE_DELAY);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
        .to.emit(f.vault, "ClaimInitiated")
        .withArgs(f.alice.address, 0, f.bob.address, anyUint, 0);
    });
  });

  // ------------------------------------------------------------------------------------ F06

  describe("F06 a fee raise waits FEE_RAISE_DELAY, so no rate can be moved under a user's transaction", () => {
    it("a raise is only scheduled: the rate in force holds until the announced second, then counts unapplied", async () => {
      const f = await loadFixture(fixture);
      const tx = await f.vault.connect(f.admin).setClaimFee(100);
      expect(await f.vault.claimFeeBps(), "rate in force right after a raise").to.equal(FEE_BPS);
      const at = (await blockTimeOf(tx)) + FEE_RAISE_DELAY;
      await expect(tx).to.emit(f.vault, "ClaimFeeRaiseScheduled").withArgs(FEE_BPS, 100, at);
      expect(await f.vault.pendingClaimFeeBps()).to.equal(100);
      expect(await f.vault.pendingClaimFeeAt()).to.equal(at);
      expect(await f.vault.FEE_RAISE_DELAY()).to.equal(FEE_RAISE_DELAY);

      // Pinned block times: one second before, the old ceiling; at the second, the new one --
      // with nobody having called applyClaimFee.
      await time.setNextBlockTimestamp(at - 1);
      await create(f, f.alice, NATIVE, ONE);
      await time.setNextBlockTimestamp(at);
      await create(f, f.alice, NATIVE, ONE);
      expect((await f.vault.getVault(f.alice.address, 0)).feeBps).to.equal(FEE_BPS);
      expect((await f.vault.getVault(f.alice.address, 1)).feeBps).to.equal(100);
      expect(await f.vault.pendingClaimFeeAt(), "not applied by anyone").to.equal(at);
    });

    it("createVault cannot be front-run into a higher ceiling", async () => {
      const f = await loadFixture(fixture);
      const quoted = Number(await f.vault.claimFeeBps());
      const horizon = (await time.latest()) + HORIZON;
      const [victim, front, back] = await oneBlock(async () => [
        await f.vault
          .connect(f.alice)
          .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT, ...USER }),
        await f.vault.connect(f.admin).setClaimFee(100, FRONT),
        await f.vault.connect(f.admin).setClaimFee(quoted, BACK),
      ]);
      expect((await ethers.provider.getBlock("latest"))!.transactions).to.deep.equal([
        front.hash,
        victim.hash,
        back.hash,
      ]);
      for (const t of [victim, front, back]) expect(await statusOf(t)).to.equal(1);
      expect(await f.vault.claimFeeBps()).to.equal(quoted); // the public rate before and after
      expect((await f.vault.getVault(f.alice.address, 0)).feeBps, "ceiling vs the rate Alice was quoted").to.equal(
        quoted
      );
    });

    it("the two-point claim sandwich cannot charge the heir more than the rate public when he claimed", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // ceiling 50
      const PROMO = 10;
      await f.vault.connect(f.admin).setClaimFee(PROMO); // a public promotion; cuts apply at once
      await time.increase(PERIOD + 1);

      // Leg 1: raise in front of Bob's initiateClaim, cut back behind it.
      const [claim, front] = await oneBlock(async () => [
        await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address, USER),
        await f.vault.connect(f.admin).setClaimFee(FEE_BPS, FRONT),
        await f.vault.connect(f.admin).setClaimFee(PROMO, BACK),
      ]);
      expect((await ethers.provider.getBlock("latest"))!.transactions[0]).to.equal(front.hash);
      expect(await statusOf(claim)).to.equal(1);

      // Leg 2: at finalizableAt the admin raises, finalizes itself and cuts, in one block.
      await time.setNextBlockTimestamp((await blockTimeOf(claim)) + WINDOW);
      const [, fin] = await oneBlock(async () => [
        await f.vault.connect(f.admin).setClaimFee(FEE_BPS, FRONT),
        await f.vault.connect(f.admin).finalizeClaim(f.alice.address, 0, FRONT),
        await f.vault.connect(f.admin).setClaimFee(PROMO, FRONT),
      ]);
      expect(await statusOf(fin)).to.equal(1);
      expect(await f.vault.claimFeeBps()).to.equal(PROMO);
      const rc = await ethers.provider.getTransactionReceipt(fin.hash);
      const settled = rc!.logs.map((l) => f.vault.interface.parseLog(l)).find((e: any) => e?.name === "ClaimSettled");
      expect(settled!.args.fee, "fee vs the rate public when Bob claimed").to.equal(feeOf(DEPOSIT, PROMO));
    });

    it("a cut applies at once and cancels a pending raise above it", async () => {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.admin).setClaimFee(100);
      expect(await f.vault.claimFeeBps()).to.equal(FEE_BPS);
      await expect(f.vault.connect(f.admin).setClaimFee(20))
        .to.emit(f.vault, "ClaimFeeRaiseCancelled")
        .withArgs(100)
        .and.to.emit(f.vault, "ClaimFeeChanged")
        .withArgs(FEE_BPS, 20);
      expect(await f.vault.claimFeeBps()).to.equal(20);
      await time.increase(FEE_RAISE_DELAY + DAY);
      expect(await f.vault.claimFeeBps(), "a cancelled raise must never take effect").to.equal(20);
      expect(await f.vault.pendingClaimFeeAt()).to.equal(0);

      // Re-affirming the rate in force is how a raise is called off without changing anything.
      // Pre-launch finalization: ClaimFeeChanged then carries the same rate twice, as its NatSpec
      // now says.
      await f.vault.connect(f.admin).setClaimFee(90);
      await expect(f.vault.connect(f.admin).setClaimFee(20))
        .to.emit(f.vault, "ClaimFeeRaiseCancelled")
        .withArgs(90)
        .and.to.emit(f.vault, "ClaimFeeChanged")
        .withArgs(20, 20);
      await time.increase(FEE_RAISE_DELAY + DAY);
      expect(await f.vault.claimFeeBps()).to.equal(20);
    });

    it("a new raise replaces a pending one and restarts the delay", async () => {
      const f = await loadFixture(fixture);
      const first = await f.vault.connect(f.admin).setClaimFee(80);
      const firstAt = (await blockTimeOf(first)) + FEE_RAISE_DELAY;
      await time.increase(20 * DAY);
      const second = await f.vault.connect(f.admin).setClaimFee(100);
      const secondAt = (await blockTimeOf(second)) + FEE_RAISE_DELAY;
      await time.setNextBlockTimestamp(firstAt);
      await create(f, f.alice, NATIVE, ONE);
      await time.setNextBlockTimestamp(secondAt);
      await create(f, f.alice, NATIVE, ONE);
      expect((await f.vault.getVault(f.alice.address, 0)).feeBps, "the replaced raise never counted").to.equal(FEE_BPS);
      expect((await f.vault.getVault(f.alice.address, 1)).feeBps).to.equal(100);
    });

    it("applyClaimFee is permissionless, refuses early or empty calls, and never moves the rate in force", async () => {
      const f = await loadFixture(fixture);
      await expect(f.vault.connect(f.dave).applyClaimFee()).to.be.revertedWithCustomError(f.vault, "NoFeeRaisePending");
      const tx = await f.vault.connect(f.admin).setClaimFee(100);
      const at = (await blockTimeOf(tx)) + FEE_RAISE_DELAY;
      await expect(f.vault.connect(f.dave).applyClaimFee())
        .to.be.revertedWithCustomError(f.vault, "FeeRaiseNotDue")
        .withArgs(at);
      await time.increaseTo(at);
      const inForce = await f.vault.claimFeeBps();
      expect(inForce).to.equal(100);
      await expect(f.vault.connect(f.dave).applyClaimFee()).to.emit(f.vault, "ClaimFeeChanged").withArgs(FEE_BPS, 100);
      expect(await f.vault.claimFeeBps()).to.equal(inForce);
      expect(await f.vault.pendingClaimFeeBps()).to.equal(0);
      expect(await f.vault.pendingClaimFeeAt()).to.equal(0);
      await expect(f.vault.connect(f.dave).applyClaimFee()).to.be.revertedWithCustomError(f.vault, "NoFeeRaisePending");

      // A setClaimFee after a matured-but-unapplied raise is measured from the raised rate: 70
      // is a cut from 90 (at once), not a raise from 60 (which would drop the rate back to 60).
      await f.vault.connect(f.admin).setClaimFee(60);
      await f.vault.connect(f.admin).setClaimFee(90);
      await time.increase(FEE_RAISE_DELAY);
      await expect(f.vault.connect(f.admin).setClaimFee(70))
        .to.emit(f.vault, "ClaimFeeChanged")
        .withArgs(60, 90)
        .and.to.emit(f.vault, "ClaimFeeChanged")
        .withArgs(90, 70);
      expect(await f.vault.claimFeeBps()).to.equal(70);
      expect(await f.vault.pendingClaimFeeAt()).to.equal(0);
    });

    // ---- review round 3: the boundary second of the new branches, pinned with setNextBlockTimestamp

    it("applyClaimFee succeeds AT pendingClaimFeeAt, the second claimFeeBps() already reports the raise", async () => {
      const f = await loadFixture(fixture);
      const tx = await f.vault.connect(f.admin).setClaimFee(100);
      const at = (await blockTimeOf(tx)) + FEE_RAISE_DELAY;
      await time.setNextBlockTimestamp(at);
      await expect(f.vault.connect(f.dave).applyClaimFee()).to.emit(f.vault, "ClaimFeeChanged").withArgs(FEE_BPS, 100);
      expect(await f.vault.pendingClaimFeeAt()).to.equal(0);
    });

    it("a setClaimFee AT pendingClaimFeeAt is measured from the matured raise: 70 is a cut from 90, not a raise from 40", async () => {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.admin).setClaimFee(40); // a cut
      const tx = await f.vault.connect(f.admin).setClaimFee(90); // a raise from 40
      const at = (await blockTimeOf(tx)) + FEE_RAISE_DELAY;
      await time.setNextBlockTimestamp(at);
      await expect(f.vault.connect(f.admin).setClaimFee(70))
        .to.emit(f.vault, "ClaimFeeChanged")
        .withArgs(40, 90)
        .and.to.emit(f.vault, "ClaimFeeChanged")
        .withArgs(90, 70);
      expect(await f.vault.claimFeeBps(), "never back down to the recorded 40").to.equal(70);
      expect(await f.vault.pendingClaimFeeAt()).to.equal(0);
    });

    it("a cut with no raise pending logs no ClaimFeeRaiseCancelled: an indexer sees no cancelled raise", async () => {
      const f = await loadFixture(fixture);
      const cut = await f.vault.connect(f.admin).setClaimFee(20);
      await expect(cut).to.emit(f.vault, "ClaimFeeChanged").withArgs(FEE_BPS, 20);
      await expect(cut).to.not.emit(f.vault, "ClaimFeeRaiseCancelled");
      // Also after a raise that was applied: nothing is pending any more.
      const tx = await f.vault.connect(f.admin).setClaimFee(60);
      await time.setNextBlockTimestamp((await blockTimeOf(tx)) + FEE_RAISE_DELAY);
      await f.vault.applyClaimFee();
      await expect(f.vault.connect(f.admin).setClaimFee(10)).to.not.emit(f.vault, "ClaimFeeRaiseCancelled");
    });

    it("(control) a raise that takes effect during a claim never reaches it (A-04 still holds)", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setClaimFee(10);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // locks 10
      await f.vault.connect(f.admin).setClaimFee(FEE_BPS);
      await time.increase(FEE_RAISE_DELAY + 1); // the raise is in force, and the window is over
      expect(await f.vault.claimFeeBps()).to.equal(FEE_BPS);
      const fee = feeOf(DEPOSIT, 10);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
    });

    it("(control) a claim begun after a matured raise ABOVE the vault's creation ceiling locks the ceiling, and settles at it", async () => {
      // Review round 2. The residual F06 documents ("a claim locks the new rate only up to the
      // vault's creation ceiling") rests on initiateClaim's clamp alone: finalizeClaim never
      // compares with the ceiling again. Nothing started a claim with the rate above it.
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // ceiling FEE_BPS (0.5%)
      await f.vault.connect(f.admin).setClaimFee(100);
      await time.increase(Math.max(PERIOD, FEE_RAISE_DELAY) + 1);
      expect(await f.vault.claimFeeBps(), "the raise is in force").to.equal(100);
      const init = f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      if (VAULT_IMPL === "v2") {
        await expect(init).to.emit(f.vault, "ClaimInitiated").withArgs(f.alice.address, 0, f.bob.address, anyUint, FEE_BPS);
        expect((await f.vault.getVault(f.alice.address, 0)).lockedFeeBps).to.equal(FEE_BPS);
      } else {
        await (await init).wait(); // v1's ClaimInitiated has no lockedFeeBps; settlement shows the lock
      }
      await time.increase(WINDOW + 1);
      const fee = feeOf(DEPOSIT, FEE_BPS);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
    });

    // ---- review round 4

    /** A native vault with a 60-day challenge window (twice FEE_RAISE_DELAY), and bob's claim on it. */
    async function longWindowClaim(f: F) {
      const LONG = 2 * FEE_RAISE_DELAY;
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, LONG, (await time.latest()) + HORIZON, { value: DEPOSIT });
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // locks FEE_BPS
      return Number((await f.vault.getVault(f.alice.address, 0)).finalizableAt);
    }

    it("(pin) with a challenge window longer than FEE_RAISE_DELAY, a cut made during it can be reversed, with notice, before the heir can settle: the heir pays the lock, never more", async () => {
      // Review round 4. finalizeClaim takes min(lock, rate in force), so a cut reaches the heir
      // only if it is still in force when finalizeClaim is mined. The heir cannot settle before
      // finalizableAt, and a reversal needs only FEE_RAISE_DELAY. Both reversals are public.
      const fee = feeOf(DEPOSIT, FEE_BPS);
      for (const reversal of ["rate", "recipient"]) {
        const f = await loadFixture(fixture);
        const finalizableAt = await longWindowClaim(f);
        await time.increase(DAY);
        if (reversal === "rate") await f.vault.connect(f.admin).setClaimFee(0);
        else await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
        // While the cut is in force the heir cannot settle: the window is still open.
        await expect(f.vault.finalizeClaim(f.alice.address, 0)).to.be.revertedWithCustomError(f.vault, "ChallengeWindowOpen");
        await time.increase(DAY);
        const back =
          reversal === "rate"
            ? await f.vault.connect(f.admin).setClaimFee(FEE_BPS)
            : await f.vault.connect(f.admin).setFeeRecipient(f.feeSink.address);
        if (VAULT_IMPL === "v2") {
          // The notice an heir (or the app) can see: the reversal takes effect before finalizableAt.
          const effective = (await blockTimeOf(back)) + FEE_RAISE_DELAY;
          if (reversal === "rate") await expect(back).to.emit(f.vault, "ClaimFeeRaiseScheduled").withArgs(0, FEE_BPS, effective);
          else expect(await f.vault.feeRecipientActiveAt()).to.equal(effective);
          expect(effective).to.be.lessThan(finalizableAt);
        }
        await time.increaseTo(finalizableAt);
        await expect(f.vault.finalizeClaim(f.alice.address, 0), `${reversal} reversed`)
          .to.emit(f.vault, "ClaimSettled")
          .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
      }
    });

    it("(pin) the heir keeps a cut for good by cancelling and re-initiating while it is in force, at the price of a fresh window", async () => {
      const f = await loadFixture(fixture);
      const first = await longWindowClaim(f);
      await time.increase(DAY);
      await f.vault.connect(f.admin).setClaimFee(0);
      await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address); // locks 0
      await f.vault.connect(f.admin).setClaimFee(FEE_BPS); // reversed, with notice
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.lockedFeeBps).to.equal(0);
      expect(Number(v.finalizableAt), "a fresh window").to.be.greaterThan(first);
      await time.increaseTo(Number(v.finalizableAt));
      expect(await f.vault.claimFeeBps(), "the reversal is in force").to.equal(FEE_BPS);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT, 0);
    });

    it("(guard) FEES and finalizeClaim say a cut reaches the heir only while still in force at settlement, and how an heir keeps one", async () => {
      const src = prose(...VAULT_SOL);
      expect(src).to.not.include("a cut during the challenge window still reaches the heir");
      expect(src).to.not.include("made during the challenge window still reach the heir");
      expect(src).to.include(
        "A cut (a lower rate, or the recipient removed) reaches the heir only if it is still in force when " +
          "finalizeClaim is mined. The admin may reverse it before then, with FEE_RAISE_DELAY of public notice"
      );
      expect(src).to.include(
        "with a challenge window longer than that delay the reversal can take effect before the heir is able to settle"
      );
      expect(src).to.include(
        "An heir keeps a cut for good only by beneficiaryCancelClaim and initiateClaim while it is in force"
      );
      // finalizeClaim's is a `//` comment, which prose() keeps as " // " between lines.
      expect(src.replace(/ \/\/ /g, " ")).to.include(
        "Re-taking the minimum here lets a fee CUT still in force at settlement reach the heir, while a rise can never " +
          "take the fee above the lock. A cut reversed before this transaction is mined does not count (see FEES)."
      );
    });
  });

  // ------------------------------------------------------------------------------------ F08

  describe("F08 before PUSH_GRACE only the credited account may push its credit", () => {
    const HEIR = DEPOSIT - feeOf(DEPOSIT, FEE_BPS);

    it("a stranger's settle-and-push cannot move a blocklisted heir's credit into his blocklisted address", async () => {
      const f = await loadFixture(fixture);
      const t = await f.usdt.getAddress();
      await create(f, f.alice, t, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.usdt.connect(f.admin).addBlackList(f.bob.address); // the issuer acts during the window
      const helper: any = await (await ethers.getContractFactory("SettleAndPush", f.dave)).deploy();
      await time.setNextBlockTimestamp(Number((await f.vault.getVault(f.alice.address, 0)).finalizableAt));
      // One transaction settles and pushes, so Bob never has a block in which to route.
      await attempt(helper.run(f.vaultAddr, f.alice.address, 0, t, f.bob.address));
      if ((await f.vault.getVault(f.alice.address, 0)).state !== STATE_SETTLED) {
        await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0); // settlement stays permissionless
        await attempt(f.vault.connect(f.dave).pushCredit(t, f.bob.address));
      }
      expect(await f.usdt.balanceOf(f.bob.address), "credit pushed into the blocklisted address").to.equal(0);
      await f.vault.connect(f.bob).withdrawCredit(t, f.carol.address); // Bob routes it himself
      expect(await f.usdt.balanceOf(f.carol.address)).to.equal(HEIR);
    });

    it("a stranger cannot push a call-only contract's credit into it ahead of the contract's own pull", async () => {
      const f = await loadFixture(fixture);
      const t = await f.token.getAddress();
      const fwdC: any = await (await ethers.getContractFactory("CallOnlyForwarder", f.bob)).deploy(
        f.bob.address,
        f.vaultAddr
      );
      const fwd = await fwdC.getAddress();
      await create(f, f.alice, t, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, fwd);
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      await attempt(f.vault.connect(f.dave).pushCredit(t, fwd)); // the front-run
      await attempt(fwdC.connect(f.bob).pull(t, f.bob.address));
      expect(await f.token.balanceOf(fwd), "stranded in a contract that cannot move it").to.equal(0);
      expect(await f.token.balanceOf(f.bob.address)).to.equal(HEIR);
    });

    it("a 1-wei credit planted early does not make a later inheritance pushable at once", async () => {
      // Beyond the plan (CHANGELOG-v2.md, F08): the grace restarts when a credit at least as large
      // as what is owed arrives. Restarting only from zero fails this test.
      const f = await loadFixture(fixture);
      const t = await f.usdt.getAddress();
      await create(f, f.alice, t, DEPOSIT);
      await create(f, f.dave, t, ONE, f.carol.address);
      await f.vault.connect(f.dave).withdraw(0, 1n, f.bob.address); // Dave plants 1 wei on Bob
      await time.increase(PERIOD + 1); // the plant is now older than PUSH_GRACE
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.usdt.connect(f.admin).addBlackList(f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      await attempt(f.vault.connect(f.dave).pushCredit(t, f.bob.address));
      expect(await f.usdt.balanceOf(f.bob.address), "inheritance pushed into the blocklisted address").to.equal(0);
      expect(await f.vault.creditOf(t, f.bob.address)).to.equal(HEIR + 1n);
    });

    it("the fee recipient's growing credit is pushable PUSH_GRACE after it was first owed, and not later", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // fee 0.05
      await create(f, f.alice, NATIVE, DEPOSIT / 2n); // fee 0.025: smaller than what is then owed
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      const first = await f.vault.finalizeClaim(f.alice.address, 0);
      const t0 = await blockTimeOf(first);
      await time.increase(10 * DAY);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 1);
      const owed = feeOf(DEPOSIT, FEE_BPS) + feeOf(DEPOSIT / 2n, FEE_BPS);
      expect(await f.vault.creditOf(NATIVE, f.feeSink.address)).to.equal(owed);
      // Too early for a stranger, counted from the FIRST fee...
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, f.feeSink.address))
        .to.be.revertedWithCustomError(f.vault, "PushTooEarly")
        .withArgs(t0 + PUSH_GRACE);
      // ...and not a second later than that, however much has accrued since.
      await time.setNextBlockTimestamp(t0 + PUSH_GRACE);
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, f.feeSink.address)).to.changeEtherBalance(
        f.feeSink,
        owed
      );
    });

    it("a partial withdrawal leaves the grace clock where it was, and a full payout clears it", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const w = await f.vault.connect(f.alice).withdraw(0, 3n * ONE, f.carol.address);
      const t0 = await blockTimeOf(w);
      expect(await f.vault.creditedSince(NATIVE, f.carol.address)).to.equal(t0);
      await time.increase(10 * DAY);
      await f.vault.connect(f.carol)["withdrawCredit(address,address,uint256)"](NATIVE, f.carol.address, ONE);
      expect(await f.vault.creditedSince(NATIVE, f.carol.address), "a part paid restarts nothing").to.equal(t0);
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, f.carol.address))
        .to.be.revertedWithCustomError(f.vault, "PushTooEarly")
        .withArgs(t0 + PUSH_GRACE);
      await time.setNextBlockTimestamp(t0 + PUSH_GRACE);
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, f.carol.address)).to.changeEtherBalance(
        f.carol,
        2n * ONE
      );
      expect(await f.vault.creditedSince(NATIVE, f.carol.address)).to.equal(0);
      expect(await f.vault.PUSH_GRACE()).to.equal(PUSH_GRACE);
    });

    it("a new credit EQUAL to what is owed restarts the grace ('at least as large'); one wei smaller does not", async () => {
      // Review round 1: the boundary of _credit's restart rule.
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const first = await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await time.increase(20 * DAY);
      const equal = await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address); // == owed
      expect(await f.vault.creditedSince(NATIVE, f.carol.address), "equal restarts").to.equal(await blockTimeOf(equal));
      expect(await blockTimeOf(equal)).to.be.greaterThan(await blockTimeOf(first));
      await time.increase(DAY);
      await f.vault.connect(f.alice).withdraw(0, 2n * ONE - 1n, f.carol.address); // owed - 1
      expect(await f.vault.creditedSince(NATIVE, f.carol.address), "smaller does not").to.equal(await blockTimeOf(equal));
    });

    it("(control) the credited account may push its own credit at any time", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await expect(f.vault.connect(f.carol).pushCredit(NATIVE, f.carol.address)).to.changeEtherBalance(f.carol, ONE);
    });

    it("(control) after PUSH_GRACE a stranger may push, so an account that cannot call is still paid", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      await time.increase(PUSH_GRACE);
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, f.carol.address)).to.changeEtherBalance(f.carol, ONE);
    });

    // ---- review round 3: the grace is per account balance, not per credit

    it("(pin) a credit SMALLER than what the account already owes joins the older clock: once that has run out, a stranger settles and pushes it in one transaction", async () => {
      // The design cost THE CREDIT LANE now states. Restarting the clock on every credit would
      // let anyone postpone the push to an account that cannot act forever, 1 wei at a time.
      const f = await loadFixture(fixture);
      const t = await f.usdt.getAddress();
      const SMALL = DEPOSIT / 10n;
      await create(f, f.alice, t, DEPOSIT); // 0: a split estate, both vaults naming bob
      await create(f, f.alice, t, SMALL); // 1
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await time.increase(WINDOW);
      await f.vault.finalizeClaim(f.alice.address, 0); // bob is owed HEIR from now
      await time.increase(PUSH_GRACE); // and has not pulled it
      await f.usdt.connect(f.admin).addBlackList(f.bob.address);
      const helper: any = await (await ethers.getContractFactory("SettleAndPush", f.dave)).deploy();
      await helper.run(f.vaultAddr, f.alice.address, 1, t, f.bob.address);
      const both = HEIR + SMALL - feeOf(SMALL, FEE_BPS);
      expect(await f.usdt.balanceOf(f.bob.address), "both inheritances, in the frozen address").to.equal(both);
      expect(await f.vault.creditOf(t, f.bob.address)).to.equal(0);
    });

    it("(guard) THE CREDIT LANE and pushCredit's NatSpec say the grace runs per account balance, and what an heir should do about it", async () => {
      const src = prose(...VAULT_SOL);
      expect(src).to.not.include("so the account always has that long to route it elsewhere first");
      expect(src).to.not.include("a credited account that CAN act always gets to route its credit first");
      expect(src).to.include("The grace runs per account balance (token, account), not per credit.");
      expect(src).to.include(
        "A credit SMALLER than what the account already owes gets no grace of its own: it joins the older clock, " +
          "and once that clock has run out, anyone may settle it (finalizeClaim is permissionless) and push the whole " +
          "balance in one transaction."
      );
      expect(src).to.include(
        "should withdraw it before settling another claim into that address, or name a fresh recipient for each claim"
      );
      const push = src.slice(src.indexOf("@notice Pays `account`'s whole credit"), src.indexOf("function pushCredit("));
      expect(push).to.include("It runs per account balance, not per credit");
    });
  });

  // ------------------------------------------------------------------------------------ F14

  describe("F14 a full withdrawal that ends a pending claim says so: ClaimSuperseded(ACT_CLOSE)", () => {
    /** An event-sourced claim tracker, as an explorer or heir dashboard builds one. It never
     * reads Withdrawn: the Claim* events are the lifecycle vocabulary the contract defines. */
    async function trackedPending(f: F): Promise<Set<string>> {
      const logs = await ethers.provider.getLogs({ address: f.vaultAddr, fromBlock: 0, toBlock: "latest" });
      const open = new Set<string>();
      for (const log of logs) {
        const p = f.vault.interface.parseLog(log);
        if (!p) continue;
        const closes = ["ClaimAborted", "ClaimSuperseded", "ClaimSettled", "ClaimCancelled"].includes(p.name);
        if (p.name !== "ClaimInitiated" && !closes) continue;
        const key = `${String(p.args.owner).toLowerCase()}#${p.args.vaultId}`;
        if (closes) open.delete(key);
        else open.add(key);
      }
      return open;
    }

    async function pendingClaim(f: F, horizonFromNow = HORIZON) {
      const horizon = (await time.latest()) + horizonFromNow;
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      return horizon;
    }

    it("before the horizon", async () => {
      const f = await loadFixture(fixture);
      await pendingClaim(f);
      const tx = await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
      await expect(tx).to.emit(f.vault, "ClaimSuperseded").withArgs(f.alice.address, 0, ACT_CLOSE);
      await expect(tx).to.emit(f.vault, "Withdrawn").withArgs(f.alice.address, 0, f.alice.address, DEPOSIT, true);
      expect(vaultLogNames(f, await tx.wait())).to.deep.equal([...RESET, "ClaimSuperseded", "Withdrawn"]);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLOSED);
      expect(await f.vault.ACT_CLOSE()).to.equal(ACT_CLOSE);
    });

    it("past the horizon, where a full withdrawal is one of only two ways left to stop a claim", async () => {
      const f = await loadFixture(fixture);
      const horizon = await pendingClaim(f, PERIOD + 5 * DAY);
      await time.increaseTo(horizon + 1);
      // A partial withdrawal past the horizon deliberately leaves the claim running...
      const partial = await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address);
      expect(vaultLogNames(f, await partial.wait())).to.deep.equal([...RESET, "Withdrawn"]);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
      // ...the full one ends it, and says so.
      await expect(f.vault.connect(f.alice).withdraw(0, DEPOSIT - ONE, f.alice.address))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 0, ACT_CLOSE);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLOSED);
    });

    it("an event-sourced claim tracker agrees with storage once the vault is closed", async () => {
      const f = await loadFixture(fixture);
      await pendingClaim(f);
      const key = `${f.alice.address.toLowerCase()}#0`;
      expect((await trackedPending(f)).has(key), "the tracker saw the claim open").to.equal(true);
      await f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address);
      await time.increase(WINDOW + 1);
      expect((await trackedPending(f)).has(key), "phantom claim on a CLOSED vault").to.equal(false);
      await expect(f.vault.finalizeClaim(f.alice.address, 0)).to.be.revertedWithCustomError(f.vault, "NoClaimPending");
    });

    it("(control) a partial withdrawal before the horizon still supersedes with ACT_WITHDRAW; a close with no claim emits none", async () => {
      const f = await loadFixture(fixture);
      await pendingClaim(f);
      await expect(f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 0, ACT_WITHDRAW);
      const close = await f.vault.connect(f.alice).withdraw(0, DEPOSIT - ONE, f.alice.address);
      expect(vaultLogNames(f, await close.wait())).to.deep.equal([...RESET, "Withdrawn"]);
    });
  });

  // ------------------------------------------------------------------------------------ F20

  describe("F20 the heir can withdraw their own pending claim, e.g. to fix the payout address", () => {
    const WRONG = "0x000000000000000000000000000000000000dEaD"; // the mistyped payout address
    const NET = DEPOSIT - feeOf(DEPOSIT, FEE_BPS);

    async function claimTo(f: F, recipient: string, horizonFromNow = HORIZON) {
      const horizon = (await time.latest()) + horizonFromNow;
      await f.vault
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, recipient);
      return horizon;
    }

    it("with the owner absent, the heir re-points a mistyped payout address and the estate goes where he meant", async () => {
      const f = await loadFixture(fixture);
      await claimTo(f, WRONG);
      await attempt(f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0));
      await attempt(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address));
      expect((await f.vault.getVault(f.alice.address, 0)).claimRecipient).to.equal(f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      expect(await f.vault.creditOf(NATIVE, WRONG), "estate credited to the typo").to.equal(0);
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(NET);
    });

    it("cancelling returns the vault to ACTIVE with deadline and horizon untouched, and logs ClaimCancelled", async () => {
      const f = await loadFixture(fixture);
      await claimTo(f, WRONG);
      const before = await f.vault.getVault(f.alice.address, 0);
      await expect(f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimCancelled")
        .withArgs(f.alice.address, 0, f.bob.address);
      const after = await f.vault.getVault(f.alice.address, 0);
      expect(after.state).to.equal(STATE_ACTIVE);
      expect(after.deadline).to.equal(before.deadline);
      expect(after.absoluteDeadline).to.equal(before.absoluteDeadline);
      expect(after.claimRecipient).to.equal(ethers.ZeroAddress);
      expect(after.claimInitiatedAt).to.equal(0);
      expect(after.balance).to.equal(DEPOSIT);
      expect(after.expired, "still expired, so the heir may start again at once").to.equal(true);
    });

    it("only the current beneficiary may cancel, and only a pending claim", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await expect(f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0))
        .to.be.revertedWithCustomError(f.vault, "NoClaimPending")
        .withArgs(0);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.carol.address);
      for (const who of [f.alice, f.carol, f.dave]) {
        // the owner, the claim recipient, a stranger
        await expect(f.vault.connect(who).beneficiaryCancelClaim(f.alice.address, 0))
          .to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary")
          .withArgs(who.address, f.bob.address);
      }
      await expect(f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 1)).to.be.revertedWithCustomError(
        f.vault,
        "NoSuchVault"
      );
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
    });

    it("a cancel never shortens the owner's time to veto: the new claim gets a full window of its own", async () => {
      const f = await loadFixture(fixture);
      await claimTo(f, WRONG);
      const first = (await f.vault.getVault(f.alice.address, 0)).finalizableAt;
      await time.increase(WINDOW - DAY);
      await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
      const again = await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const second = BigInt((await blockTimeOf(again)) + WINDOW);
      expect((await f.vault.getVault(f.alice.address, 0)).finalizableAt).to.equal(second);
      await time.increaseTo(first + 1n);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.be.revertedWithCustomError(f.vault, "ChallengeWindowOpen")
        .withArgs(second);
      await f.vault.connect(f.alice).abortClaim(0); // the owner's veto is intact
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);
    });

    it("past the horizon it reopens neither abortClaim nor checkIn, and the heir claims at once", async () => {
      // Review round 2: retitled from "it reopens no veto". It does reopen setBeneficiary there;
      // see "(pin) the documented cost of the gap (past the horizon)" below.
      const f = await loadFixture(fixture);
      const horizon = await claimTo(f, WRONG, PERIOD + 5 * DAY);
      await time.increaseTo(horizon + 1);
      expect(await attempt(f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0)), "heir cancels").to.equal(
        true
      );
      await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(f.vault, "NoClaimPending");
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.reverted;
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(NET);
    });

    it("(control) a hostile heir cancelling in front of the owner's veto cannot keep the claim alive", async () => {
      const f = await loadFixture(fixture);
      await claimTo(f, f.bob.address);
      // Bob cancels in front of Alice's abortClaim and re-initiates behind it, in one block.
      const [abort, cancel, again] = await oneBlock(async () => [
        await f.vault.connect(f.alice).abortClaim(0, USER),
        await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0, FRONT),
        await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address, BACK),
      ]);
      if (VAULT_IMPL === "v2") {
        // Review round 3: asserted outright, not only when the cancel happens to succeed, so the
        // documented limitation cannot go stale unnoticed. The order is the one the tips set; the
        // cancel lands, that one abortClaim reverts, and the claim is back with a fresh window.
        expect((await ethers.provider.getBlock("latest"))!.transactions, "[cancel, abort, initiate]").to.deep.equal([
          cancel.hash,
          abort.hash,
          again.hash,
        ]);
        expect([await statusOf(cancel), await statusOf(abort), await statusOf(again)]).to.deep.equal([1, 0, 1]);
        expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
      }
      // Any owner action that does not need a claim to be pending still ends it.
      await f.vault.connect(f.alice).setInactivityPeriod(0, PERIOD);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NotYetExpired");
    });

    it("(control) the owner's veto still works while the owner is alive", async () => {
      const f = await loadFixture(fixture);
      await claimTo(f, WRONG);
      await f.vault.connect(f.alice).abortClaim(0);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);
    });

    // ---- review round 1: the cost of the undo, pinned and disclosed

    it("(pin) the documented cost: until finalizeClaim is mined, the beneficiary key alone can redirect a pending payout", async () => {
      // v1 froze the recipient at initiateClaim. v2 does not, by the plan's choice (see
      // CHANGELOG-v2.md, Review round 1). A key stolen on day 13 of 14, with the owner gone:
      const f = await loadFixture(fixture);
      const thief = ethers.Wallet.createRandom().address;
      await claimTo(f, f.carol.address); // the heir's cold address
      await time.increase(WINDOW - DAY);
      await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, thief);
      // The price: a fresh full window, in which the real heir (who still holds the key) can
      // cancel again, and a living owner can veto.
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.finalizableAt - v.claimInitiatedAt).to.equal(BigInt(WINDOW));
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      expect(await f.vault.creditOf(NATIVE, thief)).to.equal(NET);
    });

    it("(guard) beneficiaryCancelClaim's NatSpec discloses that cost instead of claiming it gives nobody new power", async () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "InheritanceVault.sol"), "utf8");
      const doc = src.slice(src.lastIndexOf("/**", src.indexOf("function beneficiaryCancelClaim(")), src.indexOf("function beneficiaryCancelClaim("));
      const prose = doc.replace(/\s*\*\s*/g, " ");
      expect(prose).to.not.include("gives nobody new power");
      expect(prose).to.include("the payout address is NOT frozen for the life of a claim");
      expect(prose).to.include("a beneficiary key stolen during the challenge window can redirect the payout");
    });

    // ---- review round 2: terminal states, and the cost of the ACTIVE gap, pinned and disclosed

    it("only a pending claim: a SETTLED vault, and one CLOSED while a claim was pending, cannot be cancelled back to life", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // 0: will settle
      await create(f, f.alice, NATIVE, DEPOSIT); // 1: will close under a pending claim
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await f.vault.connect(f.alice).withdraw(1, DEPOSIT, f.alice.address); // closes vault 1
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      for (const id of [0, 1]) {
        await expect(f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, id))
          .to.be.revertedWithCustomError(f.vault, "NoClaimPending")
          .withArgs(id);
      }
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_SETTLED);
      expect((await f.vault.getVault(f.alice.address, 1)).state).to.equal(STATE_CLOSED);
      expect(await f.vault.openVaultIds(f.alice.address)).to.deep.equal([]);
    });

    it("(pin) the documented cost of the gap (past the horizon): after a cancel the owner may name a new heir, who claims at once", async () => {
      // A pending claim makes setBeneficiary revert HorizonReached past the horizon; the cancel
      // returns the vault to ACTIVE, and there setBeneficiary works (F43, kept by design).
      const f = await loadFixture(fixture);
      const horizon = await claimTo(f, WRONG, PERIOD + 5 * DAY);
      await time.increaseTo(horizon + 1);
      await expect(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address))
        .to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
      await f.vault.connect(f.alice).setBeneficiary(0, f.carol.address); // the gap
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
        .to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary");
      await f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
    });

    it("(pin) the documented cost of the gap (before the horizon): after a cancel anyone holding an unspent chain value can postpone the heir by a full period", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const leaked = ethers.id("an unspent check-in chain value");
      const anchor = await f.vault.hbStep(f.alice.address, 0, 1, leaked);
      await f.vault.connect(f.alice)["setCheckInChain(uint256,bytes32,uint32,uint32)"](0, anchor, 1, 1);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, WRONG);
      await expect(f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, leaked))
        .to.be.revertedWithCustomError(f.vault, "VaultNotActive");
      await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
      const moved = await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, leaked); // the gap
      const deadline = BigInt((await blockTimeOf(moved)) + PERIOD);
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(deadline);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
        .to.be.revertedWithCustomError(f.vault, "NotYetExpired")
        .withArgs(deadline);
    });

    it("(guard) beneficiaryCancelClaim's NatSpec discloses the cost of the ACTIVE gap: any chain-value holder, and a new heir past the horizon", async () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "InheritanceVault.sol"), "utf8");
      const doc = src.slice(src.lastIndexOf("/**", src.indexOf("function beneficiaryCancelClaim(")), src.indexOf("function beneficiaryCancelClaim("));
      const prose = doc.replace(/\s*\*\s*/g, " ");
      expect(prose).to.not.include("(or a check-in chain relayer) may check in");
      expect(prose).to.include("ANYONE holding an unspent check-in chain value");
      expect(prose).to.include("postpones the heir's new claim by a full inactivity period");
      expect(prose).to.include("the owner may name a new heir, who can claim at once");
    });

    // ---- pre-launch finalization (review round 5, R5-2): the correction deadline is finalizableAt

    it("(pin) the documented cost: from finalizableAt a stranger's finalizeClaim mined first settles the estate to the mistyped recipient for good, so the heir's cancel is certain only before that second", async () => {
      // R5-2 (F20 x F13). The lead kept the design: no grace period after finalizableAt and no
      // atomic re-point. The NatSpec names the deadline, and the app shows it.
      const f = await loadFixture(fixture);
      await claimTo(f, WRONG);
      const at = Number((await f.vault.getVault(f.alice.address, 0)).finalizableAt);
      /** One block stamped `t`: a stranger's finalizeClaim (the higher tip, so mined first), then the heir's cancel. */
      const race = async (t: number) => {
        await time.setNextBlockTimestamp(t);
        const [fin, cancel] = await oneBlock(async () => [
          await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0, FRONT),
          await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0, USER),
        ]);
        expect((await ethers.provider.getBlock("latest"))!.transactions, "[finalize, cancel]").to.deep.equal([
          fin.hash,
          cancel.hash,
        ]);
        return [await statusOf(fin), await statusOf(cancel)];
      };
      const snap = await network.provider.send("evm_snapshot", []);
      expect(await race(at), "statuses AT finalizableAt").to.deep.equal([1, 0]);
      expect(await f.vault.creditOf(NATIVE, WRONG), "the estate, credited to the typo").to.equal(NET);
      await expect(
        f.vault.connect(f.bob)["withdrawCredit(address,address)"](NATIVE, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NothingCredited");
      await time.increase(PUSH_GRACE);
      await expect(f.vault.connect(f.dave).pushCredit(NATIVE, WRONG)).to.changeEtherBalance(WRONG, NET);
      await network.provider.send("evm_revert", [snap]);

      // (control) A second earlier the window is still open: the finalize reverts, the cancel
      // lands, and the re-initiated claim settles where the heir meant.
      expect(await race(at - 1), "statuses a second before finalizableAt").to.deep.equal([0, 1]);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 0);
      expect(await f.vault.creditOf(NATIVE, f.bob.address)).to.equal(NET);
      expect(await f.vault.creditOf(NATIVE, WRONG)).to.equal(0);
    });

    it("(guard) the NatSpec names finalizableAt, not settlement, as the last safe moment to correct a recipient: beneficiaryCancelClaim, initiateClaim, finalizeClaim and THE CREDIT LANE", async () => {
      // R5-2. Until the pre-launch finalization, beneficiaryCancelClaim offered the undo "until
      // finalizeClaim is mined" and THE CREDIT LANE "before settlement". The pin above shows
      // that from finalizableAt on, a stranger's finalizeClaim can land first.
      const cancel = docAbove("    function beneficiaryCancelClaim(");
      expect(cancel).to.include(
        "The last safe moment to correct a recipient is finalizableAt (in getVault and in ClaimInitiated), not settlement."
      );
      expect(cancel).to.include("From that second anyone may call finalizeClaim");
      expect(cancel).to.include("A cancel is certain to work only if it is mined before finalizableAt.");
      expect(docAbove("    function initiateClaim(")).to.include(
        "only beneficiaryCancelClaim can change it, and only safely before finalizableAt"
      );
      expect(docAbove("    function finalizeClaim(")).to.include(
        "a correction of that recipient (beneficiaryCancelClaim) is safe only before then"
      );
      const src = prose(...VAULT_SOL);
      expect(src).to.not.include("beneficiaryCancelClaim can still change it before settlement");
      expect(src).to.include("(beneficiaryCancelClaim can still change it, safely only before finalizableAt)");
    });
  });

  // ------------------------------------------------------------------------------------ F22

  describe("F22 withdraw(id, type(uint256).max, to) closes the vault whatever its balance has become", () => {
    it("a 1-wei front-run topUp cannot keep open a vault its owner asked to close", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const [close, grief] = await oneBlock(async () => [
        await f.vault.connect(f.alice).withdraw(0, ethers.MaxUint256, f.alice.address, USER),
        await f.vault.connect(f.dave).topUp(f.alice.address, 0, 1n, { value: 1n, ...FRONT }),
      ]);
      expect((await ethers.provider.getBlock("latest"))!.transactions).to.deep.equal([grief.hash, close.hash]);
      expect(await statusOf(grief)).to.equal(1);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.state, "the vault its owner asked to close").to.equal(STATE_CLOSED);
      expect(v.balance).to.equal(0);
      expect(await f.vault.openVaultIds(f.alice.address)).to.deep.equal([]);
      expect(await f.vault.totalLocked(NATIVE)).to.equal(0);
      expect(await f.vault.creditOf(NATIVE, f.alice.address)).to.equal(DEPOSIT + 1n); // the griefer's wei too
      await expect(close)
        .to.emit(f.vault, "Withdrawn")
        .withArgs(f.alice.address, 0, f.alice.address, DEPOSIT + 1n, true);
    });

    it("with a claim pending, the sentinel closes the vault and ends the claim with ACT_CLOSE", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const tx = f.vault.connect(f.alice).withdraw(0, ethers.MaxUint256, f.alice.address);
      await expect(tx).to.emit(f.vault, "ClaimSuperseded").withArgs(f.alice.address, 0, ACT_CLOSE);
      await expect(tx).to.emit(f.vault, "Withdrawn").withArgs(f.alice.address, 0, f.alice.address, DEPOSIT, true);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLOSED);
    });

    it("(control) an exact-balance withdrawal still closes, and any other amount above the balance still reverts", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await expect(f.vault.connect(f.alice).withdraw(0, DEPOSIT + 1n, f.alice.address))
        .to.be.revertedWithCustomError(f.vault, "InsufficientBalance")
        .withArgs(DEPOSIT, DEPOSIT + 1n);
      await expect(f.vault.connect(f.alice).withdraw(0, ethers.MaxUint256 - 1n, f.alice.address))
        .to.be.revertedWithCustomError(f.vault, "InsufficientBalance")
        .withArgs(DEPOSIT, ethers.MaxUint256 - 1n);
      await expect(f.vault.connect(f.alice).withdraw(0, DEPOSIT, f.alice.address))
        .to.emit(f.vault, "Withdrawn")
        .withArgs(f.alice.address, 0, f.alice.address, DEPOSIT, true);
    });
  });

  // ------------------------------------------------------------------------------------ F25

  describe("F25 the fee locked for a claim is visible in getVault and in ClaimInitiated", () => {
    const PROMO = 20;

    it("getVault shows the locked rate while a claim is pending (ceiling 0.5%, locked 0.2%), and settlement takes that", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setClaimFee(PROMO);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.feeBps, "the ceiling").to.equal(FEE_BPS);
      expect(v.lockedFeeBps, "the locked rate").to.equal(PROMO);
      await time.increase(WINDOW + 1);
      const fee = feeOf(DEPOSIT, v.lockedFeeBps ?? FEE_BPS);
      await expect(f.vault.finalizeClaim(f.alice.address, 0))
        .to.emit(f.vault, "ClaimSettled")
        .withArgs(f.alice.address, 0, f.bob.address, DEPOSIT - fee, fee);
    });

    it("ClaimInitiated carries the locked rate", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setClaimFee(PROMO);
      await time.increase(PERIOD + 1);
      const tx = await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(tx)
        .to.emit(f.vault, "ClaimInitiated")
        .withArgs(f.alice.address, 0, f.bob.address, (await blockTimeOf(tx)) + WINDOW, PROMO);
    });

    it("with no fee recipient in force the lock shows 0, which is what settlement takes", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.admin).setFeeRecipient(ethers.ZeroAddress);
      await time.increase(PERIOD + 1);
      const tx = await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(tx)
        .to.emit(f.vault, "ClaimInitiated")
        .withArgs(f.alice.address, 0, f.bob.address, (await blockTimeOf(tx)) + WINDOW, 0);
      expect((await f.vault.getVault(f.alice.address, 0)).lockedFeeBps).to.equal(0);
    });

    it("the lock is shown only while a claim is pending, never as a stale value", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // 0
      await create(f, f.alice, NATIVE, DEPOSIT); // 1
      await f.vault.connect(f.admin).setClaimFee(PROMO);
      await time.increase(PERIOD + 1);
      const locked = async (id: number) => (await f.vault.getVault(f.alice.address, id)).lockedFeeBps;
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      expect(await locked(0)).to.equal(PROMO);
      await f.vault.connect(f.alice).abortClaim(0);
      expect(await locked(0), "after an abort").to.equal(0);
      // Review round 3: every other way a claim ends, each leaving the stored lock behind.
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, 1);
      expect(await locked(1), "after settlement (SETTLED)").to.equal(0);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      expect(await locked(0)).to.equal(PROMO);
      await f.vault.connect(f.alice).setBeneficiary(0, f.carol.address);
      expect(await locked(0), "after a superseding owner action").to.equal(0);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.carol).initiateClaim(f.alice.address, 0, f.carol.address);
      expect(await locked(0)).to.equal(PROMO);
      await f.vault.connect(f.alice).withdraw(0, ethers.MaxUint256, f.alice.address);
      expect(await locked(0), "after a closing withdrawal (CLOSED)").to.equal(0);
    });
  });

  // ------------------------------------------------------------------------------------ F26

  describe("F26 value events say what they record, and CreditPaid follows the transfer it reports", () => {
    const TRANSFER = ethers.id("Transfer(address,address,uint256)");
    const order = (f: F, rc: any): string[] =>
      rc.logs.map((l: any) => (l.topics[0] === TRANSFER ? "Transfer" : f.vault.interface.parseLog(l)?.name ?? "other"));

    it("withdrawCredit: the token's Transfer out comes first, then CreditPaid", async () => {
      const f = await loadFixture(fixture);
      const t = await f.token.getAddress();
      await create(f, f.alice, t, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, f.carol.address);
      const rc = await (await f.vault.connect(f.carol).withdrawCredit(t, f.carol.address)).wait();
      expect(order(f, rc)).to.deep.equal(["Transfer", "CreditPaid"]);
    });

    it("pushCredit of native coin: the recipient's receive() runs first, then CreditPaid", async () => {
      const f = await loadFixture(fixture);
      const receiver = await (await ethers.getContractFactory("LoggingReceiver", f.admin)).deploy();
      const r = await receiver.getAddress();
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).withdraw(0, ONE, r);
      await time.increase(PUSH_GRACE);
      const rc = await (await f.vault.connect(f.dave).pushCredit(NATIVE, r)).wait();
      const names = rc.logs.map((l: any) =>
        l.address.toLowerCase() === r.toLowerCase() ? "Received" : f.vault.interface.parseLog(l)?.name
      );
      expect(names).to.deep.equal(["Received", "CreditPaid"]);
    });

    it("sweepSurplus: the Transfer out comes first, then SurplusSwept", async () => {
      const f = await loadFixture(fixture);
      const t = await f.token.getAddress();
      await f.token.connect(f.dave).transfer(f.vaultAddr, ONE); // force-fed
      const rc = await (await f.vault.connect(f.admin).sweepSurplus(t, f.carol.address)).wait();
      expect(order(f, rc)).to.deep.equal(["Transfer", "SurplusSwept"]);
    });

    it("(guard) each value event's NatSpec says whether it records a credit or a transfer", async () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "InheritanceVault.sol"), "utf8");
      const expected: [string, string][] = [
        ["VaultCreated", "TRANSFER IN"],
        ["ToppedUp", "TRANSFER IN"],
        ["Withdrawn", "CREDIT, not a transfer"],
        ["ClaimSettled", "CREDIT, not a transfer"],
        ["CreditPaid", "TRANSFER OUT, emitted after it succeeded"],
        ["SurplusSwept", "TRANSFER OUT, emitted after it succeeded"],
      ];
      for (const [name, kind] of expected) {
        const i = src.indexOf(`    event ${name}(`);
        expect(i, `event ${name} declared`).to.be.greaterThan(0);
        const above = src.slice(0, i).trimEnd().split("\n");
        const doc: string[] = [];
        for (let j = above.length - 1; j >= 0 && above[j].trim().startsWith("///"); j--) doc.unshift(above[j].trim());
        expect(doc.join(" "), `NatSpec of ${name}`).to.include(kind);
      }
    });
  });

  // ====================================================================== pass 3: check-ins

  const SKIP_UNKNOWN_ID = 1;
  const SKIP_TERMINAL = 2;
  const SKIP_CLAIM_PENDING = 3;
  const SKIP_HORIZON_REACHED = 4;
  const SKIP_PINNED = 5;
  const SKIP_REPEATED = 6;
  const SKIP_CLAIM_PENDING_PAST_HORIZON = 7; // review round 3
  const ACT_EXTEND_HORIZON = 3;
  const ACT_SET_CHECKIN_CHAIN = 5;
  const BIT3 = 1 << 3;
  const BIT4 = 1 << 4;
  /** The step the implementation under test checks: v1 plain keccak, v2 domain-separated. */
  const IMPL: chain.Mode = VAULT_IMPL;
  const SEED = ethers.keccak256(ethers.toUtf8Bytes("alice paper seed (test only)"));
  const SET3 = "setCheckInChain(uint256,bytes32,uint32)";
  const SET4 = "setCheckInChain(uint256,bytes32,uint32,uint32)";

  /** A chain context for `owner`'s vault `vaultId`; the epoch defaults to the next installation. */
  async function chainCtx(f: F, owner: string, vaultId: number, epoch?: number, vault: any = f.vault) {
    if (epoch === undefined) {
      // v1 has no hbEpoch; the generator's v1 mode then takes it as the install index.
      const e = (await vault.getVault(owner, vaultId)).hbEpoch;
      epoch = Number(e ?? 0n) + 1;
    }
    const ctx: chain.ChainContext = {
      chainId: (await ethers.provider.getNetwork()).chainId,
      vault: await vault.getAddress(),
      owner,
      vaultId,
      epoch,
    };
    return ctx;
  }

  /** Arms `who`'s vault `id` with a reference-generator chain (mode = the implementation). */
  async function armChain(f: F, who: any, id: number, count: number, seed = SEED) {
    const ctx = await chainCtx(f, who.address, id);
    const plan = chain.buildChain(IMPL, ctx, seed, count);
    await f.vault.connect(who)[SET3](id, plan.anchor, count);
    return { ctx, anchor: plan.anchor, value: (left: number) => chain.nextValue(IMPL, ctx, seed, left) };
  }

  /** Vault `id` of `who` with a horizon `extra` seconds more than one period after its (pinned) creation second. */
  async function vaultWithHorizon(f: F, extra: number, who: any = f.alice) {
    const t0 = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(t0);
    const horizon = t0 + PERIOD + extra;
    await f.vault
      .connect(who)
      .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { t0, horizon, id: Number(await f.vault.vaultCount(who.address)) - 1 };
  }

  /**
   * Alice's vault in the last inactivity period before its horizon: created with a horizon
   * PERIOD + 10 days out, then checked in on day 11, the first (clamped) check-in, which moves
   * the deadline onto the horizon. From here on nothing can move it.
   */
  async function pinnedVault(f: F) {
    const { t0, horizon, id } = await vaultWithHorizon(f, 10 * DAY);
    await time.increaseTo(t0 + 11 * DAY);
    await f.vault.connect(f.alice).checkIn(id);
    const v = await f.vault.getVault(f.alice.address, id);
    expect(v.deadline, "setup: pinned").to.equal(horizon);
    return { t0, horizon, id };
  }

  /** The vault's own logs in a receipt, parsed, in order. */
  function vaultLogs(f: F, rc: any): any[] {
    return rc.logs
      .filter((l: any) => l.address.toLowerCase() === f.vaultAddr.toLowerCase())
      .map((l: any) => f.vault.interface.parseLog(l))
      .filter((p: any) => p);
  }

  // ------------------------------------------------------------------------------------ F02

  describe("F02 a check-in chain step is bound to its chain, contract, owner, vault and installation", () => {
    const HOUR = 3_600;
    /** Hashes forward with the step the contract under test checks, as anyone can. */
    const walk = (ctx: chain.ChainContext, x: string, n: number) => {
      for (let i = 0; i < n; i++) x = chain.step(IMPL, ctx, x);
      return x;
    };
    /** A hand-rolled chain on the repo's old convention: the tip IS the paper seed. The worst case. */
    const handLink = (ctx: chain.ChainContext, k: number) => walk(ctx, SEED, k);

    async function openVault(f: F, vault: any, owner: any, heir: string = f.bob.address, horizonSecs = HORIZON) {
      const horizon = (await time.latest()) + horizonSecs;
      await vault.connect(owner).createVault(NATIVE, DEPOSIT, heir, PERIOD, WINDOW, horizon, { value: DEPOSIT });
      return { id: Number(await vault.vaultCount(owner.address)) - 1, horizon };
    }

    /** Alice rehearses on another deployment: a 10-use chain, two check-ins, so values 9 and 8 are public. */
    async function rehearse(f: F) {
      const other = await deployVault({
        deployer: f.admin, admin: f.admin.address, feeBps: FEE_BPS, feeRecipient: f.feeSink.address,
      });
      const { id } = await openVault(f, other, f.alice);
      const ctx = await chainCtx(f, f.alice.address, id, undefined, other);
      await other.connect(f.alice)[SET3](id, handLink(ctx, 10), 10);
      for (const k of [9, 8]) {
        await time.increase(DAY);
        await other.connect(f.alice).checkInByChain(f.alice.address, id, handLink(ctx, k));
      }
      return { leaked: handLink(ctx, 8), depth: 8 };
    }

    it("a value revealed on another deployment cannot be walked forward into a check-in here", async () => {
      const f = await loadFixture(fixture);
      const { leaked, depth } = await rehearse(f);
      const N = 100;
      const { id } = await openVault(f, f.vault, f.alice);
      const ctx = await chainCtx(f, f.alice.address, id);
      await f.vault.connect(f.alice)[SET3](id, handLink(ctx, N), N);
      const d0 = (await f.vault.getVault(f.alice.address, id)).deadline;
      // Alice dies. Dave, holding no key and no seed, hashes the leaked value forward.
      await time.increaseTo(Number(d0) - HOUR);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, id, walk(ctx, leaked, N - 1 - depth))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
    });

    it("a value revealed on one of the owner's vaults is refused on her other vault", async () => {
      const f = await loadFixture(fixture);
      const v0 = await openVault(f, f.vault, f.alice);
      const v1 = await openVault(f, f.vault, f.alice, f.carol.address); // split estate
      const c0 = await chainCtx(f, f.alice.address, v0.id);
      const c1 = await chainCtx(f, f.alice.address, v1.id);
      await f.vault.connect(f.alice)[SET3](v0.id, handLink(c0, 5), 5);
      await f.vault.connect(f.alice)[SET3](v1.id, handLink(c1, 5), 5);
      await time.increase(DAY);
      await f.vault.connect(f.alice).checkInByChain(f.alice.address, v0.id, handLink(c0, 4));
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, v1.id, handLink(c0, 4))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
    });

    it("a value revealed on one owner's vault is refused on another owner's vault from the same seed", async () => {
      const f = await loadFixture(fixture);
      const va = await openVault(f, f.vault, f.alice);
      const vc = await openVault(f, f.vault, f.carol);
      const ca = await chainCtx(f, f.alice.address, va.id);
      const cc = await chainCtx(f, f.carol.address, vc.id);
      await f.vault.connect(f.alice)[SET3](va.id, handLink(ca, 5), 5);
      await f.vault.connect(f.carol)[SET3](vc.id, handLink(cc, 5), 5);
      await time.increase(DAY);
      await f.vault.connect(f.alice).checkInByChain(f.alice.address, va.id, handLink(ca, 4));
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.carol.address, vc.id, handLink(ca, 4))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
    });

    it("re-arming from the same seed does not make values spent under the earlier installation valid again", async () => {
      const f = await loadFixture(fixture);
      const { id } = await openVault(f, f.vault, f.alice);
      const e1 = await chainCtx(f, f.alice.address, id, 1);
      await f.vault.connect(f.alice)[SET3](id, handLink(e1, 3), 3);
      for (const k of [2, 1]) {
        await time.increase(DAY);
        await f.vault.connect(f.alice).checkInByChain(f.alice.address, id, handLink(e1, k));
      }
      const e2 = await chainCtx(f, f.alice.address, id, 2);
      await f.vault.connect(f.alice)[SET3](id, handLink(e2, 3), 3); // "refill the counter"
      await time.increase(DAY);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, id, handLink(e1, 2))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
    });

    it("damage bound: a stranger holding a leaked value cannot keep a dead owner's deadline moving", async () => {
      const f = await loadFixture(fixture);
      const { leaked, depth } = await rehearse(f);
      const N = 100;
      const { id, horizon } = await openVault(f, f.vault, f.alice);
      const ctx = await chainCtx(f, f.alice.address, id);
      await f.vault.connect(f.alice)[SET3](id, handLink(ctx, N), N);
      let forged = 0;
      for (let next = N - 1; next > depth; next--) {
        const d = (await f.vault.getVault(f.alice.address, id)).deadline;
        if (d >= BigInt(horizon)) break;
        await time.increaseTo(Number(d) - HOUR);
        if (!(await attempt(f.vault.connect(f.dave).checkInByChain(f.alice.address, id, walk(ctx, leaked, next - depth))))) {
          break;
        }
        forged += 1;
      }
      expect(forged, "forged check-ins accepted from a value leaked elsewhere").to.equal(0);
      await time.increase(HOUR + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address); // the heir is not delayed
    });

    it("the step is keccak256(abi.encode(HB_DOMAIN, chainid, vault, owner, vaultId, epoch, value)); the reference generator agrees", async () => {
      const f = await loadFixture(fixture);
      expect(await f.vault.HB_DOMAIN()).to.equal(ethers.id("WillAndKey.CheckInChain.v2"));
      expect(chain.HB_DOMAIN).to.equal(ethers.id("WillAndKey.CheckInChain.v2"));
      const x = ethers.hexlify(ethers.randomBytes(32));
      const base = await chainCtx(f, f.alice.address, 0, 1);
      // Written out by hand, independent of the generator.
      const byHand = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "uint256", "address", "address", "uint256", "uint32", "bytes32"],
          [ethers.id("WillAndKey.CheckInChain.v2"), base.chainId, f.vaultAddr, f.alice.address, 0, 1, x]
        )
      );
      const variants = [base, { ...base, owner: f.carol.address }, { ...base, vaultId: 1 }, { ...base, epoch: 2 }];
      const outs: string[] = [];
      for (const c of variants) {
        const onChain = await f.vault.hbStep(c.owner, c.vaultId, c.epoch, x);
        expect(onChain, "contract and generator agree").to.equal(chain.step("v2", c, x));
        outs.push(onChain);
      }
      expect(outs[0]).to.equal(byHand);
      expect(new Set(outs).size, "owner, vault id and epoch each change the step").to.equal(4);
    });

    // Review round 1: a guard, not a v1 regression. It checks the generator's v2 mode against
    // the v2 contract; on v1 it fails only because the epoch-checked setCheckInChain is absent.
    it("(guard) the reference generator's v2 chain runs end to end; the last check-in reveals the derived tip, never the seed", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const ctx = await chainCtx(f, f.alice.address, 0);
      const plan = chain.buildChain("v2", ctx, SEED, 3);
      await f.vault.connect(f.alice)[SET4](0, plan.anchor, 3, plan.epoch);
      // The generator's --rpc checks, against this contract.
      const st = await chain.readChainState(ethers.provider as any, "v2", f.vaultAddr, f.alice.address, 0);
      expect([st.hbAnchor, st.hbLeft, st.hbEpoch]).to.deep.equal([plan.anchor, 3, 1]);
      await chain.checkStepAgainstContract(ethers.provider, ctx, SEED);
      // Pass 4: the printed reveal order is the order the contract accepts, value by value.
      const sheet = chain.revealOrder("v2", ctx, SEED, 3);
      for (let left = 3; left >= 1; left--) {
        await time.increase(DAY);
        expect(sheet[3 - left], "reveal order agrees with nextValue").to.equal(chain.nextValue("v2", ctx, SEED, left));
        await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, sheet[3 - left]);
      }
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.hbAnchor).to.equal(chain.tip("v2", ctx, SEED));
      expect(v.hbAnchor).to.not.equal(SEED);
      expect(Number(v.warnings) & BIT3, "exhausted").to.equal(BIT3);
    });

    it("hbEpoch counts installations (a disarm too), and getVault and CheckInChainSet both report it", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      expect((await f.vault.getVault(f.alice.address, 0)).hbEpoch, "never installed").to.equal(0);
      const a = ethers.hexlify(ethers.randomBytes(32));
      await expect(f.vault.connect(f.alice)[SET3](0, a, 3))
        .to.emit(f.vault, "CheckInChainSet")
        .withArgs(f.alice.address, 0, a, 3, 1);
      await expect(f.vault.connect(f.alice)[SET3](0, a, 3))
        .to.emit(f.vault, "CheckInChainSet")
        .withArgs(f.alice.address, 0, a, 3, 2);
      await expect(f.vault.connect(f.alice)[SET3](0, ethers.ZeroHash, 0))
        .to.emit(f.vault, "CheckInChainSet")
        .withArgs(f.alice.address, 0, ethers.ZeroHash, 0, 3);
      expect((await f.vault.getVault(f.alice.address, 0)).hbEpoch).to.equal(3);
    });

    it("the epoch-checked setCheckInChain refuses a chain built for another installation, so a printed chain is never installed dead", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const ctx = await chainCtx(f, f.alice.address, 0); // epoch 1
      const paper = chain.buildChain("v2", ctx, SEED, 5);
      // Built against a stale epoch: refused, with both numbers.
      await expect(f.vault.connect(f.alice)[SET4](0, paper.anchor, 5, 2))
        .to.be.revertedWithCustomError(f.vault, "CheckInChainEpochMismatch")
        .withArgs(2, 1);
      await f.vault.connect(f.alice)[SET4](0, paper.anchor, 5, paper.epoch);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, chain.nextValue("v2", ctx, SEED, 5));
      // The same paper again later: the guarded form refuses it...
      await expect(f.vault.connect(f.alice)[SET4](0, paper.anchor, 5, paper.epoch))
        .to.be.revertedWithCustomError(f.vault, "CheckInChainEpochMismatch")
        .withArgs(1, 2);
      // ...which is the point: the unguarded form installs it, and it is dead from the start.
      await f.vault.connect(f.alice)[SET3](0, paper.anchor, 5);
      await time.increase(DAY);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, chain.nextValue("v2", ctx, SEED, 5))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
    });

    it("(control) with the reference generator, exhausting a chain never reveals the seed, so a re-armed chain from it is not forgeable (both modes)", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const e1 = await chainCtx(f, f.alice.address, 0, 1);
      await f.vault.connect(f.alice)[SET3](0, chain.buildChain(IMPL, e1, SEED, 3).anchor, 3);
      for (let left = 3; left >= 1; left--) {
        await time.increase(DAY);
        await f.vault.connect(f.alice).checkInByChain(f.alice.address, 0, chain.nextValue(IMPL, e1, SEED, left));
      }
      const lastReveal = (await f.vault.getVault(f.alice.address, 0)).hbAnchor;
      expect(lastReveal).to.not.equal(SEED);
      const e2 = await chainCtx(f, f.alice.address, 0, 2);
      await f.vault.connect(f.alice)[SET3](0, chain.buildChain(IMPL, e2, SEED, 500).anchor, 500);
      await time.increase(DAY);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, walk(e2, lastReveal, 499))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, chain.nextValue(IMPL, e2, SEED, 500));
    });

    it("(control) the generator's v1 mode builds chains the deployed v1 bytecode accepts, and its tip hides the seed", async () => {
      const f = await loadFixture(fixture);
      const v1 = await (await ethers.getContractFactory("InheritanceVaultV1", f.admin)).deploy(
        f.admin.address, FEE_BPS, f.feeSink.address
      );
      const v1Addr = await v1.getAddress();
      await (v1 as any)
        .connect(f.alice)
        .createVault(NATIVE, DEPOSIT, f.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, { value: DEPOSIT });
      const ctx = await chainCtx(f, f.alice.address, 0, 1, v1); // install index 1
      const plan = chain.buildChain("v1", ctx, SEED, 3);
      await (v1 as any).connect(f.alice).setCheckInChain(0, plan.anchor, 3);
      const sheet = chain.revealOrder("v1", ctx, SEED, 3); // pass 4: the printed order
      for (let left = 3; left >= 1; left--) {
        const st = await chain.readChainState(ethers.provider as any, "v1", v1Addr, f.alice.address, 0);
        expect(st.hbLeft).to.equal(left);
        expect(sheet[3 - left]).to.equal(chain.nextValue("v1", ctx, SEED, st.hbLeft));
        await time.increase(DAY);
        await (v1 as any).connect(f.dave).checkInByChain(f.alice.address, 0, sheet[3 - left]);
      }
      const end = await chain.readChainState(ethers.provider as any, "v1", v1Addr, f.alice.address, 0);
      expect(end.hbAnchor).to.equal(chain.tip("v1", ctx, SEED));
      expect(end.hbAnchor).to.not.equal(SEED);
    });

    it("(guard) the generator's getVault ABI matches the compiled VaultView", async () => {
      const compiled = (await vaultFactory()).interface.getFunction("getVault")!.outputs[0];
      const mine = new ethers.Interface([chain.GET_VAULT_V2]).getFunction("getVault")!.outputs[0];
      expect(mine.components!.map((c) => c.format("full"))).to.deep.equal(compiled.components!.map((c) => c.format("full")));
    });

    // ---- pass 4: the reference generator across vaults and chains

    /** A chain id other than this test chain's, e.g. Base, where the same deployer nonce gives the same address. */
    const OTHER_CHAIN = 8453n;

    it("a value revealed on another chain, at the same contract address, cannot be walked forward into a check-in here", async () => {
      const f = await loadFixture(fixture);
      const N = 100;
      const { id } = await openVault(f, f.vault, f.alice);
      const here = await chainCtx(f, f.alice.address, id);
      // The same contract address, owner, vault id and epoch on another chain: only block.chainid differs.
      const there = { ...here, chainId: OTHER_CHAIN };
      expect(BigInt(here.chainId)).to.not.equal(OTHER_CHAIN);
      // One hand-rolled paper seed on both chains; two check-ins on the other chain made values 99 and 98 public there.
      await f.vault.connect(f.alice)[SET3](id, handLink(here, N), N);
      const leaked = handLink(there, N - 2);
      const d0 = (await f.vault.getVault(f.alice.address, id)).deadline;
      await time.increaseTo(Number(d0) - HOUR);
      // Dave hashes the deepest public value forward one step, with this chain's own step.
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, id, walk(here, leaked, 1))
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
      expect((await f.vault.getVault(f.alice.address, id)).hbLeft, "nothing spent").to.equal(N);
    });

    // Review round 1: a guard, not a v1 regression. Its values are built in v2 mode, which v1
    // refuses everywhere, so on v1 every negative line passes and only the positive line fails,
    // for a reason (v1 cannot verify a v2 step) that says nothing about cross-vault or cross-chain
    // reuse. The F02 regressions above (hand-rolled chains walked with IMPL's own step) are the
    // tests that fail on v1 for F02's reason.
    it("(guard) the reference generator's v2 values work on their own vault only: refused on the owner's other vault and on this chain when built for another", async () => {
      const f = await loadFixture(fixture);
      const v0 = await openVault(f, f.vault, f.alice);
      const v1 = await openVault(f, f.vault, f.alice, f.carol.address);
      const c0 = await chainCtx(f, f.alice.address, v0.id);
      const c1 = await chainCtx(f, f.alice.address, v1.id);
      // Against the rules (a fresh seed per vault and chain), one seed everywhere: the binding must still hold.
      await f.vault.connect(f.alice)[SET3](v0.id, chain.buildChain("v2", c0, SEED, 3).anchor, 3);
      await f.vault.connect(f.alice)[SET3](v1.id, chain.buildChain("v2", c1, SEED, 3).anchor, 3);
      const sheet0 = chain.revealOrder("v2", c0, SEED, 3);
      const sheetOther = chain.revealOrder("v2", { ...c1, chainId: OTHER_CHAIN }, SEED, 3);
      await time.increase(DAY);
      for (const x of [...sheet0, ...sheetOther]) {
        await expect(
          f.vault.connect(f.dave).checkInByChain(f.alice.address, v1.id, x)
        ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
      }
      // Each value is accepted where it belongs.
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, v0.id, sheet0[0]);
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, v1.id, chain.revealOrder("v2", c1, SEED, 3)[0]);
      expect((await f.vault.getVault(f.alice.address, v1.id)).hbLeft).to.equal(2);
    });

    it("(control) the generator's v1 mode binds vault and chain off-chain, so even the deployed v1 bytecode refuses a value built for another vault or chain", async () => {
      const f = await loadFixture(fixture);
      const v1 = (await (await ethers.getContractFactory("InheritanceVaultV1", f.admin)).deploy(
        f.admin.address, FEE_BPS, f.feeSink.address
      )) as any;
      for (const heir of [f.bob.address, f.carol.address]) {
        await v1.connect(f.alice)
          .createVault(NATIVE, DEPOSIT, heir, PERIOD, WINDOW, (await time.latest()) + HORIZON, { value: DEPOSIT });
      }
      const c0 = await chainCtx(f, f.alice.address, 0, 1, v1);
      const c1 = await chainCtx(f, f.alice.address, 1, 1, v1);
      await v1.connect(f.alice).setCheckInChain(0, chain.buildChain("v1", c0, SEED, 3).anchor, 3);
      await v1.connect(f.alice).setCheckInChain(1, chain.buildChain("v1", c1, SEED, 3).anchor, 3);
      const sheet0 = chain.revealOrder("v1", c0, SEED, 3);
      const sheetOther = chain.revealOrder("v1", { ...c1, chainId: OTHER_CHAIN }, SEED, 3);
      await time.increase(DAY);
      await v1.connect(f.dave).checkInByChain(f.alice.address, 0, sheet0[0]); // vault 0's first value is now public
      for (const x of [...sheet0, ...sheetOther]) {
        await expect(v1.connect(f.dave).checkInByChain(f.alice.address, 1, x)).to.be.revertedWithCustomError(v1, "BadCheckIn");
      }
      await v1.connect(f.dave).checkInByChain(f.alice.address, 1, chain.revealOrder("v1", c1, SEED, 3)[0]);
    });

    it("(guard) the generator's tip is keccak256(abi.encode(\"WillAndKey/hb/v1\", chainid, vault, owner, vaultId, installIndex, seed)), and v2's uses \"WillAndKey/hb/v2\"", async () => {
      const f = await loadFixture(fixture);
      const ctx = await chainCtx(f, f.alice.address, 3, 2);
      const byHand = (tag: string) =>
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "uint256", "address", "address", "uint256", "uint32", "bytes32"],
            [tag, ctx.chainId, f.vaultAddr, f.alice.address, 3, 2, SEED]
          )
        );
      expect(chain.tip("v1", ctx, SEED)).to.equal(byHand("WillAndKey/hb/v1"));
      expect(chain.tip("v2", ctx, SEED)).to.equal(byHand("WillAndKey/hb/v2"));
      // v1 chains with plain keccak256 over the raw 32 bytes, which is all v1 checks.
      const x = chain.tip("v1", ctx, SEED);
      expect(chain.step("v1", ctx, x)).to.equal(ethers.keccak256(x));
      expect(chain.link("v1", ctx, SEED, 2)).to.equal(ethers.keccak256(ethers.keccak256(x)));
      // Every element of the context changes the tip, in both modes.
      for (const mode of ["v1", "v2"] as chain.Mode[]) {
        const tips = [ctx, { ...ctx, chainId: OTHER_CHAIN }, { ...ctx, vault: f.fwd.target as string },
          { ...ctx, owner: f.carol.address }, { ...ctx, vaultId: 4 }, { ...ctx, epoch: 3 }].map((c) => chain.tip(mode, c, SEED));
        expect(new Set(tips).size, `${mode}: six contexts, six tips`).to.equal(6);
      }
    });

    it("(guard) the CLI prints the anchor, the count and every value in the order it must be revealed", async () => {
      const f = await loadFixture(fixture);
      const run = async (mode: chain.Mode, extra: string[] = []) => {
        const out: string[] = [];
        await chain.cli(
          ["anchor", "--mode", mode, "--vault", f.vaultAddr, "--owner", f.alice.address, "--vault-id", "5",
            "--chain-id", "8453", "--epoch", "2", "--count", "4", "--seed", SEED, ...extra],
          (l) => out.push(l),
          {}
        );
        return out;
      };
      for (const mode of ["v1", "v2"] as chain.Mode[]) {
        const ctx = { chainId: 8453n, vault: f.vaultAddr, owner: f.alice.address, vaultId: 5, epoch: 2 };
        const plan = chain.buildChain(mode, ctx, SEED, 4);
        const out = await run(mode);
        expect(out, mode).to.include(`anchor ${plan.anchor}`);
        expect(out, mode).to.include("count 4");
        expect(out, mode).to.include(
          mode === "v2" ? `call setCheckInChain(5, ${plan.anchor}, 4, 2)` : `call setCheckInChain(5, ${plan.anchor}, 4)`
        );
        const rows = out.filter((l) => /^\s+\d+\s+hbLeft\s+\d+\s+0x[0-9a-f]{64}$/.test(l)).map((l) => l.trim().split(/\s+/));
        expect(rows.map((r) => [Number(r[0]), Number(r[2])]), `${mode}: numbered 1..4 while hbLeft is 4..1`).to.deep.equal([
          [1, 4], [2, 3], [3, 2], [4, 1],
        ]);
        expect(rows.map((r) => r[3])).to.deep.equal(chain.revealOrder(mode, ctx, SEED, 4));
        // Each printed value hashes to the one before it, ending at the anchor.
        expect(chain.step(mode, ctx, rows[0][3])).to.equal(plan.anchor);
        for (let i = 1; i < 4; i++) expect(chain.step(mode, ctx, rows[i][3])).to.equal(rows[i - 1][3]);
        expect(rows[3][3], `${mode}: the last value is the derived tip, not the seed`).to.equal(chain.tip(mode, ctx, SEED));
        expect((await run(mode, ["--no-values"])).some((l) => l.includes(rows[0][3]))).to.equal(false);
      }
    });

    // ---- review round 3: the generator's `next` command and its --rpc refusals, against this node

    const OTHER_SEED = ethers.keccak256(ethers.toUtf8Bytes("another paper seed (test only)"));

    /** The CLI with --rpc answered by this test node, as a real node would answer it. */
    async function cliHere(args: string[], seed = SEED): Promise<string[]> {
      const out: string[] = [];
      await chain.cli(args, (l) => out.push(l), { CHECKIN_SEED: seed }, () => ethers.provider as any);
      return out;
    }
    const onChain = (f: F, cmd: "anchor" | "next", id: number, ...extra: string[]) =>
      [cmd, "--mode", "v2", "--rpc", "hardhat", "--vault", f.vaultAddr, "--owner", f.alice.address, "--vault-id", String(id), ...extra];
    /** The arguments of the `call fn(...)` line the CLI printed. */
    function printedCall(out: string[], fn: string): string[] {
      const line = out.find((l) => l.startsWith(`call ${fn}(`));
      expect(line, `the CLI printed a ${fn} call`).to.not.equal(undefined);
      return line!.slice(`call ${fn}(`.length, -1).split(", ");
    }
    /** Installs a chain exactly as the CLI's `anchor --rpc` prints it. */
    async function installPrinted(f: F, id: number, count: number, seed = SEED) {
      const [vid, anchor, n, epoch] = printedCall(await cliHere(onChain(f, "anchor", id, "--count", String(count)), seed), "setCheckInChain");
      await f.vault.connect(f.alice)[SET4](vid, anchor, n, epoch);
    }
    async function rejects(p: Promise<unknown>, message: RegExp) {
      let err: unknown;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      expect(err, `refused with ${message}`).to.be.instanceOf(Error);
      expect((err as Error).message).to.match(message);
    }

    it("(guard) the generator's `next` prints the value checkInByChain accepts: with --rpc, and offline with --left", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await installPrinted(f, 0, 3);
      await time.increase(DAY);
      const out = await cliHere(onChain(f, "next", 0));
      expect(out.some((l) => l.includes("pinned")), "no pinned warning on a healthy vault").to.equal(false);
      const [owner, id, value] = printedCall(out, "checkInByChain");
      await f.vault.connect(f.dave).checkInByChain(owner, id, value);
      expect((await f.vault.getVault(f.alice.address, 0)).hbLeft).to.equal(2);
      // Offline, from the paper: chain id, epoch and the hbLeft getVault shows.
      const chainId = String((await ethers.provider.getNetwork()).chainId);
      const offline = await cliHere([
        "next", "--mode", "v2", "--vault", f.vaultAddr, "--owner", f.alice.address, "--vault-id", "0",
        "--chain-id", chainId, "--epoch", "1", "--left", "2",
      ]);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(...printedCall(offline, "checkInByChain"));
      expect((await f.vault.getVault(f.alice.address, 0)).hbLeft).to.equal(1);
    });

    it("(guard) the generator refuses an --epoch that disagrees with the vault: hbEpoch + 1 for `anchor`, hbEpoch for `next`", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await rejects(cliHere(onChain(f, "anchor", 0, "--count", "3", "--epoch", "2")), /--epoch 2 disagrees with the vault, which needs 1/);
      await installPrinted(f, 0, 3);
      await rejects(cliHere(onChain(f, "next", 0, "--epoch", "2")), /--epoch 2 disagrees with the vault, which needs 1/);
      await rejects(cliHere(onChain(f, "anchor", 0, "--count", "3", "--epoch", "1")), /--epoch 1 disagrees with the vault, which needs 2/);
    });

    it("(guard) `next --rpc` says \"do not submit\" when the seed does not lead to the installed anchor: a wrong seed, or a chain the owner has since replaced", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await installPrinted(f, 0, 3);
      await rejects(cliHere(onChain(f, "next", 0), OTHER_SEED), /do not lead to the anchor installed on chain; do not submit/);
      await installPrinted(f, 0, 3, OTHER_SEED); // the owner re-arms from another seed (epoch 2)
      await rejects(cliHere(onChain(f, "next", 0)), /do not lead to the anchor installed on chain; do not submit/);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(...printedCall(await cliHere(onChain(f, "next", 0), OTHER_SEED), "checkInByChain"));
    });

    it("(guard) `next` refuses a vault with no chain armed (never installed, or disarmed) and a used-up chain; both commands refuse a zero seed and epoch 0", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await rejects(cliHere(onChain(f, "next", 0)), /no chain is armed on this vault/);
      await installPrinted(f, 0, 1);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(...printedCall(await cliHere(onChain(f, "next", 0)), "checkInByChain"));
      await rejects(cliHere(onChain(f, "next", 0)), /the chain is exhausted \(hbLeft is 0\)/);
      await rejects(
        cliHere(["next", "--mode", "v2", "--vault", f.vaultAddr, "--owner", f.alice.address, "--vault-id", "0",
          "--chain-id", "8453", "--epoch", "1", "--left", "0"]),
        /the chain is exhausted/
      );
      await f.vault.connect(f.alice)[SET3](0, ethers.ZeroHash, 0); // disarm
      await rejects(cliHere(onChain(f, "next", 0)), /no chain is armed on this vault/);
      const offline = ["--mode", "v2", "--vault", f.vaultAddr, "--owner", f.alice.address, "--vault-id", "0", "--chain-id", "8453"];
      await rejects(cliHere(["anchor", ...offline, "--epoch", "1", "--count", "3"], ethers.ZeroHash), /the seed must not be zero/);
      await rejects(cliHere(["next", ...offline, "--epoch", "1", "--left", "1"], ethers.ZeroHash), /the seed must not be zero/);
      await rejects(cliHere(["anchor", ...offline, "--epoch", "0", "--count", "3"]), /epoch must be an integer from 1/);
    });

    it("(guard) `next --rpc` warns once the deadline is pinned at the horizon, and not in the last period before, where a check-in still moves it", async () => {
      const f = await loadFixture(fixture);
      const { t0, horizon, id } = await vaultWithHorizon(f, PERIOD / 2);
      await installPrinted(f, id, 3);
      await time.setNextBlockTimestamp(t0 + PERIOD - DAY); // within one period of the horizon
      await mine();
      const before = await cliHere(onChain(f, "next", id));
      expect(before.some((l) => l.includes("pinned")), "no warning while a check-in can still move the deadline").to.equal(false);
      await f.vault.connect(f.dave).checkInByChain(...printedCall(before, "checkInByChain"));
      expect((await f.vault.getVault(f.alice.address, id)).deadline).to.equal(horizon);
      const after = await cliHere(onChain(f, "next", id));
      expect(after).to.include("warning: the deadline is pinned at the horizon; checkInByChain reverts until the owner extends it");
    });
  });

  // ------------------------------------------------------------------------------------ F28

  describe("F28 setCheckInChain(id, 0, 0) disarms the chain; a zero value can never hide one", () => {
    it("the owner disarms an exposed chain: its next value is refused and getVault shows no chain armed", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const armed = await armChain(f, f.alice, 0, 2);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, armed.value(2)); // the seed leaks
      await expect(f.vault.connect(f.alice)[SET3](0, ethers.ZeroHash, 0))
        .to.emit(f.vault, "CheckInChainSet")
        .withArgs(f.alice.address, 0, ethers.ZeroHash, 0, 2);
      const v = await f.vault.getVault(f.alice.address, 0);
      expect([v.hbAnchor, v.hbLeft]).to.deep.equal([ethers.ZeroHash, 0n]);
      expect(Number(v.warnings) & BIT3, "a disarmed chain is not an exhausted one").to.equal(0);
      await time.increase(DAY);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, armed.value(1))
      ).to.be.revertedWithCustomError(f.vault, "InvalidCheckInChain");
    });

    it("a disarm is an owner action: before the horizon it resets the clock and ends a pending claim; past it, it reverts and is no veto", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT); // vault 0, far horizon
      const near = await vaultWithHorizon(f, DAY); // vault 1, horizon a day after its first deadline
      await armChain(f, f.alice, 0, 2);
      await armChain(f, f.alice, 1, 2);
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      const tx = await f.vault.connect(f.alice)[SET3](0, ethers.ZeroHash, 0);
      await expect(tx).to.emit(f.vault, "ClaimSuperseded").withArgs(f.alice.address, 0, ACT_SET_CHECKIN_CHAIN);
      const v0 = await f.vault.getVault(f.alice.address, 0);
      expect(v0.state).to.equal(STATE_ACTIVE);
      expect(v0.deadline).to.equal((await blockTimeOf(tx)) + PERIOD);
      // Past vault 1's horizon: A-02 / B-01. The disarm cannot displace the heir's claim.
      await time.increaseTo(near.horizon + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, near.id, f.bob.address);
      await expect(f.vault.connect(f.alice)[SET3](near.id, ethers.ZeroHash, 0))
        .to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await expect(f.vault.connect(f.alice)[SET4](near.id, ethers.ZeroHash, 0, 2)) // the right next epoch
        .to.be.revertedWithCustomError(f.vault, "HorizonReached");
      expect((await f.vault.getVault(f.alice.address, near.id)).state).to.equal(STATE_CLAIM_PENDING);
      await time.increase(WINDOW + 1);
      await f.vault.finalizeClaim(f.alice.address, near.id);
    });

    it("a zero value is refused as a check-in, so hbAnchor == 0 always means no chain is armed", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      // A hand-rolled chain whose tip is zero (an unset seed): exact count 2.
      const ctx = await chainCtx(f, f.alice.address, 0);
      const x1 = chain.step(IMPL, ctx, ethers.ZeroHash);
      await f.vault.connect(f.alice)[SET3](0, chain.step(IMPL, ctx, x1), 2);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, x1);
      await time.increase(DAY);
      await expect(
        f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(f.vault, "BadCheckIn");
      const v = await f.vault.getVault(f.alice.address, 0);
      expect(v.hbAnchor, "the vault still reports a chain armed").to.equal(x1);
    });

    it("(control) arming still needs both an anchor and a count; only the pair (0, 0) disarms", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const a = ethers.hexlify(ethers.randomBytes(32));
      for (const [anchor, count] of [[ethers.ZeroHash, 5], [a, 0], [a, 100_001]] as [string, number][]) {
        await expect(f.vault.connect(f.alice)[SET3](0, anchor, count))
          .to.be.revertedWithCustomError(f.vault, "InvalidCheckInChain");
      }
    });
  });

  // ------------------------------------------------------------------------------------ F18

  describe("F18 a check-in that cannot move the deadline reverts, and never spends a chain value", () => {
    it("checkIn reverts DeadlinePinnedAtHorizon once the deadline sits at the horizon", async () => {
      const f = await loadFixture(fixture);
      const { horizon, id } = await pinnedVault(f);
      await time.increase(DAY);
      await expect(f.vault.connect(f.alice).checkIn(id))
        .to.be.revertedWithCustomError(f.vault, "DeadlinePinnedAtHorizon")
        .withArgs(horizon);
    });

    it("(control) the first clamped check-in, which moves the deadline part of the way to the horizon, still succeeds", async () => {
      const f = await loadFixture(fixture);
      const { t0, horizon, id } = await vaultWithHorizon(f, 10 * DAY);
      await time.increaseTo(t0 + 11 * DAY);
      const before = (await f.vault.getVault(f.alice.address, id)).deadline;
      await expect(f.vault.connect(f.alice).checkIn(id))
        .to.emit(f.vault, "CheckedIn")
        .withArgs(f.alice.address, id, horizon, false);
      expect(before).to.be.lessThan(horizon);
    });

    // ---- review round 3: "check-ins stop one period before the horizon" was wrong

    it("(control) the first CHAIN check-in within one inactivity period of the horizon still moves the deadline, to the horizon, and spends a value", async () => {
      // A relayer that believed the old text would stop one period early and leave the deadline
      // up to almost a period short of the horizon.
      const f = await loadFixture(fixture);
      const { t0, horizon, id } = await vaultWithHorizon(f, PERIOD / 2);
      const armed = await armChain(f, f.alice, id, 3);
      const before = (await f.vault.getVault(f.alice.address, id)).deadline;
      const inLastPeriod = t0 + PERIOD - DAY; // before the deadline, and after horizon - PERIOD
      expect(inLastPeriod).to.be.greaterThan(horizon - PERIOD);
      await time.setNextBlockTimestamp(inLastPeriod);
      await expect(f.vault.connect(f.carol).checkInByChain(f.alice.address, id, armed.value(3)))
        .to.emit(f.vault, "CheckedIn")
        .withArgs(f.alice.address, id, horizon, true);
      const v = await f.vault.getVault(f.alice.address, id);
      expect(v.deadline - before, "the liveness it bought").to.be.greaterThan(BigInt(14 * DAY));
      expect(v.hbLeft, "a value was spent").to.equal(2);
      if (VAULT_IMPL === "v2") {
        // Only from here on is the vault pinned, and only now does the next value revert unspent.
        expect(Number(v.warnings) & BIT4).to.equal(BIT4);
        await time.increase(DAY);
        await expect(f.vault.connect(f.carol).checkInByChain(f.alice.address, id, armed.value(2)))
          .to.be.revertedWithCustomError(f.vault, "DeadlinePinnedAtHorizon")
          .withArgs(horizon);
      }
    });

    it("(guard) checkInByChain's NatSpec, the T3 header and the chain doc say the first check-in within one period of the horizon still moves the deadline", async () => {
      const src = prose(...VAULT_SOL);
      expect(src).to.not.include("in the last inactivity period before the horizon (DeadlinePinnedAtHorizon)");
      expect(src).to.not.include("(the last inactivity period before it)");
      expect(src).to.include(
        "The first check-in within one inactivity period of the horizon still moves the deadline, to the horizon " +
          "itself, and spends a value: keep a relayer running until warnings bit 4 (pinned) is set"
      );
      expect(src).to.include("(which the first check-in within one inactivity period of it brings about)");
      const doc = prose("docs", "CHECKIN-CHAIN.md");
      expect(doc).to.not.include("in v2 one period earlier");
      expect(doc).to.include(
        "The first check-in within one inactivity period of the horizon still counts: it moves the deadline to the horizon itself"
      );
    });

    it("a vault created with its horizon exactly one period out is pinned from creation", async () => {
      const f = await loadFixture(fixture);
      const { horizon, id } = await vaultWithHorizon(f, 0);
      await time.increase(DAY);
      await expect(f.vault.connect(f.alice).checkIn(id))
        .to.be.revertedWithCustomError(f.vault, "DeadlinePinnedAtHorizon")
        .withArgs(horizon);
    });

    it("checkInByChain reverts in the pinned period without spending the value, which still works after extendHorizon", async () => {
      const f = await loadFixture(fixture);
      const { t0, id } = await vaultWithHorizon(f, 10 * DAY);
      await time.increaseTo(t0 + 11 * DAY);
      const armed = await armChain(f, f.alice, id, 3); // arming resets the clock: pinned now
      await time.increase(DAY);
      await expect(f.vault.connect(f.carol).checkInByChain(f.alice.address, id, armed.value(3)))
        .to.be.revertedWithCustomError(f.vault, "DeadlinePinnedAtHorizon");
      const v = await f.vault.getVault(f.alice.address, id);
      expect([v.hbAnchor, v.hbLeft]).to.deep.equal([armed.anchor, 3n]);
      await f.vault.connect(f.alice).extendHorizon(id, (await time.latest()) + 400 * DAY);
      await time.increase(DAY);
      await f.vault.connect(f.carol).checkInByChain(f.alice.address, id, armed.value(3));
      expect((await f.vault.getVault(f.alice.address, id)).hbLeft).to.equal(2);
    });

    it("a second chain check-in in the same second reverts and keeps its value unspent", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const armed = await armChain(f, f.alice, 0, 3);
      await time.increase(10 * DAY);
      const [first, second] = await oneBlock(async () => [
        await f.vault.connect(f.carol).checkInByChain(f.alice.address, 0, armed.value(3), FRONT),
        await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, armed.value(2), BACK),
      ]);
      expect([await statusOf(first), await statusOf(second)]).to.deep.equal([1, 0]);
      expect((await f.vault.getVault(f.alice.address, 0)).hbLeft, "one value spent, one extension").to.equal(2);
      await time.increase(DAY);
      await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, armed.value(2));
    });

    it("warnings bit 4 flags the pinned state, and only it", async () => {
      const f = await loadFixture(fixture);
      const { t0, horizon, id } = await vaultWithHorizon(f, 10 * DAY);
      expect(Number(await f.vault.warningsOf(f.alice.address, id)) & BIT4, "not yet pinned").to.equal(0);
      await time.increaseTo(t0 + 11 * DAY);
      await f.vault.connect(f.alice).checkIn(id);
      expect(Number(await f.vault.warningsOf(f.alice.address, id)) & BIT4, "pinned").to.equal(BIT4);
      expect(Number((await f.vault.getVault(f.alice.address, id)).warnings) & BIT4).to.equal(BIT4);
      await time.increaseTo(horizon);
      await mine();
      const w = Number(await f.vault.warningsOf(f.alice.address, id));
      expect([w & BIT4, w & 2], "past the horizon bit 1 says it, not bit 4").to.deep.equal([0, 2]);
    });

    it("checkInMany does not count a pinned vault, and a batch of only pinned vaults reverts NothingCheckedIn", async () => {
      const f = await loadFixture(fixture);
      const { id: pinned } = await pinnedVault(f);
      await create(f, f.alice, NATIVE, DEPOSIT); // healthy
      await time.increase(DAY);
      expect(await f.vault.connect(f.alice).checkInMany.staticCall([pinned, pinned + 1])).to.equal(1);
      await expect(f.vault.connect(f.alice).checkInMany([pinned, pinned + 1]))
        .to.emit(f.vault, "CheckInSkipped")
        .withArgs(f.alice.address, pinned, SKIP_PINNED);
      await expect(f.vault.connect(f.alice).checkInMany([pinned]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(1 << SKIP_PINNED);
    });

    it("(control) past the horizon the check-in paths still revert and a pending claim is untouched (A-02/B-01)", async () => {
      const f = await loadFixture(fixture);
      const { horizon, id } = await pinnedVault(f);
      await time.increaseTo(horizon + 1);
      await expect(f.vault.connect(f.alice).checkIn(id)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address);
      // Review round 3: v2 no longer names the veto here, since abortClaim reverts past the
      // horizon too (see F15, "a pending claim past the horizon has its own reason").
      await expect(f.vault.connect(f.alice).checkIn(id)).to.be.revertedWithCustomError(
        f.vault,
        VAULT_IMPL === "v1" ? "ClaimPendingUseAbort" : "HorizonReached"
      );
      await expect(f.vault.connect(f.alice).checkInMany([id])).to.be.revertedWithCustomError(f.vault, "NothingCheckedIn");
      await expect(f.vault.connect(f.alice).abortClaim(id)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      expect((await f.vault.getVault(f.alice.address, id)).state).to.equal(STATE_CLAIM_PENDING);
      // Only a genuinely future horizon stops it, at the cost of a full period.
      await f.vault.connect(f.alice).extendHorizon(id, (await time.latest()) + 400 * DAY);
      await expect(
        f.vault.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address)
      ).to.be.revertedWithCustomError(f.vault, "NotYetExpired");
    });
  });

  // ------------------------------------------------------------------------------------ F15

  describe("F15 checkInMany logs every skip with its reason, and counts only deadlines it moved", () => {
    it("every id a keeper sends is accounted for in the receipt: CheckedIn, or CheckInSkipped with the reason", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, ONE, f.carol.address); // 0: healthy
      await create(f, f.alice, NATIVE, ONE); // 1: bob claims it
      const short = (await time.latest()) + PERIOD + DAY;
      await f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, short, { value: ONE }); // 2
      await create(f, f.alice, NATIVE, ONE); // 3: closed
      await f.vault.connect(f.alice).withdraw(3, ONE, f.alice.address);
      await time.increase(PERIOD + 2 * DAY); // 2 is past its horizon
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await vaultWithHorizon(f, 0); // 4: pinned from creation
      const rc = await (await f.vault.connect(f.alice).checkInMany([0, 1, 2, 3, 4, 9, 0])).wait();
      const seen = vaultLogs(f, rc)
        .filter((p) => p.name === "CheckedIn" || p.name === "CheckInSkipped")
        .map((p) => (p.name === "CheckedIn" ? `${p.args.vaultId}:in` : `${p.args.vaultId}:skip${p.args.reason}`));
      expect(seen).to.deep.equal([
        "0:in",
        `1:skip${SKIP_CLAIM_PENDING}`,
        `2:skip${SKIP_HORIZON_REACHED}`,
        `3:skip${SKIP_TERMINAL}`,
        `4:skip${SKIP_PINNED}`,
        `9:skip${SKIP_UNKNOWN_ID}`,
        `0:skip${SKIP_REPEATED}`,
      ]);
      const names = ["SKIP_UNKNOWN_ID", "SKIP_TERMINAL", "SKIP_CLAIM_PENDING", "SKIP_HORIZON_REACHED", "SKIP_PINNED", "SKIP_REPEATED"];
      const values: number[] = [];
      for (const n of names) values.push(Number(await f.vault[n]()));
      expect(values).to.deep.equal([1, 2, 3, 4, 5, 6]);
    });

    it("a keeper's receipts name the claim-pending vault on every run of the challenge window", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT, f.carol.address);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1); // the keeper missed a run
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      for (let run = 0; run < 3; run++) {
        await time.increase(2 * DAY);
        await expect(f.vault.connect(f.alice).checkInMany([0, 1]))
          .to.emit(f.vault, "CheckInSkipped")
          .withArgs(f.alice.address, 1, SKIP_CLAIM_PENDING);
      }
    });

    it("refreshed counts distinct vaults: repeated ids do not inflate it", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, ONE);
      await create(f, f.alice, NATIVE, ONE);
      await time.increase(DAY);
      expect(await f.vault.connect(f.alice).checkInMany.staticCall([0, 0, 1, 1, 0])).to.equal(2);
      const rc = await (await f.vault.connect(f.alice).checkInMany([0, 0, 1, 1, 0])).wait();
      expect(vaultLogs(f, rc).filter((p) => p.name === "CheckedIn").length).to.equal(2);
    });

    it("a batch whose only vault already moved at this second reverts NothingCheckedIn instead of counting it", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, ONE);
      await time.increase(DAY);
      const [single, batch] = await oneBlock(async () => [
        await f.vault.connect(f.alice).checkIn(0, FRONT),
        await f.vault.connect(f.alice).checkInMany([0], BACK),
      ]);
      expect([await statusOf(single), await statusOf(batch)]).to.deep.equal([1, 0]);
    });

    it("(control) a batch that can move nothing still reverts NothingCheckedIn", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, ONE);
      await expect(f.vault.connect(f.alice).checkInMany([7])).to.be.revertedWithCustomError(f.vault, "NothingCheckedIn");
    });

    it("when nothing moves, the revert still says why: a one-vault keeper can tell a pending claim from an unknown id", async () => {
      // Review round 1. The all-skipped batch reverts, so its CheckInSkipped logs roll back; the
      // reasons must survive in the error, or "a claim is running" and "my id list outran the
      // owner's vaults" are the same bare NothingCheckedIn().
      const f = await loadFixture(fixture);
      const bit = (reason: number) => 1 << reason;
      await create(f, f.alice, NATIVE, DEPOSIT); // Alice's only vault
      await create(f, f.carol, NATIVE, DEPOSIT); // Carol's only vault, healthy
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await expect(f.vault.connect(f.alice).checkInMany([0]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(bit(SKIP_CLAIM_PENDING));
      await expect(f.vault.connect(f.carol).checkInMany([7]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(bit(SKIP_UNKNOWN_ID));
      // Every reason seen is reported, whatever the order.
      await expect(f.vault.connect(f.alice).checkInMany([9, 0, 9]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(bit(SKIP_CLAIM_PENDING) | bit(SKIP_UNKNOWN_ID));
      // (control) a batch that moves something does not revert, and logs each skip as before.
      await expect(f.vault.connect(f.carol).checkInMany([0, 7]))
        .to.emit(f.vault, "CheckInSkipped")
        .withArgs(f.carol.address, 7, SKIP_UNKNOWN_ID);
    });

    it("a pending claim past the horizon has its own reason, naming the remedy that works there: SKIP_CLAIM_PENDING_PAST_HORIZON, NothingCheckedIn(128), and checkIn's HorizonReached", async () => {
      // Review round 3. SKIP_CLAIM_PENDING names abortClaim, which reverts HorizonReached past the
      // horizon: a keeper that mapped the reason to its remedy sent a veto that could not work
      // while a challenge window of as little as 7 days ran out.
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, ONE, f.carol.address); // 0: healthy
      const late = (await time.latest()) + PERIOD + DAY;
      await f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, late, { value: ONE }); // 1
      await create(f, f.alice, NATIVE, ONE); // 2: its horizon is far off
      await f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, late, { value: ONE }); // 3
      await f.vault.connect(f.alice).withdraw(3, ONE, f.alice.address); // closed before its horizon (exact balance: v1 has no sentinel)
      await time.increase(PERIOD + 2 * DAY); // vaults 1 and 3 are past their horizon
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 1, f.bob.address);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 2, f.bob.address);

      const rc = await (await f.vault.connect(f.alice).checkInMany([0, 1, 2])).wait();
      const seen = vaultLogs(f, rc)
        .filter((p) => p.name === "CheckedIn" || p.name === "CheckInSkipped")
        .map((p) => (p.name === "CheckedIn" ? `${p.args.vaultId}:in` : `${p.args.vaultId}:skip${p.args.reason}`));
      expect(seen).to.deep.equal(["0:in", `1:skip${SKIP_CLAIM_PENDING_PAST_HORIZON}`, `2:skip${SKIP_CLAIM_PENDING}`]);
      expect(await f.vault.SKIP_CLAIM_PENDING_PAST_HORIZON()).to.equal(SKIP_CLAIM_PENDING_PAST_HORIZON);
      // A one-vault keeper reads it from the revert: bit 7 past the horizon, bit 3 before it.
      await expect(f.vault.connect(f.alice).checkInMany([1]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(1 << SKIP_CLAIM_PENDING_PAST_HORIZON);
      await expect(f.vault.connect(f.alice).checkInMany([2]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(1 << SKIP_CLAIM_PENDING);
      // checkIn no longer points at the veto past the horizon.
      await expect(f.vault.connect(f.alice).checkIn(1)).to.be.revertedWithCustomError(f.vault, "HorizonReached").withArgs(late);
      await expect(f.vault.connect(f.alice).checkIn(2)).to.be.revertedWithCustomError(f.vault, "ClaimPendingUseAbort").withArgs(2);
      // Each reason's remedy works where it is given.
      await expect(f.vault.connect(f.alice).abortClaim(1)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await expect(f.vault.connect(f.alice).extendHorizon(1, (await time.latest()) + 2 * PERIOD))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 1, ACT_EXTEND_HORIZON);
      await f.vault.connect(f.alice).abortClaim(2);
      for (const id of [1, 2]) expect((await f.vault.getVault(f.alice.address, id)).state).to.equal(STATE_ACTIVE);
      // (control) the reordered checkIn still refuses a terminal vault first. Review round 4: on
      // a vault that is past its own horizon, where the horizon test could fire first and name a
      // remedy (extendHorizon) that cannot help a closed vault. Vault 3 was closed before it.
      expect(await time.latest(), "vault 3 is past its horizon").to.be.greaterThanOrEqual(late);
      await expect(f.vault.connect(f.alice).checkIn(3))
        .to.be.revertedWithCustomError(f.vault, "VaultNotActive")
        .withArgs(3, STATE_CLOSED);
      // And the NatSpec says which reason means which remedy.
      const src = prose(...VAULT_SOL);
      expect(src).to.include("A claim is pending and the horizon is still ahead. A check-in never ends one: abortClaim (the veto) does.");
      // Pre-launch finalization: "has been reached", not "has passed". The reason is given AT the
      // horizon second itself (the next test), as HorizonReached is.
      expect(src).to.include(
        "A claim is pending and the horizon has been reached. abortClaim reverts HorizonReached there; only " +
          "extendHorizon to at least now + inactivityPeriod, or withdrawing everything (withdraw(id, " +
          "type(uint256).max, to)), ends the claim"
      );
      expect(src).to.include("The horizon has been reached. Only extendHorizon reopens check-ins.");
      expect(src).to.not.include("the horizon has passed. abortClaim");
    });

    it("AT the horizon second itself the horizon has been reached everywhere: reason 7 and HorizonReached, never the veto; a second earlier, reason 3 and the veto", async () => {
      // Review round 4. Every earlier test ran well past the horizon, so `<` and `>=` could each
      // be flipped unnoticed. At that one second the contract would then name the veto (reason 3,
      // ClaimPendingUseAbort) where abortClaim already reverts, or let a check-in, a veto or a
      // soft owner action through at T3's hard date. Each assertion runs in its own block,
      // stamped exactly, and is rolled back.
      const f = await loadFixture(fixture);
      const atSecond = async (at: number, check: () => Promise<void>) => {
        const snap = await network.provider.send("evm_snapshot", []);
        try {
          await time.setNextBlockTimestamp(at);
          await check();
        } finally {
          await network.provider.send("evm_revert", [snap]);
        }
      };
      const t0 = (await time.latest()) + 1;
      await time.setNextBlockTimestamp(t0);
      const H = t0 + PERIOD + DAY;
      const open = () => f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, H, { value: ONE });
      await open(); // 0: bob's claim is pending at H
      await open(); // 1: ACTIVE at H, its deadline short of H, a chain armed
      await open(); // 2: closed before H
      await open(); // 3: pinned (its deadline at H) from day 2
      const c = await armChain(f, f.alice, 1, 3);
      await f.vault.connect(f.alice).withdraw(2, ONE, f.alice.address); // closes it (exact balance: v1 has no sentinel)
      await time.increaseTo(t0 + 2 * DAY);
      await f.vault.connect(f.alice).checkIn(3);
      expect((await f.vault.getVault(f.alice.address, 3)).deadline, "vault 3 pinned").to.equal(H);
      await time.increaseTo(t0 + PERIOD + 10);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      expect((await f.vault.getVault(f.alice.address, 1)).deadline).to.be.lessThan(H);

      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).checkInMany([0]))
          .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
          .withArgs(1 << SKIP_CLAIM_PENDING_PAST_HORIZON);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached").withArgs(H);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).abortClaim(0)).to.be.revertedWithCustomError(f.vault, "HorizonReached").withArgs(H);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).setBeneficiary(0, f.carol.address))
          .to.be.revertedWithCustomError(f.vault, "HorizonReached")
          .withArgs(H);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).checkIn(1)).to.be.revertedWithCustomError(f.vault, "HorizonReached").withArgs(H);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).checkInMany([1]))
          .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
          .withArgs(1 << SKIP_HORIZON_REACHED);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.dave).checkInByChain(f.alice.address, 1, c.value(3)))
          .to.be.revertedWithCustomError(f.vault, "HorizonReached")
          .withArgs(H);
      });
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice).checkIn(2)).to.be.revertedWithCustomError(f.vault, "VaultNotActive").withArgs(2, STATE_CLOSED);
      });
      // The other horizon comparisons, which the same one-second flips left untested (the
      // fixer's SC1, WD1, WB1, WB4 and GV1): installing a chain, a partial withdrawal that must
      // no longer displace the claim (T3), and what warningsOf and getVault report.
      await atSecond(H, async () => {
        await expect(f.vault.connect(f.alice)[SET3](1, ethers.id("a fresh anchor"), 3))
          .to.be.revertedWithCustomError(f.vault, "HorizonReached")
          .withArgs(H);
      });
      await atSecond(H, async () => {
        const rc = await (await f.vault.connect(f.alice).withdraw(0, 1n, f.alice.address)).wait();
        expect(vaultLogNames(f, rc), "a partial withdrawal at H").to.not.include("ClaimSuperseded");
        expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
      });
      await atSecond(H, async () => {
        await mine(); // views read the block mined at H
        expect(await f.vault.warningsOf(f.alice.address, 3), "expired and past the horizon, no longer 'pinned'").to.equal(1 | 2);
        expect((await f.vault.getVault(f.alice.address, 3)).horizonReached).to.equal(true);
      });
      expect((await f.vault.getVault(f.alice.address, 0)).state, "the claim is untouched").to.equal(STATE_CLAIM_PENDING);

      // (control) one second earlier the horizon is still ahead: reason 3, and the veto works.
      await atSecond(H - 1, async () => {
        await expect(f.vault.connect(f.alice).checkInMany([0]))
          .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
          .withArgs(1 << SKIP_CLAIM_PENDING);
      });
      await atSecond(H - 1, async () => {
        await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "ClaimPendingUseAbort").withArgs(0);
      });
      await atSecond(H - 1, async () => {
        await expect(f.vault.connect(f.alice).abortClaim(0)).to.emit(f.vault, "ClaimAborted");
      });
      await atSecond(H - 1, async () => {
        await expect(f.vault.connect(f.dave).checkInByChain(f.alice.address, 1, c.value(3)))
          .to.emit(f.vault, "CheckedIn")
          .withArgs(f.alice.address, 1, H, true);
      });
      await atSecond(H - 1, async () => {
        await expect(f.vault.connect(f.alice).withdraw(0, 1n, f.alice.address))
          .to.emit(f.vault, "ClaimSuperseded")
          .withArgs(f.alice.address, 0, ACT_WITHDRAW);
      });
      await atSecond(H - 1, async () => {
        await mine();
        expect(await f.vault.warningsOf(f.alice.address, 3), "pinned, and nothing else yet").to.equal(16);
        expect((await f.vault.getVault(f.alice.address, 3)).horizonReached).to.equal(false);
      });
    });

    it("a SETTLED vault is terminal for checkIn and checkInMany, before and past its horizon: VaultNotActive(id, SETTLED) and SKIP_TERMINAL, never HorizonReached", async () => {
      // Pre-launch finalization (R5-4). Every earlier terminal-state assertion used a CLOSED
      // vault, so dropping SETTLED from either terminal test (checkIn's compound state test,
      // checkInMany's SKIP_TERMINAL) went unnoticed: a check-in on an estate already paid out
      // would have succeeded, and a keeper would have counted it as refreshed.
      const f = await loadFixture(fixture);
      const late = (await time.latest()) + PERIOD + 20 * DAY;
      await create(f, f.alice, NATIVE, ONE); // 0: settled, its horizon far off
      await f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, late, { value: ONE }); // 1
      await time.increase(PERIOD + 1);
      for (const id of [0, 1]) await f.vault.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address);
      await time.increase(WINDOW + 1);
      for (const id of [0, 1]) await f.vault.finalizeClaim(f.alice.address, id);
      await create(f, f.alice, NATIVE, ONE); // 2: healthy
      for (const id of [0, 1]) expect((await f.vault.getVault(f.alice.address, id)).state).to.equal(STATE_SETTLED);

      // Before either horizon.
      expect(await time.latest(), "vault 1's horizon is still ahead").to.be.lessThan(late);
      for (const id of [0, 1]) {
        await expect(f.vault.connect(f.alice).checkIn(id))
          .to.be.revertedWithCustomError(f.vault, "VaultNotActive")
          .withArgs(id, STATE_SETTLED);
      }
      const rc = await (await f.vault.connect(f.alice).checkInMany([0, 1, 2])).wait();
      const seen = vaultLogs(f, rc)
        .filter((p) => p.name === "CheckedIn" || p.name === "CheckInSkipped")
        .map((p) => (p.name === "CheckedIn" ? `${p.args.vaultId}:in` : `${p.args.vaultId}:skip${p.args.reason}`));
      expect(seen).to.deep.equal([`0:skip${SKIP_TERMINAL}`, `1:skip${SKIP_TERMINAL}`, "2:in"]);
      await expect(f.vault.connect(f.alice).checkInMany([0, 1]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(1 << SKIP_TERMINAL);

      // Past vault 1's horizon: still the terminal state, never HorizonReached, whose remedy
      // (extendHorizon) cannot help a settled vault.
      await time.increaseTo(late + DAY);
      expect((await f.vault.getVault(f.alice.address, 1)).horizonReached).to.equal(true);
      await expect(f.vault.connect(f.alice).checkIn(1))
        .to.be.revertedWithCustomError(f.vault, "VaultNotActive")
        .withArgs(1, STATE_SETTLED);
      await expect(f.vault.connect(f.alice).checkInMany([1]))
        .to.be.revertedWithCustomError(f.vault, "NothingCheckedIn")
        .withArgs(1 << SKIP_TERMINAL);
    });
  });

  // ------------------------------------------------------------------------------------ F27

  describe("F27 events: DeadlineReset on every clock write, inactivityPeriod in VaultCreated, the old heir indexed", () => {
    it("every write of a deadline logs DeadlineReset, before the action's own event, with the value getVault then shows", async () => {
      const f = await loadFixture(fixture);
      const me = f.alice.address;
      let last = 0n;
      const check = async (label: string, send: Promise<any>, own: string, earlier = false) => {
        const rc = await (await send).wait();
        const logs = vaultLogs(f, rc);
        const names = logs.map((p) => p.name);
        const resets = logs.filter((p) => p.name === "DeadlineReset");
        expect(resets.length, `${label}: one DeadlineReset`).to.equal(1);
        expect(names.indexOf("DeadlineReset"), `${label}: logged before ${own}`).to.be.lessThan(names.indexOf(own));
        const v = await f.vault.getVault(me, 0);
        expect([resets[0].args.owner, resets[0].args.vaultId], label).to.deep.equal([me, 0n]);
        expect([resets[0].args.newDeadline, resets[0].args.absoluteDeadline], label).to.deep.equal([v.deadline, v.absoluteDeadline]);
        if (earlier) expect(v.deadline, `${label} moved the deadline EARLIER`).to.be.lessThan(last);
        last = v.deadline;
      };
      await check("createVault", create(f, f.alice, NATIVE, DEPOSIT), "VaultCreated");
      await time.increase(DAY);
      await check("checkIn", f.vault.connect(f.alice).checkIn(0), "CheckedIn");
      await time.increase(DAY);
      await check("checkInMany", f.vault.connect(f.alice).checkInMany([0]), "CheckedIn");
      await time.increase(DAY);
      const ctx = await chainCtx(f, me, 0);
      await check("setCheckInChain", f.vault.connect(f.alice)[SET3](0, chain.buildChain(IMPL, ctx, SEED, 2).anchor, 2), "CheckInChainSet");
      await time.increase(DAY);
      await check("checkInByChain", f.vault.connect(f.dave).checkInByChain(me, 0, chain.nextValue(IMPL, ctx, SEED, 2)), "CheckedIn");
      await time.increase(DAY);
      await check("setBeneficiary", f.vault.connect(f.alice).setBeneficiary(0, f.carol.address), "BeneficiaryChanged");
      await time.increase(DAY);
      await check("setInactivityPeriod", f.vault.connect(f.alice).setInactivityPeriod(0, 10 * DAY), "InactivityPeriodSet", true);
      await time.increase(DAY);
      await check("extendHorizon", f.vault.connect(f.alice).extendHorizon(0, (await time.latest()) + 800 * DAY), "HorizonExtended");
      await time.increase(DAY);
      await check("withdraw", f.vault.connect(f.alice).withdraw(0, ONE, me), "Withdrawn");
      await time.increase(10 * DAY + 1);
      await f.vault.connect(f.carol).initiateClaim(me, 0, f.carol.address);
      await check("abortClaim", f.vault.connect(f.alice).abortClaim(0), "ClaimAborted");
      await time.increase(DAY);
      await check("disarm", f.vault.connect(f.alice)[SET3](0, ethers.ZeroHash, 0), "CheckInChainSet");
      await time.increase(DAY);
      await check("closing withdraw", f.vault.connect(f.alice).withdraw(0, DEPOSIT - ONE, me), "Withdrawn");
      // An events-only indexer ends where storage is.
      const iface = f.vault.interface;
      const logs = await ethers.provider.getLogs({
        address: f.vaultAddr, fromBlock: 0, toBlock: "latest",
        topics: [iface.getEvent("DeadlineReset")!.topicHash, ethers.zeroPadValue(me, 32)],
      });
      const indexed = iface.parseLog(logs[logs.length - 1])!.args.newDeadline;
      expect(logs.length).to.equal(12);
      expect(indexed).to.equal((await f.vault.getVault(me, 0)).deadline);
    });

    it("VaultCreated carries the inactivity period", async () => {
      const f = await loadFixture(fixture);
      const rc = await (await create(f, f.alice, NATIVE, DEPOSIT)).wait();
      const created = vaultLogs(f, rc).find((p) => p.name === "VaultCreated");
      expect(created.args.inactivityPeriod).to.equal(PERIOD);
      expect(created.args.challengeWindow).to.equal(WINDOW);
    });

    it("a removed heir finds its removal by filtering on its own address", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).setBeneficiary(0, f.carol.address);
      const topic = f.vault.interface.getEvent("BeneficiaryChanged")!.topicHash;
      const hits = await ethers.provider.getLogs({
        address: f.vaultAddr, fromBlock: 0, toBlock: "latest",
        topics: [topic, null, ethers.zeroPadValue(f.bob.address, 32)],
      });
      expect(hits.length, "logs naming bob as the removed heir").to.equal(1);
      const p = f.vault.interface.parseLog(hits[0])!;
      expect([p.args.owner, p.args.oldBeneficiary, p.args.newBeneficiary, p.args.vaultId]).to.deep.equal([
        f.alice.address, f.bob.address, f.carol.address, 0n,
      ]);
    });

    it("(control) the owner and the new heir still find the change by their own address", async () => {
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      await f.vault.connect(f.alice).setBeneficiary(0, f.carol.address);
      const topic = f.vault.interface.getEvent("BeneficiaryChanged")!.topicHash;
      const q = (topics: (string | null)[]) =>
        ethers.provider.getLogs({ address: f.vaultAddr, fromBlock: 0, toBlock: "latest", topics });
      expect((await q([topic, ethers.zeroPadValue(f.alice.address, 32)])).length).to.equal(1);
      expect((await q([topic, null, null, ethers.zeroPadValue(f.carol.address, 32)])).length).to.equal(1);
    });

    it("DeadlineReset stays a complete record through a claim, a cancel and a settlement: after each, getVault's deadline is the last one logged", async () => {
      // Pre-launch finalization (R5-5). The test above covers every owner action; this one covers
      // the three claim paths, none of which may write the deadline without logging it.
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const topic = f.vault.interface.getEvent("DeadlineReset")!.topicHash;
      const lastLogged = async () => {
        const logs = await ethers.provider.getLogs({
          address: f.vaultAddr, fromBlock: 0, toBlock: "latest", topics: [topic, ethers.zeroPadValue(f.alice.address, 32)],
        });
        expect(logs.length, "DeadlineReset logs for alice").to.be.greaterThan(0);
        return f.vault.interface.parseLog(logs[logs.length - 1])!.args.newDeadline;
      };
      const agree = async (label: string) =>
        expect((await f.vault.getVault(f.alice.address, 0)).deadline, label).to.equal(await lastLogged());
      await agree("created");
      await time.increase(PERIOD + 1);
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.carol.address);
      await agree("claim initiated");
      await f.vault.connect(f.bob).beneficiaryCancelClaim(f.alice.address, 0);
      await agree("claim cancelled");
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
      await time.increase(WINDOW + 1);
      await f.vault.connect(f.dave).finalizeClaim(f.alice.address, 0);
      await agree("settled");
    });

    it("(guard) the deadline is written in exactly one place, which emits DeadlineReset", async () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "InheritanceVault.sol"), "utf8");
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
      // Every assignment to a `.deadline` (plain or compound, through a name or an indexed
      // expression such as `_vaults[o][id].deadline`), except getVault's memory copy `o.deadline`.
      // Review round 1: the old pattern needed a word character before the dot, so a write
      // through an index expression escaped it.
      const writes = code.filter(
        (l) => /\.deadline\s*(?:[-+*\/%|&^]|<<|>>)?=(?!=)/.test(l) && !/\bo\.deadline\s*=/.test(l)
      );
      expect(writes.map((l) => l.trim())).to.deep.equal(["v.deadline = next;"]);
      expect(code.filter((l) => l.includes("emit DeadlineReset(")).length).to.equal(1);
      const body = src.slice(src.indexOf("function _resetClock("), src.indexOf("function _clearPending("));
      expect(body).to.include("v.deadline = next;");
      expect(body).to.include("emit DeadlineReset(");

      // Pre-launch finalization (R5-5): the same rule on the compiler's AST, as review round 4
      // did for F01. The text pattern above cannot see `delete v.deadline`, a tuple target
      // `(v.deadline, x) = (..)` or `v.deadline++`; the AST marks each of them as an lvalue.
      const VAULT_IN_STORAGE = /^struct InheritanceVault\.Vault storage\b/;
      const memberWrites: string[] = [];
      const wholeWrites: string[] = [];
      const assembly: string[] = [];
      const emits: string[] = [];
      walkAst(await vaultAst(), (n, parent, fn) => {
        const type = n.typeDescriptions?.typeString ?? "";
        // A stored Vault's deadline as an lvalue, however it is spelled (getVault's `o` is a
        // VaultView in memory, and so does not match).
        if (
          n.nodeType === "MemberAccess" && n.memberName === "deadline" && n.lValueRequested === true &&
          VAULT_IN_STORAGE.test(n.expression?.typeDescriptions?.typeString ?? "")
        ) {
          memberWrites.push(fn);
        }
        // A whole stored Vault as an lvalue (assigned into, deleted, a tuple target) writes its
        // deadline without naming it. The one lvalue allowed is a storage pointer being pointed
        // at a vault (`v = _vaults[o][id]` in _vault), which writes nothing.
        if (n.lValueRequested === true && VAULT_IN_STORAGE.test(type)) {
          const pointed =
            n.nodeType === "Identifier" && /storage pointer$/.test(type) &&
            parent?.nodeType === "Assignment" && parent.operator === "=" && parent.leftHandSide === n;
          if (!pointed) wholeWrites.push(`${fn}: ${n.nodeType} (${type})`);
        }
        // Raw storage writes name no member at all.
        if (n.nodeType === "YulFunctionCall" && n.functionName?.name === "sstore") assembly.push(`${fn}: sstore`);
        if (n.nodeType === "InlineAssembly") {
          for (const r of n.externalReferences ?? []) if (r.isSlot || r.suffix === "slot") assembly.push(`${fn}: .slot`);
        }
        if (n.nodeType === "EmitStatement" && n.eventCall?.expression?.name === "DeadlineReset") emits.push(fn);
      });
      expect(memberWrites, "AST: every write of a stored Vault's deadline, by function").to.deep.equal(["_resetClock"]);
      expect(wholeWrites, "AST: a whole stored Vault written").to.deep.equal([]);
      expect(assembly, "AST: inline assembly that can write storage").to.deep.equal([]);
      expect(emits, "AST: every DeadlineReset, by function").to.deep.equal(["_resetClock"]);
    });
  });

  // ====================================================================== pass 4: F38

  describe("F38 hostile tokens: each class meets the v2 control that stops it", () => {
    /**
     * Its own deployment. The "listed" tokens are listed as a careless deployer might list them,
     * because what is under test is what the contract still enforces then; the rest are kept
     * out by the allowlist.
     */
    async function hostileFixture() {
      const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
      const deploy = async (name: string, ...args: unknown[]) => {
        const c = await (await ethers.getContractFactory(name, admin)).deploy(...args);
        await c.waitForDeployment();
        return c as any;
      };
      const fotToken = await deploy("FeeOnTransferToken"); // fee taken from what arrives
      const fot = await deploy("FeeOnTopToken"); // fee charged to the sender on top (over-debit)
      const dbl = await deploy("DoubleEntryToken");
      const capped = await deploy("MaxTxToken", CAP);
      const falseTok = await deploy("FalseReturnToken");
      const blk = await deploy("BlocklistToken"); // USDC-style, both sides; issuer = admin
      const tether = await deploy("SenderBlocklistToken"); // Tether-style, sender only; issuer = admin
      const hookListed = await deploy("HookToken");
      const noBool = await deploy("NoBoolPausableToken"); // USDT-on-Ethereum style, pausable; issuer = admin
      // Not listed.
      const fwd = await deploy("DoubleEntryForwarder", await dbl.getAddress());
      await dbl.setForwarder(await fwd.getAddress());
      const rebasing = await deploy("RebasingToken");
      const hook = await deploy("HookToken");
      const falseUnlisted = await deploy("FalseReturnToken");

      const listed = [fotToken, fot, dbl, capped, falseTok, blk, tether, hookListed, noBool];
      const vault = await deployVault({
        deployer: admin,
        admin: admin.address,
        feeBps: FEE_BPS,
        feeRecipient: feeSink.address,
        supported: await Promise.all(listed.map((t: any) => t.getAddress())),
      });
      const vaultAddr = await vault.getAddress();
      for (const t of [...listed, rebasing, hook, falseUnlisted]) {
        for (const who of [alice, dave]) {
          await t.mint(who.address, ethers.parseEther("1000"));
          await t.connect(who).approve(vaultAddr, ethers.MaxUint256);
        }
      }
      return {
        vault, vaultAddr, admin, alice, bob, carol, dave, feeSink,
        fotToken, fot, dbl, fwd, capped, falseTok, blk, tether, hookListed, noBool, rebasing, hook, falseUnlisted,
      };
    }
    type H = Awaited<ReturnType<typeof hostileFixture>>;

    const open = async (h: H, who: any, token: string, amount: bigint, heir: string = h.bob.address) =>
      h.vault.connect(who).createVault(token, amount, heir, PERIOD, WINDOW, (await time.latest()) + HORIZON);

    /** Every lane covered by the balance, and no user value in surplus (only `surplus` of force-fed value). */
    async function lanes(h: H, t: any, surplus = 0n) {
      const a = await t.getAddress();
      const owed = (await h.vault.totalLocked(a)) + (await h.vault.totalCredited(a));
      expect(await t.balanceOf(h.vaultAddr), "the vault's balance covers every lane").to.be.gte(owed);
      expect(await h.vault.surplus(a), "no user value in surplus").to.equal(surplus);
    }

    /** Opens, lets the deadline lapse, and settles alice's vault `id` to bob. */
    async function settleToBob(h: H, id = 0) {
      await time.increase(PERIOD + 1);
      await h.vault.connect(h.bob).initiateClaim(h.alice.address, id, h.bob.address);
      await time.increase(WINDOW + 1);
      await h.vault.finalizeClaim(h.alice.address, id);
    }

    async function hookDepositor(h: H, token: any) {
      const dep = await (await ethers.getContractFactory("HookDepositor", h.admin)).deploy(h.vaultAddr, await token.getAddress());
      await dep.waitForDeployment();
      await token.mint(await dep.getAddress(), ethers.parseEther("1000"));
      return dep as any;
    }

    it("positive rebase: a rebasing token is refused at creation and at the sweep, so no holder's yield can become admin surplus", async () => {
      const h = await loadFixture(hostileFixture);
      const reb = await h.rebasing.getAddress();
      await expect(open(h, h.alice, reb, DEPOSIT)).to.be.revertedWithCustomError(h.vault, "UnsupportedToken").withArgs(reb);
      // Sent here directly and then rebased, it stays stranded: the admin cannot sweep it.
      await h.rebasing.connect(h.dave).transfer(h.vaultAddr, DEPOSIT);
      await h.rebasing.rebase(1_000); // +10% to every holder
      expect(await h.rebasing.balanceOf(h.vaultAddr)).to.be.greaterThan(DEPOSIT);
      await expect(h.vault.connect(h.admin).sweepSurplus(reb, h.admin.address))
        .to.be.revertedWithCustomError(h.vault, "UnsupportedToken")
        .withArgs(reb);
    });

    it("ERC777-style hook: an unlisted hook token is refused before the vault calls it at all, so its sender hook cannot run", async () => {
      // Review round 1: this used to read hookCalls after the reverted deposit, which cannot tell
      // "refused before calling the token" from "refused after": a revert rolls the counter back
      // either way. The tripwire makes the order observable: once armed, ANY call the vault makes
      // to the token (balanceOf, transferFrom) reverts TokenCalled(). So the deposit can revert
      // UnsupportedToken only if the vault refused the token before touching it.
      const h = await loadFixture(hostileFixture);
      const dep = await hookDepositor(h, h.hook);
      await h.hook.setTripwire(true);
      await expect(dep.deposit(h.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, DEPOSIT, false))
        .to.be.revertedWithCustomError(h.vault, "UnsupportedToken")
        .withArgs(await h.hook.getAddress());
      // (control) the tripwire does fire when the token is called: a direct call trips it.
      await expect(h.hook.balanceOf(h.vaultAddr)).to.be.revertedWithCustomError(h.hook, "TokenCalled");
    });

    it("(control) ERC777-style hook: were one listed anyway, a sender hook that re-enters mid-deposit is refused and the deposit records exactly what arrived", async () => {
      const h = await loadFixture(hostileFixture);
      const dep = await hookDepositor(h, h.hookListed);
      const depAddr = await dep.getAddress();
      const calls = await h.hookListed.hookCalls();
      await dep.deposit(h.bob.address, PERIOD, WINDOW, (await time.latest()) + HORIZON, DEPOSIT, true);
      expect(await h.hookListed.hookCalls(), "the sender hook ran once, inside the deposit").to.equal(calls + 1n);
      expect(await dep.reentered(), "the re-entrant createVault got through").to.equal(false);
      expect(await dep.reentryError()).to.equal(REENTRANT_VIEW);
      expect(await h.vault.vaultCount(depAddr)).to.equal(1);
      expect((await h.vault.getVault(depAddr, 0)).balance).to.equal(DEPOSIT);
      await lanes(h, h.hookListed);
    });

    it("double entry: the ledger's second address can neither deposit nor sweep, so the listed ledger's locked value is untouchable", async () => {
      const h = await loadFixture(hostileFixture);
      const dblA = await h.dbl.getAddress();
      const fwdA = await h.fwd.getAddress();
      await open(h, h.alice, dblA, DEPOSIT);
      await expect(open(h, h.dave, fwdA, DEPOSIT)).to.be.revertedWithCustomError(h.vault, "UnsupportedToken").withArgs(fwdA);
      await expect(h.vault.connect(h.admin).sweepSurplus(fwdA, h.admin.address))
        .to.be.revertedWithCustomError(h.vault, "UnsupportedToken")
        .withArgs(fwdA);
      expect(await h.dbl.balanceOf(h.vaultAddr)).to.equal(DEPOSIT);
      await lanes(h, h.dbl);
    });

    it("(control) fee on transfer: a whole lifecycle keeps every lane covered and moves no user value into surplus", async () => {
      const h = await loadFixture(hostileFixture);
      const t = h.fotToken;
      const a = await t.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      expect((await h.vault.getVault(h.alice.address, 0)).balance, "records what arrived").to.equal(DEPOSIT - DEPOSIT / 100n);
      await lanes(h, t);
      await h.vault.connect(h.dave).topUp(h.alice.address, 0, ONE);
      await lanes(h, t);
      await h.vault.connect(h.alice).withdraw(0, ONE, h.alice.address);
      await lanes(h, t);
      await h.vault.connect(h.alice).withdrawCredit(a, h.carol.address);
      await lanes(h, t);
      await settleToBob(h);
      await lanes(h, t);
      await h.vault.connect(h.bob).withdrawCredit(a, h.bob.address);
      await h.vault.connect(h.feeSink).withdrawCredit(a, h.feeSink.address);
      await lanes(h, t);
      expect([await h.vault.totalLocked(a), await h.vault.totalCredited(a), await t.balanceOf(h.vaultAddr)]).to.deep.equal([0n, 0n, 0n]);
    });

    it("fee on top (over-debit): every payout path reverts PayoutOverdebited and the lanes stay whole", async () => {
      const h = await loadFixture(hostileFixture);
      const t = h.fot;
      const a = await t.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      await open(h, h.dave, a, DEPOSIT); // another user's lane in the same pool
      await h.vault.connect(h.alice).withdraw(0, DEPOSIT, h.alice.address);
      const debit = DEPOSIT + DEPOSIT / 100n;
      await expect(h.vault.connect(h.alice).withdrawCredit(a, h.carol.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutOverdebited")
        .withArgs(a, debit, DEPOSIT);
      await expect(h.vault.connect(h.alice).pushCredit(a, h.alice.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutOverdebited")
        .withArgs(a, debit, DEPOSIT);
      await t.connect(h.dave).transfer(h.vaultAddr, ONE); // force-fed: real surplus
      await expect(h.vault.connect(h.admin).sweepSurplus(a, h.admin.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutOverdebited")
        .withArgs(a, ONE + ONE / 100n, ONE);
      expect(await h.vault.creditOf(a, h.alice.address), "the credit is kept").to.equal(DEPOSIT);
      await lanes(h, t, ONE);
    });

    it("false-returning token: one that is not listed is refused at creation", async () => {
      const h = await loadFixture(hostileFixture);
      const a = await h.falseUnlisted.getAddress();
      await expect(open(h, h.alice, a, DEPOSIT)).to.be.revertedWithCustomError(h.vault, "UnsupportedToken").withArgs(a);
    });

    it("(control) a listed token whose transfer returns false: the payout reverts and the credit is kept, not written off", async () => {
      const h = await loadFixture(hostileFixture);
      const a = await h.falseTok.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      await h.vault.connect(h.alice).withdraw(0, DEPOSIT, h.alice.address);
      await h.falseTok.setMode(1);
      await expect(h.vault.connect(h.alice).withdrawCredit(a, h.carol.address))
        .to.be.revertedWithCustomError(h.vault, "SafeERC20FailedOperation")
        .withArgs(a);
      expect(await h.vault.creditOf(a, h.alice.address)).to.equal(DEPOSIT);
      await lanes(h, h.falseTok);
      await h.falseTok.setMode(0);
      await h.vault.connect(h.alice).withdrawCredit(a, h.carol.address);
      expect(await h.falseTok.balanceOf(h.carol.address)).to.equal(DEPOSIT);
    });

    it("a listed token whose transfer reports success but moves nothing, or half, or even raises the vault's balance: the payout reverts PayoutShortfall, the credit is kept and the admin cannot sweep it", async () => {
      const h = await loadFixture(hostileFixture);
      const a = await h.falseTok.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      await h.vault.connect(h.alice).withdraw(0, DEPOSIT, h.alice.address);
      // Mode 4 (review round 3): the balance rises across the transfer, so `debited` is 0, not a
      // checked-subtraction panic.
      for (const [mode, moved] of [[2, 0n], [3, DEPOSIT / 2n], [4, 0n]] as [number, bigint][]) {
        await h.falseTok.setMode(mode);
        await expect(h.vault.connect(h.alice).withdrawCredit(a, h.carol.address))
          .to.be.revertedWithCustomError(h.vault, "PayoutShortfall")
          .withArgs(a, moved, DEPOSIT);
        expect(await h.vault.creditOf(a, h.alice.address), `mode ${mode}: the credit is kept`).to.equal(DEPOSIT);
        await lanes(h, h.falseTok);
        await expect(h.vault.connect(h.admin).sweepSurplus(a, h.admin.address))
          .to.be.revertedWithCustomError(h.vault, "NoSurplus");
      }
      await h.falseTok.setMode(0);
      await h.vault.connect(h.alice).withdrawCredit(a, h.carol.address);
      expect(await h.falseTok.balanceOf(h.carol.address)).to.equal(DEPOSIT);
    });

    it("a listed token whose transfer is off by a single unit, over or short, meets the same wall: PayoutOverdebited(amount + 1), PayoutShortfall(amount - 1), the credit kept", async () => {
      // Review round 4. The other hostile tokens miss by 1%, 50% or all of it, so a check that
      // tolerated a small skim or shortfall would have passed them all. Exactly `amount` or
      // nothing: one unit over is taken from another user's lane (dave's vault shares the pool),
      // one unit short would leave a unit of a retired credit here as sweepable surplus.
      const h = await loadFixture(hostileFixture);
      const a = await h.falseTok.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      await open(h, h.dave, a, DEPOSIT);
      await h.vault.connect(h.alice).withdraw(0, DEPOSIT, h.alice.address);
      await h.falseTok.setMode(5);
      await expect(h.vault.connect(h.alice).withdrawCredit(a, h.carol.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutOverdebited")
        .withArgs(a, DEPOSIT + 1n, DEPOSIT);
      await expect(h.vault.connect(h.alice).pushCredit(a, h.alice.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutOverdebited")
        .withArgs(a, DEPOSIT + 1n, DEPOSIT);
      await h.falseTok.setMode(6);
      await expect(h.vault.connect(h.alice).withdrawCredit(a, h.carol.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutShortfall")
        .withArgs(a, DEPOSIT - 1n, DEPOSIT);
      await expect(h.vault.connect(h.alice).pushCredit(a, h.alice.address))
        .to.be.revertedWithCustomError(h.vault, "PayoutShortfall")
        .withArgs(a, DEPOSIT - 1n, DEPOSIT);
      expect(await h.vault.creditOf(a, h.alice.address), "the credit is kept").to.equal(DEPOSIT);
      await lanes(h, h.falseTok);
      // (control) exact, it pays.
      await h.falseTok.setMode(0);
      await h.vault.connect(h.alice).withdrawCredit(a, h.carol.address);
      expect(await h.falseTok.balanceOf(h.carol.address)).to.equal(DEPOSIT);
      await lanes(h, h.falseTok);
    });

    it("(control) USDC-style blocklist: a blocklisted heir routes the credit elsewhere; a blocklisted vault freezes every exit but loses nothing and gives the admin nothing", async () => {
      const h = await loadFixture(hostileFixture);
      const t = h.blk;
      const a = await t.getAddress();
      await open(h, h.alice, a, DEPOSIT); // vault 0, heir bob
      await open(h, h.alice, a, DEPOSIT); // vault 1
      await settleToBob(h, 0);
      await t.connect(h.admin).setBlocked(h.bob.address, true);
      await expect(h.vault.connect(h.bob).withdrawCredit(a, h.bob.address)).to.be.revertedWith("blocked");
      await h.vault.connect(h.bob).withdrawCredit(a, h.carol.address);
      expect(await t.balanceOf(h.carol.address)).to.equal(DEPOSIT - feeOf(DEPOSIT, FEE_BPS));
      await lanes(h, t);
      // The issuer blocks the vault itself (the pooled issuer risk the contract discloses).
      await t.connect(h.admin).setBlocked(h.vaultAddr, true);
      await h.vault.connect(h.alice).withdraw(1, DEPOSIT, h.alice.address); // a credit; nothing moves
      await expect(h.vault.connect(h.alice).withdrawCredit(a, h.alice.address)).to.be.revertedWith("blocked");
      await expect(h.vault.connect(h.admin).sweepSurplus(a, h.admin.address)).to.be.revertedWithCustomError(h.vault, "NoSurplus");
      await lanes(h, t);
      await t.connect(h.admin).setBlocked(h.vaultAddr, false);
      await h.vault.connect(h.alice).withdrawCredit(a, h.alice.address);
      await lanes(h, t);
    });

    it("sender-only blocklist (Tether-style): before PUSH_GRACE a stranger cannot push a credit into the frozen address, and the heir routes it elsewhere", async () => {
      const h = await loadFixture(hostileFixture);
      const t = h.tether;
      const a = await t.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      await settleToBob(h);
      await t.connect(h.admin).addBlackList(h.bob.address); // receiving still works; spending does not
      await expect(h.vault.connect(h.dave).pushCredit(a, h.bob.address)).to.be.revertedWithCustomError(h.vault, "PushTooEarly");
      await h.vault.connect(h.bob).withdrawCredit(a, h.carol.address);
      expect(await t.balanceOf(h.carol.address)).to.equal(DEPOSIT - feeOf(DEPOSIT, FEE_BPS));
      expect(await t.balanceOf(h.bob.address), "nothing was delivered into the frozen address").to.equal(0);
      await lanes(h, t);
    });

    it("transfer cap: an estate above the cap settles and is paid out in cap-sized parts, every lane covered at each step", async () => {
      const h = await loadFixture(hostileFixture);
      const t = h.capped;
      const a = await t.getAddress();
      await open(h, h.alice, a, CAP);
      await h.vault.connect(h.dave).topUp(h.alice.address, 0, CAP); // 2 x CAP: no single transfer can pay it
      await settleToBob(h);
      await expect(h.vault.connect(h.bob).withdrawCredit(a, h.bob.address)).to.be.revertedWith("maxTx");
      let owed: bigint = await h.vault.creditOf(a, h.bob.address);
      expect(owed).to.equal(2n * CAP - feeOf(2n * CAP, FEE_BPS));
      while (owed > 0n) {
        const part = owed > CAP ? CAP : owed;
        await h.vault.connect(h.bob)["withdrawCredit(address,address,uint256)"](a, h.bob.address, part);
        owed -= part;
        expect(await h.vault.creditOf(a, h.bob.address)).to.equal(owed);
        await lanes(h, t);
      }
      expect(await t.balanceOf(h.bob.address)).to.equal(2n * CAP - feeOf(2n * CAP, FEE_BPS));
    });

    it("(control) no-bool (USDT-on-Ethereum style) and pausable: a whole lifecycle keeps every lane covered; a pause freezes every exit, loses nothing and gives the admin nothing", async () => {
      // Review round 1: the two classes the digest named that the matrix lacked. transfer,
      // transferFrom and approve return nothing (SafeERC20 must accept that), and the issuer can
      // pause every transfer (the pooled issuer risk).
      const h = await loadFixture(hostileFixture);
      const t = h.noBool;
      const a = await t.getAddress();
      await open(h, h.alice, a, DEPOSIT);
      await h.vault.connect(h.dave).topUp(h.alice.address, 0, DEPOSIT);
      await lanes(h, t);
      await h.vault.connect(h.alice).withdraw(0, DEPOSIT, h.carol.address);
      await h.vault.connect(h.carol).withdrawCredit(a, h.carol.address);
      expect(await t.balanceOf(h.carol.address)).to.equal(DEPOSIT);
      await lanes(h, t);
      await settleToBob(h);
      await lanes(h, t);
      const net = DEPOSIT - feeOf(DEPOSIT, FEE_BPS);
      await t.connect(h.admin).setPaused(true);
      await expect(h.vault.connect(h.bob).withdrawCredit(a, h.bob.address)).to.be.revertedWith("paused");
      await expect(h.vault.connect(h.bob).pushCredit(a, h.bob.address)).to.be.revertedWith("paused");
      await expect(open(h, h.dave, a, DEPOSIT)).to.be.revertedWith("paused");
      await expect(h.vault.connect(h.admin).sweepSurplus(a, h.admin.address)).to.be.revertedWithCustomError(h.vault, "NoSurplus");
      expect(await h.vault.creditOf(a, h.bob.address), "the credit survives the pause").to.equal(net);
      await lanes(h, t);
      await t.connect(h.admin).setPaused(false);
      await h.vault.connect(h.bob).withdrawCredit(a, h.bob.address);
      await h.vault.connect(h.feeSink).withdrawCredit(a, h.feeSink.address);
      expect(await t.balanceOf(h.bob.address)).to.equal(net);
      await lanes(h, t);
      expect([await h.vault.totalLocked(a), await h.vault.totalCredited(a), await t.balanceOf(h.vaultAddr)]).to.deep.equal([0n, 0n, 0n]);
    });
  });

  // ====================================================================== pre-launch finalization

  describe("F21 and F29 the v2 source comments say what the code does", () => {
    // The audit found these comments wrong in v1, and its report said v2 still carried them. Each
    // guard first establishes the behaviour by running the contract, then checks the comment
    // against it, so it fails on the audited wording because the code contradicts it.
    const ACT_SET_BENEFICIARY = 2;
    /** The trust-model paragraph that starts at `start`, as prose, up to `end`. */
    const section = (start: string, end: string) => {
      const src = prose(...VAULT_SOL);
      const i = src.indexOf(start);
      expect(i, `${start} found`).to.be.greaterThan(0);
      const j = src.indexOf(end, i);
      expect(j, `${end} found after ${start}`).to.be.greaterThan(i);
      return src.slice(i, j);
    };
    /** Stamps the next block one second after the last, and returns that second. */
    const nextSecond = async () => {
      const s = (await time.latest()) + 1;
      await time.setNextBlockTimestamp(s);
      return s;
    };

    it("(guard) T2: once the owner is gone, a lost heir key strands the funds for good; nothing opens at the horizon or twenty years after it", async () => {
      // F29 (5). The audited T2 said "stuck until the horizon".
      const f = await loadFixture(fixture);
      await create(f, f.alice, NATIVE, DEPOSIT);
      const g = (await f.vault.getVault(f.alice.address, 0)).guaranteedInheritanceAt;
      await time.increaseTo(Number(g) + 20 * 365 * DAY); // the owner never acts again; bob lost his key
      for (const s of [f.carol, f.dave, f.admin, f.feeSink]) {
        await expect(f.vault.connect(s).initiateClaim(f.alice.address, 0, s.address))
          .to.be.revertedWithCustomError(f.vault, "NotTheBeneficiary")
          .withArgs(s.address, f.bob.address);
      }
      await expect(f.vault.connect(f.carol).finalizeClaim(f.alice.address, 0)).to.be.revertedWithCustomError(
        f.vault,
        "NoClaimPending"
      );
      const v = await f.vault.getVault(f.alice.address, 0);
      expect([v.state, v.balance, v.horizonReached], "still ACTIVE, still holding the estate").to.deep.equal([
        STATE_ACTIVE,
        DEPOSIT,
        true,
      ]);
      const t2 = section("T2. The beneficiary's wallet key", "T3. guaranteedInheritanceAt");
      expect(t2).to.not.include("stuck until the horizon");
      expect(t2).to.include(
        "Nothing opens at the horizon or after it: only the beneficiary can ever start a claim, so once the owner " +
          "is gone a lost beneficiary key leaves the funds stuck for good, as does an heir who never claims."
      );
    });

    it("(guard) T1: the owner key stops any claim that has not settled, a matured one included, with the veto before the horizon and past it only as T3 says", async () => {
      // F29 (6, control). The audited T1 said the owner key can "veto any claim"; past the
      // horizon abortClaim reverts.
      const f = await loadFixture(fixture);
      const t0 = await nextSecond();
      const H = t0 + PERIOD + DAY;
      await f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, H, { value: ONE }); // 0
      await create(f, f.alice, NATIVE, ONE); // 1: its horizon far off
      await create(f, f.alice, NATIVE, ONE); // 2: its horizon far off; its claim will mature
      await time.increaseTo(H - DAY / 2); // every vault has expired: they were opened a second apart
      for (const id of [0, 1, 2]) await f.vault.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address);
      await time.increaseTo(H + DAY);
      // Before its own horizon, the veto: on a pending claim, and on a matured one not yet settled.
      await expect(f.vault.connect(f.alice).abortClaim(1)).to.emit(f.vault, "ClaimAborted");
      await time.increase(WINDOW);
      expect((await f.vault.getVault(f.alice.address, 2)).finalizable, "vault 2's claim has matured").to.equal(true);
      await expect(f.vault.connect(f.alice).abortClaim(2)).to.emit(f.vault, "ClaimAborted");
      // Past its horizon, no veto; the claim is stopped only as T3 says (extendHorizon here).
      await expect(f.vault.connect(f.alice).abortClaim(0))
        .to.be.revertedWithCustomError(f.vault, "HorizonReached")
        .withArgs(H);
      await f.vault.connect(f.alice).extendHorizon(0, (await time.latest()) + PERIOD + 10);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_ACTIVE);
      const t1 = section("T1. The vault owner's wallet key", "T2. The beneficiary's wallet key");
      expect(t1).to.not.include("veto any claim");
      expect(t1).to.include(
        "stop any claim that has not settled: with the veto (abortClaim) before the horizon, and past it only as T3 says."
      );
    });

    it("(guard) T3: past the horizon only the owner key moves the date, in two logged ways; an override can be as short as MIN_INACTIVITY or as long as MAX_HORIZON; a new heir does not move the date", async () => {
      // F21. The audited T3 called extendHorizon "the ONLY way past the date", priced every
      // override at "one full inactivity period", and said nothing moves the date "without bound".
      const f = await loadFixture(fixture);
      const MAX_HORIZON = 36_500 * DAY;
      expect([await f.vault.MIN_INACTIVITY(), await f.vault.MAX_HORIZON()]).to.deep.equal([BigInt(7 * DAY), BigInt(MAX_HORIZON)]);
      const t0 = await nextSecond();
      const H = t0 + PERIOD + DAY;
      for (let i = 0; i < 4; i++) {
        await f.vault.connect(f.alice).createVault(NATIVE, ONE, f.bob.address, PERIOD, WINDOW, H, { value: ONE });
      }
      await time.increaseTo(H - DAY / 2); // every vault has expired: they were opened a second apart
      for (const id of [1, 2]) await f.vault.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address);
      // The date holds for an heir who claims by the horizon: each claim is finalizable by it.
      for (const id of [1, 2]) {
        const v = await f.vault.getVault(f.alice.address, id);
        expect(v.finalizableAt, `vault ${id}`).to.be.lessThanOrEqual(v.guaranteedInheritanceAt);
      }
      await time.increaseTo(H + DAY); // past the horizon; both challenge windows still open

      // Vault 1, a claim pending: no veto and no cut of the period, but one call can move the
      // horizon MAX_HORIZON ahead, which ends the claim.
      await expect(f.vault.connect(f.alice).abortClaim(1)).to.be.revertedWithCustomError(f.vault, "HorizonReached");
      await expect(f.vault.connect(f.alice).setInactivityPeriod(1, 7 * DAY)).to.be.revertedWithCustomError(
        f.vault,
        "HorizonReached"
      );
      let s = await nextSecond();
      await expect(f.vault.connect(f.alice).extendHorizon(1, s + MAX_HORIZON + 1)).to.be.revertedWithCustomError(
        f.vault,
        "HorizonTooFar"
      );
      s = await nextSecond();
      await expect(f.vault.connect(f.alice).extendHorizon(1, s + MAX_HORIZON))
        .to.emit(f.vault, "HorizonExtended")
        .withArgs(f.alice.address, 1, s + MAX_HORIZON);
      const v1 = await f.vault.getVault(f.alice.address, 1);
      expect([v1.state, v1.deadline], "the claim ended; the heir's next chance is one period out").to.deep.equal([
        STATE_ACTIVE,
        BigInt(s + PERIOD),
      ]);

      // Vault 2, a claim pending: withdrawing everything closes the vault, and the claim with it.
      await f.vault.connect(f.alice).withdraw(2, ONE, f.alice.address); // the exact balance: v1 has no sentinel
      expect((await f.vault.getVault(f.alice.address, 2)).state).to.equal(STATE_CLOSED);
      await expect(f.vault.finalizeClaim(f.alice.address, 2)).to.be.revertedWithCustomError(f.vault, "NoClaimPending");

      // Vault 3, no claim pending: a new heir moves no date, and may claim at once.
      await f.vault.connect(f.alice).setBeneficiary(3, f.carol.address);
      expect((await f.vault.getVault(f.alice.address, 3)).absoluteDeadline).to.equal(H);
      await expect(f.vault.connect(f.carol).initiateClaim(f.alice.address, 3, f.carol.address)).to.emit(
        f.vault,
        "ClaimInitiated"
      );

      // Vault 0, no claim pending: the period cut to MIN_INACTIVITY first, so the override costs
      // the heir 7 days, not the vault's 30.
      await f.vault.connect(f.alice).setInactivityPeriod(0, 7 * DAY);
      s = await nextSecond();
      await expect(f.vault.connect(f.alice).extendHorizon(0, s + 7 * DAY))
        .to.emit(f.vault, "HorizonExtended")
        .withArgs(f.alice.address, 0, s + 7 * DAY);
      expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(s + 7 * DAY);
      await time.setNextBlockTimestamp(s + 7 * DAY - 1);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)).to.be.revertedWithCustomError(
        f.vault,
        "NotYetExpired"
      );
      await time.setNextBlockTimestamp(s + 7 * DAY);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)).to.emit(
        f.vault,
        "ClaimInitiated"
      );

      const t3 = section("T3. guaranteedInheritanceAt", "T4. The admin can");
      for (const audited of [
        "The ONLY way past the date is extendHorizon",
        "at a cost of one full inactivity period per override",
        "nothing can do it silently or without bound",
      ]) {
        expect(t3).to.not.include(audited);
      }
      expect(t3).to.include("The date is not a payout: it holds for an heir who claims by the horizon.");
      expect(t3).to.include(
        "Past the horizon nothing but the live owner key can move the date, and it can move the date or stop a claim " +
          "only in two logged ways: withdrawing everything, which closes the vault, or extendHorizon"
      );
      expect(t3).to.include("Either ends a pending claim.");
      expect(t3).to.include(
        "the heir may claim again at the new deadline, one inactivity period out -- the vault's current period, which " +
          "the owner can first cut to MIN_INACTIVITY (7 days) while no claim is pending -- and one call can move the " +
          "horizon as far as MAX_HORIZON (100 years) ahead."
      );
      expect(t3).to.include(
        "Naming a new heir, which setBeneficiary allows past the horizon while no claim is pending, does not move " +
          "the date, and the new heir may claim at once."
      );
    });

    it("(guard) _clearPending's comment names the owner actions that end a claim, and says a check-in and a top-up do not", async () => {
      // F29 (6). The audited comment said "Any owner action supersedes a running claim".
      const f = await loadFixture(fixture);
      expect(await f.vault.ACT_SET_BENEFICIARY()).to.equal(ACT_SET_BENEFICIARY);
      for (let i = 0; i < 7; i++) await create(f, f.alice, NATIVE, DEPOSIT);
      await time.increase(PERIOD + 1);
      for (let i = 0; i < 7; i++) await f.vault.connect(f.bob).initiateClaim(f.alice.address, i, f.bob.address);
      // These do not end it.
      await expect(f.vault.connect(f.alice).checkIn(0)).to.be.revertedWithCustomError(f.vault, "ClaimPendingUseAbort");
      await expect(f.vault.connect(f.alice).checkInMany([0])).to.be.revertedWithCustomError(f.vault, "NothingCheckedIn");
      await expect(
        f.vault.connect(f.alice).topUp(f.alice.address, 0, ONE, { value: ONE })
      ).to.be.revertedWithCustomError(f.vault, "VaultNotActive");
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(STATE_CLAIM_PENDING);
      // These do, each through _clearPending, which logs the action's tag.
      const ends: [string, () => Promise<any>, number, number][] = [
        ["setBeneficiary", () => f.vault.connect(f.alice).setBeneficiary(1, f.carol.address), 1, ACT_SET_BENEFICIARY],
        ["setInactivityPeriod", () => f.vault.connect(f.alice).setInactivityPeriod(2, PERIOD), 2, ACT_SET_INACTIVITY],
        [
          "extendHorizon",
          async () => f.vault.connect(f.alice).extendHorizon(3, (await time.latest()) + HORIZON + DAY),
          3,
          ACT_EXTEND_HORIZON,
        ],
        ["a disarm", () => f.vault.connect(f.alice)[SET3](4, ethers.ZeroHash, 0), 4, ACT_SET_CHECKIN_CHAIN],
        ["a partial withdraw", () => f.vault.connect(f.alice).withdraw(5, ONE, f.alice.address), 5, ACT_WITHDRAW],
      ];
      for (const [label, send, id, tag] of ends) {
        await expect(send(), label).to.emit(f.vault, "ClaimSuperseded").withArgs(f.alice.address, id, tag);
        expect((await f.vault.getVault(f.alice.address, id)).state, label).to.equal(STATE_ACTIVE);
      }
      // A full withdraw ends the claim by closing the vault, not through _clearPending.
      await expect(f.vault.connect(f.alice).withdraw(6, DEPOSIT, f.alice.address))
        .to.emit(f.vault, "ClaimSuperseded")
        .withArgs(f.alice.address, 6, ACT_CLOSE);
      expect((await f.vault.getVault(f.alice.address, 6)).state).to.equal(STATE_CLOSED);

      const doc = docAbove("    function _clearPending(");
      expect(doc).to.not.include("Any owner action supersedes a running claim");
      expect(doc).to.include(
        "These owner actions supersede a running claim here: setBeneficiary, setInactivityPeriod, extendHorizon, " +
          "setCheckInChain (a disarm included) and a partial withdraw."
      );
      expect(doc).to.include(
        "A check-in does not (checkIn reverts and checkInMany skips the vault: abortClaim is the veto), nor does a " +
          "top-up, which is refused mid-claim. A full withdraw ends the claim by closing the vault, without coming here."
      );
    });

    it("(guard) setCheckInChain's comment no longer says an install past the horizon \"would take a fee\": the call is not payable, and there it reverts", async () => {
      // F29. The audited comment said installing a chain past the horizon "would take a fee".
      const f = await loadFixture(fixture);
      for (const sig of [SET3, SET4]) {
        expect(f.vault.interface.getFunction(sig)!.stateMutability, `${sig} is not payable`).to.equal("nonpayable");
      }
      const h = await vaultWithHorizon(f, DAY);
      const anchor = ethers.id("an anchor");
      const data = f.vault.interface.encodeFunctionData(SET3, [h.id, anchor, 3]);
      await expect(f.alice.sendTransaction({ to: f.vaultAddr, data, value: 1n }), "value sent with it").to.be.reverted;
      await time.increaseTo(h.horizon);
      await expect(f.vault.connect(f.alice)[SET3](h.id, anchor, 3))
        .to.be.revertedWithCustomError(f.vault, "HorizonReached")
        .withArgs(h.horizon);
      // The comment is a `//` block, which prose() keeps as " // " between lines.
      const src = prose(...VAULT_SOL).replace(/ \/\/ /g, " ");
      expect(src).to.not.include("would take a fee");
      expect(src).to.include(
        "checkInByChain reverts past the horizon, so installing a chain there would cost gas, clear the \"chain " +
          "exhausted\" warning, and hand the owner a mechanism that can never fire"
      );
    });
  });
});
