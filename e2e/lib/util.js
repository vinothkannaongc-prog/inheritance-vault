"use strict";
// Small helpers shared by the e2e suite: waiting, assertions and the app's own date formats.

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A failed expectation, as opposed to a crash of the harness itself. */
class TestFailure extends Error {}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value.length > 1500 ? `${value.slice(0, 1500)}...` : value);
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  } catch {
    return String(value);
  }
}

function assert(condition, message) {
  if (!condition) throw new TestFailure(message);
}

function assertEqual(actual, expected, what) {
  const a = typeof actual === "bigint" || typeof expected === "bigint" ? BigInt(actual) : actual;
  const e = typeof actual === "bigint" || typeof expected === "bigint" ? BigInt(expected) : expected;
  if (a !== e) throw new TestFailure(`${what}: expected ${describe(expected)}, got ${describe(actual)}`);
}

const same = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

/** True when `text` contains `pattern` (a string) or matches it (a RegExp). */
function matches(text, pattern) {
  if (pattern instanceof RegExp) return pattern.test(text);
  return String(text).includes(pattern);
}

/**
 * Calls `read` until `check(value)` is true, and returns that value. On timeout it fails with
 * the last value read, so a wrong text is reported as the text the page actually showed.
 */
async function poll(read, check, { timeout = 20000, interval = 100, what = "the condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  let lastError = null;
  for (;;) {
    try {
      last = await read();
      lastError = null;
      if (check(last)) return last;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > end) {
      throw new TestFailure(`timed out after ${timeout} ms waiting for ${what}; last value: ${describe(last)}` +
        (lastError ? `; last error: ${lastError.message}` : ""));
    }
    await sleep(interval);
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

/** "27 September 2026": the launch-date format of scripts/set-launch-values.js. */
function utcDateText(seconds) {
  const date = new Date(Number(seconds) * 1000);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The app's fmtUtc: "2046-09-27 00:00 UTC". */
function fmtUtc(seconds) {
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The app's utcDay: "2046-09-27". */
function utcDay(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/** 00:00 UTC of a YYYY-MM-DD date, in seconds. */
function utcMidnight(day) {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

/** The first UTC midnight at or after `seconds`, as YYYY-MM-DD (the app's utcDayCeil). */
function utcDayCeil(seconds) {
  return utcDay(Math.ceil(Number(seconds) / 86400) * 86400);
}

/** The app's fmtCountdown(timestamp, now): "in 29d 23h", "3h ago", "in 4m". */
function fmtCountdown(timestamp, now) {
  const delta = Number(timestamp) - Number(now);
  const days = Math.floor(Math.abs(delta) / 86400);
  const hours = Math.floor((Math.abs(delta) % 86400) / 3600);
  const minutes = Math.floor((Math.abs(delta) % 3600) / 60);
  let span = `${minutes}m`;
  if (days > 0) span = `${days}d ${hours}h`;
  else if (hours > 0) span = `${hours}h`;
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

/** The app's short(): 0x1234...abcd. */
const short = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`;

const DAY = 86400;

module.exports = {
  sleep, TestFailure, assert, assertEqual, same, matches, poll, describe,
  utcDateText, fmtUtc, utcDay, utcMidnight, utcDayCeil, fmtCountdown, short, DAY,
};
