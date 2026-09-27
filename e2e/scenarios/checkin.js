"use strict";
// Checking in: one vault, the last check-in that pins a deadline at its horizon, and "Check in on
// all vaults" with every CheckInSkipped reason the app can meet. Reasons the app reads before
// sending (a pending claim, a passed horizon, a pinned deadline) are shown before anything is
// signed; the others come from the contract's CheckInSkipped logs, when a vault changes between
// the app's read and the mining of its transaction. The wallet hook makes those changes: another
// party's transaction (or a clock jump) mined just before the app's checkInMany.

const { ethers } = require("ethers");
const { assert, assertEqual, poll, DAY, fmtUtc } = require("../lib/util");

/** The check-in-all report: the ok lines, and each "NOT checked in" item with its buttons. */
async function report(t) {
  return t.page.evaluate(() => {
    const root = document.getElementById("checkAllReport");
    const okLines = [...root.querySelectorAll(":scope > .follow-up")].map((el) => el.textContent.replace(/\s+/g, " ").trim());
    const head = root.querySelector(".banner .claim-head")?.textContent.trim() ?? null;
    const items = [...root.querySelectorAll(".skip-list > li")].map((li) => {
      const copy = li.cloneNode(true);
      copy.querySelectorAll(".review-actions").forEach((el) => el.remove());
      return {
        text: copy.textContent.replace(/\s+/g, " ").trim(),
        buttons: [...li.querySelectorAll(".review-actions button")].map((b) => b.textContent),
      };
    });
    return { okLines, head, items };
  });
}

const REASON = {
  2: "it has settled or closed. Nothing can be checked in on it any more.",
  3: "a claim is pending on it. A check-in never cancels a claim. Veto the claim.",
  4: "it has reached its horizon. Check-ins no longer work on it, and your heir can start a claim at any time. Extend the horizon.",
  5: "its deadline already sits at the horizon, so a check-in cannot move it. At the horizon your heir can claim. Extend the horizon to keep checking in.",
  7: "a claim is pending on it and it has reached its horizon. Veto no longer works here",
};
const BUTTONS = {
  2: [], 3: ["Veto claim"], 4: ["Extend horizon"], 5: ["Extend horizon"],
  7: ["Stop this claim: extend horizon", "Withdraw everything and close"],
};

function expectItems(got, expected) {
  const lines = got.items.map((item) => `${item.text} [${item.buttons.join(" | ")}]`);
  assertEqual(got.items.length, expected.length, `NOT-checked-in items (${lines.join(" / ")})`);
  expected.forEach(([id, code], i) => {
    const item = got.items[i];
    assert(item.text.startsWith(`Vault #${id}: ${REASON[code]}`), `item ${i}: expected vault #${id} with reason ${code}, got "${item.text}"`);
    assertEqual(JSON.stringify(item.buttons), JSON.stringify(BUTTONS[code]), `remedy buttons for vault #${id}`);
  });
  const head = expected.length === 1 ? "1 vault is NOT checked in:" : `${expected.length} vaults are NOT checked in:`;
  assertEqual(got.head, head, "the report's heading");
}

/** Clicks Check in on all vaults and waits for its log to settle. */
async function checkInAll(t) {
  await t.page.click("#checkAllBtn");
  return poll(() => t.app.textOf("#checkAllLog"), (text) => /confirmed|failed|Nothing sent|could not be read/.test(text),
    { what: "the check-in-all log to settle", timeout: 30000 });
}

module.exports = [
  {
    name: "check in: an expired vault, then the last check-in that pins the deadline at its horizon",
    async run(t) {
      const { app } = t;
      const { alice } = t.who;
      const t0 = await t.now();
      const quick = await t.createVault(alice, { period: 7 * DAY, window: 7 * DAY });
      const near = await t.createVault(alice, { period: 30 * DAY, horizon: t0 + 40 * DAY });
      await t.chain.travel(8 * DAY);
      await app.open();
      await app.connect(alice);
      await t.step("the expired vault says so", async () => {
        const text = await app.cardText(quick);
        assert(text.includes("Warning: your timer has expired - check in now; until you do, your heir can start a claim"),
          `vault #${quick}'s card: ${text}`);
        assert(/Next deadline: 1d 0h ago|Next deadline: \d+h ago/.test(text), `the countdown should be past: ${text}`);
      });
      await t.step("Check in moves its deadline one period on", async () => {
        const before = await t.vault(alice, quick);
        await app.sign(app.card(quick).locator(".actions"), "Check in", `#log-owner-${quick}`, "Check-in");
        const after = await t.vault(alice, quick);
        const now = await t.now();
        assertEqual(Number(after.deadline), now + 7 * DAY, "the new deadline");
        assert(Number(after.deadline) > Number(before.deadline), "the deadline must move");
        const text = await app.cardText(quick);
        assert(!text.includes("your timer has expired"), `the expired warning must be gone: ${text}`);
      });
      await t.step("four days on, the next check-in reaches the horizon and says it was the last", async () => {
        await t.chain.travel(4 * DAY);
        await app.reload();
        const text = await app.cardText(near);
        assert(!text.includes("Check-ins can no longer move"), `not pinned yet: ${text}`);
        await app.sign(app.card(near).locator(".actions"), "Check in", `#log-owner-${near}`, "Check-in");
        const log = await app.waitLog(near, "that was the last check-in that can move this deadline");
        assert(log.includes(`Your deadline has reached the horizon (${fmtUtc(t0 + 40 * DAY)})`), `pinned follow-up: ${log}`);
        const v = await t.vault(alice, near);
        assertEqual(Number(v.deadline), t0 + 40 * DAY, "the deadline sits at the horizon");
        assertEqual(Number(v.warnings) & 16, 16, "warnings bit 4 (pinned)");
      });
      await t.step("the pinned card offers Extend horizon instead of Check in", async () => {
        const text = await app.cardText(near);
        assert(text.includes("Check-ins can no longer move this vault's deadline."), `pinned block: ${text}`);
        assertEqual(JSON.stringify(await app.buttons(app.card(near).locator(".actions"))),
          JSON.stringify(["Extend horizon", "Top up", "Withdraw part", "Withdraw everything and close", "Change heir"]),
          "a pinned vault's actions");
      });
    },
  },

  {
    name: "check in: a paper check-in chain armed outside the app and used up is flagged on the card",
    async run(t) {
      const { app } = t;
      const { alice, dave } = t.who;
      const id = await t.createVault(alice, {});
      const preimage = ethers.keccak256(ethers.toUtf8Bytes("e2e check-in chain seed"));
      const anchor = await t.v2().hbStep(alice, id, 1, preimage);
      await t.tx(alice, "setCheckInChain(uint256,bytes32,uint32)", id, anchor, 1);
      await t.chain.travel(DAY);
      await t.tx(dave, "checkInByChain", alice, id, preimage);
      assertEqual(Number((await t.vault(alice, id)).warnings) & 8, 8, "warnings bit 3 (chain used up)");
      await app.open();
      await app.connect(alice);
      const text = await app.cardText(id);
      t.check(text.includes("Warning: paper check-in chain exhausted"), `card: ${text}`);
    },
  },

  {
    name: "check in all: skips read before sending, and CheckInSkipped reasons 2, 3, 5 and 6 from the receipt",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const t0 = await t.now();
      const plain = await t.createVault(alice, {});
      const claimedLate = await t.createVault(alice, { period: 7 * DAY });
      const closedLate = await t.createVault(alice, {});
      const pinnedLate = await t.createVault(alice, { period: 30 * DAY, horizon: t0 + 40 * DAY });
      const sameBlock = await t.createVault(alice, {});
      const claimedBefore = await t.createVault(alice, { period: 7 * DAY });
      const pinnedBefore = await t.createVault(alice, { period: 30 * DAY, horizon: t0 + 40 * DAY });
      // Checked in by the batch itself, which moves its deadline onto its horizon.
      const lastMove = await t.createVault(alice, { period: 30 * DAY, horizon: t0 + 40 * DAY });
      await t.chain.travel(12 * DAY);
      await t.tx(bob, "initiateClaim", alice, claimedBefore, bob);
      await t.tx(alice, "checkIn", pinnedBefore);
      await app.open();
      await app.connect(alice);

      let shownBeforeSigning = null;
      t.wallet.beforeNext("checkInMany", async (tx) => {
        shownBeforeSigning = await report(t);
        const ids = t.wallet.iface.parseTransaction({ data: tx.data }).args[0].map(Number);
        assertEqual(JSON.stringify(ids), JSON.stringify([plain, claimedLate, closedLate, pinnedLate, sameBlock, lastMove]), "the batch sent");
        await t.tx(bob, "initiateClaim", alice, claimedLate, bob);
        await t.tx(alice, "withdraw", closedLate, ethers.MaxUint256, alice);
        await t.tx(alice, "checkIn", pinnedLate);
        // The same vault checked in again in the block that mines the batch.
        await t.chain.setAutomine(false);
        await t.v2(alice).checkIn(sameBlock);
        return async () => {
          await t.chain.mine();
          await t.chain.setAutomine(true);
        };
      });
      const log = await checkInAll(t);
      assert(log.includes("Check-in (6 of 8 vaults): confirmed"), `check-in-all log: ${log}`);

      await t.step("before signing, the report named the vaults it would skip and why", async () => {
        assert(shownBeforeSigning, "the hook did not run");
        assert(shownBeforeSigning.okLines.includes(`Sending a check-in for vault #${plain}, #${claimedLate}, #${closedLate}, #${pinnedLate}, #${sameBlock}, #${lastMove}.`),
          `the report while signing: ${JSON.stringify(shownBeforeSigning)}`);
        expectItems(shownBeforeSigning, [[claimedBefore, 3], [pinnedBefore, 5]]);
      });
      await t.step("after mining, every vault has its line", async () => {
        const got = await poll(() => report(t), (r) => r.items.length > 0 && !r.okLines.some((l) => l.startsWith("Sending")),
          { what: "the final check-in report" });
        assert(got.okLines.includes(`Checked in: vault #${plain}.`), `checked-in line: ${JSON.stringify(got.okLines)}`);
        t.check(got.okLines.includes(`Vault #${lastMove}: checked in, and that was the last check-in that can move its deadline. Your deadline has reached the horizon (${fmtUtc(t0 + 40 * DAY)}): check-ins can no longer move it, and the contract refuses them. At the horizon your heir can claim, and then only extending the horizon or withdrawing everything stops the claim. Extend the horizon to keep checking in.`),
          `the batch's last-move line: ${JSON.stringify(got.okLines)}`);
        assert(got.okLines.includes(`Vault #${sameBlock}: not checked in again, because it was already checked in at this second. Nothing is wrong: its deadline already moved in this block.`),
          `reason 6 line: ${JSON.stringify(got.okLines)}`);
        expectItems(got, [[claimedLate, 3], [closedLate, 2], [pinnedLate, 5], [claimedBefore, 3], [pinnedBefore, 5]]);
      });
      await t.step("the receipt really carried those reasons", async () => {
        const receipt = await t.chain.provider.getTransactionReceipt(t.wallet.lastHash());
        const iface = t.wallet.iface;
        const skips = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } })
          .filter((p) => p?.name === "CheckInSkipped").map((p) => `${p.args.vaultId}:${p.args.reason}`);
        assertEqual(JSON.stringify(skips), JSON.stringify([`${claimedLate}:3`, `${closedLate}:2`, `${pinnedLate}:5`, `${sameBlock}:6`]),
          "CheckInSkipped logs (vault:reason)");
      });
      await t.step("a remedy button acts: Veto claim on the vault the heir claimed", async () => {
        const item = (await report(t)).items.findIndex((i) => i.text.startsWith(`Vault #${claimedLate}:`));
        const before = t.wallet.hashes.length;
        await t.page.locator("#checkAllReport .skip-list > li").nth(item).getByRole("button", { name: "Veto claim" }).click();
        await app.waitConfirmed(`#log-owner-${claimedLate}`, "Veto", before);
        await app.waitLog(claimedLate, "Claim vetoed.");
        assertEqual(Number((await t.vault(alice, claimedLate)).state), 1, "the vetoed vault's state");
      });
    },
  },

  {
    name: "check in all: the horizon passes between read and mining (reasons 4 and 7), and the past-horizon remedies",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const t0 = await t.now();
      const plain = await t.createVault(alice, {});
      const horizonLate = await t.createVault(alice, { period: 7 * DAY, horizon: t0 + 20 * DAY });
      const claimHorizonLate = await t.createVault(alice, { period: 7 * DAY, horizon: t0 + 20 * DAY });
      const horizonBefore = await t.createVault(alice, { period: 7 * DAY, horizon: t0 + 10 * DAY });
      const claimHorizonBefore = await t.createVault(alice, { period: 7 * DAY, horizon: t0 + 10 * DAY });
      await t.chain.travel(8 * DAY);
      await t.tx(bob, "initiateClaim", alice, claimHorizonBefore, bob);
      await t.chain.travel(7 * DAY);
      await app.open();
      await app.connect(alice);
      t.wallet.beforeNext("checkInMany", async () => {
        await t.tx(bob, "initiateClaim", alice, claimHorizonLate, bob);
        await t.chain.travel(6 * DAY);
      });
      const log = await checkInAll(t);
      assert(log.includes("Check-in (3 of 5 vaults): confirmed"), `check-in-all log: ${log}`);
      const got = await poll(() => report(t), (r) => r.items.length > 0 && !r.okLines.some((l) => l.startsWith("Sending")),
        { what: "the final check-in report" });
      assert(got.okLines.includes(`Checked in: vault #${plain}.`), `checked-in line: ${JSON.stringify(got.okLines)}`);
      expectItems(got, [[horizonLate, 4], [claimHorizonLate, 7], [horizonBefore, 4], [claimHorizonBefore, 7]]);

      await t.step("Stop this claim: extend horizon, from the report, ends the past-horizon claim", async () => {
        const item = got.items.findIndex((i) => i.text.startsWith(`Vault #${claimHorizonBefore}:`));
        await t.page.locator("#checkAllReport .skip-list > li").nth(item)
          .getByRole("button", { name: "Stop this claim: extend horizon" }).click();
        const panel = t.page.locator(`#panel-owner-${claimHorizonBefore}`);
        await poll(() => panel.isVisible(), Boolean, { what: "the horizon panel to open on the vault's card" });
        const text = await app.textOf(panel);
        assert(text.includes(`Stop the claim on vault #${claimHorizonBefore}: extend its horizon`), `panel title: ${text}`);
        assert(text.includes("Past the horizon, extending it (or withdrawing everything) is the only way to stop this claim."), `panel: ${text}`);
        const prefilled = await panel.locator("input[type=date]").inputValue();
        assert(/^\d{4}-\d{2}-\d{2}$/.test(prefilled), `the date must come pre-filled: "${prefilled}"`);
        await app.press(panel, "Review change");
        await poll(() => panel.getByRole("button", { name: "Sign horizon change" }).count(), (n) => n === 1,
          { what: "the Sign horizon change button" });
        const review = await app.textOf(panel);
        assert(review.includes("This also cancels the claim that is pending on this vault."), `review notes: ${review}`);
        await app.sign(panel, "Sign horizon change", `#log-owner-${claimHorizonBefore}`, "Extend horizon");
        const v = await t.vault(alice, claimHorizonBefore);
        assertEqual(Number(v.state), 1, "state after extending past the horizon");
        assertEqual(Number(v.absoluteDeadline), Math.floor(Date.parse(`${prefilled}T00:00:00Z`) / 1000), "the new horizon");
      });
    },
  },

  {
    name: "check in all: every vault skipped at mining, so the batch reverts NothingCheckedIn and the app says why",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const claimed = await t.createVault(alice, { period: 7 * DAY });
      const closed = await t.createVault(alice, {});
      await t.chain.travel(8 * DAY);
      await app.open();
      await app.connect(alice);
      t.wallet.beforeNext("checkInMany", async () => {
        await t.tx(bob, "initiateClaim", alice, claimed, bob);
        await t.tx(alice, "withdraw", closed, ethers.MaxUint256, alice);
      });
      const log = await checkInAll(t);
      assert(log.startsWith("Check-in (2 of 2 vaults) failed:"), `log: ${log}`);
      assert(log.includes("Most likely: None of the vaults sent could be checked in. The contract's reasons: it has settled or closed (Nothing can be checked in on it any more.); a claim is pending on it (A check-in never cancels a claim. Veto the claim.). (NothingCheckedIn)"),
        `the revert explained: ${log}`);
      const receipt = await t.chain.provider.getTransactionReceipt(t.wallet.lastHash());
      assertEqual(receipt.status, 0, "the batch's receipt status");
      const got = await poll(() => report(t), (r) => r.items.length === 2, { what: "the re-read report" });
      expectItems(got, [[claimed, 3], [closed, 2]]);
    },
  },

  {
    name: "check in all: declined in the wallet, every vault is listed as not checked in",
    async run(t) {
      const { app } = t;
      const { alice } = t.who;
      const a = await t.createVault(alice, {});
      const b = await t.createVault(alice, {});
      await app.open();
      await app.connect(alice);
      t.wallet.rejectNext = 1;
      const log = await checkInAll(t);
      assertEqual(log, "Check-in (2 of 2 vaults) failed: you declined it in your wallet", "check-in-all log");
      const got = await poll(() => report(t), (r) => r.items.length === 2, { what: "the report after declining" });
      for (const [i, id] of [a, b].entries()) {
        assertEqual(got.items[i].text, `Vault #${id}: the check-in was not sent or not mined. Check in on its card.`, `item ${i}`);
      }
    },
  },

  {
    name: "check in all: nothing can be checked in, so nothing is sent",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const a = await t.createVault(alice, { period: 7 * DAY });
      const b = await t.createVault(alice, { period: 7 * DAY });
      await t.chain.travel(8 * DAY);
      await t.tx(bob, "initiateClaim", alice, a, bob);
      await t.tx(bob, "initiateClaim", alice, b, bob);
      await app.open();
      await app.connect(alice);
      const log = await checkInAll(t);
      assertEqual(log, "Nothing sent: none of your vaults can be checked in right now.", "check-in-all log");
      expectItems(await report(t), [[a, 3], [b, 3]]);
      assertEqual(t.wallet.sent.length, 0, "transactions sent");
    },
  },
];
