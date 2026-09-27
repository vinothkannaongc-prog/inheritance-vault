"use strict";
// The site under test: a TEMPORARY COPY of site/ (the repository's site/ is never written), with
// the launch markers filled in by the repository's own scripts/set-launch-values.js from the
// local deployment, served by an unmodified copy of scripts/serve-site.js (clean URLs, the
// _redirects table and every production header from _headers, the CSP included).

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REPO, freePort } = require("./chain");
const { sleep } = require("./util");

const DOCS = ["README.md", "SECURITY.md", "AUDIT_SCOPE.md", "DEPLOY.md"];
const MARKER = /\b[A-Z][A-Z0-9_]*_TBD\b/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * A new temporary root holding a copy of site/, the four documents set-launch-values.js insists
 * on, and copies of the two scripts that run inside it (serve-site.js and validate-site.js, which
 * both work on the site/ next to their own folder). No launch value is filled in yet.
 */
function copySite(prefix = "willandkey-e2e-site-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(REPO, "site"), path.join(root, "site"), { recursive: true });
  for (const doc of DOCS) fs.copyFileSync(path.join(REPO, doc), path.join(root, doc));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const script of ["serve-site.js", "validate-site.js"]) {
    fs.copyFileSync(path.join(REPO, "scripts", script), path.join(root, "scripts", script));
  }
  return root;
}

/** Runs the repository's scripts/set-launch-values.js against `root` with `args`. */
function setLaunchValues(root, args) {
  const run = spawnSync(process.execPath, [path.join(REPO, "scripts", "set-launch-values.js"), "--root", root, ...args],
    { cwd: REPO, encoding: "utf8", windowsHide: true });
  return { status: run.status, output: `${run.stdout || ""}${run.stderr || ""}` };
}

/** The launch arguments for `launch` (world.launch), checked on chain through `nodeUrl`. */
function launchArgs(launch, nodeUrl) {
  return [
    "--address", launch.address,
    "--block", String(launch.block),
    "--tx", launch.tx,
    "--date", launch.date,
    "--v1-pause-tx", launch.v1PauseTx,
    "--rpc", nodeUrl,
  ];
}

/** Runs the copied scripts/validate-site.js inside `root` (it validates root/site). */
function validateCopy(root) {
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "validate-site.js")],
    { cwd: root, encoding: "utf8", windowsHide: true });
  return { status: run.status, output: `${run.stdout || ""}${run.stderr || ""}` };
}

/** Every file under `root` with its content, to prove a refused run wrote nothing. */
function snapshotFiles(root) {
  const out = new Map();
  for (const file of walk(root)) out.set(path.relative(root, file), fs.readFileSync(file).toString("base64"));
  return out;
}

/** The files that differ between two snapshots (added, removed or changed). */
function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

/**
 * Copies site/ (and the four documents set-launch-values.js insists on) into a new temporary
 * root, then runs set-launch-values.js against it WITH its on-chain checks, pointed at the local
 * node. Returns the root and the script's output.
 */
function prepareSite(launch, nodeUrl) {
  const root = copySite();
  const run = setLaunchValues(root, launchArgs(launch, nodeUrl));
  if (run.status !== 0) {
    throw new Error(`scripts/set-launch-values.js exited ${run.status} against the temporary copy:\n${run.output}`);
  }
  const left = [];
  for (const file of walk(path.join(root, "site"))) {
    if (/\.(png|jpe?g|webp|gif|ico|woff2?|pdf)$/i.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const hit of text.matchAll(MARKER)) left.push(`${path.relative(root, file)}: ${hit[0]}`);
  }
  return { root, output: run.output, left };
}

/** Serves `root`/site with the copied scripts/serve-site.js on a free port. */
async function serveSite(root, logFile) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "scripts", "serve-site.js"), String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const log = fs.createWriteStream(logFile);
  let text = "";
  child.stdout.on("data", (chunk) => { text += chunk; log.write(chunk); });
  child.stderr.on("data", (chunk) => { text += chunk; log.write(chunk); });
  const end = Date.now() + 20000;
  while (!text.includes("willandkey preview")) {
    if (child.exitCode !== null) throw new Error(`serve-site.js exited ${child.exitCode}: ${text}`);
    if (Date.now() > end) throw new Error(`serve-site.js did not start: ${text}`);
    await sleep(50);
  }
  return {
    origin: `http://localhost:${port}`,
    port,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(resolve, 3000);
    }),
  };
}

module.exports = {
  prepareSite, serveSite, copySite, setLaunchValues, launchArgs, validateCopy, snapshotFiles, changedFiles,
};
