// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F08/test/poc-F08.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC F08 -- permissionless pushCredit overrides the credited account's routing choice.
 *
 * NatSpec InheritanceVault.sol:67-72 promises: "withdrawCredit lets the credited account route
 * anywhere, which covers blocklisted EOAs and any contract able to make one call".
 * pushCredit (:726-733) is permissionless and always pays `account` itself, so a third party can
 * deliver the credit INTO the blocklisted EOA / the call-only contract before the account routes it.
 *
 * The "regression" tests assert the SAFE property (the heir can still route the full credit to a
 * clean address after a third party has acted) and therefore FAIL against the current code.
 * The "control" tests show the escape works when nobody pushes, isolating the defect to pushCredit.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50;
const DEPOSIT = ethers.parseEther("1000");
const FEE = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n; // 5 tokens
const HEIR_CREDIT = DEPOSIT - FEE; // 995 tokens

describe("PoC F08 - permissionless pushCredit defeats the withdrawCredit routing escape", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, mallory, fresh, feeSink, issuer] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("InheritanceVaultV1", admin)).deploy(
      admin.address,
      FEE_BPS,
      feeSink.address
    );
    const vaultAddr = await vault.getAddress();
    // Tether-style token, issued by an unrelated party (NOT the vault admin).
    const usdt = await (await ethers.getContractFactory("F08_SenderOnlyBlocklistToken", issuer)).deploy();
    const plain = await (await ethers.getContractFactory("MintableToken", issuer)).deploy();
    const helper = await (await ethers.getContractFactory("F08_FinalizeAndPush", mallory)).deploy();
    const forwarder = await (await ethers.getContractFactory("F08_CreditForwarder", bob)).deploy(bob.address, vaultAddr);
    return { vault, vaultAddr, usdt, plain, helper, forwarder, admin, alice, bob, mallory, fresh, feeSink, issuer };
  }

  /** Alice deposits DEPOSIT of `token` naming Bob as heir; Bob initiates a claim to `recipient`. */
  async function openClaim(f: any, token: any, recipient: string) {
    const tokenAddr = await token.getAddress();
    await token.connect(f.issuer).mint(f.alice.address, DEPOSIT);
    await token.connect(f.alice).approve(f.vaultAddr, DEPOSIT);
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(tokenAddr, DEPOSIT, f.bob.address, PERIOD, WINDOW, horizon);
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, recipient);
    const v = await f.vault.getVault(f.alice.address, 0);
    return { tokenAddr, finalizableAt: Number(v.finalizableAt) };
  }

  /** Blocklist variant setup: claim to Bob himself, issuer blocklists Bob during the window. */
  async function blocklistedHeir() {
    const f = await loadFixture(fixture);
    const { tokenAddr, finalizableAt } = await openClaim(f, f.usdt, f.bob.address);
    await f.usdt.connect(f.issuer).addBlackList(f.bob.address);
    // sanity on the token model: Bob can no longer SEND, but the vault can still send TO him
    expect(await f.usdt.isBlackListed(f.bob.address)).to.equal(true);
    return { ...f, tokenAddr, finalizableAt };
  }

  /** Mallory's attack: finalize + push in one tx in the first block after the window. */
  async function malloryFinalizeAndPush(f: any) {
    await time.setNextBlockTimestamp(f.finalizableAt);
    let atomicTxHash: string | undefined;
    try {
      const tx = await f.helper
        .connect(f.mallory)
        .run(f.vaultAddr, f.alice.address, 0, f.tokenAddr, f.bob.address);
      atomicTxHash = (await tx.wait()).hash;
    } catch {
      // A fixed vault may refuse the push (and with it the atomic tx). Settlement is still
      // permissionless, so Mallory settles anyway and tries a bare push.
    }
    if ((await f.vault.getVault(f.alice.address, 0)).state !== 3n) {
      await f.vault.connect(f.mallory).finalizeClaim(f.alice.address, 0);
      try {
        await f.vault.connect(f.mallory).pushCredit(f.tokenAddr, f.bob.address);
      } catch {}
    }
    return atomicTxHash;
  }

  // ------------------------------------------------------------------ blocklist variant

  describe("variant 1: sender-only blocklist token (TetherToken semantics)", () => {
    it("control: a blocklisted heir who routes first recovers the full credit at a clean address", async () => {
      const f = await blocklistedHeir();
      await time.increaseTo(f.finalizableAt);
      await f.vault.connect(f.mallory).finalizeClaim(f.alice.address, 0); // permissionless
      expect(await f.vault.creditOf(f.tokenAddr, f.bob.address)).to.equal(HEIR_CREDIT);

      await f.vault.connect(f.bob).withdrawCredit(f.tokenAddr, f.fresh.address);
      expect(await f.usdt.balanceOf(f.fresh.address)).to.equal(HEIR_CREDIT);
      expect(await f.usdt.balanceOf(f.bob.address)).to.equal(0n);
    });

    it("regression: a third party's finalize+pushCredit must not move a blocklisted heir's credit into his blocklisted address", async () => {
      const f = await blocklistedHeir();
      await malloryFinalizeAndPush(f);
      expect((await f.vault.getVault(f.alice.address, 0)).state).to.equal(3n); // SETTLED either way

      // SAFE PROPERTY: the credit is still Bob's to route (NatSpec :69-70).
      expect(await f.vault.creditOf(f.tokenAddr, f.bob.address)).to.equal(
        HEIR_CREDIT,
        "a third party pushed the blocklisted heir's credit out of the credit lane before he could route it"
      );
      await f.vault.connect(f.bob).withdrawCredit(f.tokenAddr, f.fresh.address);
      expect(await f.usdt.balanceOf(f.fresh.address)).to.equal(HEIR_CREDIT);
    });

    it("damage: the credit lands frozen in the blocklisted address in the same tx as settlement, and the issuer can burn it", async () => {
      const f = await blocklistedHeir();
      const supplyBefore = await f.usdt.totalSupply();
      const atomicTxHash = await malloryFinalizeAndPush(f);

      // If the attack tx succeeded, settlement and push share ONE receipt: Bob never had a block
      // in which his credit existed and could be routed.
      let settledAndPushedInOneTx = false;
      if (atomicTxHash) {
        const rc = await ethers.provider.getTransactionReceipt(atomicTxHash);
        const names = rc!.logs
          .filter((l) => l.address.toLowerCase() === f.vaultAddr.toLowerCase())
          .map((l) => f.vault.interface.parseLog(l)?.name);
        settledAndPushedInOneTx = names.includes("ClaimSettled") && names.includes("CreditPaid");
      }

      // Bob's best effort to save the money.
      try {
        await f.vault.connect(f.bob).withdrawCredit(f.tokenAddr, f.fresh.address);
      } catch {}
      const frozenAtBob = await f.usdt.balanceOf(f.bob.address);
      if (frozenAtBob > 0n) {
        await expect(f.usdt.connect(f.bob).transfer(f.fresh.address, frozenAtBob)).to.be.revertedWith("blacklisted");
      }
      // The issuer exercises destroyBlackFunds on the blocklisted address.
      await f.usdt.connect(f.issuer).destroyBlackFunds(f.bob.address);
      const burned = supplyBefore - (await f.usdt.totalSupply());

      console.log(
        `      [F08] settledAndPushedInOneTx=${settledAndPushedInOneTx} frozenAtBob=${ethers.formatEther(frozenAtBob)} ` +
          `recoveredToFresh=${ethers.formatEther(await f.usdt.balanceOf(f.fresh.address))} burned=${ethers.formatEther(burned)}`
      );
      expect({
        frozenInBlocklistedAddress: frozenAtBob,
        recoveredByHeirToCleanAddress: await f.usdt.balanceOf(f.fresh.address),
        burnedByIssuer: burned,
      }).to.deep.equal({
        frozenInBlocklistedAddress: 0n,
        recoveredByHeirToCleanAddress: HEIR_CREDIT,
        burnedByIssuer: 0n,
      });
    });
  });

  // ------------------------------------------------------------------ call-only contract variant

  describe("variant 2: claim recipient is a contract that can call withdrawCredit but cannot move ERC20", () => {
    async function forwarderClaim() {
      const f = await loadFixture(fixture);
      const fwd = await f.forwarder.getAddress();
      const { tokenAddr, finalizableAt } = await openClaim(f, f.plain, fwd);
      await time.increaseTo(finalizableAt);
      await f.vault.connect(f.mallory).finalizeClaim(f.alice.address, 0);
      expect(await f.vault.creditOf(tokenAddr, fwd)).to.equal(HEIR_CREDIT);
      return { ...f, fwd, tokenAddr };
    }

    it("control: with nobody pushing, the forwarder's one call routes the full credit to Bob", async () => {
      const f = await forwarderClaim();
      await f.forwarder.connect(f.bob).pull(f.tokenAddr, f.bob.address);
      expect(await f.plain.balanceOf(f.bob.address)).to.equal(HEIR_CREDIT);
      expect(await f.plain.balanceOf(f.fwd)).to.equal(0n);
    });

    it("regression: Mallory front-running Bob's pull with pushCredit must not strand the credit in the forwarder", async () => {
      const f = await forwarderClaim();
      const gwei = (n: number) => ethers.parseUnits(String(n), "gwei");

      // Bob broadcasts his pull; Mallory sees it and outbids it with pushCredit. Same block.
      await network.provider.send("evm_setAutomine", [false]);
      let bobHash: string, malHash: string;
      try {
        bobHash = (
          await f.forwarder.connect(f.bob).pull(f.tokenAddr, f.bob.address, {
            gasLimit: 300_000,
            maxPriorityFeePerGas: gwei(1),
            maxFeePerGas: gwei(200),
          })
        ).hash;
        malHash = (
          await f.vault.connect(f.mallory).pushCredit(f.tokenAddr, f.fwd, {
            gasLimit: 300_000,
            maxPriorityFeePerGas: gwei(50),
            maxFeePerGas: gwei(200),
          })
        ).hash;
        await mine(1);
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }

      // precondition: this really is a front-run -- both in one block, Mallory's first
      const block = await ethers.provider.getBlock("latest");
      expect(block!.transactions).to.deep.equal([malHash!, bobHash!]);

      const bobRc = await ethers.provider.getTransactionReceipt(bobHash!);
      if (bobRc!.status !== 1) {
        // diagnose WHY Bob's pull failed: not gas, not access control -- the credit is gone
        expect(bobRc!.gasUsed).to.be.lessThan(300_000n);
        await expect(f.forwarder.connect(f.bob).pull.staticCall(f.tokenAddr, f.bob.address))
          .to.be.revertedWithCustomError(f.vault, "NothingCredited")
          .withArgs(f.tokenAddr, f.fwd);
      }
      const outcome = {
        bobPullSucceeded: bobRc!.status === 1,
        receivedByBob: await f.plain.balanceOf(f.bob.address),
        strandedInForwarder: await f.plain.balanceOf(f.fwd),
      };
      console.log(
        `      [F08] bobPullSucceeded=${outcome.bobPullSucceeded} receivedByBob=${ethers.formatEther(outcome.receivedByBob)} ` +
          `strandedInForwarder=${ethers.formatEther(outcome.strandedInForwarder)}`
      );
      // SAFE PROPERTY: Bob's own routing choice wins; nothing is stranded in the call-only contract.
      expect(outcome).to.deep.equal({
        bobPullSucceeded: true,
        receivedByBob: HEIR_CREDIT,
        strandedInForwarder: 0n,
      });
    });
  });
});
