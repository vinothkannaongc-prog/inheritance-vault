#!/usr/bin/env node
/*
 * Fills in the v2 launch values wherever the site and the docs hold a launch marker.
 *
 *   node scripts/set-launch-values.js --address 0x.. --block N --tx 0x.. --date "28 September 2026"
 *        [--v1-pause-tx 0x..] [--chain 8453|84532] [--root <dir>] [--rpc <url>] [--offline] [--dry-run]
 *
 * Base mainnet (--chain 8453, the default) replaces these markers:
 *   V2_ADDRESS_TBD   --address, which must be pasted in its EIP-55 checksummed form
 *   V2_BLOCK_TBD     --block, the block the v2 contract was created in
 *   V2_TX_TBD        --tx, the deploy transaction
 *   V2_DATE_TBD      --date, the deploy block's UTC date, as "28 September 2026"
 *   V2_DATE_ISO_TBD  the same date as 2026-09-28
 *   V2_KECCAK_TBD    keccak-256 of the runtime code read from the chain (its EXTCODEHASH)
 *   V2_SHA256_TBD    SHA-256 of the same raw bytes
 *   V1_PAUSE_TX_TBD  --v1-pause-tx, v1's setCreationPaused(true). Optional: without it that
 *                    marker stays in place, and the script says so.
 * in every text file under site/, in README.md, SECURITY.md, AUDIT_SCOPE.md and DEPLOY.md (all
 * required: a root without them is refused), and, when present, in audit/2026-09-preliminary/
 * REPORT.md and the audit report generator's inputs (tmp/audit-2026-09-workbench/report-gen/*.cjs,
 * where V2_DATE_ISO_TBD is left alone because the generator derives it from the date).
 * site/assets/app.js carries V2_KECCAK_TBD too: the app refuses a contract whose code hash differs.
 *
 * Before writing anything it checks the values on chain (--rpc, by default the chain's public
 * endpoint): the transaction created a contract at --address in block --block, that contract is
 * a v2 vault (its HB_DOMAIN), --date is that block's UTC date, and the v1 pause transaction
 * logged CreationPauseSet(true) on v1. On Base it also reads back what the launch plan fixes:
 * the hot key sent the deploy transaction, owner() and feeRecipient() are the Ledger,
 * claimFeeBps() is 50, supportedTokens() is USDC, WETH, cbBTC and EURC in that order, and
 * wrappedNative() is WETH, because the documents state all of these as facts.
 * Every file is then changed in memory, and nothing is written unless every marker found is one
 * this script knows, and the result names exactly the verified values where the app reads them:
 * the chain's entry in site/assets/app.js (contract, deployBlock, codehash) and, on Base, the
 * deployment links in site/app.html's footer. That also catches a value an earlier run or a hand
 * edit left in place, which no marker would show. --dry-run writes nothing. --offline skips the
 * on-chain checks and therefore implies --dry-run: it only previews which markers would change.
 *
 * Base Sepolia (--chain 84532) fills only the app's testnet slot (the BASE_SEPOLIA_V2_ADDRESS_UNSET,
 * BASE_SEPOLIA_V2_BLOCK_UNSET and BASE_SEPOLIA_V2_KECCAK_UNSET placeholders in site/assets/app.js)
 * and touches no document.
 *
 * Afterwards run `node scripts/validate-site.js`: it fails while any *_TBD marker remains in site/.
 * Exit codes: 0 done (markers may be left in place, as reported; with --offline or --dry-run,
 * nothing written), 1 refused or failed (nothing written), 2 usage.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const V1_ADDRESS = "0xC821849A1D74959753450409b594b23eCE7fEe2f";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const CHAINS = {
  8453: { name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  84532: { name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
};
// What the launch plan fixes for the Base deployment, and the documents state as fact. The token
// list and wrappedNative are immutable; the others are what the constructor set.
const LEDGER = "0x883C821103B5415C53B11E584D3592205B5CdCA3";
const PLAN = {
  8453: {
    deployer: "0x4306a8875a04c0FbaC76CE2FC860E0b3c7aAd986",
    admin: LEDGER,
    feeRecipient: LEDGER,
    claimFeeBps: 50n,
    tokens: [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
      "0x4200000000000000000000000000000000000006", // WETH
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
      "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
    ],
    wrappedNative: "0x4200000000000000000000000000000000000006",
  },
};
const DOCS = ["README.md", "SECURITY.md", "AUDIT_SCOPE.md", "DEPLOY.md"];
const REPORT = path.join("audit", "2026-09-preliminary", "REPORT.md");
const REPORT_GEN = path.join("tmp", "audit-2026-09-workbench", "report-gen");
const TEXT_EXT = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".xml", ".txt", ".json", ".md", ".svg",
  ".webmanifest"]);
const TEXT_NAMES = new Set(["_headers", "_redirects"]);
const MARKER = /\b[A-Z][A-Z0-9_]*_TBD\b/g;
const TESTNET = {
  address: "BASE_SEPOLIA_V2_ADDRESS_UNSET", block: "BASE_SEPOLIA_V2_BLOCK_UNSET", keccak: "BASE_SEPOLIA_V2_KECCAK_UNSET",
};

// ------------------------------------------------------------------------------ keccak-256
// Ethereum's keccak-256 (the original Keccak padding, not NIST SHA3-256, which Node's crypto has),
// for EIP-55 checksums, selectors and the EXTCODEHASH. No dependency, so the script runs anywhere.

const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets r[x][y] for the lane at index x + 5y.
const ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
].map((row) => row.map(BigInt));

const rotl = (value, bits) => (bits === 0n ? value : ((value << bits) | (value >> (64n - bits))) & MASK64);

function keccakF(state) {
  for (let round = 0; round < 24; round += 1) {
    const c = [0, 1, 2, 3, 4].map((x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATIONS[x][y]);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
      }
    }
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

function keccak256(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((bytes.length + 1) / rate) * rate);
  bytes.copy(padded);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
    keccakF(state);
  }
  const out = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) out.writeBigUInt64LE(state[lane], lane * 8);
  return out;
}

// EIP-55: the checksummed form of a 0x-prefixed 40-hex-character address.
function checksum(address) {
  const hex = address.slice(2).toLowerCase();
  const hash = keccak256(Buffer.from(hex, "ascii")).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i += 1) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

const selector = (signature) => `0x${keccak256(Buffer.from(signature, "utf8")).toString("hex").slice(0, 8)}`;

// ------------------------------------------------------------------------------ arguments

class Refusal extends Error {}

const USAGE = "usage: node scripts/set-launch-values.js --address 0x.. --block N --tx 0x.. --date \"28 September 2026\" " +
  "[--v1-pause-tx 0x..] [--chain 8453|84532] [--root <dir>] [--rpc <url>] [--offline] [--dry-run]";

function parseArgs(argv) {
  const flags = new Set(["offline", "dry-run", "help"]);
  const valued = new Set(["address", "block", "tx", "date", "v1-pause-tx", "chain", "root", "rpc"]);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Refusal(`unexpected argument "${arg}"`);
    const [, name, inline] = match;
    if (flags.has(name)) {
      if (inline !== undefined) throw new Refusal(`--${name} takes no value`);
      out[name] = true;
    } else if (valued.has(name)) {
      const value = inline !== undefined ? inline : argv[(i += 1)];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Refusal(`--${name} needs a value`);
      if (out[name] !== undefined) throw new Refusal(`--${name} is given twice`);
      out[name] = value.trim();
    } else {
      throw new Refusal(`unknown option --${name}`);
    }
  }
  return out;
}

// The address exactly as pasted must carry a valid EIP-55 checksum: a lower- or upper-case
// address has none, so a mistyped character in it could not be detected.
function readAddress(value, option) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Refusal(`${option} "${value}" is not 0x followed by 40 hex characters`);
  const hex = value.slice(2);
  if (!/[a-f]/.test(hex) || !/[A-F]/.test(hex)) {
    throw new Refusal(`${option} ${value} carries no checksum (all one case). Paste the checksummed form the deploy ` +
      `script printed; its checksum is ${checksum(value)}.`);
  }
  if (checksum(value) !== value) {
    throw new Refusal(`${option} ${value} fails its EIP-55 checksum, so at least one character is wrong. Copy it again ` +
      "from the deploy record.");
  }
  return value;
}

function readHash(value, option) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Refusal(`${option} "${value}" is not a transaction hash (0x and 64 hex characters)`);
  return value.toLowerCase();
}

// "28 September 2026" -> { text: "28 September 2026", iso: "2026-09-28" }. A real calendar day only.
function readDate(value) {
  const match = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value.replace(/\s+/g, " "));
  const month = match ? MONTHS.findIndex((name) => name.toLowerCase() === match[2].toLowerCase()) : -1;
  if (!match || month < 0) throw new Refusal(`--date "${value}" must look like "28 September 2026" (day, month name, year)`);
  const day = Number(match[1]);
  const year = Number(match[3]);
  const time = Date.UTC(year, month, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Refusal(`--date "${value}" is not a real calendar date`);
  }
  return { text: `${day} ${MONTHS[month]} ${year}`, iso: date.toISOString().slice(0, 10) };
}

function utcDateText(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// ------------------------------------------------------------------------------ chain checks

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// An ABI-encoded address[] return value (offset, length, then one word per address).
function decodeAddressArray(hex) {
  const words = hex.slice(2).match(/.{64}/g) || [];
  const start = words.length ? Number(BigInt(`0x${words[0]}`) / 32n) : -1;
  const length = start >= 0 && start < words.length ? Number(BigInt(`0x${words[start]}`)) : -1;
  if (length < 0 || length > 64 || start + 1 + length > words.length) {
    throw new Refusal("supportedTokens() returned data that is not a list of addresses");
  }
  return words.slice(start + 1, start + 1 + length).map((word) => checksum(`0x${word.slice(24)}`));
}

// One JSON-RPC call, retried on a network error or a rate limit (the public endpoints answer
// HTTP 429 or -32016 "over rate limit" after a burst).
async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt += 1) {
    let response = null;
    let body = null;
    try {
      response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      if (attempt < 4) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`${method} failed: ${error.message}`);
    }
    const limited = response.status === 429 || body?.error?.code === -32016 || /rate.?limit/i.test(body?.error?.message || "");
    if (limited && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (body?.error) throw new Error(`${method} failed: ${body.error.message}`);
    if (!response.ok || !body || !("result" in body)) throw new Error(`${method} failed: HTTP ${response.status}`);
    return body.result;
  }
}

// Everything the markers claim, checked against the chain. Returns what was read.
async function verifyOnChain(opts) {
  const { url, chainId, address, block, tx, date, v1PauseTx } = opts;
  const lines = [];
  const remoteChain = Number(await rpc(url, "eth_chainId", []));
  if (remoteChain !== chainId) throw new Refusal(`${url} is chain ${remoteChain}, not ${chainId}`);

  const receipt = await rpc(url, "eth_getTransactionReceipt", [tx]);
  if (!receipt) throw new Refusal(`transaction ${tx} was not found on chain ${chainId} (not mined, or a typo)`);
  if (receipt.status !== "0x1") throw new Refusal(`transaction ${tx} reverted`);
  if (!receipt.contractAddress) throw new Refusal(`transaction ${tx} did not create a contract`);
  if (receipt.contractAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Refusal(`transaction ${tx} created ${checksum(receipt.contractAddress)}, not ${address}`);
  }
  if (Number(receipt.blockNumber) !== block) {
    throw new Refusal(`transaction ${tx} was mined in block ${Number(receipt.blockNumber)}, not ${block}`);
  }
  lines.push(`transaction ${tx} created ${address} in block ${block} (status 1)`);

  const header = await rpc(url, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  const blockDate = utcDateText(Number(header.timestamp));
  if (blockDate !== date.text) {
    throw new Refusal(`block ${block} is dated ${blockDate} (UTC), not ${date.text}: pass --date "${blockDate}"`);
  }
  lines.push(`block ${block} is dated ${blockDate} (UTC)`);

  const code = await rpc(url, "eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal(`${address} has no code on chain ${chainId}`);
  const domain = await rpc(url, "eth_call", [{ to: address, data: selector("HB_DOMAIN()") }, "latest"]);
  const expected = `0x${keccak256(Buffer.from("WillAndKey.CheckInChain.v2", "utf8")).toString("hex")}`;
  if (String(domain).toLowerCase() !== expected) {
    throw new Refusal(`${address} does not answer HB_DOMAIN() with v2's domain tag, so it is not a Will & Key v2 vault`);
  }
  const bytes = Buffer.from(code.slice(2), "hex");
  const keccak = keccak256(bytes).toString("hex");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  lines.push(`its runtime code is ${bytes.length.toLocaleString("en-US")} bytes and answers v2's HB_DOMAIN(); ` +
    `keccak-256 ${keccak}, SHA-256 ${sha256}`);

  // What the constructor set, read back. On Base each must be what the launch plan says.
  const call = async (signature) => {
    const out = await rpc(url, "eth_call", [{ to: address, data: selector(signature) }, "latest"]);
    if (typeof out !== "string" || !/^0x([0-9a-fA-F]{64})+$/.test(out)) {
      throw new Refusal(`${address} returned no value for ${signature}, so it is not a Will & Key v2 vault`);
    }
    return out;
  };
  const words = (hex) => hex.slice(2).match(/.{64}/g);
  const asAddress = (word) => checksum(`0x${word.slice(24)}`);
  const settings = {
    deployer: checksum(String(receipt.from)),
    admin: asAddress(words(await call("owner()"))[0]),
    feeRecipient: asAddress(words(await call("feeRecipient()"))[0]),
    claimFeeBps: BigInt(`0x${words(await call("claimFeeBps()"))[0]}`),
    tokens: decodeAddressArray(await call("supportedTokens()")),
    wrappedNative: asAddress(words(await call("wrappedNative()"))[0]),
  };
  lines.push(`deployed by ${settings.deployer}; owner() ${settings.admin}; feeRecipient() ${settings.feeRecipient}; ` +
    `claimFeeBps() ${settings.claimFeeBps}; supportedTokens() ${settings.tokens.join(", ") || "none"}; ` +
    `wrappedNative() ${settings.wrappedNative}`);
  const plan = PLAN[chainId];
  if (plan) {
    const wrong = [];
    const differs = (a, b) => String(a).toLowerCase() !== String(b).toLowerCase();
    if (differs(settings.deployer, plan.deployer)) wrong.push(`the deploy transaction was sent by ${settings.deployer}, not ${plan.deployer}`);
    if (differs(settings.admin, plan.admin)) wrong.push(`owner() is ${settings.admin}, not ${plan.admin}`);
    if (differs(settings.feeRecipient, plan.feeRecipient)) wrong.push(`feeRecipient() is ${settings.feeRecipient}, not ${plan.feeRecipient}`);
    if (settings.claimFeeBps !== plan.claimFeeBps) wrong.push(`claimFeeBps() is ${settings.claimFeeBps}, not ${plan.claimFeeBps}`);
    if (settings.tokens.length !== plan.tokens.length || settings.tokens.some((token, i) => differs(token, plan.tokens[i]))) {
      wrong.push(`supportedTokens() is [${settings.tokens.join(", ")}], not [${plan.tokens.join(", ")}] in that order`);
    }
    if (differs(settings.wrappedNative, plan.wrappedNative)) wrong.push(`wrappedNative() is ${settings.wrappedNative}, not ${plan.wrappedNative}`);
    if (wrong.length) {
      throw new Refusal(`${address} is not the deployment the launch plan and the documents describe: ${wrong.join("; ")}. ` +
        "Nothing was changed. The documents must be corrected for this deployment first, or the right deployment named.");
    }
    lines.push("these match the launch plan");
  }

  if (v1PauseTx) {
    const pause = await rpc(url, "eth_getTransactionReceipt", [v1PauseTx]);
    if (!pause) throw new Refusal(`v1 pause transaction ${v1PauseTx} was not found on chain ${chainId}`);
    if (pause.status !== "0x1") throw new Refusal(`v1 pause transaction ${v1PauseTx} reverted`);
    const topic = `0x${keccak256(Buffer.from("CreationPauseSet(bool)", "utf8")).toString("hex")}`;
    const paused = (pause.logs || []).some((log) => log.address.toLowerCase() === V1_ADDRESS.toLowerCase()
      && log.topics?.[0]?.toLowerCase() === topic && BigInt(log.data) === 1n);
    if (!paused) throw new Refusal(`transaction ${v1PauseTx} did not log CreationPauseSet(true) on v1 (${V1_ADDRESS})`);
    lines.push(`transaction ${v1PauseTx} logged CreationPauseSet(true) on v1`);
    const now = await rpc(url, "eth_call", [{ to: V1_ADDRESS, data: selector("creationPaused()") }, "latest"]);
    if (BigInt(now) !== 1n) lines.push(`WARNING: v1's creationPaused() reads false now: creation was paused, then resumed`);
  }
  return { lines, keccak, sha256 };
}

// ------------------------------------------------------------------------------ files

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const isText = (file) => TEXT_EXT.has(path.extname(file).toLowerCase()) || TEXT_NAMES.has(path.basename(file));

// The files each run may change: [{ file, group }], or a Refusal naming what is missing.
function targets(root, chainId) {
  const site = path.join(root, "site");
  const missing = [];
  if (!fs.existsSync(path.join(site, "assets", "app.js"))) missing.push("site/assets/app.js");
  if (chainId === 8453) for (const doc of DOCS) if (!fs.existsSync(path.join(root, doc))) missing.push(doc);
  if (missing.length) {
    throw new Refusal(`${root} is not the Will & Key repository, or it is incomplete: ${missing.join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} missing. Nothing was changed.`);
  }
  const out = walk(site).filter(isText).map((file) => ({ file, group: "site" }));
  if (chainId !== 8453) return out;
  for (const doc of DOCS) out.push({ file: path.join(root, doc), group: "docs" });
  if (fs.existsSync(path.join(root, REPORT))) out.push({ file: path.join(root, REPORT), group: "report" });
  const generator = path.join(root, REPORT_GEN);
  if (fs.existsSync(generator)) {
    for (const file of walk(generator)) {
      if (file.endsWith(".cjs") && !file.endsWith(".before-lead.cjs")) out.push({ file, group: "generator" });
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Replaces every marker with a value in `text`. Returns the new text and what happened.
function replaceMarkers(text, values, skip) {
  const replaced = new Map();
  const left = [];
  const unknown = [];
  const out = text.replace(MARKER, (marker, index) => {
    if (skip.has(marker)) return marker;
    if (!(marker in values)) {
      unknown.push({ marker, line: lineOf(text, index) });
      return marker;
    }
    if (values[marker] === null) {
      left.push({ marker, line: lineOf(text, index) });
      return marker;
    }
    replaced.set(marker, (replaced.get(marker) || 0) + 1);
    return values[marker];
  });
  return { out, replaced, left, unknown };
}

// The fields of one chain's entry in site/assets/app.js's CHAINS table (`  8453: {` to `  },`),
// or null when the entry is missing.
function appSlot(text, chainId) {
  const start = text.indexOf(`\n  ${chainId}: {`);
  if (start < 0) return null;
  const end = text.indexOf("\n  },", start);
  const body = text.slice(start, end < 0 ? undefined : end);
  const field = (name) => (new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(body) || [])[1] ?? null;
  return { contract: field("contract"), deployBlock: field("deployBlock"), codehash: field("codehash") };
}

// What the finished files publish where the app reads the deployment, checked against the verified
// values. `texts` maps a path relative to the root to the file's final text. A value that an earlier
// run or a hand edit left in place is not a marker, so replacing the markers alone cannot catch it.
function checkPublished(texts, chainId, { address, block, tx, keccak }) {
  const problems = [];
  const app = texts.get("site/assets/app.js");
  const slot = app ? appSlot(app, chainId) : null;
  if (!slot) {
    problems.push(`site/assets/app.js has no entry for chain ${chainId}`);
  } else {
    if (slot.contract !== address) problems.push(`site/assets/app.js names the contract "${slot.contract}", not ${address}`);
    if (slot.deployBlock !== String(block)) problems.push(`site/assets/app.js names deployBlock "${slot.deployBlock}", not ${block}`);
    if (keccak && String(slot.codehash).replace(/^0x/i, "").toLowerCase() !== keccak) {
      problems.push(`site/assets/app.js names codehash "${slot.codehash}", not the code's keccak-256 ${keccak}`);
    }
  }
  if (chainId === 8453) {
    const html = texts.get("site/app.html") || "";
    const footer = (/<div class="footer-contract">([\s\S]*?)<\/div>/.exec(html) || [])[1];
    if (!footer) {
      problems.push("site/app.html has no deployment footer (div.footer-contract)");
    } else {
      const links = [...footer.matchAll(/href="https:\/\/basescan\.org\/(address|block|tx)\/([^"]*)"/g)];
      const expected = { address, block: String(block), tx };
      for (const kind of Object.keys(expected)) {
        const found = links.filter((link) => link[1] === kind).map((link) => link[2]);
        if (found.length !== 1 || found[0] !== expected[kind]) {
          problems.push(`site/app.html's footer links ${kind} ${found.join(", ") || "nothing"}, not ${expected[kind]}`);
        }
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const chainId = Number(args.chain ?? 8453);
  if (!CHAINS[chainId]) throw new Refusal(`--chain must be 8453 (Base) or 84532 (Base Sepolia), not "${args.chain}"`);
  for (const option of ["address", "block", "tx", "date"]) {
    if (!args[option]) throw new Refusal(`--${option} is required`);
  }
  const address = readAddress(args.address, "--address");
  if (address.toLowerCase() === V1_ADDRESS.toLowerCase()) throw new Refusal("--address is the retired v1 contract, not v2");
  if (!/^[1-9]\d*$/.test(args.block) || !Number.isSafeInteger(Number(args.block))) {
    throw new Refusal(`--block "${args.block}" is not a block number`);
  }
  const block = Number(args.block);
  const tx = readHash(args.tx, "--tx");
  const date = readDate(args.date);
  let v1PauseTx = null;
  if (args["v1-pause-tx"] !== undefined) {
    if (chainId !== 8453) throw new Refusal("--v1-pause-tx is a Base mainnet value; it does not go with --chain 84532");
    v1PauseTx = readHash(args["v1-pause-tx"], "--v1-pause-tx");
    if (v1PauseTx === tx) throw new Refusal("--v1-pause-tx is the same hash as --tx");
  }
  const root = path.resolve(args.root ?? path.join(__dirname, ".."));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Refusal(`--root ${root} is not a directory`);
  const files = targets(root, chainId);
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");

  console.log(`Launch values for ${CHAINS[chainId].name} (chain ${chainId}), root ${root}`);
  // Nothing unchecked is ever written: --offline only previews.
  const dryRun = Boolean(args["dry-run"] || args.offline);
  let fingerprints = null;
  if (args.offline) {
    console.log("--offline: nothing was checked on chain, so nothing will be written (a preview, as with --dry-run).");
  } else {
    const url = args.rpc ?? CHAINS[chainId].rpc;
    console.log(`Checking on chain through ${url} ...`);
    let result;
    try {
      result = await verifyOnChain({ url, chainId, address, block, tx, date, v1PauseTx });
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal(`the on-chain check could not run (${error.message}). Nothing was changed. Retry, or pass ` +
        "--rpc <url> to use another endpoint.");
    }
    for (const line of result.lines) console.log(`  ${line}`);
    fingerprints = result;
  }

  let values;
  if (chainId === 8453) {
    values = {
      V2_ADDRESS_TBD: address,
      V2_BLOCK_TBD: String(block),
      V2_TX_TBD: tx,
      V2_DATE_TBD: date.text,
      V2_DATE_ISO_TBD: date.iso,
      V2_KECCAK_TBD: fingerprints ? fingerprints.keccak : null,
      V2_SHA256_TBD: fingerprints ? fingerprints.sha256 : null,
      V1_PAUSE_TX_TBD: v1PauseTx,
    };
  } else {
    values = {};
  }
  const testnet = chainId === 84532;

  const changes = [];
  const left = [];
  const unknown = [];
  const finalTexts = new Map();
  let replacedTotal = 0;
  for (const { file, group } of files) {
    const text = fs.readFileSync(file, "utf8");
    let result;
    if (testnet) {
      // Only the app's testnet slot; the *_TBD markers belong to the mainnet launch.
      let count = 0;
      let out = text
        .replace(new RegExp(`\\b${TESTNET.address}\\b`, "g"), () => { count += 1; return address; })
        .replace(new RegExp(`\\b${TESTNET.block}\\b`, "g"), () => { count += 1; return String(block); });
      if (fingerprints) out = out.replace(new RegExp(`\\b${TESTNET.keccak}\\b`, "g"), () => { count += 1; return fingerprints.keccak; });
      result = { out, replaced: new Map(count ? [["testnet slot", count]] : []), left: [], unknown: [] };
    } else {
      // The report generator derives V2_DATE_ISO_TBD from the date itself.
      result = replaceMarkers(text, values, new Set(group === "generator" ? ["V2_DATE_ISO_TBD"] : []));
    }
    for (const entry of result.left) left.push({ file: rel(file), ...entry });
    for (const entry of result.unknown) unknown.push({ file: rel(file), ...entry });
    finalTexts.set(rel(file), result.out);
    if (result.out !== text) {
      changes.push({ file, out: result.out, replaced: result.replaced });
      for (const count of result.replaced.values()) replacedTotal += count;
    }
  }

  // Every check comes before the first write, so a refused run changes nothing.
  if (unknown.length) {
    console.log("\nUnknown markers (this script has no value for them):");
    for (const entry of unknown) console.log(`  ${entry.file}:${entry.line} ${entry.marker}`);
    throw new Refusal(`${unknown.length} marker${unknown.length === 1 ? "" : "s"} this script does not know ` +
      `${unknown.length === 1 ? "is" : "are"} in the files (listed above). Nothing was changed. Add the value to this ` +
      "script, or correct the marker, and run it again.");
  }
  if (!changes.length) {
    // Nothing to replace: either already done with these values, or done with other values.
    const haystack = [...finalTexts.values()].join("\n");
    if (!haystack.includes(address)) {
      throw new Refusal(`No launch markers were found, and ${address} appears in none of the files: the launch values ` +
        "seem to have been set already, to something else. Nothing was changed. Restore the files from git to redo it.");
    }
    console.log(`No markers left to replace for these values; ${address} is already in the files.`);
  }
  if (fingerprints) {
    const problems = checkPublished(finalTexts, chainId, { address, block, tx, keccak: fingerprints.keccak });
    if (problems.length) {
      throw new Refusal(`after replacing the markers the site would still publish other values than the ones just ` +
        `verified: ${problems.join("; ")}. Nothing was changed. An earlier run, or a hand edit, left those values in ` +
        "place: restore the files from git, then run this script once with the right values.");
    }
    console.log("The app's entry for this chain" + (chainId === 8453 ? " and app.html's deployment footer" : "") +
      " name exactly the verified values.");
  }

  console.log(dryRun ? `\nWould change (${args.offline ? "--offline" : "--dry-run"}: nothing written):` : "\nChanged:");
  for (const change of changes) {
    const detail = [...change.replaced].map(([marker, count]) => `${marker} x${count}`).join(", ");
    console.log(`  ${rel(change.file)}: ${detail}`);
  }
  if (!dryRun) {
    for (const change of changes) fs.writeFileSync(change.file, change.out, "utf8");
  }
  console.log(`${replacedTotal} marker${replacedTotal === 1 ? "" : "s"} ${dryRun ? "would be replaced" : "replaced"} ` +
    `in ${changes.length} file${changes.length === 1 ? "" : "s"}.`);

  if (left.length) {
    const why = {
      V1_PAUSE_TX_TBD: "no --v1-pause-tx was given",
      V2_KECCAK_TBD: "--offline: the runtime code was not read",
      V2_SHA256_TBD: "--offline: the runtime code was not read",
    };
    console.log(`\n${dryRun ? "Would be left" : "Left"} in place:`);
    for (const entry of left) console.log(`  ${entry.file}:${entry.line} ${entry.marker} (${why[entry.marker] || "no value"})`);
    if (left.some((entry) => entry.file.startsWith("site/"))) {
      console.log("  Markers remain in site/, so scripts/validate-site.js fails until they are filled in: run this " +
        "script again with the missing value.");
    }
  }
  if (args.offline) {
    console.log("\nNothing was written. Run again without --offline to check the values on chain and write them.");
    return 0;
  }
  console.log(dryRun ? "\nNothing was written (--dry-run)." : "\nNext: node scripts/validate-site.js");
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    if (error instanceof Refusal) {
      console.error(`Refused: ${error.message}`);
      process.exitCode = /required|unexpected argument|unknown option|needs a value|given twice|takes no value/.test(error.message)
        ? 2 : 1;
      if (process.exitCode === 2) console.error(USAGE);
    } else {
      console.error(error.stack || String(error));
      process.exitCode = 1;
    }
  });
}

module.exports = { keccak256, checksum, readDate, readAddress, replaceMarkers, appSlot, checkPublished, decodeAddressArray };
