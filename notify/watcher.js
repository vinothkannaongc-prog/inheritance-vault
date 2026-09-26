#!/usr/bin/env node
/* Will & Key watcher: reads public vault state, sends escalating reminders.
 *
 * STATUS (2026-09): RETIRED. The production watcher is not running and Will & Key sends no alerts
 * of any kind. The paid-reminder billing contract (NotifySubscription) is retired and must not be
 * paid. Read notify/README.md ("Before any restart") before running this against a live chain.
 *
 * Design constraints, in order:
 *   1. Holds no keys and can sign nothing. It reads vault state and sends email.
 *   2. Run-to-completion. Invoked by cron; no daemon, no queue, nothing to babysit.
 *   3. FAIL OPEN, ALWAYS. Every failure must degrade toward a duplicate email, never toward
 *      silence. A missed veto alert costs someone their estate; a duplicate costs five seconds.
 *   4. Missing a run is safe. Alerts key off absolute deadlines, not run cadence. The one alert
 *      that cannot be recovered from current state -- the veto alert, whose trigger evaporates
 *      when the claim settles -- is backfilled from ClaimInitiated logs.
 *   5. Never assert something the contract will refuse. An email that tells an owner to take an
 *      action that reverts is worse than no email: it burns the window while looking like help.
 *
 * WHAT BILLING GATES, EXACTLY: advance reminders (the 14/7/3/1-day ladder) are the paid
 * product. Everything that means something is HAPPENING -- a live claim, an expired timer, an
 * approaching horizon, an exhausted recovery chain, a settlement -- is sent whether or not the
 * subscription is current. A lapsed $3/month must never be why someone loses an estate, and the
 * lapse is most likely caused by the very event this service exists to detect.
 *
 * Usage: node watcher.js --config config.json
 * Transport: config.smtp present -> nodemailer; absent -> .txt files in outboxDir (dev mode).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const VAULT_VIEW =
  "tuple(address owner, uint256 vaultId, uint8 state, address beneficiary, address token, uint128 balance, uint16 feeBps, uint64 createdAt, uint64 deadline, uint64 absoluteDeadline, uint64 guaranteedInheritanceAt, uint32 inactivityPeriod, uint32 challengeWindow, bool expired, bool horizonReached, address claimRecipient, uint64 claimInitiatedAt, uint64 finalizableAt, bool finalizable, bytes32 hbAnchor, uint32 hbLeft, uint16 warnings)";
const VAULT_ABI = [
  `function getOpenVaults(address) view returns (${VAULT_VIEW}[])`,
  `function getVault(address,uint256) view returns (${VAULT_VIEW})`,
  "event ClaimInitiated(address indexed owner, uint256 indexed vaultId, address indexed recipient, uint64 finalizableAt)",
];
const SUB_ABI = ["function paidUntil(address) view returns (uint64)"];

const DAY = 86400;
const REMINDER_TIERS = [1, 3, 7, 14];
const VETO_TIERS = [1, 3, 7];
const HORIZON_WARN_DAYS = 30;
const REPEAT_BUCKET = 7 * DAY;
// Public RPCs cap eth_getLogs ranges (commonly 10k blocks), so the scan is paged and its
// position persisted rather than expressed as one huge lookback. A fixed 200k-block window was
// both rejected by every provider AND shorter than MIN_CHALLENGE on 2s-block chains, so the
// backfill it powered could never once have fired in production.
const LOG_PAGE = 9_000;
const MAX_PAGES_PER_RUN = 25;
// Stop retrying a permanently-failing recipient. Unbounded retries of one typo'd address drive
// the bounce rate into provider-suspension territory, which silences every other customer.
const MAX_ATTEMPTS = 12;
const STATE_TTL = 400 * DAY;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const configPath = path.resolve(arg("config", "config.json"));
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const baseDir = path.dirname(configPath);
const statePath = path.resolve(baseDir, cfg.stateFile || "state.json");
const outboxDir = path.resolve(baseDir, cfg.outboxDir || "outbox");

/** Fails open: a truncated or unparseable state file resets rather than throwing at load. */
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!s || typeof s !== "object" || typeof s.sent !== "object") throw new Error("shape");
    for (const k of ["seen", "scan", "fail"]) {
      if (!s[k] || typeof s[k] !== "object") s[k] = {};
    }
    return s;
  } catch (e) {
    if (fs.existsSync(statePath)) {
      console.error(`state file unreadable (${e.message}) — starting fresh; some alerts may repeat`);
    }
    return { sent: {}, seen: {}, scan: {}, fail: {} };
  }
}
const state = loadState();
let failures = 0;

/** Atomic: temp file then rename. A kill can never leave a half-written state.json behind. */
function saveState() {
  try {
    const now = Date.now();
    for (const [k, v] of Object.entries(state.sent)) {
      if (now - Date.parse(v) > STATE_TTL * 1000) delete state.sent[k];
    }
    const tmp = `${statePath}.tmp`;
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd); // survive power loss, not just a process kill
    fs.closeSync(fd);
    fs.renameSync(tmp, statePath);
  } catch (e) {
    // Never fatal: an unsaved run repeats alerts (fail-open). But it must be visible, because
    // a permanently unwritable state file is a permanent duplicate storm.
    failures += 1;
    console.error(`STATE SAVE FAILED (${e.message}) — alerts may repeat next run`);
  }
}

function short(a) { return String(a).slice(0, 6) + "…" + String(a).slice(-4); }
function fmtDate(ts) { return new Date(Number(ts) * 1000).toUTCString(); }
function daysUntil(ts, now) { return (Number(ts) - now) / DAY; }
function norm(a) { return String(a).toLowerCase(); }
function bucket(now) { return Math.floor(now / REPEAT_BUCKET); }

const queue = [];
/** Queues a message under a dedupe key. The key is burned only after delivery succeeds. */
function alert(key, to, subject, body) {
  if (state.sent[key]) return;
  if ((state.fail[key] || 0) >= MAX_ATTEMPTS) return; // dead letter; reported at end of run
  if (!to) {
    failures += 1;
    console.error(`NO RECIPIENT for alert ${key} — check the watch config`);
    return;
  }
  if (queue.some((m) => m.key === key)) return;
  queue.push({ key, to, subject, body });
}

function appLink() { return cfg.appUrl || "https://willandkey.com/app.html"; }
function vaultLabel(w, v) { return `${w.label || short(v.owner)} — vault #${v.vaultId}`; }

/**
 * The ONE place that words what an owner can still do to keep control. Every alert that tells
 * someone how to stop or prevent a claim takes its wording from here, so no alert can send an owner
 * to an action the contract refuses (rule 5). Text only: it decides nothing about which alerts fire.
 *
 * What it restates, from the live v1 contract:
 *   - before the horizon, checkIn restarts the timer but reverts while a claim is pending
 *     (ClaimPendingUseAbort); abortClaim, setBeneficiary, setInactivityPeriod, setCheckInChain,
 *     extendHorizon and any withdraw cancel a pending claim; topUp and checkInByChain revert and
 *     checkInMany skips the vault, so none of those cancels it;
 *   - at or after the horizon, checkIn and abortClaim revert (HorizonReached), and only
 *     extendHorizon (to at least now + inactivityPeriod) or withdrawing the whole balance stops a
 *     claim.
 */
function ownerRemedy(v, now, forHeir = false, pastHorizon = Boolean(v.horizonReached)) {
  const key = forHeir ? "the owner's" : "your";
  const period = Number(v.inactivityPeriod);
  if (pastHorizon) {
    return (
      `This vault passed its horizon on ${fmtDate(v.absoluteDeadline)}, so check-ins no longer work,\n` +
      `and once a claim has started the Veto button does not work either. Only two things can stop\n` +
      `a claim, and both need ${key} wallet key: extending the horizon to a date later than\n` +
      `${fmtDate(now + period)} (the contract requires at least one full check-in period,\n` +
      `${period / DAY} days, after the transaction is mined, so leave a margin), or withdrawing the\n` +
      `whole balance.\n`
    );
  }
  if (Number(v.state) === 2) {
    return (
      `To cancel the claim, use "Veto claim" in the app with ${key} wallet. Changing the heir,\n` +
      `changing the check-in period, installing a new check-in chain (advanced), extending the\n` +
      `horizon or withdrawing any amount also cancels it. A check-in does NOT: it is refused while\n` +
      `a claim is pending, and a batch check-in skips this vault. Ordinary wallet activity does not\n` +
      `count either; only transactions sent to the vault contract do.\n`
    );
  }
  return (
    `A check-in from ${key} wallet restarts the timer. Once a claim has started, a check-in no\n` +
    `longer helps: only "Veto claim" or one of the other cancelling actions does.\n`
  );
}

/* ---------------------------------------------------------------- alerts */

function ownerAlerts(w, v, now, funded) {
  const id = `${norm(w.email)}:${norm(v.owner)}:${v.vaultId}`;

  if (Number(v.state) === 2) {
    const stamp = v.claimInitiatedAt;
    const baseKey = `${id}:claim:${stamp}`;
    let key = baseKey;
    if (state.sent[baseKey]) {
      const left = daysUntil(v.finalizableAt, now);
      // Only tiers strictly inside the window can be an escalation; on a 7-day window the
      // 7-day tier would otherwise fire one cron interval after the base alert, as a duplicate.
      const tier = VETO_TIERS.filter((t) => t * DAY < Number(v.challengeWindow)).find((t) => left <= t);
      if (tier === undefined) return;
      key = `${baseKey}:t${tier}`;
    }
    // Past the horizon abortClaim, setBeneficiary and friends all revert, and before it a plain
    // check-in reverts while a claim is pending. ownerRemedy words both cases, so this alert can
    // never send the owner to a bare revert while the window runs out.
    const how = ownerRemedy(v, now);
    alert(key, w.email,
      `ACTION NEEDED: an inheritance claim is running on your vault (${vaultLabel(w, v)})`,
      `A claim was initiated on your vault at ${fmtDate(stamp)}.\n\n` +
      `If this is expected (you are coordinating a planned transfer), do nothing.\n` +
      `If you are alive and this is NOT expected, you must act before the challenge window\n` +
      `closes at ${fmtDate(v.finalizableAt)}.\n\n` + how + `\n  ${appLink()}\n\n` +
      `A transaction only counts once it is included in a block. On Base, if the network's\n` +
      `sequencer is down, a transaction can still be forced in through Ethereum, but that can take\n` +
      `up to about 12 hours: do not wait for the last day.\n\n` +
      `When the window closes, anyone can finalize the claim at any moment. Until a finalize\n` +
      `transaction is mined your wallet can still cancel it, but do not count on that.`);
    return;
  }

  if (Number(v.warnings) & 8) {
    alert(`${id}:chain-exhausted:${v.hbAnchor}`, w.email,
      `Your paper check-in chain is used up (${vaultLabel(w, v)})`,
      `The backup check-in chain on this vault has no declared uses left, so keyless check-ins\n` +
      `will no longer work. The app cannot install a chain: a new one needs your wallet key, a\n` +
      `direct call to setCheckInChain before the horizon, and a fresh seed. Never re-install a\n` +
      `seed or anchor you have used before. The construction is specified in docs/CHECKIN-CHAIN.md\n` +
      `in the Will & Key repository.\n\n  ${appLink()}\n`);
  }

  const horizonDays = daysUntil(v.absoluteDeadline, now);
  if (horizonDays <= HORIZON_WARN_DAYS) {
    const passed = horizonDays <= 0;
    const left = Math.ceil(horizonDays);
    alert(`${id}:horizon:${v.absoluteDeadline}`, w.email,
      passed
        ? `Your vault's horizon has passed (${vaultLabel(w, v)})`
        : `Your vault's horizon is ${left} day${left === 1 ? "" : "s"} away (${vaultLabel(w, v)})`,
      passed
        ? ownerRemedy(v, now, false, true) + `\n  ${appLink()}\n`
        : `After ${fmtDate(v.absoluteDeadline)} check-ins stop working, and from then only extending\n` +
          `the horizon or withdrawing everything can stop a claim. Check-ins already cannot push\n` +
          `your deadline past the horizon. If that is not what you want, extend the horizon now:\n\n` +
          `  ${appLink()}\n`);
  }

  if (v.expired) {
    alert(`${id}:expired:${v.deadline}:${bucket(now)}`, w.email,
      `Your vault timer has EXPIRED (${vaultLabel(w, v)})`,
      `Your inactivity deadline passed at ${fmtDate(v.deadline)}. Your heir can now initiate a\n` +
      `claim at any time.\n\n` +
      (v.horizonReached
        ? ""
        : `Nothing is lost yet: a claim would still have a ${Number(v.challengeWindow) / DAY}-day veto window.\n`) +
      ownerRemedy(v, now) + `\n  ${appLink()}\n`);
    return;
  }

  if (!funded) return; // advance reminders are the paid product; everything above is not

  const days = daysUntil(v.deadline, now);
  for (const tier of REMINDER_TIERS) {
    if (tier * DAY >= Number(v.inactivityPeriod)) continue;
    if (days <= tier) {
      alert(`${id}:t${tier}:${v.deadline}`, w.email,
        `Check in within ${tier} day${tier > 1 ? "s" : ""} (${vaultLabel(w, v)})`,
        `Your vault's inactivity deadline is ${fmtDate(v.deadline)}.\n` +
        `One check-in resets it to ${Number(v.inactivityPeriod) / DAY} days after the transaction is mined,\n` +
        `but never past your horizon (${fmtDate(v.absoluteDeadline)}):\n\n` +
        `  ${appLink()}\n`);
      break;
    }
  }
}

function heirAlerts(w, v, now) {
  if (!w.heirEmail) return;
  // If the owner has re-pointed the vault, the configured contact is a STRANGER to this estate.
  // Telling them the owner is presumed dead and the funds are in play is a disclosure, not a
  // service, and the real heir would be the one hearing nothing.
  if (w.heirAddress && norm(w.heirAddress) !== norm(v.beneficiary)) {
    alert(`${norm(w.email)}:${norm(v.owner)}:${v.vaultId}:heir-mismatch:${norm(v.beneficiary)}`, w.email,
      `Your heir contact no longer matches the vault (${vaultLabel(w, v)})`,
      `This vault now names ${v.beneficiary} as heir, which is not the address on file for your\n` +
      `heir notifications. We have stopped notifying the old contact. Update your details so the\n` +
      `right person is told when it matters.\n\n  ${appLink()}\n`);
    return;
  }
  const id = `${norm(w.heirEmail)}:${norm(v.owner)}:${v.vaultId}`;

  if (Number(v.state) === 1 && v.expired) {
    alert(`${id}:heir-claimable:${v.deadline}:${bucket(now)}`, w.heirEmail,
      `A vault naming you as heir is now claimable (${vaultLabel(w, v)})`,
      `The owner's inactivity deadline passed at ${fmtDate(v.deadline)}.\n\n` +
      `If the owner is fine, that is the system working. ` + ownerRemedy(v, now, true) + `\n` +
      `If they are not, you can initiate your claim with the wallet they named:\n\n` +
      `  ${appLink()}\n\n` +
      `Check the payout address carefully when you start the claim: it cannot be changed\n` +
      `afterwards. A ${Number(v.challengeWindow) / DAY}-day challenge window will run before settlement.`);
  }
  if (Number(v.state) === 2 && v.finalizable) {
    alert(`${id}:heir-finalizable:${v.claimInitiatedAt}`, w.heirEmail,
      `Your inheritance claim can now be finalized (${vaultLabel(w, v)})`,
      `The challenge window ended at ${fmtDate(v.finalizableAt)} and the claim has not been vetoed.\n` +
      `Finalize promptly: until a finalize transaction is mined, the owner's key can still cancel\n` +
      `the claim. Finalize to settle the transfer, then withdraw your payout:\n\n  ${appLink()}\n`);
  }
}

/**
 * Vaults that were open on a previous run and are gone now have settled or closed. Each
 * disappearance is CONFIRMED on chain before alerting: a lagging RPC replica that omits a vault
 * would otherwise tell an owner their estate had settled, with no retraction possible.
 *
 * Returns the ids that may be dropped from `seen` — an id whose alert has not been delivered
 * stays, so a failed send is retried instead of being forgotten (the trigger lives here, not in
 * state.sent, so the delivery-gated dedupe alone does not protect it).
 */
async function terminalAlerts(contract, w, openIds) {
  const seenKey = `${norm(w.email)}:${norm(w.owner)}`;
  const before = state.seen[seenKey] || [];
  const keep = [...openIds];
  for (const id of before.filter((x) => !openIds.includes(x))) {
    let v;
    try {
      v = await contract.getVault(w.owner, id);
    } catch (e) {
      keep.push(id); // unconfirmed: try again next run rather than assert a settlement
      continue;
    }
    const st = Number(v.state);
    if (st !== 3 && st !== 4) { keep.push(id); continue; } // stale read, not a settlement
    const label = `${w.label || short(v.owner)} — vault #${id}`;
    const ownerKey = `${norm(w.email)}:${norm(v.owner)}:${id}:terminal`;
    const heirKey = `${norm(w.heirEmail)}:${norm(v.owner)}:${id}:terminal`;
    alert(ownerKey, w.email,
      `Your vault is now closed (${label})`,
      st === 3
        ? `An inheritance claim on this vault has settled and the funds were transferred to your\n` +
          `heir's chosen address. If that was not expected, review it now:\n\n  ${appLink()}\n`
        : `You withdrew the full balance, so this vault is closed. Nothing further is watched on\n` +
          `it:\n\n  ${appLink()}\n`);
    if (w.heirEmail && st === 3) {
      alert(heirKey, w.heirEmail,
        `A vault naming you as heir has closed (${label})`,
        `The claim settled. Your payout is waiting in the Payouts tab:\n\n  ${appLink()}\n`);
    }
    // Held until the notice actually goes out.
    if (!state.sent[ownerKey] || (w.heirEmail && st === 3 && !state.sent[heirKey])) keep.push(id);
  }
  return { seenKey, keep };
}

/**
 * The veto alert is the only one whose trigger disappears: finalizeClaim removes the vault from
 * getOpenVaults, so an outage spanning a challenge window would lose it with no trace.
 * ClaimInitiated logs persist, so a late run can still tell the owner what happened.
 */
async function backfillClaims(contract, provider, w, latest) {
  const scanKey = `${norm(w.email)}:${norm(w.owner)}`;
  let from = Number.isInteger(state.scan[scanKey])
    ? state.scan[scanKey]
    : Math.max(0, latest - LOG_PAGE);
  let pages = 0;
  let clean = true;
  while (from <= latest && pages < MAX_PAGES_PER_RUN) {
    const to = Math.min(from + LOG_PAGE - 1, latest);
    const logs = await contract.queryFilter(contract.filters.ClaimInitiated(w.owner), from, to);
    for (const log of logs) {
      const vaultId = log.args.vaultId.toString();
      const v = await contract.getVault(w.owner, vaultId);
      if (Number(v.state) !== 3) continue; // not settled: the live path owns this one
      // challengeWindow is immutable, so this reconstructs the live alert's key exactly.
      const stamp = BigInt(log.args.finalizableAt) - BigInt(v.challengeWindow);
      // A settled vault records the claim that ACTUALLY settled. Earlier claims on the same
      // vault were aborted or superseded; reporting those as settled would tell an owner their
      // estate transferred on a date they had successfully vetoed.
      if (stamp !== BigInt(v.claimInitiatedAt)) continue;
      const key = `${norm(w.email)}:${norm(v.owner)}:${vaultId}`;
      if (state.sent[`${key}:claim:${stamp}`]) continue; // the live path already said it
      const alertKey = `${key}:settled-unseen:${stamp}`;
      alert(alertKey, w.email,
        `A claim on your vault SETTLED while reminders were down (${w.label || short(v.owner)} — vault #${vaultId})`,
        `An inheritance claim on this vault settled at ${fmtDate(log.args.finalizableAt)} and the\n` +
        `funds were transferred. Our reminders did not reach you while it was running — we are\n` +
        `telling you now because you should know, even though the transfer is final.\n\n` +
        `  ${appLink()}\n`);
      if (!state.sent[alertKey]) clean = false; // hold the cursor until it is delivered
    }
    from = to + 1;
    pages += 1;
  }
  // Only advance past ground we have both scanned AND successfully reported on.
  return { scanKey, cursor: clean ? from : (Number.isInteger(state.scan[scanKey]) ? state.scan[scanKey] : from) };
}

/* ---------------------------------------------------------------- delivery */

async function deliver() {
  if (queue.length === 0) return 0;
  let sent = 0;
  let transport = null;
  try {
    if (cfg.smtp) {
      transport = require("nodemailer").createTransport(cfg.smtp);
    } else {
      fs.mkdirSync(outboxDir, { recursive: true });
    }
  } catch (e) {
    failures += 1;
    console.error(`TRANSPORT UNAVAILABLE (${e.message}) — nothing sent this run`);
    return 0;
  }
  for (const m of queue) {
    try {
      if (transport) {
        const info = await transport.sendMail({
          from: cfg.from || "Will & Key <reminders@willandkey.com>",
          to: m.to, subject: m.subject, text: m.body,
        });
        // Acceptance by the relay is not delivery, but a rejected recipient is knowable here.
        if (info && Array.isArray(info.rejected) && info.rejected.length > 0) {
          throw new Error(`recipient rejected: ${info.rejected.join(",")}`);
        }
      } else {
        const name = `${String(Date.now()).padStart(13, "0")}-${sent}-${m.key.replace(/[^a-z0-9]/gi, "_").slice(0, 60)}.txt`;
        fs.writeFileSync(path.join(outboxDir, name), `To: ${m.to}\nSubject: ${m.subject}\n\n${m.body}`);
      }
      state.sent[m.key] = new Date().toISOString();
      delete state.fail[m.key];
      sent += 1;
      console.log(`sent: [${m.to}] ${m.subject}`);
    } catch (e) {
      const n = (state.fail[m.key] || 0) + 1;
      state.fail[m.key] = n;
      console.error(`DELIVERY FAILED (${n}/${MAX_ATTEMPTS}) [${m.to}] ${m.subject}: ${e.message}`);
      if (n >= MAX_ATTEMPTS) {
        console.error(`DEAD LETTER: giving up on [${m.to}] "${m.subject}" — fix the address and clear its key from state.json`);
      }
    }
  }
  return sent;
}

/* ---------------------------------------------------------------- main */

async function main() {
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const contract = new ethers.Contract(cfg.contract, VAULT_ABI, provider);

  let now, latest;
  try {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("provider returned no block");
    now = Number(block.timestamp);
    latest = block.number;
  } catch (e) {
    console.error(`FATAL: cannot read chain head: ${e.message}`);
    process.exit(1);
  }

  const sub = cfg.subscription && cfg.subscription.enforce
    ? new ethers.Contract(cfg.subscription.contract, SUB_ABI, provider)
    : null;

  const commits = [];
  for (const w of cfg.watches) {
    try {
      const vaults = await contract.getOpenVaults(w.owner);

      let funded = true;
      if (sub) {
        try {
          funded = Number(await sub.paidUntil(w.owner)) >= now;
        } catch (e) {
          console.error(`subscription read failed for ${w.owner}: ${e.message} — failing open`);
        }
        if (!funded && vaults.length > 0) {
          alert(`${norm(w.email)}:${norm(w.owner)}:sub-expired:${bucket(now)}`, w.email,
            `Your Will & Key reminders are paused — subscription expired`,
            `Your subscription has lapsed, so ADVANCE check-in reminders are paused.\n\n` +
            `You will still be told if anything actually happens: a claim on your vault, an\n` +
            `expired timer, an approaching horizon, or a settlement. We do not withhold those.\n\n` +
            `Your vault itself is untouched and keeps running exactly as before. Paid reminders\n` +
            `are no longer sold. Do not send funds to the reminder billing contract: a payment to\n` +
            `it buys nothing.\n\n  ${appLink()}\n`);
        }
      }

      for (const v of vaults) {
        ownerAlerts(w, v, now, funded);
        heirAlerts(w, v, now);
      }
      commits.push(await terminalAlerts(contract, w, vaults.map((v) => v.vaultId.toString())));

      if (cfg.backfillClaims !== false) {
        try {
          commits.push(await backfillClaims(contract, provider, w, latest));
        } catch (e) {
          failures += 1; // a silently dead backfill must not report a green run
          console.error(`backfill failed for ${w.owner}: ${e.message}`);
        }
      }
    } catch (e) {
      failures += 1;
      console.error(`watch failed for ${w.owner}: ${e.shortMessage || e.message}`);
    }
  }

  const sent = await deliver();
  // Cursors are committed only after delivery, so an undelivered backfill alert is rescanned.
  for (const c of commits) {
    if (c.seenKey) state.seen[c.seenKey] = c.keep;
    if (c.scanKey) state.scan[c.scanKey] = c.cursor;
  }
  saveState();
  console.log(`done: ${cfg.watches.length} watch(es), ${queue.length} queued, ${sent} sent, ${failures} failure(s)`);
  if (failures > 0 || sent < queue.length) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
