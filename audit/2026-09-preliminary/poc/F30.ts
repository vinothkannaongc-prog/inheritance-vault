// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F30/test/poc-F30.ts.
// Compares the fingerprints published in site/security.html and AUDIT_SCOPE.md (working tree) with the
// deployed runtime (support/fixtures snapshot, tied to contracts/v1 by the [port] test). See ../README.md.
/**
 * PoC for audit finding F30 (informational, documentation / verification).
 *
 * Claim under test: site/security.html and AUDIT_SCOPE.md publish, under the label "SHA-256",
 * a fingerprint of each deployed runtime bytecode. The intended property is that the value
 * under each label is what that label says it is, so a user who reproduces it with the named
 * algorithm gets the published value.
 *
 * The published documents are read READ-ONLY from the repo; nothing is written there.
 *
 * The regression test is label-aware: whatever algorithm a label names (SHA-256 or keccak-256),
 * the value must equal that algorithm applied to the runtime bytecode. It therefore passes after
 * EITHER fix (relabel to keccak-256 / EXTCODEHASH, or publish true SHA-256 values).
 */
import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const REPO = path.resolve(__dirname, "..", "..", ".."); // evidence-suite port: this repo's working tree, read-only
const SECURITY_HTML = path.join(REPO, "site/security.html");
const AUDIT_SCOPE_MD = path.join(REPO, "AUDIT_SCOPE.md");

const ADDR: Record<string, string> = {
  InheritanceVault: "0xC821849A1D74959753450409b594b23eCE7fEe2f",
  NotifySubscription: "0x60749aF621180de1DC05DB4f3d158D09dE979dC6",
};

type Algo = "sha256" | "keccak256";
type Published = { source: string; contract: string; label: string; algo: Algo; value: string };

function sha256Hex(code: string): string {
  return createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex");
}
function keccakHex(code: string): string {
  return ethers.keccak256(code).slice(2);
}
function hashWith(algo: Algo, code: string): string {
  return algo === "sha256" ? sha256Hex(code) : keccakHex(code);
}

/** Which algorithm a human-readable label claims. */
function algoOf(label: string): Algo {
  if (/keccak|extcodehash/i.test(label)) return "keccak256";
  if (/sha-?256/i.test(label)) return "sha256";
  throw new Error(`label names no recognisable hash algorithm: "${label}"`);
}

function contractOf(text: string): string {
  if (/InheritanceVault/.test(text)) return "InheritanceVault";
  if (/NotifySubscription|reminder/i.test(text)) return "NotifySubscription";
  throw new Error(`cannot tell which contract "${text}" refers to`);
}

/** Every 64-hex fingerprint in site/security.html, with the <li> label it sits under. */
function publishedInSecurityHtml(): Published[] {
  const html = fs.readFileSync(SECURITY_HTML, "utf8");
  const out: Published[] = [];
  const re = /<li>\s*<strong>([^<]*)<\/strong>\s*<span[^>]*>\s*([0-9a-fA-F]{64})\s*<\/span>/g;
  for (const m of html.matchAll(re)) {
    out.push({
      source: "site/security.html",
      contract: contractOf(m[1]),
      label: m[1].trim(),
      algo: algoOf(m[1]),
      value: m[2].toLowerCase(),
    });
  }
  return out;
}

/** Every fingerprint row of the "Exact on-chain targets" table in AUDIT_SCOPE.md. */
function publishedInAuditScope(): Published[] {
  const lines = fs.readFileSync(AUDIT_SCOPE_MD, "utf8").split(/\r?\n/);
  const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
  const out: Published[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!header.startsWith("|")) continue;
    const hdr = cells(header);
    const col = hdr.findIndex((h) => /bytecode/i.test(h) && /(sha|keccak|hash)/i.test(h));
    if (col < 0) continue;
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
      const row = cells(lines[j]);
      const value = row[col].replace(/`/g, "");
      if (!/^[0-9a-fA-F]{64}$/.test(value)) continue;
      out.push({
        source: "AUDIT_SCOPE.md",
        contract: contractOf(row[0]),
        label: hdr[col],
        algo: algoOf(hdr[col]),
        value: value.toLowerCase(),
      });
    }
  }
  return out;
}

// Evidence-suite port. The sandbox read the runtime from the compiled InheritanceVault artifact,
// which was byte-identical to the Base deployment. Here v1 is compiled as InheritanceVaultV1, and the
// rename changes the CBOR metadata hash at the end of the runtime, so the deployed runtime of both
// contracts is taken from an eth_getCode snapshot (Base, 2026-09-24) in support/fixtures. The test
// "[port] ..." below proves the snapshot and the compiled v1 sources agree.
const DEPLOYED: Record<string, { address: string; runtime: string }> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "support", "fixtures", "base-runtime-2026-09-24.json"), "utf8"),
).contracts;
const V1_ARTIFACT: Record<string, string> = {
  InheritanceVault: "InheritanceVaultV1",
  NotifySubscription: "NotifySubscription",
};

async function runtime(name: string): Promise<string> {
  return DEPLOYED[name].runtime;
}

/** Runtime bytecode without the trailing CBOR metadata (its length is the last two bytes). */
function executable(code: string): string {
  const hex = code.toLowerCase().replace(/^0x/, "");
  const metaLen = parseInt(hex.slice(-4), 16);
  return hex.slice(0, hex.length - 4 - metaLen * 2);
}

describe("PoC F30: published 'SHA-256' bytecode fingerprints", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  const published = [...publishedInSecurityHtml(), ...publishedInAuditScope()];

  it("parses the four published fingerprints (sanity: the test reads what the docs say)", () => {
    expect(published.map((p) => `${p.source}:${p.contract}`)).to.have.members([
      "site/security.html:InheritanceVault",
      "site/security.html:NotifySubscription",
      "AUDIT_SCOPE.md:InheritanceVault",
      "AUDIT_SCOPE.md:NotifySubscription",
    ]);
  });

  it("the published values ARE a fingerprint of the compiled runtime (the 'exact match' claim holds)", async () => {
    // Diagnostic, passes today: the value matches the artifact under SOME algorithm, so the
    // deployment claim is fine and only the label is wrong.
    for (const p of published) {
      const code = await runtime(p.contract);
      expect([sha256Hex(code), keccakHex(code)], `${p.source} ${p.contract}`).to.include(p.value);
    }
  });

  it("REGRESSION: every published fingerprint equals the algorithm its label names, applied to the runtime bytecode", async () => {
    const mismatches: string[] = [];
    for (const p of published) {
      const code = await runtime(p.contract);
      const expected = hashWith(p.algo, code);
      if (expected !== p.value) {
        mismatches.push(
          `${p.source} "${p.label}" (${p.contract}): published ${p.value}, ` +
            `actual ${p.algo}(runtime) = ${expected}; keccak256(runtime) = ${keccakHex(code)}`,
        );
      }
    }
    expect(mismatches, mismatches.join("\n")).to.deep.equal([]);
  });

  it("[port] the deployed-runtime snapshot matches the compiled v1 sources (vault: all bytes before the metadata; subscription: every byte)", async () => {
    for (const [name, artifactName] of Object.entries(V1_ARTIFACT)) {
      const snap = DEPLOYED[name];
      expect(snap.address.toLowerCase(), name).to.equal(ADDR[name].toLowerCase());
      const compiled = (await artifacts.readArtifact(artifactName)).deployedBytecode.toLowerCase();
      expect(executable(compiled), `${artifactName} executable bytes vs deployed ${name}`).to.equal(executable(snap.runtime));
      if (artifactName === name) expect(compiled, `${name} full runtime`).to.equal(snap.runtime.toLowerCase());
    }
  });

  it("the deployed-runtime snapshot is byte-identical to the live Base code (read-only eth_getCode; skipped offline)", async function () {
    this.timeout(30_000);
    const provider = new ethers.JsonRpcProvider("https://mainnet.base.org", 8453, { staticNetwork: true });
    for (const [name, addr] of Object.entries(ADDR)) {
      let live: string;
      try {
        live = await provider.getCode(addr);
      } catch (e) {
        this.skip();
        return;
      }
      const local = await runtime(name);
      expect(live.toLowerCase(), `${name} live code`).to.equal(local.toLowerCase());
      console.log(
        `      ${name}: ${(live.length - 2) / 2} bytes, keccak256=${keccakHex(live)}, sha256=${sha256Hex(live)}`,
      );
    }
  });
});
