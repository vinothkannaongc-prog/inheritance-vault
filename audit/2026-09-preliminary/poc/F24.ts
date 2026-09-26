// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F24/test/poc-F24.ts.
// No contract. Reads AUDIT-2026-08-09.md, AUDIT_SCOPE.md and site/index.html from this repo's working tree.
// See ../README.md.
/**
 * PoC F24: the public FAQ and the internal report's headline overstate the internal review.
 *
 * This is a documentation-consistency regression test. It reads (never writes) the report
 * AUDIT-2026-08-09.md, AUDIT_SCOPE.md and site/index.html, counts the report's itemised findings
 * by their own "### X-NN · SEVERITY" headings and "| W-NN |" table rows, and asserts that the
 * headline tally and the FAQ agree with the itemised list. The expected numbers are derived from
 * the itemised list, not hard-coded from the claim under test.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const CANDIDATE_ROOTS = [
  path.resolve(__dirname, "..", "..", ".."), // evidence-suite port: this repo's working tree, read-only
];
const ROOT = CANDIDATE_ROOTS.find((r) => fs.existsSync(path.join(r, "AUDIT-2026-08-09.md")));
if (!ROOT) throw new Error("cannot locate AUDIT-2026-08-09.md");

const report = fs.readFileSync(path.join(ROOT, "AUDIT-2026-08-09.md"), "utf8");
const scope = fs.readFileSync(path.join(ROOT, "AUDIT_SCOPE.md"), "utf8");
const index = fs.readFileSync(path.join(ROOT, "site/index.html"), "utf8");

type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

function itemised() {
  const onChain: Record<Sev, string[]> = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
  const offChain: Record<Sev, string[]> = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
  const re = /^### ([A-Z]-\d+) · (CRITICAL|HIGH|MEDIUM|LOW)( \(off-chain\))? ·/gm;
  for (const m of report.matchAll(re)) {
    (m[3] ? offChain : onChain)[m[2] as Sev].push(m[1]);
  }
  // The W-01..W-05 table sits under the heading "Off-chain (watcher) — five criticals".
  const wHeading = /^### Off-chain \(watcher\) — five criticals$/m;
  expect(wHeading.test(report), "W-table heading moved; update the parser").to.equal(true);
  for (const m of report.matchAll(/^\| (W-\d+) \|/gm)) offChain.CRITICAL.push(m[1]);
  return { onChain, offChain };
}

function headline() {
  const m = report.match(
    /\*\*Result:\*\* (\d+) defects fixed \((\d+) high, (\d+) medium, (\d+) low on chain; (\d+) critical, (\d+) high off chain/,
  );
  if (!m) throw new Error("headline tally not found");
  const n = m.slice(1).map(Number);
  return { total: n[0], high: n[1], medium: n[2], low: n[3], offCritical: n[4], offHigh: n[5] };
}

function faqAuditAnswer(): string {
  const m = index.match(/<summary>Has it been audited\?<\/summary>\s*<p>([\s\S]*?)<\/p>/);
  if (!m) throw new Error("FAQ entry 'Has it been audited?' not found");
  return m[1].replace(/\s+/g, " ");
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20,
};

describe("F24 review claims must match the itemised report", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  it("the report's on-chain headline tally equals its itemised on-chain findings", () => {
    const { onChain } = itemised();
    const h = headline();
    const counted = { high: onChain.HIGH.length, medium: onChain.MEDIUM.length, low: onChain.LOW.length };
    console.log("      itemised on-chain:", JSON.stringify(onChain));
    console.log("      headline on-chain:", JSON.stringify({ high: h.high, medium: h.medium, low: h.low }));
    expect({ high: h.high, medium: h.medium, low: h.low }).to.deep.equal(counted);
  });

  it("the report's off-chain critical tally equals its itemised off-chain criticals", () => {
    const { offChain } = itemised();
    const h = headline();
    console.log("      itemised off-chain CRITICAL:", offChain.CRITICAL.join(", "));
    expect(h.offCritical).to.equal(offChain.CRITICAL.length);
  });

  it("the FAQ's defect count equals the report's itemised count", () => {
    const { onChain, offChain } = itemised();
    const nOn = Object.values(onChain).flat().length;
    const nAll = nOn + Object.values(offChain).flat().length;
    const text = faqAuditAnswer();
    const m = text.match(/(\w+) defects were found and fixed/i);
    if (!m) throw new Error("FAQ no longer states a defect count; review this test");
    const stated = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    console.log(`      FAQ states ${stated}; itemised on-chain ${nOn}, itemised total ${nAll}`);
    // The FAQ says the passes were "over the contract", so the on-chain count is the match;
    // the itemised grand total is accepted too in case the wording is broadened.
    expect([nOn, nAll], `FAQ says "${m[0]}"`).to.include(stated);
  });

  it("the FAQ does not call the self-run review 'independent' (AUDIT_SCOPE.md forbids it)", () => {
    expect(scope).to.match(/must not be described as independent/); // the rule being enforced
    const text = faqAuditAnswer();
    const hit = text.match(/[^.]*\bindependent\b[^.]*/i);
    expect(hit, `FAQ sentence: "${hit?.[0]?.trim()}"`).to.equal(null);
  });
});
