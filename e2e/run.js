#!/usr/bin/env node
/*
 * Will & Key v2: the real-browser end-to-end suite for the app (site/app.html, site/assets/app.js).
 *
 *   npm run e2e                      every scenario
 *   npm run e2e -- --only claim      scenarios whose name contains "claim" (repeatable)
 *   npm run e2e -- --headed          watch it (WK_E2E_HEADED=1 does the same)
 *   npm run e2e -- --list            print the scenario names and exit
 *
 * What it does, in order:
 *   1. compiles contracts/ into a build directory outside the repository (e2e/hardhat.config.ts);
 *   2. starts `hardhat node` on a free port, reporting chain id 8453 (Base);
 *   3. deploys the world (e2e/lib/world.js): v1 at its Base address, paused by the Ledger, with an
 *      open vault and a credit for one test wallet; mock tokens at the four listed Base token
 *      addresses; v2 exactly as the launch plan deploys it;
 *   4. copies site/ to a temporary root and runs scripts/set-launch-values.js against the copy,
 *      with its on-chain checks against the local node (the repository's site/ is never written);
 *   5. serves the copy with an unmodified copy of scripts/serve-site.js (production headers, CSP);
 *   6. runs every scenario in the system Chrome through playwright-core, each in a fresh browser
 *      context with an injected EIP-1193 wallet, from a chain snapshot of step 3. Any uncaught
 *      page error, console error, CSP violation or request to an unexpected host fails the
 *      scenario, and so does a call to the public endpoint (mainnet.base.org, answered by the
 *      local node) that the scenario did not provoke. The browser runs in the UTC+14 zone.
 * Needs: Chrome at C:/Program Files/Google/Chrome/Application/chrome.exe (or WK_E2E_CHROME, or
 * any Chrome that playwright-core's channel "chrome" finds). Nothing is downloaded.
 * Writes: nothing in the repository. Compiler output goes to <os tmp>/willandkey-e2e-build (or
 * WK_E2E_BUILD_DIR); logs and failure screenshots to <os tmp>/willandkey-e2e-out/<run>/.
 * Exit code: 0 when every selected scenario passed, 1 otherwise.
 *
 * A scenario's "check(s) failed" lines are soft checks: recorded, the scenario carries on, and
 * it fails at the end, so one wrong line of text does not hide what the later steps find.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { compile, startNode, Chain } = require("./lib/chain");
const { deployWorld } = require("./lib/world");
const { prepareSite, serveSite } = require("./lib/site");
const { launchBrowser, Session } = require("./lib/browser");
const { Harness } = require("./lib/harness");
const { TestFailure } = require("./lib/util");

const SCENARIO_FILES = ["setup", "create", "checkin", "owner", "claim", "fees", "heir", "faults", "layout"];

function loadScenarios() {
  const out = [];
  for (const file of SCENARIO_FILES) {
    for (const scenario of require(`./scenarios/${file}`)) out.push({ ...scenario, file });
  }
  return out;
}

function parseArgs(argv) {
  const args = { only: [], headed: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") args.only.push(String(argv[(i += 1)] || "").toLowerCase());
    else if (argv[i] === "--headed") args.headed = true;
    else if (argv[i] === "--list") args.list = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.headed) process.env.WK_E2E_HEADED = "1";
  const scenarios = loadScenarios();
  if (args.list) {
    for (const s of scenarios) console.log(s.name);
    return 0;
  }
  const selected = args.only.length
    ? scenarios.filter((s) => args.only.some((needle) => s.name.toLowerCase().includes(needle)))
    : scenarios;
  if (!selected.length) throw new Error(`no scenario matches ${args.only.join(", ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(os.tmpdir(), "willandkey-e2e-out", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const cleanup = [];
  const started = Date.now();
  const say = (text) => console.log(`[${secs(Date.now() - started)}] ${text}`);

  try {
    say("compiling contracts/ ...");
    await compile(path.join(outDir, "compile.log"));
    say("starting hardhat node (chain id 8453) ...");
    const node = await startNode(path.join(outDir, "node.log"));
    cleanup.push(() => node.stop());
    const chain = new Chain(node.url);
    say(`node at ${node.url}; deploying v1, the tokens and v2 ...`);
    const world = await deployWorld(chain);
    say(`v2 at ${world.v2Address}, block ${world.launch.block}, ${world.launch.date}; v1 paused in ${world.v1PauseTx}`);

    say("copying site/ and running scripts/set-launch-values.js against the copy ...");
    const prepared = prepareSite(world.launch, node.url);
    fs.writeFileSync(path.join(outDir, "set-launch-values.log"), prepared.output);
    cleanup.push(() => fs.rmSync(prepared.root, { recursive: true, force: true }));
    const server = await serveSite(prepared.root, path.join(outDir, "serve-site.log"));
    cleanup.push(() => server.stop());
    say(`site copy served at ${server.origin}/app (root ${prepared.root})`);

    const browser = await launchBrowser();
    cleanup.push(() => browser.close());
    say(`Chrome ${browser.version()} launched; running ${selected.length} scenario(s)`);

    let snapshot = await chain.snapshot();
    const results = [];
    for (const scenario of selected) {
      await chain.revert(snapshot);
      snapshot = await chain.snapshot();
      const session = new Session({ browser, site: server, nodeUrl: node.url, world });
      const t = new Harness({ chain, world, session, prepared, outDir });
      const begin = Date.now();
      let error = null;
      try {
        await session.open(scenario.session || {});
        await scenario.run(t);
        session.checkClean();
        if (t.soft.length) throw new TestFailure(`${t.soft.length} check(s) failed:\n  ${t.soft.join("\n  ")}`);
      } catch (caught) {
        error = caught;
        const shot = path.join(outDir, `${scenario.name.replace(/[^a-z0-9]+/gi, "-")}.png`);
        await session.page?.screenshot({ path: shot, fullPage: true }).catch(() => {});
        error.screenshot = shot;
        // Problems recorded before the failure explain it more often than not.
        const extra = [...session.problems, ...session.unexpectedRequests];
        if (extra.length && !(caught instanceof TestFailure && /page reported problems/.test(caught.message))) {
          error.extra = extra;
        }
        if (t.soft.length && !/check\(s\) failed/.test(caught.message)) error.extra = [...(error.extra || []), ...t.soft];
      } finally {
        await session.close();
      }
      const took = Date.now() - begin;
      results.push({ name: scenario.name, error, took, steps: t.steps });
      if (!error) {
        say(`PASS  ${scenario.name} (${secs(took)})`);
      } else {
        say(`FAIL  ${scenario.name} (${secs(took)})`);
        console.log(`      after step: ${t.steps[t.steps.length - 1] || "(none)"}`);
        console.log(`      ${String(error.message || error).split("\n").join("\n      ")}`);
        if (!(error instanceof TestFailure) && error.stack) console.log(`      ${error.stack.split("\n").slice(1, 6).join("\n      ")}`);
        if (error.extra) console.log(`      also recorded:\n        ${error.extra.join("\n        ")}`);
        console.log(`      screenshot: ${error.screenshot}`);
      }
    }

    const failed = results.filter((r) => r.error);
    console.log("");
    console.log(`${results.length - failed.length} passed, ${failed.length} failed, in ${secs(Date.now() - started)}. ` +
      `Logs: ${outDir}`);
    for (const r of results) console.log(`  ${r.error ? "FAIL" : "pass"}  ${r.name}`);
    return failed.length ? 1 : 0;
  } finally {
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch {
        // best effort
      }
    }
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
