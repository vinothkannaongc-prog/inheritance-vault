"use strict";
// Owner actions on a vault card: changing the heir, extending the horizon, topping up, partial
// and full withdrawal, and what the card offers once the horizon has passed.

const { ethers } = require("ethers");
const { assert, assertEqual, same, DAY, fmtUtc, utcDay, utcMidnight } = require("../lib/util");
const { lookalike, openOwnerPanel, reviewPanel, expectKind, lookupOwner } = require("../lib/flows");

const ACT_SET_BENEFICIARY = 2;
const ACT_CLOSE = 6;

async function fillPair(panel, first, second) {
  const inputs = panel.locator("input[type=text], input:not([type])");
  await inputs.nth(0).fill(first);
  await inputs.nth(1).fill(second ?? first);
}

/** Signs in a card panel and waits for THIS transaction's confirmation in the card's log. */
async function signIn(app, panel, label, id, txLabel) {
  await app.sign(panel, label, `#log-owner-${id}`, txLabel);
  return app.textOf(`#log-owner-${id}`);
}

function superseded(t, receipt) {
  return receipt.logs.map((l) => { try { return t.wallet.iface.parseLog(l); } catch { return null; } })
    .filter((p) => p?.name === "ClaimSuperseded").map((p) => Number(p.args.byAction));
}

async function lastReceipt(t) {
  return t.chain.provider.getTransactionReceipt(t.wallet.lastHash());
}

module.exports = [
  {
    name: "change heir: refusals, a new heir reviewed and signed, the picker, and a change that ends a pending claim",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol, dave } = t.who;
      const first = await t.createVault(alice, { heir: bob });
      const second = await t.createVault(alice, { heir: carol });
      const claimed = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      await t.chain.travel(8 * DAY);
      await t.tx(bob, "initiateClaim", alice, claimed, bob);
      await app.open();
      await app.connect(alice);

      let panel;
      await t.step("refusals in the change-heir review", async () => {
        panel = await openOwnerPanel(app, first, "Change heir");
        const text = await app.textOf(panel);
        assert(text.includes(`Change the heir of vault #${first}`) && text.includes(`Current heir0x${bob.slice(2)}`), `panel: ${text}`);
        const cases = [
          ["the current heir again", bob, undefined, "banner", "That address is already the heir of this vault."],
          ["a look-alike of another vault's heir", lookalike(carol), undefined, "banner", `the heir of your vault #${second}`],
          ["a look-alike of this vault's heir", lookalike(bob, { end: true }), undefined, "banner", "Blocked: this address starts or ends with the same 4 characters"],
          ["the EntryPoint v0.7", t.world.refused.entryPointV07, undefined, "banner", "That is the ERC-4337 EntryPoint v0.7"],
          ["the cbBTC token", t.world.tokens.cbBTC.address, undefined, "banner", "That is the cbBTC token contract, one of the tokens the vault contract lists"],
          ["the owner", alice, undefined, "banner", "That is your own connected wallet."],
          ["two different entries", dave, carol, "banner", "the two entries are different addresses"],
        ];
        for (const [what, a, b, kind, pattern] of cases) {
          await fillPair(panel, a, b);
          expectKind(await reviewPanel(app, panel, "Review change", "Sign heir change"), kind, pattern, what);
        }
        assertEqual(t.wallet.sent.length, 0, "transactions sent during the refusals");
      });
      await t.step("a new heir: review and sign", async () => {
        await fillPair(panel, dave);
        const review = expectKind(await reviewPanel(app, panel, "Review change", "Sign heir change"), "sign", null, "the review");
        assert(review.includes(`Current heir0x${bob.slice(2)}`) && review.includes(`New heir0x${dave.slice(2)}`) && review.includes("claim authority"),
          `review rows: ${review}`);
        assert(review.includes("Changing the heir restarts your check-in timer."), `review notes: ${review}`);
        const log = await signIn(app, panel, "Sign heir change", first, "Change heir");
        assert(log.includes("ask your heir to open the \"I'm an heir\" tab"), `follow-up: ${log}`);
        const v = await t.vault(alice, first);
        assert(same(v.beneficiary, dave), "the new beneficiary on chain");
        assertEqual(Number(v.deadline), (await t.now()) + 90 * DAY, "the restarted deadline");
      });
      await t.step("the picker offers the heirs of the other open vaults and fills both boxes", async () => {
        panel = await openOwnerPanel(app, second, "Change heir");
        const options = await panel.locator("select option").evaluateAll((opts) => opts.map((o) => o.value));
        assert(options.includes(dave) && !options.includes(carol), `picker options (vault #${second}): ${options}`);
        await panel.locator("select").selectOption(dave);
        const inputs = panel.locator("input[type=text], input:not([type])");
        assertEqual(await inputs.nth(0).inputValue(), dave, "first box");
        assertEqual(await inputs.nth(1).inputValue(), dave, "second box");
        expectKind(await reviewPanel(app, panel, "Review change", "Sign heir change"), "sign", dave, "picked heir review");
        await signIn(app, panel, "Sign heir change", second, "Change heir");
        assert(same((await t.vault(alice, second)).beneficiary, dave), "vault #1's new beneficiary");
      });
      await t.step("with a claim pending, the change says it cancels the claim, and does", async () => {
        const text = await app.cardText(claimed);
        assert(text.includes("A claim has been filed on this vault."), `claimed card: ${text}`);
        panel = await openOwnerPanel(app, claimed, "Change heir");
        await fillPair(panel, carol);
        const review = expectKind(await reviewPanel(app, panel, "Review change", "Sign heir change"), "sign", null, "claim-pending review");
        assert(review.includes("This also cancels the claim that is pending on this vault."), `notes: ${review}`);
        await signIn(app, panel, "Sign heir change", claimed, "Change heir");
        const v = await t.vault(alice, claimed);
        assertEqual(Number(v.state), 1, "state after the change");
        assert(same(v.beneficiary, carol), "beneficiary after the change");
        assertEqual(JSON.stringify(superseded(t, await lastReceipt(t))), JSON.stringify([ACT_SET_BENEFICIARY]), "ClaimSuperseded tags");
      });
    },
  },

  {
    name: "a claim filed while the owner's review is open: Sign refuses, and the card shows the claim",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      await t.expire(alice, id);
      await app.open();
      await app.connect(alice);
      const panel = await openOwnerPanel(app, id, "Withdraw part");
      await panel.locator("input").first().fill("0.1");
      expectKind(await reviewPanel(app, panel, "Review withdrawal", "Sign withdrawal"), "sign", null, "review");
      await t.tx(bob, "initiateClaim", alice, id, bob);
      await app.press(panel, "Sign withdrawal");
      const log = await app.waitLog(id, "changed after this panel was opened");
      t.check(log.includes(`Vault #${id} changed after this panel was opened: a claim was filed on it. What it said no longer describes what signing would do, so nothing was signed. Review the vault again from its card.`),
        `refusal: ${log}`);
      await app.waitText(app.card(id), "A claim has been filed on this vault.");
      assertEqual(t.wallet.sent.length, 0, "transactions sent");
      assertEqual((await t.vault(alice, id)).balance, ethers.parseEther("1"), "balance untouched");
    },
  },

  {
    name: "extend horizon: floor and ceiling refused, a review with the span, and the year retyped for a jump over ten years",
    async run(t) {
      const { app } = t;
      const { alice } = t.who;
      const t0 = await t.now();
      const id = await t.createVault(alice, { period: 90 * DAY, window: 30 * DAY, horizon: t0 + 2 * 365 * DAY });
      await app.open();
      await app.connect(alice);
      let panel = await openOwnerPanel(app, id, "Extend horizon");
      const date = panel.locator("input[type=date]");
      const minDay = await date.getAttribute("min");
      const maxDay = await date.getAttribute("max");
      await t.step("the panel", async () => {
        const text = await app.textOf(panel);
        assert(text.includes(`Current horizon${fmtUtc(t0 + 2 * 365 * DAY)}`) && text.includes("Challenge window30 days"), `panel: ${text}`);
        assertEqual(await date.inputValue(), "", "the date is not pre-filled before the horizon");
        assertEqual(minDay, utcDay(Math.ceil((t0 + 2 * 365 * DAY + 1) / DAY) * DAY), "the earliest date offered");
      });
      await t.step("refusals", async () => {
        const dayBefore = utcDay(utcMidnight(minDay) - DAY);
        await date.fill(dayBefore);
        expectKind(await reviewPanel(app, panel, "Review change", "Sign horizon change"), "banner",
          `The new horizon must be ${minDay} or later`, "a date below the floor");
        const dayAfter = utcDay(utcMidnight(maxDay) + DAY);
        await date.fill(dayAfter);
        expectKind(await reviewPanel(app, panel, "Review change", "Sign horizon change"), "banner",
          `The new horizon must be ${maxDay} or earlier (at most 36500 days from now).`, "a date past the ceiling");
        await date.fill("");
        expectKind(await reviewPanel(app, panel, "Review change", "Sign horizon change"), "banner",
          "Pick a real calendar date (YYYY-MM-DD).", "no date");
      });
      await t.step("three more years: review and sign", async () => {
        const target = utcDay(utcMidnight(minDay) + 3 * 365 * DAY);
        await date.fill(target);
        const review = expectKind(await reviewPanel(app, panel, "Review change", "Sign horizon change"), "sign", null, "review");
        for (const part of [`New horizon${fmtUtc(utcMidnight(target))}raise-only`, "Change+3 years",
          `finalizable from ${fmtUtc(utcMidnight(target) + 30 * DAY)} (horizon + challenge window)`,
          "The horizon can never be lowered on this vault."]) {
          assert(review.includes(part), `review lacks "${part}": ${review}`);
        }
        await signIn(app, panel, "Sign horizon change", id, "Extend horizon");
        assertEqual(Number((await t.vault(alice, id)).absoluteDeadline), utcMidnight(target), "horizon on chain");
        assert((await app.cardText(id)).includes(`Horizon (long-stop) ${fmtUtc(utcMidnight(target))}`), "the card shows the new horizon");
      });
      await t.step("a jump of more than ten years needs the year typed, and a wrong one is refused", async () => {
        panel = await openOwnerPanel(app, id, "Extend horizon");
        const current = Number((await t.vault(alice, id)).absoluteDeadline);
        const target = utcDay(current + 15 * 366 * DAY);
        await panel.locator("input[type=date]").fill(target);
        const review = expectKind(await reviewPanel(app, panel, "Review change", "Sign horizon change"), "sign", null, "long-jump review");
        assert(review.includes("Type the new horizon's year to confirm"), `year check missing: ${review}`);
        const year = panel.locator(".panel-out input");
        await year.fill(String(Number(target.slice(0, 4)) + 1));
        await app.press(panel, "Sign horizon change");
        await app.waitText(panel, "The year you typed does not match the new horizon.");
        assertEqual(t.wallet.sentCalls().filter((c) => c === "extendHorizon").length, 1, "extendHorizon calls after the wrong year");
        await year.fill(target.slice(0, 4));
        await signIn(app, panel, "Sign horizon change", id, "Extend horizon");
        assertEqual(Number((await t.vault(alice, id)).absoluteDeadline), utcMidnight(target), "horizon after the long jump");
      });
    },
  },

  {
    name: "withdrawals: top-up, partial (refusals, then signed), and everything-and-close whatever a front-run top-up added",
    async run(t) {
      const { app } = t;
      const { alice, bob, dave } = t.who;
      const usdc = t.world.tokens.USDC.address;
      const eth = await t.createVault(alice, { heir: bob, amount: ethers.parseEther("2") });
      const tok = await t.createVault(alice, { heir: bob, token: usdc, amount: ethers.parseUnits("500", 6) });
      await app.open();
      await app.connect(alice);
      let panel;
      await t.step("top up the ETH vault", async () => {
        panel = await openOwnerPanel(app, eth, "Top up");
        await panel.locator("input").first().fill("0.25");
        const review = expectKind(await reviewPanel(app, panel, "Review top-up", "Sign top-up"), "sign", null, "top-up review");
        assert(review.includes("Add0.25 ETH") && review.includes("Balance after2.25 ETH"), `top-up review: ${review}`);
        assert(review.includes("A top-up does not restart your check-in timer"), `top-up notes: ${review}`);
        await signIn(app, panel, "Sign top-up", eth, "Top-up");
        assertEqual((await t.vault(alice, eth)).balance, ethers.parseEther("2.25"), "balance after the top-up");
      });
      await t.step("partial withdrawal: refusals", async () => {
        panel = await openOwnerPanel(app, eth, "Withdraw part");
        const input = panel.locator("input").first();
        for (const [value, pattern] of [["2.25", "That is the whole balance or more. Use \"Withdraw everything and close\""],
          ["3", "That is the whole balance or more"], ["1,5", "is not an amount"], ["0", "enter an amount above zero"],
          ["0.0000000000000000001", "has more than 18 decimal places"]]) {
          await input.fill(value);
          expectKind(await reviewPanel(app, panel, "Review withdrawal", "Sign withdrawal"), "banner", pattern, `withdraw "${value}"`);
        }
      });
      await t.step("partial withdrawal: 0.5 ETH, credited to the owner", async () => {
        await panel.locator("input").first().fill("0.5");
        const review = expectKind(await reviewPanel(app, panel, "Review withdrawal", "Sign withdrawal"), "sign", null, "withdraw review");
        for (const part of ["Amount0.5 ETH", "Left in the vault1.75 ETH", `Credited to0x${alice.slice(2)}`, "your wallet",
          "A withdrawal restarts your check-in timer", "The amount is credited to your wallet, not sent: collect it on the Payouts tab."]) {
          assert(review.includes(part), `withdraw review lacks "${part}": ${review}`);
        }
        const log = await signIn(app, panel, "Sign withdrawal", eth, "Withdraw");
        assert(log.includes("Credited to your wallet: collect it on the Payouts tab."), `follow-up: ${log}`);
        assertEqual((await t.vault(alice, eth)).balance, ethers.parseEther("1.75"), "balance after the partial withdrawal");
        assertEqual(await t.credit(ethers.ZeroAddress, alice), ethers.parseEther("0.5"), "alice's ETH credit");
      });
      await t.step("withdraw everything and close, with a 1-wei top-up mined just before it", async () => {
        panel = await openOwnerPanel(app, eth, "Withdraw everything and close");
        const text = await app.textOf(panel);
        assert(text.includes("everything (now 1.75 ETH)") && text.includes("closes the vault") && text.includes("This closes the vault permanently"),
          `withdraw-all panel: ${text}`);
        t.wallet.beforeNext("withdraw", async () => {
          await t.v2(dave).topUp(alice, eth, 1n, { value: 1n }).then((tx) => tx.wait());
        });
        const sentBefore = t.wallet.hashes.length;
        await app.press(panel, "Sign: withdraw everything");
        await app.waitText("#mineAlerts", `Vault #${eth} is closed. 1.750000000000000001 ETH was credited to your wallet: collect it on the Payouts tab.`);
        const closeHash = t.wallet.hashes[sentBefore];
        const links = await t.page.locator("#tab-mine a").evaluateAll((as) => as.map((x) => x.href));
        t.check(links.some((href) => href.endsWith(`/tx/${closeHash}`)),
          `after closing the vault nothing links its transaction ${closeHash}: the confirmation line went with the card`);
        const v = await t.vault(alice, eth);
        assertEqual(Number(v.state), 4, "state after withdrawing everything");
        assertEqual(v.balance, 0n, "balance after withdrawing everything");
        assertEqual(await t.credit(ethers.ZeroAddress, alice), ethers.parseEther("2.25") + 1n, "alice's ETH credit");
        assertEqual(await app.card(eth).count(), 0, "the closed vault's card is gone");
      });
      await t.step("top up the USDC vault: approve exactly the amount, then the top-up", async () => {
        panel = await openOwnerPanel(app, tok, "Top up");
        await panel.locator("input").first().fill("50");
        const review = expectKind(await reviewPanel(app, panel, "Review top-up", "Sign top-up"), "sign", null, "USDC top-up review");
        assert(review.includes("Add50.0 USDC") && review.includes("Balance after550.0 USDC"), `USDC top-up review: ${review}`);
        assert(review.includes("your wallet first asks you to approve exactly this amount, then to sign the top-up"), `approval note: ${review}`);
        const before = t.wallet.hashes.length;
        await app.press(panel, "Sign top-up");
        await app.waitConfirmed(`#log-owner-${tok}`, "Top-up", before + 1);
        assertEqual(JSON.stringify(t.wallet.sentCalls().slice(-2)), JSON.stringify(["0x095ea7b3", "topUp"]), "approve, then topUp");
        assertEqual((await t.vault(alice, tok)).balance, ethers.parseUnits("550", 6), "USDC balance after the top-up");
        assertEqual(await t.erc20(usdc).allowance(alice, t.world.v2Address), 0n, "allowance left");
      });
      await t.step("the USDC vault: part, then everything", async () => {
        panel = await openOwnerPanel(app, tok, "Withdraw part");
        await panel.locator("input").first().fill("100.5");
        const review = expectKind(await reviewPanel(app, panel, "Review withdrawal", "Sign withdrawal"), "sign", null, "USDC withdraw review");
        assert(review.includes("Amount100.5 USDC") && review.includes("Left in the vault449.5 USDC"), `USDC review: ${review}`);
        await signIn(app, panel, "Sign withdrawal", tok, "Withdraw");
        panel = await openOwnerPanel(app, tok, "Withdraw everything and close");
        await app.press(panel, "Sign: withdraw everything");
        await app.waitText("#mineAlerts", `Vault #${tok} is closed. 449.5 USDC was credited to your wallet`);
        assertEqual(await t.credit(usdc, alice), ethers.parseUnits("550", 6), "alice's USDC credit");
        await app.waitText("#mineEmpty", "No vaults yet");
      });
    },
  },

  {
    name: "past the horizon: the owner card's offers, a heir change behind an acknowledgement, and a claim only extend or close can stop",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol } = t.who;
      const t0 = await t.now();
      const active = await t.createVault(alice, { heir: bob, period: 7 * DAY, horizon: t0 + 10 * DAY });
      const claimed = await t.createVault(alice, { heir: bob, period: 7 * DAY, horizon: t0 + 10 * DAY, amount: ethers.parseEther("3") });
      await t.chain.travel(8 * DAY);
      await t.tx(bob, "initiateClaim", alice, claimed, bob);
      await t.chain.travel(3 * DAY);
      await app.open();
      await app.connect(alice);
      const horizon = fmtUtc(t0 + 10 * DAY);

      await t.step("an active vault past its horizon", async () => {
        const text = await app.cardText(active);
        for (const part of [`This vault passed its horizon on ${horizon}.`,
          "Check-ins no longer work, and your heir can start a claim at any time.",
          "To keep control, extend the horizon to"]) {
          assert(text.includes(part), `vault #${active} lacks "${part}": ${text}`);
        }
        const buttons = await app.buttons(app.card(active).locator(".actions"));
        assert(/^Extend horizon \(from \d{4}-\d{2}-\d{2}\)$/.test(buttons[0]), `first action: ${buttons[0]}`);
        assertEqual(JSON.stringify(buttons.slice(1)), JSON.stringify(["Top up", "Withdraw part", "Withdraw everything and close",
          "Change heir without extending"]), "the other actions");
      });
      await t.step("a heir change past the horizon needs the acknowledgement, and says it restarts nothing", async () => {
        const panel = await openOwnerPanel(app, active, "Change heir without extending");
        assert((await app.textOf(panel)).includes("Changing the heir now does not restart your check-in timer"), "past-horizon warning");
        await app.press(panel, "Change heir without extending");
        await app.waitText(panel, "Tick the box above first, or extend the horizon first.");
        await panel.locator("input[type=checkbox]").check();
        await app.press(panel, "Change heir without extending");
        await app.waitText(panel, `Change the heir of vault #${active} (past the horizon)`);
        await fillPair(panel, carol);
        const review = expectKind(await reviewPanel(app, panel, "Review change", "Sign heir change"), "sign", null, "past-horizon heir review");
        assert(review.includes("Past the horizon this does not restart your check-in timer: the new heir can start a claim as soon as it is mined, and you could not veto it."),
          `notes: ${review}`);
        await signIn(app, panel, "Sign heir change", active, "Change heir");
        const v = await t.vault(alice, active);
        assert(same(v.beneficiary, carol), "beneficiary");
        assertEqual(v.expired, true, "the vault is still claimable at once");
      });
      await t.step("the new heir can indeed claim at once, as the warning said", async () => {
        await app.switchAccount(carol);
        await lookupOwner(app, alice);
        assertEqual(JSON.stringify(await app.buttons(app.heirCard(alice, active).locator(".actions"))), JSON.stringify(["Initiate claim"]),
          "the new heir's actions");
        await app.switchAccount(alice);
      });
      await t.step("a claim pending past the horizon: what the card says and offers", async () => {
        const text = await app.cardText(claimed);
        for (const part of ["A claim has been filed on this vault.",
          `This vault passed its horizon on ${horizon}, so Veto, Check in and Change heir no longer work`,
          "A partial withdrawal does not stop it; the heir would inherit the rest."]) {
          assert(text.includes(part), `claimed card lacks "${part}": ${text}`);
        }
        assertEqual(JSON.stringify(await app.buttons(app.card(claimed).locator(".actions"))),
          JSON.stringify(["Stop this claim: extend horizon", "Withdraw everything and close", "Withdraw part"]), "actions");
      });
      await t.step("a partial withdrawal leaves that claim running", async () => {
        const panel = await openOwnerPanel(app, claimed, "Withdraw part");
        await panel.locator("input").first().fill("1");
        const review = expectKind(await reviewPanel(app, panel, "Review withdrawal", "Sign withdrawal"), "sign", null, "review");
        assert(review.includes("This does NOT stop the pending claim"), `notes: ${review}`);
        await signIn(app, panel, "Sign withdrawal", claimed, "Withdraw");
        const v = await t.vault(alice, claimed);
        assertEqual(Number(v.state), 2, "the claim is still pending");
        assertEqual(v.balance, ethers.parseEther("2"), "balance");
      });
      await t.step("withdrawing everything ends it", async () => {
        const panel = await openOwnerPanel(app, claimed, "Withdraw everything and close");
        assert((await app.textOf(panel)).includes("This ends the pending claim by closing the vault, provided it is mined before anyone finalizes the claim"),
          "withdraw-all note on a pending claim");
        await app.press(panel, "Sign: withdraw everything");
        await app.waitText("#mineAlerts", `Vault #${claimed} is closed.`);
        assertEqual(Number((await t.vault(alice, claimed)).state), 4, "closed");
        assertEqual(JSON.stringify(superseded(t, await lastReceipt(t))), JSON.stringify([ACT_CLOSE]), "ClaimSuperseded tags");
      });
    },
  },
];
