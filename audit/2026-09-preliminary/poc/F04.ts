// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F04/test/poc-F04.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for audit finding F04: the credit lane is all-or-nothing.
 *
 * _credit() merges every credit for (token, account) into one number, and both exits
 * (withdrawCredit, pushCredit) move that whole number in ONE transfer. With a token that caps a
 * single transfer (anti-whale maxTx), a credit above the cap can never leave the contract.
 *
 * Every `it` below (except the explicit CONTROL) asserts the SAFE property -- "the heir gets the
 * inheritance out" -- so it FAILS against the current contract and becomes a regression test
 * once a partial exit such as withdrawCredit(address,address,uint256) exists. The recovery
 * helper is deliberately fix-agnostic: it tries every exit the deployed ABI offers, including a
 * partial-amount overload if one is present, and only then measures what reached the heir.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const FEE_BPS = 50n; // 0.5%, same as the other suites
const E = (x: string) => ethers.parseEther(x);
const CAP = E("100"); // maxTx of the anti-whale token

function reasonOf(e: any): string {
  const m = String(e?.message ?? e).match(/reverted with reason string '([^']*)'|reverted with custom error '([^']*)'/);
  if (m) return m[1] ?? m[2];
  return String(e?.shortMessage ?? e?.message ?? e).slice(0, 120);
}

describe("F04 all-or-nothing credit lane vs a transfer-capped token", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, mallory, dave, feeSink, keeper, bobFresh] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, Number(FEE_BPS), feeSink.address);
    const Tok = await ethers.getContractFactory("F04_PocMaxTxToken", admin);
    const token = await Tok.deploy(CAP);
    const vaultAddr = await vault.getAddress();
    const tokenAddr = await token.getAddress();
    for (const s of [alice, mallory]) {
      await token.mint(s.address, E("1000"));
      await token.connect(s).approve(vaultAddr, ethers.MaxUint256);
    }
    return { vault, token, vaultAddr, tokenAddr, admin, alice, bob, mallory, dave, feeSink, keeper, bobFresh };
  }

  /** Alice opens a vault naming Bob, then goes silent. */
  async function openAliceVault(f: any, amount: bigint) {
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.alice).createVault(f.tokenAddr, amount, f.bob.address, PERIOD, WINDOW, horizon);
  }

  /** Bob claims after the inactivity period; the window passes. Returns nothing -- not finalized. */
  async function bobClaimsAndWaits(f: any) {
    await time.increase(PERIOD + 1);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    await time.increase(WINDOW + 1);
  }

  /**
   * Tries EVERY exit the contract offers to move `holder`'s credit to the holder or a fresh
   * address of theirs, then reports what actually arrived. Fix-agnostic: if a partial-amount
   * withdrawCredit(address,address,uint256) exists it is used in cap-sized chunks.
   */
  async function recoverCredit(f: any, holder: any, fresh: any) {
    const reasons: string[] = [];
    const bal = async () => (await f.token.balanceOf(holder.address)) + (await f.token.balanceOf(fresh.address));
    const credit = async () => f.vault.creditOf(f.tokenAddr, holder.address);
    const before = await bal();
    const creditBefore: bigint = await credit();

    // 1. pull the whole credit to the holder's own address
    try {
      await (await f.vault.connect(holder)["withdrawCredit(address,address)"](f.tokenAddr, holder.address)).wait();
    } catch (e) {
      reasons.push(`withdrawCredit(T, heir) -> ${reasonOf(e)}`);
    }
    // 2. pull the whole credit to a fresh address (the documented escape hatch)
    if ((await credit()) > 0n) {
      try {
        await (await f.vault.connect(holder)["withdrawCredit(address,address)"](f.tokenAddr, fresh.address)).wait();
      } catch (e) {
        reasons.push(`withdrawCredit(T, freshAddr) -> ${reasonOf(e)}`);
      }
    }
    // 3. permissionless push by a keeper
    if ((await credit()) > 0n) {
      try {
        await (await f.vault.connect(f.keeper)["pushCredit(address,address)"](f.tokenAddr, holder.address)).wait();
      } catch (e) {
        reasons.push(`pushCredit(T, heir) -> ${reasonOf(e)}`);
      }
    }
    // 4. a partial-amount exit, if the contract has one (the recommended fix)
    if ((await credit()) > 0n) {
      const partial = f.vault.interface.getFunction("withdrawCredit(address,address,uint256)");
      if (!partial) {
        reasons.push("no partial-amount exit exists in the ABI");
      } else {
        for (let i = 0; i < 64 && (await credit()) > 0n; i++) {
          const left: bigint = await credit();
          const chunk = left < CAP ? left : CAP;
          try {
            await (
              await f.vault.connect(holder)["withdrawCredit(address,address,uint256)"](f.tokenAddr, holder.address, chunk)
            ).wait();
          } catch (e) {
            reasons.push(`withdrawCredit(T, heir, ${ethers.formatEther(chunk)}) -> ${reasonOf(e)}`);
            break;
          }
        }
      }
    }
    return { creditBefore, recovered: (await bal()) - before, creditLeft: await credit(), reasons };
  }

  // ------------------------------------------------------------------ control

  it("CONTROL: an estate under the cap settles and the heir withdraws it in full", async () => {
    const f = await loadFixture(fixture);
    await openAliceVault(f, E("99"));
    await bobClaimsAndWaits(f);
    await f.vault.connect(f.keeper).finalizeClaim(f.alice.address, 0);
    const r = await recoverCredit(f, f.bob, f.bobFresh);
    expect(r.creditBefore).to.equal(E("98.505")); // 99 minus 0.5% fee
    expect(r.recovered).to.equal(E("98.505"));
    expect(r.creditLeft).to.equal(0n);
  });

  // ------------------------------------------------------------------ F04-1

  it("F04-1 a stranger's topUp pushes the estate over the cap; the heir must still receive it", async () => {
    const f = await loadFixture(fixture);
    await openAliceVault(f, E("90")); // under the cap: this would settle and pay out fine
    // Mallory, a stranger, "gifts" 20 to the ACTIVE vault. topUp is permissionless.
    await f.vault.connect(f.mallory).topUp(f.alice.address, 0, E("20"));
    expect((await f.vault.getVault(f.alice.address, 0)).balance).to.equal(E("110"));

    await bobClaimsAndWaits(f);
    await f.vault.connect(f.keeper).finalizeClaim(f.alice.address, 0);
    expect(await f.vault.creditOf(f.tokenAddr, f.bob.address)).to.equal(E("109.45"));

    const r = await recoverCredit(f, f.bob, f.bobFresh);
    // SAFE PROPERTY: the settled inheritance reaches the heir.
    expect(
      r.recovered,
      `heir recovered ${ethers.formatEther(r.recovered)} of ${ethers.formatEther(r.creditBefore)}; ` +
        `credit still stuck: ${ethers.formatEther(r.creditLeft)}; exits tried: ${r.reasons.join(" | ")}`
    ).to.equal(r.creditBefore);
  });

  // ------------------------------------------------------------------ F04-2

  it("F04-2 a stranger's withdraw(to=heir) in the settlement block merges into and freezes the heir's credit", async () => {
    const f = await loadFixture(fixture);
    await openAliceVault(f, E("99")); // settles to 98.505: under the cap (see CONTROL)
    await bobClaimsAndWaits(f);

    // Mallory opens her OWN vault in the same token with just the gap (1.5), naming anyone.
    const horizon = (await time.latest()) + 730 * DAY;
    await f.vault.connect(f.mallory).createVault(f.tokenAddr, E("1.5"), f.dave.address, PERIOD, WINDOW, horizon);

    // Same block: Mallory finalizes Alice's claim (permissionless) AND withdraws her own vault
    // to Bob. Bob never has a block in which his credit sits under the cap.
    await network.provider.send("evm_setAutomine", [false]);
    let tx1, tx2;
    try {
      tx1 = await f.vault.connect(f.mallory).finalizeClaim(f.alice.address, 0, { gasLimit: 500_000 });
      tx2 = await f.vault.connect(f.mallory).withdraw(0, E("1.5"), f.bob.address, { gasLimit: 500_000 });
      await network.provider.send("evm_mine");
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const [r1, r2] = [await tx1!.wait(), await tx2!.wait()];
    expect(r1!.status).to.equal(1);
    expect(r2!.status).to.equal(1);
    expect(r1!.blockNumber).to.equal(r2!.blockNumber);
    expect(await f.vault.creditOf(f.tokenAddr, f.bob.address)).to.equal(E("100.005"));

    const r = await recoverCredit(f, f.bob, f.bobFresh);
    // SAFE PROPERTY: at the very least the heir's OWN inheritance (98.505) must reach him.
    expect(
      r.recovered >= E("98.505"),
      `heir recovered ${ethers.formatEther(r.recovered)} (inheritance 98.505, merged credit ` +
        `${ethers.formatEther(r.creditBefore)}); exits tried: ${r.reasons.join(" | ")}`
    ).to.equal(true);
  });

  // ------------------------------------------------------------------ F04-3

  it("F04-3 no malice: createVault + topUp, each under the cap, settle into one credit the heir must be able to withdraw", async () => {
    const f = await loadFixture(fixture);
    // Alice herself funds in two cap-sized steps (each transfer IN obeys the cap).
    await openAliceVault(f, E("100"));
    await f.vault.connect(f.alice).topUp(f.alice.address, 0, E("100"));
    await bobClaimsAndWaits(f);
    await f.vault.connect(f.keeper).finalizeClaim(f.alice.address, 0);
    expect(await f.vault.creditOf(f.tokenAddr, f.bob.address)).to.equal(E("199"));

    const r = await recoverCredit(f, f.bob, f.bobFresh);
    expect(
      r.recovered,
      `heir recovered ${ethers.formatEther(r.recovered)} of ${ethers.formatEther(r.creditBefore)}; ` +
        `exits tried: ${r.reasons.join(" | ")}`
    ).to.equal(r.creditBefore);
  });

  // ------------------------------------------------------------------ damage

  it("F04-4 damage: a 10.6 donation freezes 89.55 of inheritance, still frozen ten years later", async () => {
    const f = await loadFixture(fixture);
    await openAliceVault(f, E("90")); // alone this settles to 89.55 and is withdrawable
    // Minimal grief: (90 + x) * 0.995 must exceed 100, so x > 10.5025.
    const donation = E("10.6");
    await f.vault.connect(f.mallory).topUp(f.alice.address, 0, donation);
    await bobClaimsAndWaits(f);
    await f.vault.connect(f.keeper).finalizeClaim(f.alice.address, 0);

    await time.increase(3650 * DAY); // nothing about the lane changes with time
    const r = await recoverCredit(f, f.bob, f.bobFresh);
    const vaultBal: bigint = await f.token.balanceOf(f.vaultAddr);
    const credited: bigint = await f.vault.totalCredited(f.tokenAddr);
    const heirOwn = E("89.55");
    expect(
      r.recovered >= heirOwn,
      `attacker spent ${ethers.formatEther(donation)}; heir's own inheritance ${ethers.formatEther(heirOwn)}; ` +
        `heir recovered ${ethers.formatEther(r.recovered)}; still credited to heir ${ethers.formatEther(r.creditLeft)}; ` +
        `vault token balance ${ethers.formatEther(vaultBal)}, totalCredited ${ethers.formatEther(credited)}; ` +
        `exits tried: ${r.reasons.join(" | ")}`
    ).to.equal(true);
  });
});
