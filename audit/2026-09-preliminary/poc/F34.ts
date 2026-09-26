// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F34/test/poc-F34.ts.
// Contract under test: contracts/NotifySubscription.sol (unchanged v1). See ../README.md.
/**
 * PoC for F34 — NotifySubscription: the owner can reprice a purchase already in flight.
 *
 * setPrice() (NotifySubscription.sol:84-88) takes effect in the same block it is mined, bounded
 * only by non-zero. subscribe() (:60-66) prices msg.value against pricePerMonth AT MINING TIME;
 * the only guard is the opt-in `minSecondsAdded` floor, whose natural value from a block
 * explorer's Write Contract form is 0.
 *
 * SAFE PROPERTY asserted: a payment signed against a quoted price either delivers the time that
 * price quoted, or does not go through. A price change ordered ahead of it in the same block
 * must not silently convert the payer's funds into a fraction of the quoted time.
 *
 * The tests FAIL against the current code because the payment is mined, succeeds, and delivers
 * a fraction of the quote. Either recommended fix (reject minSecondsAdded == 0 / take a
 * maxPricePerMonth, or delay price increases) makes them pass: the payment then either reverts
 * or is priced at the quoted rate.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const MONTH = 30n * 86_400n;
const PRICE = ethers.parseEther("0.001"); // per 30 days, as in test/NotifySubscription.ts
const GAS = 200_000n;
const gwei = (n: number) => ethers.parseUnits(String(n), "gwei");

describe("F34 PoC — admin reprices an in-flight subscription payment", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice] = await ethers.getSigners();
    const Sub = await ethers.getContractFactory("NotifySubscription", admin);
    const sub = await Sub.deploy(admin.address, PRICE);
    await sub.waitForDeployment();
    return { sub, admin, alice };
  }

  /**
   * Puts the admin's setPrice(newPrice) and Alice's subscribe(alice, 0) into the SAME block, the
   * admin's at a higher priority fee (the MEV / sequencer ordering a watching admin would buy),
   * then mines that one block. Returns what Alice was actually credited.
   */
  async function raceInOneBlock(f: any, newPrice: bigint, value: bigint) {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      // Alice submits first: 12 months at the price she just read, floor 0 (explorer default).
      const aliceTx = await f.sub.connect(f.alice).subscribe(f.alice.address, 0, {
        value,
        gasLimit: GAS,
        maxFeePerGas: gwei(100),
        maxPriorityFeePerGas: gwei(1),
      });
      // The admin sees it pending and outbids it with a reprice.
      const adminTx = await f.sub.connect(f.admin).setPrice(newPrice, {
        gasLimit: GAS,
        maxFeePerGas: gwei(100),
        maxPriorityFeePerGas: gwei(50),
      });
      await network.provider.send("evm_mine", []);

      const aliceRcpt = await ethers.provider.getTransactionReceipt(aliceTx.hash);
      const adminRcpt = await ethers.provider.getTransactionReceipt(adminTx.hash);
      // Setup sanity (not the defect): both mined in one block, reprice ordered first.
      expect(aliceRcpt, "alice tx mined").to.not.equal(null);
      expect(adminRcpt, "admin tx mined").to.not.equal(null);
      expect(adminRcpt!.status, "setPrice succeeded").to.equal(1);
      expect(aliceRcpt!.blockNumber).to.equal(adminRcpt!.blockNumber);
      expect(adminRcpt!.index).to.be.lessThan(aliceRcpt!.index);
      expect(await f.sub.pricePerMonth()).to.equal(newPrice);

      const blk = await ethers.provider.getBlock(aliceRcpt!.blockNumber);
      const delivered = BigInt(await f.sub.paidUntil(f.alice.address)) - BigInt(blk!.timestamp);
      return { aliceStatus: aliceRcpt!.status, delivered };
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  }

  it("a payment signed at the quoted price is never mined at a price the payer did not see", async () => {
    const f = await loadFixture(fixture);
    const value = PRICE * 12n; // 0.012 ETH
    const quoted = (value * MONTH) / (await f.sub.pricePerMonth()); // 12 * 30 days = 31,104,000 s

    const { aliceStatus, delivered } = await raceInOneBlock(f, PRICE * 100n, value);

    // SAFE: either the payment did not go through (floor enforced / reprice delayed), or it
    // delivered what the quoted price promised.
    if (aliceStatus === 1) {
      expect(
        delivered,
        `payment of ${ethers.formatEther(value)} ETH quoted ${quoted}s but was credited ${delivered}s`,
      ).to.be.gte(quoted);
    }
  });

  it("damage: the admin can choose a price that turns the whole payment into 1 second, then withdraw it", async () => {
    const f = await loadFixture(fixture);
    const value = PRICE * 12n;
    const quoted = (value * MONTH) / (await f.sub.pricePerMonth());
    // Largest price that still keeps `added` >= 1 (added == 0 would revert ZeroAmount at :65).
    const hostilePrice = value * MONTH;

    const { aliceStatus, delivered } = await raceInOneBlock(f, hostilePrice, value);

    // Quantify what the admin can take for that 1 second.
    const bal = await ethers.provider.getBalance(await f.sub.getAddress());
    if (bal > 0n) {
      await expect(f.sub.connect(f.admin).withdraw(f.admin.address)).to.changeEtherBalance(f.admin, bal);
    }

    if (aliceStatus === 1) {
      expect(
        delivered,
        `payer credited ${delivered}s of ${quoted}s quoted; admin withdrew ${ethers.formatEther(bal)} ETH`,
      ).to.be.gte(quoted);
    }
  });
});
