// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F27/test/poc-F27.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F27 (informational): event schema gaps.
 *
 * Every test asserts the INTENDED property -- an event-only consumer can learn what changed from
 * the events alone -- so each fails against the current contract because of the gap, and passes
 * once the events carry the missing fields.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const ONE = ethers.parseEther("1");
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

describe("F27 event schema gaps", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const horizon = (await time.latest()) + 730 * DAY;
    const createTx = await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    const createRcpt = await createTx.wait();
    return { vault, admin, alice, bob, carol, dave, feeSink, horizon, createRcpt };
  }

  /** Parse the single log named `eventName` out of a receipt. */
  function parseEvent(vault: any, rcpt: any, eventName: string) {
    for (const log of rcpt.logs) {
      let parsed;
      try {
        parsed = vault.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed && parsed.name === eventName) return parsed;
    }
    throw new Error(`fixture error: ${eventName} not emitted`);
  }

  /** The value of the first event argument named in `names`, or undefined if the event has none. */
  function namedArg(parsed: any, names: string[]) {
    const idx = parsed.fragment.inputs.findIndex((i: any) => names.includes(i.name));
    return idx < 0 ? undefined : parsed.args[idx];
  }

  const DEADLINE_FIELDS = ["newDeadline", "deadline"];

  // ------------------------------------------------------------------ five clock resets

  const RESETS: Array<{ fn: string; ev: string; call: (f: any) => Promise<any> }> = [
    { fn: "withdraw (partial)", ev: "Withdrawn", call: (f) => f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address) },
    { fn: "setBeneficiary", ev: "BeneficiaryChanged", call: (f) => f.vault.connect(f.alice).setBeneficiary(0, f.carol.address) },
    { fn: "setInactivityPeriod", ev: "InactivityPeriodSet", call: (f) => f.vault.connect(f.alice).setInactivityPeriod(0, 60 * DAY) },
    {
      fn: "extendHorizon",
      ev: "HorizonExtended",
      // A horizon far beyond now+period, so the event's newAbsoluteDeadline cannot coincide with
      // the clamped deadline and pass the check by accident.
      call: (f) => f.vault.connect(f.alice).extendHorizon(0, f.horizon + 365 * DAY),
    },
    {
      fn: "setCheckInChain",
      ev: "CheckInChainSet",
      call: (f) => f.vault.connect(f.alice).setCheckInChain(0, ethers.keccak256(ethers.toUtf8Bytes("seed")), 10),
    },
  ];

  for (const r of RESETS) {
    it(`${r.fn} resets the clock and ${r.ev} reports the new deadline`, async () => {
      const f = await loadFixture(fixture);
      await time.increase(10 * DAY); // so the reset visibly moves the deadline
      const before = await f.vault.getVault(f.alice.address, 0);

      const rcpt = await (await r.call(f)).wait();
      const after = await f.vault.getVault(f.alice.address, 0);

      // Precondition (passes): the action really did move the inactivity deadline.
      expect(after.deadline, `${r.fn} did not reset the clock`).to.be.greaterThan(before.deadline);

      // Intended property (fails today): the event says what the deadline became.
      const parsed = parseEvent(f.vault, rcpt, r.ev);
      const fields = parsed.fragment.inputs.map((i: any) => i.name);
      expect(
        fields,
        `${r.ev}(${fields.join(", ")}) carries no deadline; on-chain deadline moved ` +
          `${before.deadline} -> ${after.deadline} (+${Number(after.deadline - before.deadline) / DAY} days)`
      ).to.include.oneOf(DEADLINE_FIELDS);
      expect(namedArg(parsed, DEADLINE_FIELDS)).to.equal(after.deadline);
    });
  }

  // Controls (PASS today): the same check recognises a deadline where the contract does emit one,
  // so the five failures above are the schema gap and not a broken assertion.
  it("control: checkIn's CheckedIn reports the new deadline", async () => {
    const f = await loadFixture(fixture);
    await time.increase(10 * DAY);
    const rcpt = await (await f.vault.connect(f.alice).checkIn(0)).wait();
    const parsed = parseEvent(f.vault, rcpt, "CheckedIn");
    expect(parsed.fragment.inputs.map((i: any) => i.name)).to.include.oneOf(DEADLINE_FIELDS);
    expect(namedArg(parsed, DEADLINE_FIELDS)).to.equal((await f.vault.getVault(f.alice.address, 0)).deadline);
  });

  it("control: abortClaim's ClaimAborted reports the new deadline", async () => {
    const f = await loadFixture(fixture);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    const rcpt = await (await f.vault.connect(f.alice).abortClaim(0)).wait();
    const parsed = parseEvent(f.vault, rcpt, "ClaimAborted");
    expect(parsed.fragment.inputs.map((i: any) => i.name)).to.include.oneOf(DEADLINE_FIELDS);
    expect(namedArg(parsed, DEADLINE_FIELDS)).to.equal((await f.vault.getVault(f.alice.address, 0)).deadline);
  });

  // ------------------------------------------------------------------ event-only indexer

  /**
   * A heir-side indexer that trusts only events: it takes the latest deadline any event of this
   * vault reported. It does NOT re-implement _resetClock -- the point of the finding.
   */
  async function indexerDeadline(vault: any, owner: string, vaultId: number): Promise<bigint> {
    const addr = await vault.getAddress();
    const logs = await ethers.provider.getLogs({
      address: addr,
      fromBlock: 0,
      toBlock: "latest",
      topics: [null, ethers.zeroPadValue(owner, 32), ethers.toBeHex(vaultId, 32)],
    });
    let d: bigint | undefined;
    for (const log of logs) {
      const parsed = vault.interface.parseLog(log);
      if (!parsed) continue;
      const v = namedArg(parsed, DEADLINE_FIELDS);
      if (v !== undefined) d = v;
    }
    if (d === undefined) throw new Error("fixture error: no deadline-bearing event found");
    return d;
  }

  it("an events-only indexer tracks the real deadline after a partial withdraw", async () => {
    const f = await loadFixture(fixture);
    await time.increase(20 * DAY);
    await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address); // clock reset, not logged

    const indexed = await indexerDeadline(f.vault, f.alice.address, 0);
    const onChain = (await f.vault.getVault(f.alice.address, 0)).deadline;
    expect(indexed, `indexer is ${Number(onChain - indexed) / DAY} days early`).to.equal(onChain);
  });

  it("an heir acting on the events-only deadline can initiate the claim", async () => {
    const f = await loadFixture(fixture);
    await time.increase(20 * DAY);
    await f.vault.connect(f.alice).withdraw(0, ONE, f.alice.address); // owner alive, clock reset

    // The owner then really does go silent. The heir's indexer says the vault expired at `indexed`.
    const indexed = await indexerDeadline(f.vault, f.alice.address, 0);
    await time.increaseTo(indexed + 1n);

    // Intended: the prompt the indexer gives the heir is actionable. Today it reverts NotYetExpired.
    const onChain = (await f.vault.getVault(f.alice.address, 0)).deadline;
    let failure: string | undefined;
    try {
      await (await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address)).wait();
    } catch (e: any) {
      const m = /custom error '([^']+)'/.exec(String(e.message));
      failure = e.revert ? `${e.revert.name}(${e.revert.args.join(", ")})` : m ? m[1] : String(e.message);
    }
    expect(
      failure,
      `heir claimed at events-only deadline ${indexed}+1; real deadline ${onChain} is ` +
        `${Number(onChain - indexed) / DAY} days later`
    ).to.equal(undefined);
  });

  // ------------------------------------------------------------------ removed heir

  it("a removed heir can find its removal with a topic filter on its own address", async () => {
    const f = await loadFixture(fixture);
    const rcpt = await (await f.vault.connect(f.alice).setBeneficiary(0, f.carol.address)).wait();
    const bobTopic = ethers.zeroPadValue(f.bob.address, 32).toLowerCase();

    // What a topic-filtered watcher for bob can see from the removal transaction.
    const addr = await f.vault.getAddress();
    let hits = 0;
    for (const pos of [1, 2, 3]) {
      const topics: (string | null)[] = [null, null, null, null].slice(0, pos + 1);
      topics[pos] = bobTopic;
      const logs = await ethers.provider.getLogs({ address: addr, fromBlock: rcpt.blockNumber, toBlock: rcpt.blockNumber, topics });
      hits += logs.filter((l) => l.transactionHash === rcpt.hash).length;
    }

    // Sanity (passes): the removal WAS logged, bob is in the data section only.
    const parsed = parseEvent(f.vault, rcpt, "BeneficiaryChanged");
    expect(parsed.args.oldBeneficiary).to.equal(f.bob.address);

    expect(hits, "no log of the removal transaction carries the removed heir as an indexed topic").to.be.greaterThan(0);
  });

  // ------------------------------------------------------------------ VaultCreated

  it("VaultCreated reports the inactivity period the vault was created with", async () => {
    const f = await loadFixture(fixture);
    const parsed = parseEvent(f.vault, f.createRcpt, "VaultCreated");
    const fields = parsed.fragment.inputs.map((i: any) => i.name);
    expect(fields, `VaultCreated(${fields.join(", ")}) has no inactivityPeriod`).to.include("inactivityPeriod");
    expect(namedArg(parsed, ["inactivityPeriod"])).to.equal(BigInt(PERIOD));
  });
});
