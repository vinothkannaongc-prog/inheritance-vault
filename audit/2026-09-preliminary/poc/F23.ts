// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F23/test/poc-F23.ts.
// Contract under test: contracts/NotifySubscription.sol (unchanged v1); the [fork] tests read the live
// contract on an in-process fork of Base (read-only RPC; skipped when offline). See ../README.md.
/**
 * PoC F23: the retired NotifySubscription still sells reminder time on chain, and the docs
 * wrongly say it "cannot be paused".
 *
 * Two kinds of test live here:
 *
 *  [fork]  Run against a local fork of Base mainnet at the latest block, so they check the
 *          REAL contract at 0x60749aF6...dC6 and its REAL storage (pricePerMonth). Nothing is
 *          sent to mainnet: impersonation and balances exist only in the in-process fork.
 *          These assert the SAFE property ("a retired billing contract takes no money"), so
 *          they FAIL today and start passing once the admin signs setPrice(type(uint256).max)
 *          on Base. If the RPC cannot be reached the fork tests are skipped, not failed.
 *
 *  [local] Deterministic, no network. They show that setPrice(type(uint256).max) is a working,
 *          admin-reversible kill switch, which is what makes "cannot be paused" false.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
  reset,
  impersonateAccount,
  stopImpersonatingAccount,
  setBalance,
  takeSnapshot,
  SnapshotRestorer,
  mine,
} from "@nomicfoundation/hardhat-network-helpers";

const MONTH = 30n * 86_400n;
const MAX_PREPAID = 3650n * 86_400n;
const LIVE_SUB = "0x60749aF621180de1DC05DB4f3d158D09dE979dC6";
const LIVE_ADMIN = "0x883C821103B5415C53B11E584D3592205B5CdCA3"; // hardware wallet, deployments/base.json
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const DEPLOY_PRICE = ethers.parseEther("0.001"); // deployments/base.json params.subPricePerMonth
const TOP_UP = ethers.parseEther("0.012"); // the finding's scenario: 12 months for a parent
const ETH_SUPPLY_WEI = ethers.parseEther("120000000"); // ~all ETH in existence

describe("PoC F23: retired NotifySubscription still takes payments", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  // ------------------------------------------------------------------ local, deterministic

  describe("[local] setPrice(type(uint256).max) is a working kill switch", () => {
    async function fixture() {
      const [admin, alice, heir, parent, newAdmin] = await ethers.getSigners();
      const Sub = await ethers.getContractFactory("NotifySubscription", admin);
      const sub = await Sub.deploy(admin.address, DEPLOY_PRICE);
      return { sub, admin, alice, heir, parent, newAdmin };
    }

    it("admin sets the price to 2^256-1: every subscribe reverts, reads, withdraw and ownership still work", async () => {
      const f = await loadFixture(fixture);

      // A subscriber who paid before retirement: one month.
      await f.sub.connect(f.alice).subscribe(f.alice.address, 0, { value: DEPLOY_PRICE });
      const aliceUntil = await f.sub.paidUntil(f.alice.address);
      expect(await f.sub.isActive(f.alice.address)).to.equal(true);

      // The kill switch.
      await expect(f.sub.connect(f.admin).setPrice(ethers.MaxUint256))
        .to.emit(f.sub, "PriceChanged")
        .withArgs(DEPLOY_PRICE, ethers.MaxUint256);

      // added = msg.value * MONTH / (2^256-1) == 0 for every payable amount, so ZeroAmount.
      // msg.value * MONTH cannot overflow: it would need msg.value > 4.4e70 wei.
      await setBalance(f.heir.address, ETH_SUPPLY_WEI * 2n);
      for (const value of [1n, TOP_UP, ethers.parseEther("1000"), ETH_SUPPLY_WEI]) {
        await expect(
          f.sub.connect(f.heir).subscribe(f.parent.address, 0, { value }),
          `subscribe with ${value} wei`,
        ).to.be.revertedWithCustomError(f.sub, "ZeroAmount");
      }
      // subscribe is the only way in: the contract has no receive() or fallback().
      await expect(f.heir.sendTransaction({ to: await f.sub.getAddress(), value: 1n })).to.be.reverted;

      // Already-bought time is untouched and still reads as active.
      expect(await f.sub.paidUntil(f.alice.address)).to.equal(aliceUntil);
      expect(await f.sub.isActive(f.alice.address)).to.equal(true);
      expect(await f.sub.paidUntil(f.parent.address)).to.equal(0n);

      // Revenue already collected can still be withdrawn.
      await expect(f.sub.connect(f.admin).withdraw(f.admin.address))
        .to.emit(f.sub, "Withdrawn")
        .withArgs(f.admin.address, DEPLOY_PRICE);

      // Ownership can still move (e.g. to a tombstone), and the switch is admin-reversible,
      // which is the honest wording: "disabled on chain; only the admin can reverse this".
      await f.sub.connect(f.admin).transferOwnership(f.newAdmin.address);
      await f.sub.connect(f.newAdmin).acceptOwnership();
      expect(await f.sub.owner()).to.equal(f.newAdmin.address);
      await f.sub.connect(f.newAdmin).setPrice(DEPLOY_PRICE);
      await expect(f.sub.connect(f.heir).subscribe(f.parent.address, 0, { value: TOP_UP }))
        .to.emit(f.sub, "Subscribed");
    });
  });

  // ------------------------------------------------------------------ fork of Base mainnet

  describe("[fork] the live contract at 0x60749aF6...dC6", function () {
    this.timeout(180_000);

    let forked = false;

    before(async function () {
      try {
        await reset(BASE_RPC);
        const code = await ethers.provider.getCode(LIVE_SUB);
        if (code === "0x") throw new Error("no code at the live address on the fork");
        // EDR has no Base hardfork history, so it cannot execute calls AT the fork block.
        // One local block on top makes "latest" a block it executes with its own config.
        await mine();
        forked = true;
      } catch (e: any) {
        console.warn(`      [fork] skipped: cannot fork ${BASE_RPC}: ${e.message}`);
        await reset();
        this.skip();
      }
    });

    after(async () => {
      if (forked) await reset(); // back to a clean local chain for any later test file
    });

    // Each fork test starts from the untouched live state.
    let snap: SnapshotRestorer;
    beforeEach(async () => {
      snap = await takeSnapshot();
    });
    afterEach(async () => {
      await snap.restore();
    });

    // Fresh addresses with no mainnet history (Hardhat's well-known dev accounts can carry
    // EIP-7702 code on public chains). Impersonated and funded only inside the fork.
    async function actor(label: string) {
      const addr = ethers.getAddress(ethers.dataSlice(ethers.id(`F23 ${label}`), 12));
      await impersonateAccount(addr);
      await setBalance(addr, ethers.parseEther("10000"));
      return ethers.getSigner(addr);
    }

    async function live() {
      const sub = await ethers.getContractAt("NotifySubscription", LIVE_SUB);
      const heir = await actor("heir");
      const parent = await actor("parent");
      expect(await ethers.provider.getCode(heir.address)).to.equal("0x");
      return { sub, heir, parent };
    }

    it("SAFE PROPERTY: a direct 'top-up' to the retired billing contract is refused on chain", async () => {
      const { sub, heir, parent } = await live();
      const price = await sub.pricePerMonth();
      console.log(`      live pricePerMonth = ${price} wei (0.001 ETH = ${DEPLOY_PRICE})`);

      // The service is retired and the watcher is off. The intended state is that the contract
      // no longer sells time at all. Today it does, so this assertion fails.
      await expect(
        sub.connect(heir).subscribe(parent.address, 0, { value: TOP_UP }),
        "retired NotifySubscription accepted a 0.012 ETH payment for a service that no longer runs",
      ).to.be.revertedWithCustomError(sub, "ZeroAmount");
    });

    it("DAMAGE: the payment is kept, time is credited to nobody's benefit, and the payer cannot get it back", async () => {
      const { sub, heir, parent } = await live();
      const subAddr = await sub.getAddress();
      const balBefore = await ethers.provider.getBalance(subAddr);
      const untilBefore = await sub.paidUntil(parent.address);

      let accepted = false;
      let creditedSecs = 0n;
      try {
        const rcpt = await (await sub.connect(heir).subscribe(parent.address, 0, { value: TOP_UP })).wait();
        accepted = true;
        const ts = BigInt((await ethers.provider.getBlock(rcpt!.blockNumber))!.timestamp);
        const base = untilBefore > ts ? untilBefore : ts; // the contract's own extension base
        creditedSecs = (await sub.paidUntil(parent.address)) - base;
      } catch {
        /* refused on chain: the fixed state */
      }

      const stranded = (await ethers.provider.getBalance(subAddr)) - balBefore;
      if (accepted) {
        console.log(
          `      stranded in contract: ${ethers.formatEther(stranded)} ETH; ` +
            `credited ${Number(creditedSecs) / 86_400} days of reminders nobody will send`,
        );
        // No refund path for the payer: the only outflow is the owner-only withdraw().
        await expect(sub.connect(heir).withdraw(heir.address)).to.be.revertedWithCustomError(
          sub,
          "OwnableUnauthorizedAccount",
        );
        // Upper bound per account per call at the current price (MAX_PREPAID cap).
        const price = await sub.pricePerMonth();
        console.log(
          `      largest single payment accepted per account today: ` +
            `${ethers.formatEther((price * MAX_PREPAID) / MONTH)} ETH (3650 days)`,
        );
      }

      expect(stranded, "wei the retired contract kept from the payer").to.equal(0n);
      expect(creditedSecs, "seconds of a retired service sold to the payer").to.equal(0n);
    });

    it("the recommended fix works on the LIVE bytecode: admin setPrice(max) makes subscribe revert", async () => {
      const { sub, heir, parent } = await live();
      // Fork-local impersonation of the hardware-wallet owner; nothing reaches mainnet.
      await impersonateAccount(LIVE_ADMIN);
      await setBalance(LIVE_ADMIN, ethers.parseEther("1"));
      const admin = await ethers.getSigner(LIVE_ADMIN);
      expect(await sub.owner()).to.equal(LIVE_ADMIN);

      await sub.connect(admin).setPrice(ethers.MaxUint256);
      await stopImpersonatingAccount(LIVE_ADMIN);

      for (const value of [1n, TOP_UP, ethers.parseEther("1000")]) {
        await expect(
          sub.connect(heir).subscribe(parent.address, 0, { value }),
          `subscribe with ${value} wei after the kill switch`,
        ).to.be.revertedWithCustomError(sub, "ZeroAmount");
      }
      // Reads the (retired) watcher would use keep working.
      expect(await sub.isActive(parent.address)).to.be.a("boolean");
      expect(await sub.pricePerMonth()).to.equal(ethers.MaxUint256);
    });
  });
});
