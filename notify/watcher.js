#!/usr/bin/env node
/* Will & Key watcher: reads public vault state, sends escalating reminders.
 *
 * Design constraints, in order:
 *   1. Holds no keys and can sign nothing. It reads getOpenVaults() and sends email.
 *   2. Run-to-completion. Invoked by cron; no daemon, no queue, nothing to babysit.
 *   3. Missing a run is safe. Alerts key off absolute deadlines, not run cadence —
 *      the next run sends whatever is due. Duplicate-send is prevented by state.json,
 *      and a check-in re-arms alerts naturally because the deadline value changes.
 *
 * Usage: node watcher.js --config config.json
 * Transport: config.smtp present -> nodemailer; absent -> .txt files in outboxDir (dev mode).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const VAULT_ABI = [
  "function getOpenVaults(address) view returns (tuple(address owner, uint256 vaultId, uint8 state, address beneficiary, address token, uint128 balance, uint16 feeBps, uint64 createdAt, uint64 deadline, uint64 absoluteDeadline, uint64 guaranteedInheritanceAt, uint32 inactivityPeriod, uint32 challengeWindow, bool expired, bool horizonReached, address claimRecipient, uint64 claimInitiatedAt, uint64 finalizableAt, bool finalizable, bytes32 hbAnchor, uint32 hbLeft, uint16 warnings)[])",
];
const SUB_ABI = ["function paidUntil(address) view returns (uint64)"];

const DAY = 86400;
// Reminder tiers, in days before the deadline. Ordered most-urgent-first so a single
// run that finds a vault 2 days from expiry sends the 3-day alert, not four alerts.
const REMINDER_TIERS = [1, 3, 7, 14];
const HORIZON_WARN_DAYS = 30;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const configPath = path.resolve(arg("config", "config.json"));
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const baseDir = path.dirname(configPath);
const statePath = path.resolve(baseDir, cfg.stateFile || "state.json");
const outboxDir = path.resolve(baseDir, cfg.outboxDir || "outbox");

const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { sent: {} };

function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
function fmtDate(ts) { return new Date(Number(ts) * 1000).toUTCString(); }
function daysUntil(ts, now) { return (Number(ts) - now) / DAY; }

/** One send per unique key. The key embeds the value it alerts about (deadline,
 * claimInitiatedAt…), so when that value changes the alert re-arms by construction. */
function shouldSend(key) {
  if (state.sent[key]) return false;
  state.sent[key] = new Date().toISOString();
  return true;
}

const queue = [];
function enqueue(to, subject, body) {
  if (!to) return;
  queue.push({ to, subject, body });
}

function vaultLabel(w, v) {
  return `${w.label || short(w.owner)} — vault #${v.vaultId}`;
}

function appLink() { return cfg.appUrl || "https://willandkey.com/app.html"; }

function ownerAlerts(w, v, now) {
  const id = `${w.owner}:${v.vaultId}`;
  const dl = Number(v.deadline);

  if (Number(v.state) === 2) {
    // A claim is running. This is the alert the whole service exists for.
    if (shouldSend(`${id}:claim:${v.claimInitiatedAt}`)) {
      enqueue(w.email,
        `ACTION NEEDED: an inheritance claim is running on your vault (${vaultLabel(w, v)})`,
        `A claim was initiated on your vault at ${fmtDate(v.claimInitiatedAt)}.\n\n` +
        `If this is expected (you are the heir coordinating a planned transfer), do nothing.\n` +
        `If you are alive and this is NOT expected, you must veto before the challenge window\n` +
        `closes at ${fmtDate(v.finalizableAt)}. Any action from your wallet cancels the claim:\n\n` +
        `  ${appLink()}\n\n` +
        `After that moment the transfer is final and cannot be reversed by anyone.`);
    }
    return; // While a claim is pending, ordinary reminders are noise.
  }

  if (v.expired) {
    if (shouldSend(`${id}:expired:${dl}`)) {
      enqueue(w.email,
        `Your vault timer has EXPIRED (${vaultLabel(w, v)})`,
        `Your inactivity deadline passed at ${fmtDate(dl)}. Your heir can now initiate a claim.\n` +
        `Nothing is lost yet — a claim still has a ${Number(v.challengeWindow) / DAY}-day veto window —\n` +
        `but you should check in now:\n\n  ${appLink()}\n`);
    }
    return;
  }

  const days = daysUntil(dl, now);
  for (const tier of REMINDER_TIERS) {
    // A tier as long as the vault's whole period would fire the moment of every check-in.
    if (tier * DAY >= Number(v.inactivityPeriod)) continue;
    if (days <= tier) {
      if (shouldSend(`${id}:t${tier}:${dl}`)) {
        enqueue(w.email,
          `Check in within ${tier} day${tier > 1 ? "s" : ""} (${vaultLabel(w, v)})`,
          `Your vault's inactivity deadline is ${fmtDate(dl)}.\n` +
          `One transaction resets it for another ${Number(v.inactivityPeriod) / DAY} days:\n\n` +
          `  ${appLink()}\n`);
      }
      break; // most urgent tier only
    }
  }

  const horizonDays = daysUntil(v.absoluteDeadline, now);
  if (horizonDays <= HORIZON_WARN_DAYS && shouldSend(`${id}:horizon:${v.absoluteDeadline}`)) {
    enqueue(w.email,
      `Your vault's horizon is ${Math.max(1, Math.ceil(horizonDays))} days away (${vaultLabel(w, v)})`,
      `After ${fmtDate(v.absoluteDeadline)} check-ins stop working and inheritance is guaranteed\n` +
      `by ${fmtDate(v.guaranteedInheritanceAt)}. If that is not what you want, extend the horizon:\n\n` +
      `  ${appLink()}\n`);
  }

  if ((Number(v.warnings) & 8) && shouldSend(`${id}:chain-exhausted`)) {
    enqueue(w.email,
      `Your paper check-in chain is used up (${vaultLabel(w, v)})`,
      `The backup check-in chain on this vault has no uses left. Install a fresh one from the app:\n\n` +
      `  ${appLink()}\n`);
  }
}

function heirAlerts(w, v, now) {
  if (!w.heirEmail) return;
  const id = `${w.owner}:${v.vaultId}`;

  if (Number(v.state) === 1 && v.expired) {
    if (shouldSend(`${id}:heir-claimable:${v.deadline}`)) {
      enqueue(w.heirEmail,
        `A vault naming you as heir is now claimable (${vaultLabel(w, v)})`,
        `The owner's inactivity deadline passed at ${fmtDate(v.deadline)}.\n\n` +
        `If the owner is fine, tell them to check in — that is the system working.\n` +
        `If they are not, you can initiate your claim with the wallet they named:\n\n` +
        `  ${appLink()}\n\n` +
        `A ${Number(v.challengeWindow) / DAY}-day challenge window will run before settlement.`);
    }
  }
  if (Number(v.state) === 2 && v.finalizable) {
    if (shouldSend(`${id}:heir-finalizable:${v.claimInitiatedAt}`)) {
      enqueue(w.heirEmail,
        `Your inheritance claim can now be finalized (${vaultLabel(w, v)})`,
        `The challenge window closed at ${fmtDate(v.finalizableAt)} with no veto.\n` +
        `Finalize to settle the transfer, then withdraw your payout:\n\n  ${appLink()}\n`);
    }
  }
}

async function deliver() {
  if (queue.length === 0) return;
  if (cfg.smtp) {
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport(cfg.smtp);
    for (const m of queue) {
      await t.sendMail({ from: cfg.from || "Will & Key <reminders@willandkey.com>", ...m });
      console.log(`sent: [${m.to}] ${m.subject}`);
    }
  } else {
    fs.mkdirSync(outboxDir, { recursive: true });
    for (const m of queue) {
      const file = path.join(outboxDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(file, `To: ${m.to}\nSubject: ${m.subject}\n\n${m.body}`);
      console.log(`outbox: [${m.to}] ${m.subject}`);
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const contract = new ethers.Contract(cfg.contract, VAULT_ABI, provider);
  const now = Number((await provider.getBlock("latest")).timestamp);

  // Crypto-paid subscriptions: one on-chain uint64 per account decides service. Enforcement
  // sends exactly one "paused" notice per lapse (the key embeds paidUntil, so renewing and
  // lapsing again re-arms it) and never silently drops a customer.
  const sub = cfg.subscription && cfg.subscription.enforce
    ? new ethers.Contract(cfg.subscription.contract, SUB_ABI, provider)
    : null;

  for (const w of cfg.watches) {
    if (sub) {
      const until = Number(await sub.paidUntil(w.owner));
      if (until < now) {
        if (shouldSend(`${w.owner}:sub-expired:${until}`)) {
          enqueue(w.email,
            `Your Will & Key reminders are paused — subscription expired`,
            `Your reminder subscription${until ? ` ended ${fmtDate(until)}` : " has not been started"}.\n` +
            `Your vault itself is untouched and keeps working — but nobody is watching the\n` +
            `clock for you until you renew (payable in crypto, from any wallet):\n\n` +
            `  ${appLink()}\n`);
        }
        continue;
      }
    }
    let vaults;
    try {
      vaults = await contract.getOpenVaults(w.owner);
    } catch (e) {
      console.error(`read failed for ${w.owner}: ${e.shortMessage || e.message}`);
      continue; // one bad watch must not block the rest
    }
    for (const v of vaults) {
      ownerAlerts(w, v, now);
      heirAlerts(w, v, now);
    }
  }

  await deliver();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`done: ${cfg.watches.length} watch(es), ${queue.length} alert(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
