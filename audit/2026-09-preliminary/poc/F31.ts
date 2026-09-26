// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F31/test/poc-F31.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
// Also reads, from this repo's working tree: scripts/deploy.ts, scripts/transfer-admin.ts,
//  site/assets/app.js; deploy.ts deploys the working-tree contracts/InheritanceVault.sol.
/**
 * PoC F31 -- the deploy tooling for the planned BNB launch.
 *
 * Runs the REAL scripts/deploy.ts and scripts/transfer-admin.ts, unmodified, as the operator
 * would ("--network bnb", ALLOW_MAINNET=yes), but against a rehearsal network that is only
 * named "bnb": it is this test's own in-process Hardhat chain (chainId 31337), exposed on
 * 127.0.0.1 through Hardhat's JSON-RPC server. The rehearsal config is written by the test and
 * defines NO real network, so nothing here can reach BNB Chain or any other live chain.
 *
 * Each test asserts the SAFE property. Against the current scripts they fail because:
 *   1. with no ADMIN_ADDRESS / FEE_RECIPIENT, the "bnb" launch makes the hot deploy key the
 *      vault admin and fee recipient (deploy.ts:39-45);
 *   2. the "bnb" launch always deploys a fresh NotifySubscription (deploy.ts:68-73), the
 *      billing contract the site says is retired, and that contract accepts payment;
 *   3. deploy.ts tells the operator to set CHAINS[id].notify, a field app.js no longer has;
 *   4. transfer-admin.ts cannot even dry-run on a vault-only deployment record.
 *
 * deployments/bnb.json is written by deploy.ts itself; the test backs up any existing file and
 * restores it (or removes the rehearsal one) afterwards.
 */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TASK_NODE_CREATE_SERVER } from "hardhat/builtin-tasks/task-names";

const ROOT = hre.config.paths.root;
const PORT = 8591;
const REHEARSAL_DIR = path.join(hre.config.paths.cache, "poc-f31");
const REHEARSAL_CONFIG = path.join(REHEARSAL_DIR, "hardhat.config.ts");
const RECORD = path.join(ROOT, "deployments", "bnb.json");
const HARDHAT_CLI = require.resolve("hardhat/internal/cli/bootstrap.js");
const SUB_PRICE = ethers.parseEther("0.001"); // deploy.ts default, 0.001 native coin / 30 days

type Run = { code: number | null; out: string };

/** Starts the real hardhat CLI as a child process. Async, because the child talks JSON-RPC
 *  to a server living on THIS process's event loop: a spawnSync would deadlock. */
function runScript(script: string, env: Record<string, string>): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const k of ["DEPLOYER_KEY", "BNB_RPC_URL", "HARDHAT_NETWORK", "CLAIM_FEE_BPS", "SUB_PRICE_ETH", "CONFIRM"]) {
    if (!(k in env)) delete childEnv[k];
  }
  if (!("ADMIN_ADDRESS" in env)) delete childEnv.ADMIN_ADDRESS;
  if (!("FEE_RECIPIENT" in env)) delete childEnv.FEE_RECIPIENT;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [HARDHAT_CLI, "run", script, "--network", "bnb", "--config", REHEARSAL_CONFIG],
      { cwd: ROOT, env: childEnv }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function runtimeCode(name: string) {
  return (await hre.artifacts.readArtifact(name)).deployedBytecode.toLowerCase();
}

/** Every contract the key created between two nonces, classified by its runtime bytecode. */
async function createdBy(from: string, fromNonce: number, toNonce: number) {
  // Evidence-suite port: deliberately "InheritanceVault", not InheritanceVaultV1. This PoC runs the
  // working-tree scripts/deploy.ts, which deploys the working-tree contracts/InheritanceVault.sol.
  const vaultCode = await runtimeCode("InheritanceVault");
  const subCode = await runtimeCode("NotifySubscription");
  const made: { addr: string; kind: string }[] = [];
  for (let nonce = fromNonce; nonce < toNonce; nonce++) {
    const addr = ethers.getCreateAddress({ from, nonce });
    const code = (await ethers.provider.getCode(addr)).toLowerCase();
    if (code === "0x") continue; // a plain transaction, not a deployment
    made.push({ addr, kind: code === vaultCode ? "InheritanceVault" : code === subCode ? "NotifySubscription" : "other" });
  }
  return made;
}

describe("PoC F31 - BNB launch rehearsal of the deploy tooling", function () {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  this.timeout(600_000);

  let server: any;
  let hot: ReturnType<typeof ethers.Wallet.createRandom>; // the deployer hot key
  let cold: string; // the hardware wallet the operator meant to use
  let savedRecord: string | null = null;

  before(async () => {
    if (hre.network.name !== "hardhat") throw new Error("rehearsal must run on the in-process network");
    const [funder, , , , , , , ledger] = await ethers.getSigners();
    cold = ledger.address;
    hot = ethers.Wallet.createRandom();
    await (await funder.sendTransaction({ to: hot.address, value: ethers.parseEther("5") })).wait();

    savedRecord = fs.existsSync(RECORD) ? fs.readFileSync(RECORD, "utf8") : null;

    fs.mkdirSync(REHEARSAL_DIR, { recursive: true });
    const base = path.join(ROOT, "hardhat.config").replace(/\\/g, "/");
    fs.writeFileSync(
      REHEARSAL_CONFIG,
      [
        `import base from ${JSON.stringify(base)};`,
        `// Rehearsal only: "bnb" is the PoC's local chain. No real network is defined here.`,
        `export default {`,
        `  ...base,`,
        `  paths: { ...(base as any).paths, root: ${JSON.stringify(ROOT.replace(/\\/g, "/"))} },`,
        `  networks: {`,
        `    hardhat: {},`,
        `    bnb: { url: "http://127.0.0.1:${PORT}", chainId: 31337, accounts: [process.env.POC_F31_KEY!] },`,
        `  },`,
        `};`,
        ``,
      ].join("\n")
    );

    server = await hre.run(TASK_NODE_CREATE_SERVER, {
      hostname: "127.0.0.1",
      port: PORT,
      provider: hre.network.provider,
    });
    await server.listen();
  });

  after(async () => {
    if (server) await server.close();
    if (savedRecord !== null) fs.writeFileSync(RECORD, savedRecord);
    else if (fs.existsSync(RECORD)) fs.unlinkSync(RECORD);
    fs.rmSync(REHEARSAL_DIR, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------------------------

  describe("operator runs the documented mainnet deploy with no ADMIN_ADDRESS / FEE_RECIPIENT", () => {
    let run: Run;
    let made: { addr: string; kind: string }[];

    before(async () => {
      const n0 = await ethers.provider.getTransactionCount(hot.address);
      run = await runScript("scripts/deploy.ts", { ALLOW_MAINNET: "yes", POC_F31_KEY: hot.privateKey });
      const n1 = await ethers.provider.getTransactionCount(hot.address);
      made = await createdBy(hot.address, n0, n1);
    });

    it("never leaves a vault whose admin or fee recipient is the hot deploy key", async () => {
      const hotControlled: string[] = [];
      for (const m of made.filter((x) => x.kind === "InheritanceVault")) {
        const vault = await ethers.getContractAt("InheritanceVault", m.addr);
        if ((await vault.owner()) === hot.address) hotControlled.push(`${m.addr} owner() = hot deploy key`);
        if ((await vault.feeRecipient()) === hot.address) hotControlled.push(`${m.addr} feeRecipient() = hot deploy key`);
      }
      expect(hotControlled, `bnb deploy exited ${run.code}; output:\n${run.out}`).to.deep.equal([]);

      // A fix that refuses must refuse loudly and name what is missing, not die of something else.
      if (made.length === 0) {
        expect(run.code, run.out).to.not.equal(0);
        expect(run.out).to.match(/ADMIN_ADDRESS|FEE_RECIPIENT/);
      }
    });
  });

  // ------------------------------------------------------------------------------------------

  describe("operator runs the mainnet deploy WITH a cold admin and fee recipient", () => {
    let run: Run;
    let made: { addr: string; kind: string }[];

    before(async () => {
      const n0 = await ethers.provider.getTransactionCount(hot.address);
      run = await runScript("scripts/deploy.ts", {
        ALLOW_MAINNET: "yes",
        POC_F31_KEY: hot.privateKey,
        ADMIN_ADDRESS: cold,
        FEE_RECIPIENT: cold,
      });
      const n1 = await ethers.provider.getTransactionCount(hot.address);
      made = await createdBy(hot.address, n0, n1);
    });

    it("deploys the vault and nothing else - never the retired NotifySubscription", async () => {
      expect(run.code, run.out).to.equal(0);
      expect(made.filter((m) => m.kind === "InheritanceVault"), run.out).to.have.length(1);
      expect(
        made.filter((m) => m.kind !== "InheritanceVault"),
        "the bnb launch created a contract other than the vault"
      ).to.deep.equal([]);
    });

    it("leaves no contract on the new chain that takes a user's reminder payment", async () => {
      const [, , , user] = await ethers.getSigners();
      const took: string[] = [];
      for (const m of made.filter((x) => x.kind !== "InheritanceVault")) {
        const sub = await ethers.getContractAt("NotifySubscription", m.addr);
        const before = await ethers.provider.getBalance(m.addr);
        try {
          await (await sub.connect(user).subscribe(user.address, 0, { value: SUB_PRICE })).wait();
        } catch {
          continue; // refused the payment: harmless
        }
        const after = await ethers.provider.getBalance(m.addr);
        const paidUntil = await sub.paidUntil(user.address);
        took.push(
          `${m.addr} accepted ${ethers.formatEther(after - before)} for a retired service ` +
            `(paidUntil=${paidUntil}, owner=${await sub.owner()} can withdraw it)`
        );
      }
      expect(took).to.deep.equal([]);
    });

    it("only tells the operator to set CHAINS fields that site/assets/app.js actually has", async () => {
      const appJs = fs.readFileSync(path.join(ROOT, "site", "assets", "app.js"), "utf8");
      const chainsBlock = appJs.slice(appJs.indexOf("const CHAINS"), appJs.indexOf("};", appJs.indexOf("const CHAINS")));
      // Object keys only: a key follows "{", "," or a line start; "https:" inside a URL does not.
      const appFields = new Set([...chainsBlock.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]));
      const told = [...run.out.matchAll(/CHAINS\[\d+\]\.(\w+)/g)].map((m) => m[1]);
      expect(told.length, run.out).to.be.greaterThan(0); // the instruction is still printed
      const missing = [...new Set(told)].filter((f) => !appFields.has(f));
      expect(missing, `deploy.ts instructs CHAINS[...].${missing.join(", ")}; app.js CHAINS has: ${[...appFields].join(", ")}`).to.deep.equal([]);
    });
  });

  // ------------------------------------------------------------------------------------------

  describe("admin handover on a vault-only deployment (what the BNB launch should produce)", () => {
    it("transfer-admin.ts dry-runs instead of requiring a NotifySubscription", async () => {
      const Vault = await ethers.getContractFactory("InheritanceVaultV1", hot.connect(ethers.provider));
      const vault = await Vault.deploy(hot.address, 50, hot.address);
      await vault.waitForDeployment();
      fs.mkdirSync(path.dirname(RECORD), { recursive: true });
      fs.writeFileSync(
        RECORD,
        JSON.stringify({
          network: "bnb",
          chainId: 31337,
          deployer: hot.address,
          admin: hot.address,
          feeRecipient: hot.address,
          contracts: { InheritanceVault: await vault.getAddress() },
          params: { claimFeeBps: 50 },
        }, null, 2)
      );

      const run = await runScript("scripts/transfer-admin.ts", { POC_F31_KEY: hot.privateKey, COLD_ADDRESS: cold });
      expect(run.code, run.out).to.equal(0);
      expect(run.out).to.match(/Dry run/);
      // Dry run sent nothing: the hot key still owns the vault.
      expect(await vault.owner()).to.equal(hot.address);
    });
  });
});
