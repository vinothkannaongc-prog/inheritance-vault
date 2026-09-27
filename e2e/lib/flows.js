"use strict";
// UI flows shared by several scenarios: the create form, the owner card panels and the heir tab.
// Each one drives the page the way a person does (fields, buttons, the review, the Sign button)
// and waits for what the app shows; none of them touches the chain directly.

const { ethers } = require("ethers");
const { poll, utcDay, DAY, TestFailure } = require("./util");

/** A look-alike of `address`: the same first four hex characters (or last four), otherwise different. */
function lookalike(address, { end = false } = {}) {
  const hex = address.toLowerCase().slice(2);
  const filler = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
  const body = end ? `${filler.slice(0, 36)}${hex.slice(-4)}` : `${hex.slice(0, 4)}${filler.slice(0, 36)}`;
  const out = ethers.getAddress(`0x${body}`);
  if (out.toLowerCase() === address.toLowerCase()) throw new Error("look-alike equals the original");
  return out;
}

/** Fills the create form; every field is optional and left as the page has it when omitted. */
async function fillCreate(app, f) {
  const page = app.page;
  await app.tab("create");
  if (f.asset !== undefined) {
    if (f.asset === "native") await page.selectOption("#cAsset", "native");
    else await page.selectOption("#cAsset", { label: f.asset });
  }
  if (f.amount !== undefined) await page.fill("#cAmount", f.amount);
  if (f.heir !== undefined) await page.fill("#cHeir", f.heir);
  if (f.heir2 !== undefined || f.heir !== undefined) await page.fill("#cHeir2", f.heir2 ?? f.heir);
  if (f.period !== undefined) await page.fill("#cPeriod", String(f.period));
  if (f.window !== undefined) await page.fill("#cWindow", String(f.window));
  if (f.horizon !== undefined) await page.fill("#cHorizon", f.horizon);
  if (f.ack !== undefined) await page.setChecked("#cAlertAck", f.ack);
}

/** Clicks Review vault and waits for the review to settle: a Sign button, a banner or a log line. */
async function reviewCreate(app) {
  await app.page.click("#createBtn");
  return poll(() => app.page.evaluate(() => {
    const review = document.getElementById("cReview");
    const log = document.getElementById("createLog").textContent.trim();
    const sign = [...review.querySelectorAll("button")].some((b) => b.textContent === "Sign and create vault");
    const banner = review.querySelector(".banner");
    if (sign) return { kind: "sign", text: review.textContent.replace(/\s+/g, " ") };
    if (banner) return { kind: "banner", text: banner.textContent.replace(/\s+/g, " ") };
    if (log) return { kind: "log", text: log.replace(/\s+/g, " ") };
    return null;
  }), Boolean, { what: "the create review to finish" });
}

/** Signs a create review that is on screen, and waits for the confirmation in the create log. */
async function signCreate(app) {
  await app.press(app.page.locator("#cReview"), "Sign and create vault");
  return app.waitText("#createLog", /Vault #\d+ created/, "the create log to confirm the new vault", 30000);
}

/** A horizon date (YYYY-MM-DD) `days` after chain time `now`, rounded up to a whole UTC day. */
function horizonDay(now, days) {
  return utcDay(Math.ceil((now + days * DAY) / DAY) * DAY);
}

/** Opens an owner card action and returns the panel locator. */
async function openOwnerPanel(app, id, label) {
  await app.press(app.card(id).locator(".actions"), label);
  const panel = app.page.locator(`#panel-owner-${id}`);
  await poll(() => panel.isVisible(), Boolean, { what: `vault #${id}'s "${label}" panel to open` });
  return panel;
}

/**
 * Presses a review button in a panel and waits for the review area to show either the Sign
 * button named `sign` or a banner; returns { kind, text }.
 */
async function reviewPanel(app, panel, reviewLabel, sign) {
  await app.press(panel, reviewLabel);
  return poll(() => panel.evaluate((el, signLabel) => {
    const out = el.querySelector(".panel-out") || el;
    const hasSign = [...el.querySelectorAll("button")].some((b) => b.textContent === signLabel);
    const banner = out.querySelector(".banner");
    if (hasSign) return { kind: "sign", text: el.textContent.replace(/\s+/g, " ") };
    if (banner) return { kind: "banner", text: banner.textContent.replace(/\s+/g, " ") };
    return null;
  }, sign), Boolean, { what: `the "${reviewLabel}" review to finish` });
}

/** Opens the heir tab, looks up `owner`, and waits for the result. */
async function lookupOwner(app, owner) {
  await app.tab("heir");
  await app.page.fill("#hOwner", owner);
  // Whatever the list shows now is marked, so the wait below sees the NEW result, not the old one.
  await app.page.evaluate(() => {
    for (const child of document.getElementById("heirList").children) child.dataset.e2eStale = "1";
  });
  await app.page.click("#hLookupBtn");
  await poll(() => app.page.evaluate(() => {
    const list = document.getElementById("heirList");
    return list.children.length > 0 && ![...list.children].some((child) => child.dataset.e2eStale);
  }), Boolean, { what: "the heir lookup to show a new result" });
  return app.textOf("#heirList");
}

function expectKind(result, kind, pattern, what) {
  if (result.kind !== kind || (pattern && !(pattern instanceof RegExp ? pattern.test(result.text) : result.text.includes(pattern)))) {
    throw new TestFailure(`${what}: expected a ${kind}${pattern ? ` matching ${pattern}` : ""}, got a ${result.kind}: ${result.text}`);
  }
  return result.text;
}

module.exports = {
  lookalike, fillCreate, reviewCreate, signCreate, horizonDay, openOwnerPanel, reviewPanel, lookupOwner, expectKind,
};
