"use strict";
// The inheritance itself: the owner's deadline passes, the heir looks the vault up and files a
// claim, the owner sees it and vetoes; later the heir files again, cancels to correct the payout
// address and re-files to another address, the window ends, the claim is finalized, and the
// credit is withdrawn in parts, in full, and pushed by a stranger after the grace.

const { ethers } = require("ethers");
const { assert, assertEqual, poll, same, short, DAY } = require("../lib/util");
const { lookupOwner, lookalike, expectKind } = require("../lib/flows");
const { Chain } = require("../lib/chain");

const heirPanel = (t, owner, id) => t.page.locator(`#panel-heir-${owner.toLowerCase()}-${id}`);
const heirLog = (owner, id) => `#log-heir-${owner.toLowerCase()}-${id}`;

/** Presses a button on the heir card of owner's vault `id`. */
async function heirButton(t, owner, id, label) {
  await t.app.press(t.app.heirCard(owner, id).locator(".actions"), label);
}

/** Opens "Initiate claim", optionally for another payout address, and reviews it. */
async function reviewClaim(t, owner, id, { to, to2 } = {}) {
  const panel = heirPanel(t, owner, id);
  if (!(await panel.isVisible())) {
    await heirButton(t, owner, id, "Initiate claim");
    await poll(() => panel.isVisible(), Boolean, { what: "the claim panel" });
  }
  if (to) {
    await panel.locator("input[type=radio]").nth(1).check();
    const inputs = panel.locator("input[type=text], input:not([type])");
    await inputs.nth(0).fill(to);
    await inputs.nth(1).fill(to2 ?? to);
  } else {
    await panel.locator("input[type=radio]").nth(0).check();
  }
  await t.app.press(panel, "Review claim");
  return poll(() => panel.evaluate((el) => {
    const out = el.querySelector(".panel-out");
    const sign = [...el.querySelectorAll("button")].some((b) => b.textContent === "Sign claim");
    const banner = out && out.querySelector(".banner");
    if (sign) return { kind: "sign", text: el.textContent.replace(/\s+/g, " ") };
    if (banner) return { kind: "banner", text: banner.textContent.replace(/\s+/g, " ") };
    return null;
  }), Boolean, { what: "the claim review" });
}

async function payouts(t) {
  await t.app.tab("credits");
  await t.page.click("#crCheckBtn");
  await poll(() => t.page.evaluate(() => {
    const log = document.getElementById("crLog").textContent;
    return !/Reading your payouts/.test(log) && document.getElementById("crList").children.length > 0;
  }), Boolean, { what: "the payouts list" });
  return t.app.textOf("#crList");
}

module.exports = [
  {
    name: "claim: the deadline passes, the heir looks the vault up and files a claim, the owner sees it and vetoes",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY, window: 14 * DAY });
      await t.expire(alice, id);
      await app.open();
      await app.connect(bob);

      await t.step("the heir finds the vault by the owner's address", async () => {
        const text = await lookupOwner(app, alice);
        for (const part of ["1.0 ETH", `Owner0x${alice.slice(2)}`, `Heir (you)0x${bob.slice(2)}`,
          "The owner's deadline has passed: you can start a claim now. Nobody will do it for you.",
          "Nothing happens by itself: you start the claim, then finalize it."]) {
          t.check(text.includes(part), `heir card lacks "${part}": ${text}`);
        }
        assertEqual(JSON.stringify(await app.buttons(app.heirCard(alice, id).locator(".actions"))), JSON.stringify(["Initiate claim"]),
          "the heir's actions on an expired vault");
      });
      await t.step("the claim review, paying the heir's own wallet", async () => {
        const review = expectKind(await reviewClaim(t, alice, id), "sign", null, "claim review");
        for (const part of [`Payout to0x${bob.slice(2)}`, "your wallet", "Amount1.0 ETH",
          "Correctable until14 days after this claim is mined (its finalizableAt)then fixed",
          "Claim feelocks 0.5% now: the lower of this vault's ceiling (0.5%) and the rate in force (0.5%).",
          "The payout address is recorded for this claim. You can correct it only by cancelling the claim and starting again, and safely only in the next 14 days"]) {
          t.check(review.includes(part), `claim review lacks "${part}": ${review}`);
        }
        assertEqual(await heirPanel(t, alice, id).locator(".panel-out input[type=checkbox]").count(), 0,
          "no acknowledgement is asked when paying the heir's own wallet");
      });
      let hash;
      await t.step("sign the claim", async () => {
        const before = t.wallet.hashes.length;
        await app.press(heirPanel(t, alice, id), "Sign claim");
        hash = await poll(() => t.wallet.hashes[before] ?? null, Boolean, { what: "the claim transaction" });
        const v = await t.waitVault(alice, id, (x) => Number(x.state) === 2, "the claim to be pending on chain");
        assert(same(v.claimRecipient, bob), "claim recipient");
        assertEqual(Number(v.lockedFeeBps), 50, "locked fee");
        const log = await app.waitText(heirLog(alice, id), "Claim started.");
        t.check(log.includes(`It can be finalized from ${await app.fmtLocal(v.finalizableAt)}`) && log.includes("It locked a fee of at most 0.5%."),
          `claim follow-up: ${log}`);
        // The owner flows keep "<action>: confirmed <tx>" in the card's log after the card is
        // re-rendered; the heir card should too, or the heir loses the transaction link.
        t.check(log.includes(`Initiate claim: confirmed ${short(hash)}`),
          `the heir card's log lost the confirmation line and its transaction link after the refresh: "${log}"`);
      });
      await t.step("the heir's card while the claim is pending", async () => {
        const v = await t.vault(alice, id);
        const text = await app.textOf(app.heirCard(alice, id));
        t.check(text.includes("Your claim on this vault is pending.") && text.includes(`Until ${await app.fmtLocal(v.finalizableAt)} you can still correct the payout address`),
          `pending heir card: ${text}`);
        const buttons = await app.buttons(app.heirCard(alice, id).locator(".actions"));
        assertEqual(JSON.stringify(buttons), JSON.stringify(["Cancel my claim"]), "heir actions while the window is open");
        t.check(text.includes(`finalizable from ${await app.fmtWhen(v.finalizableAt)}`), `finalizable-from pill: ${text}`);
      });
      await t.step("the owner sees the claim lead the card, with Veto instead of Check in", async () => {
        await app.switchAccount(alice);
        const v = await t.vault(alice, id);
        const text = await app.cardText(id);
        for (const part of ["Claim pending", "A claim has been filed on this vault.", `Filed by0x${bob.slice(2)}`, "the heir",
          `Paying0x${bob.slice(2)}`, "the heir's address", `Finalizable from${await app.fmtLocal(v.finalizableAt)}`,
          "Fee lockedat most 0.5%", "Your veto only works if it is mined before someone's finalize is: act now, not on the last day.",
          "To stop it, use Veto."]) {
          t.check(text.includes(part), `owner's claim card lacks "${part}": ${text}`);
        }
        assertEqual(JSON.stringify(await app.buttons(app.card(id).locator(".actions"))),
          JSON.stringify(["Veto claim", "Withdraw part", "Withdraw everything and close", "Change heir", "Extend horizon"]),
          "owner actions during a claim");
      });
      await t.step("Veto", async () => {
        await app.sign(app.card(id).locator(".actions"), "Veto claim", `#log-owner-${id}`, "Veto");
        await app.waitLog(id, "Claim vetoed. The vault is active again and your check-in timer restarted.");
        const v = await t.vault(alice, id);
        assertEqual(Number(v.state), 1, "state after the veto");
        assertEqual(Number(v.deadline), (await t.now()) + 7 * DAY, "the restarted deadline");
      });
    },
  },

  {
    name: "claim: cancel and re-file to another address (with its checks), finalize, withdraw in part and in full, push after the grace",
    async run(t) {
      const { app } = t;
      const { alice, bob, dave, erin } = t.who;
      const eth = ethers.ZeroAddress;
      const id = await t.createVault(alice, { heir: bob, amount: ethers.parseEther("2"), period: 7 * DAY, window: 14 * DAY });
      // Erin already holds a small ETH credit on v2 (a withdrawal the owner sent her).
      const other = await t.createVault(alice, { heir: bob, amount: ethers.parseEther("1") });
      await t.tx(alice, "withdraw", other, ethers.parseEther("0.1"), erin);
      await t.expire(alice, id);
      await t.tx(bob, "initiateClaim", alice, id, bob);
      await app.open();
      await app.connect(bob);
      await lookupOwner(app, alice);

      await t.step("cancel the claim to correct the payout address", async () => {
        const v = await t.vault(alice, id);
        await heirButton(t, alice, id, "Cancel my claim");
        const panel = heirPanel(t, alice, id);
        await poll(() => panel.isVisible(), Boolean, { what: "the cancel panel" });
        const text = await app.textOf(panel);
        t.check(text.includes(`Now paying0x${bob.slice(2)}`) && text.includes(`Last safe moment to cancel${await app.fmtLocal(v.finalizableAt)}`)
          && text.includes("finalizableAt"), `cancel panel: ${text}`);
        assertEqual(await panel.locator("input[type=checkbox]").count(), 0, "no acknowledgement before finalizableAt");
        await app.press(panel, "Sign: cancel my claim");
        const log = await app.waitText(heirLog(alice, id), "Your claim is cancelled. Start it again now, with the correct payout address");
        t.check(/Cancel claim: confirmed/.test(log), `the cancel's confirmation line is missing from the heir card's log: "${log}"`);
        assertEqual(Number((await t.vault(alice, id)).state), 1, "state after the cancel");
      });
      await t.step("payout-address refusals", async () => {
        const cases = [
          ["the WETH token", t.world.tokens.WETH.address, undefined,
            "Refused: that is the WETH token contract, one of the tokens the vault contract lists. Anything paid there is lost"],
          ["the vault contract", t.world.v2Address, undefined, "Refused: that is the Will & Key vault contract itself."],
          ["the L2ToL1MessagePasser", t.world.refused.messagePasser, undefined, "Refused: that is an OP-stack system contract"],
          // The contract accepts it, but v1 refuses the coin and has no call to collect a credit.
          ["the retired v1 contract", t.world.v1Address, undefined, "Refused: that is the retired Will & Key v1 vault contract"],
          ["a look-alike of the owner", lookalike(alice), undefined, "same 4 characters as the vault owner, but it is a different address"],
          ["a look-alike of the heir's wallet", lookalike(bob, { end: true }), undefined, "same 4 characters as your connected wallet"],
          ["two different entries", erin, dave, "the two entries are different addresses"],
        ];
        for (const [what, a, b, pattern] of cases) {
          expectKind(await reviewClaim(t, alice, id, { to: a, to2: b }), "banner", pattern, what);
        }
      });
      await t.step("a payout address with code needs a second acknowledgement", async () => {
        // A smart wallet the heir controls, as far as the app can tell: an address with code.
        const smartWallet = ethers.getAddress(`0x${"c0de".repeat(10)}`);
        await t.chain.send("hardhat_setCode", [smartWallet, "0x00"]);
        const review = expectKind(await reviewClaim(t, alice, id, { to: smartWallet }), "sign", null, "contract payout review");
        t.check(review.includes("This address is a smart contract. I have confirmed it can receive this asset"), `contract ack: ${review}`);
        assertEqual(await heirPanel(t, alice, id).locator(".panel-out input[type=checkbox]").count(), 2, "acknowledgements for a contract");
      });
      await t.step("re-file to Erin: her older credit is flagged, the acknowledgement is required", async () => {
        const review = expectKind(await reviewClaim(t, alice, id, { to: erin }), "sign", null, "Erin review");
        for (const part of [`Payout to0x${erin.slice(2)}`, "not your wallet",
          "This address already has 0.1 ETH credited on this contract. A smaller new credit joins that older credit's 30 days clock"]) {
          t.check(review.includes(part), `re-file review lacks "${part}": ${review}`);
        }
        const panel = heirPanel(t, alice, id);
        await app.press(panel, "Sign claim");
        await app.waitText(panel, "Tick every confirmation above first.");
        assertEqual(t.wallet.sent.length, 1, "transactions sent (only the cancel)");
        await panel.locator(".panel-out input[type=checkbox]").check();
        await app.press(panel, "Sign claim");
        const v = await t.waitVault(alice, id, (x) => Number(x.state) === 2, "the new claim");
        assert(same(v.claimRecipient, erin), "the new claim's recipient");
        await app.waitText(heirLog(alice, id), "Claim started.");
      });
      await t.step("the owner sees a claim paying an address that is not the heir's", async () => {
        await app.switchAccount(alice);
        const text = await app.cardText(id);
        t.check(text.includes("not the heir's address") && text.includes("It pays an address that is not the heir's own."),
          `owner card for a claim paying elsewhere: ${text}`);
      });
      await t.step("the window ends: the heir may finalize, and a late cancel asks for an acknowledgement", async () => {
        await t.windowEnds(alice, id);
        await app.switchAccount(bob);
        await lookupOwner(app, alice);
        const text = await app.textOf(app.heirCard(alice, id));
        t.check(text.includes("Anyone can finalize it now, and the payout goes to the address above: it is too late to correct the payout address safely."),
          `heir card after the window: ${text}`);
        assertEqual(JSON.stringify(await app.buttons(app.heirCard(alice, id).locator(".actions"))),
          JSON.stringify(["Finalize inheritance", "Cancel my claim"]), "heir actions after the window");
        await heirButton(t, alice, id, "Cancel my claim");
        const panel = heirPanel(t, alice, id);
        await poll(() => panel.isVisible(), Boolean, { what: "the late cancel panel" });
        const late = await app.textOf(panel);
        t.check(late.includes("Finalizable since") && late.includes("passed") && late.includes("I understand that someone may finalize this claim before my cancel is mined."),
          `late cancel panel: ${late}`);
        await app.press(panel, "Keep my claim");
      });
      await t.step("finalize: 1.99 ETH to Erin, 0.01 ETH fee", async () => {
        const sentBefore = t.wallet.hashes.length;
        await heirButton(t, alice, id, "Finalize inheritance");
        const note = await app.waitText("#heirList", `Vault #${id} settled:`);
        const finalizeHash = t.wallet.hashes[sentBefore];
        const links = await t.page.locator("#heirList a").evaluateAll((as) => as.map((a) => a.href));
        t.check(links.some((href) => href.endsWith(`/tx/${finalizeHash}`)),
          `the settlement note gives no link to the finalize transaction ${finalizeHash} (links: ${links.join(", ")})`);
        t.check(note.includes(`Vault #${id} settled: 1.99 ETH was credited to the address below, and a fee of 0.01 ETH to the fee recipient.`)
          && note.includes(`Credited to0x${erin.slice(2)}`), `settlement note: ${note}`);
        const v = await t.vault(alice, id);
        assertEqual(Number(v.state), 3, "state");
        assertEqual(await t.credit(eth, erin), ethers.parseEther("2.09"), "Erin's credit");
        assertEqual(await t.credit(eth, t.world.ledger), ethers.parseEther("0.01"), "the fee recipient's credit");
      });
      await t.step("Erin withdraws part of her credit; a stranger cannot push it yet", async () => {
        await app.switchAccount(erin);
        const text = await payouts(t);
        const since = Number(await t.v2().creditedSince(eth, erin));
        t.check(text.includes("2.09 ETH") && text.includes(`From ${await app.fmtLocal(since + 30 * DAY)} anyone may push it to your wallet; until then only you can move it.`),
          `Erin's payouts: ${text}`);
        await assertReverts(t.v2(dave).pushCredit(eth, erin), "PushTooEarly");
        const card = app.creditCard(eth);
        await app.press(card.locator(".actions"), "Withdraw part");
        const panel = t.page.locator(`#panel-credit-credit-${eth}`);
        await poll(() => panel.isVisible(), Boolean, { what: "the partial payout panel" });
        await panel.locator("input").first().fill("3");
        await app.press(panel, "Review withdrawal");
        await app.waitText(panel, "That is more than is credited to you (2.09 ETH).");
        await panel.locator("input").first().fill("0.5");
        await app.press(panel, "Review withdrawal");
        await app.waitText(panel, "1.59 ETH stays credited to you.");
        const balance = await t.chain.provider.getBalance(erin);
        const before = t.wallet.hashes.length;
        await app.press(panel, "Sign withdrawal");
        // Some credit is left, so the re-read card keeps the confirmation and the result in its log.
        const payHash = await app.waitConfirmed(`#log-credit-credit-${eth}`, "Withdraw part of payout", before);
        await app.waitText(`#log-credit-credit-${eth}`, "Paid 0.5 ETH to your wallet.");
        const links = await t.page.locator(`#log-credit-credit-${eth} a`).evaluateAll((as) => as.map((x) => x.href));
        t.check(links.some((href) => href.endsWith(`/tx/${payHash}`)),
          `after the payout nothing links its transaction ${payHash}: the payout list was re-read over its confirmation line`);
        const receipt = await t.chain.provider.getTransactionReceipt(payHash);
        const gas = receipt.gasUsed * receipt.gasPrice;
        assertEqual((await t.chain.provider.getBalance(erin)) - balance + gas, ethers.parseEther("0.5"), "ETH that reached Erin");
        assertEqual(await t.credit(eth, erin), ethers.parseEther("1.59"), "Erin's remaining credit");
        await app.waitText("#crList", "1.59 ETH");
      });
      await t.step("after the grace the payout says anyone may push it, and a stranger's push pays Erin", async () => {
        await t.chain.travel(31 * DAY);
        await app.reload();
        const text = await payouts(t);
        t.check(text.includes("Anyone can now push it to your wallet, which pays it to this same wallet."), `after the grace: ${text}`);
        const balance = await t.chain.provider.getBalance(erin);
        await Chain.mined(t.v2(dave).pushCredit(eth, erin));
        assertEqual((await t.chain.provider.getBalance(erin)) - balance, ethers.parseEther("1.59"), "ETH pushed to Erin");
        const after = await payouts(t);
        t.check(after.includes("Nothing is credited to your wallet on this vault contract, in ETH or any listed token."), `after the push: ${after}`);
      });
      await t.step("the fee recipient withdraws its whole credit", async () => {
        await app.switchAccount(t.world.ledger);
        const text = await payouts(t);
        t.check(text.includes("0.01 ETH"), `the Ledger's payouts: ${text}`);
        await app.press(app.creditCard(eth).locator(".actions"), "Withdraw all to my wallet");
        const panel = t.page.locator(`#panel-credit-credit-${eth}`);
        await poll(() => panel.isVisible(), Boolean, { what: "the payout panel" });
        await app.press(panel, "Review withdrawal");
        await app.waitText(panel, "Sign withdrawal");
        const before = t.wallet.hashes.length;
        await app.press(panel, "Sign withdrawal");
        // Nothing is left, so the card is gone: the confirmation and the result move to the status line.
        const hash = await app.waitConfirmed("#crLog", "Withdraw payout", before);
        await app.waitText("#crLog", "Paid 0.01 ETH to your wallet.");
        const links = await t.page.locator("#crLog a").evaluateAll((as) => as.map((x) => x.href));
        t.check(links.some((href) => href.endsWith(`/tx/${hash}`)), `the Payouts status line lacks the transaction link: ${links}`);
        assertEqual(await t.credit(eth, t.world.ledger), 0n, "the Ledger's credit after withdrawing it");
        await app.waitText("#crList", "Nothing is credited to your wallet");
      });
    },
  },

  {
    // R5-2: finalizableAt is the last safe moment to cancel. A panel opened in time can be signed
    // too late, so the moment is checked again at signing; and when a keeper's finalize is mined
    // first, the reverted cancel is explained and the heir list re-read instead of left stale.
    name: "claim: a cancel opened before finalizableAt and signed after it asks for the acknowledgement first; a finalize mined first is reported and the list re-read",
    async run(t) {
      const { app } = t;
      const { alice, bob, dave, erin } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY, window: 7 * DAY });
      await t.expire(alice, id);
      // The heir filed to a payout address it now wants to correct (erin stands for the wrong one).
      await t.tx(bob, "initiateClaim", alice, id, erin);
      const v = await t.vault(alice, id);
      await t.chain.travelTo(Number(v.finalizableAt) - 3600);
      await app.open();
      await app.connect(bob);
      await lookupOwner(app, alice);
      const panel = heirPanel(t, alice, id);
      await t.step("an hour before finalizableAt the panel asks for no acknowledgement", async () => {
        await heirButton(t, alice, id, "Cancel my claim");
        await poll(() => panel.isVisible(), Boolean, { what: "the cancel panel" });
        const text = await app.textOf(panel);
        t.check(text.includes(`Last safe moment to cancel${await app.fmtLocal(v.finalizableAt)}`) && !text.includes("The challenge window ended"),
          `the panel an hour before: ${text}`);
        assertEqual(await panel.locator("input[type=checkbox]").count(), 0, "acknowledgements an hour before finalizableAt");
      });
      await t.step("the window ends while the panel is open: Sign shows the warning and the acknowledgement, and sends nothing", async () => {
        await t.chain.travelTo(Number(v.finalizableAt) + 120);
        await app.press(panel, "Sign: cancel my claim");
        const text = await app.waitText(panel, "Nothing was signed: the challenge window has ended since this panel was opened.");
        t.check(text.includes(`The challenge window ended ${await app.fmtLocal(v.finalizableAt)}. From then anyone can finalize this claim`),
          `the late warning: ${text}`);
        t.check(text.includes(`Finalizable since${await app.fmtLocal(v.finalizableAt)} (`) && /\([23]m ago\)passed/.test(text)
          && !text.includes("Last safe moment"), `the panel's finalizableAt row must say it has passed: ${text}`);
        assertEqual(await panel.locator("input[type=checkbox]").count(), 1, "the acknowledgement, shown at signing");
        assertEqual(t.wallet.sent.length, 0, "transactions sent");
        await app.press(panel, "Sign: cancel my claim");
        await app.waitText(panel, "Tick the confirmation above first.");
        assertEqual(t.wallet.sent.length, 0, "transactions sent without the acknowledgement");
      });
      await t.step("acknowledged and signed, but a keeper's finalize is mined first: the revert is explained and the list re-read", async () => {
        await panel.locator("input[type=checkbox]").check();
        t.wallet.beforeNext("beneficiaryCancelClaim", async () => {
          await t.tx(dave, "finalizeClaim", alice, id);
        });
        await app.press(panel, "Sign: cancel my claim");
        const text = await app.waitText("#heirList", "Cancel claim failed:");
        t.check(text.includes("Most likely: No claim is pending on this vault any more. (NoClaimPending)"), `the explained revert: ${text}`);
        t.check(text.includes("No open vaults at that address name your wallet as heir."), `the re-read list: ${text}`);
        assertEqual(await app.heirCard(alice, id).count(), 0, "the settled vault's stale card must be gone after the re-read");
        const after = await t.vault(alice, id);
        assertEqual(Number(after.state), 3, "the vault settled by the keeper's finalize");
        assertEqual(await t.credit(ethers.ZeroAddress, erin), ethers.parseEther("0.995"), "credited to the recorded payout address");
      });
    },
  },

  {
    name: "claim: the owner checks in after the heir's review, so Sign claim refuses and nothing is sent",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      await t.expire(alice, id);
      await app.open();
      await app.connect(bob);
      await lookupOwner(app, alice);
      expectKind(await reviewClaim(t, alice, id), "sign", null, "claim review");
      await t.tx(alice, "checkIn", id);
      const deadline = Number((await t.vault(alice, id)).deadline);
      await app.press(heirPanel(t, alice, id), "Sign claim");
      const text = await app.waitText(heirPanel(t, alice, id), "The owner checked in after this review");
      t.check(text.includes(`The owner checked in after this review: the new deadline is ${await app.fmtLocal(deadline)}, and no claim can start before it. Nothing was signed.`),
        `refusal: ${text}`);
      assertEqual(t.wallet.sent.length, 0, "transactions sent");
      assertEqual(Number((await t.vault(alice, id)).state), 1, "state");
    },
  },

  {
    name: "claim: a USDC vault claimed and finalized to the heir's wallet, the payout withdrawn in full",
    async run(t) {
      const { app } = t;
      const { frank, carol } = t.who;
      const usdc = t.world.tokens.USDC.address;
      const id = await t.createVault(frank, { heir: carol, token: usdc, amount: ethers.parseUnits("1000", 6), period: 7 * DAY, window: 7 * DAY });
      await t.expire(frank, id);
      await app.open();
      await app.connect(carol);
      await lookupOwner(app, frank);
      expectKind(await reviewClaim(t, frank, id), "sign", "Amount1000.0 USDC", "USDC claim review");
      await app.press(heirPanel(t, frank, id), "Sign claim");
      await t.waitVault(frank, id, (x) => Number(x.state) === 2, "the USDC claim");
      await t.windowEnds(frank, id);
      await lookupOwner(app, frank);
      await heirButton(t, frank, id, "Finalize inheritance");
      await app.waitText("#heirList", `Vault #${id} settled: 995.0 USDC was credited to the address below, and a fee of 5.0 USDC to the fee recipient.`);
      const text = await payouts(t);
      t.check(text.includes("995.0 USDC") && text.includes("Token USDC"), `carol's payouts: ${text}`);
      await app.press(app.creditCard(usdc).locator(".actions"), "Withdraw all to my wallet");
      const panel = t.page.locator(`#panel-credit-credit-${usdc.toLowerCase()}`);
      await poll(() => panel.isVisible(), Boolean, { what: "the payout panel" });
      await app.press(panel, "Review withdrawal");
      await app.waitText(panel, "If the token blocks the transfer");
      const before = await t.erc20(usdc).balanceOf(carol);
      await app.press(panel, "Sign withdrawal");
      await app.waitText("#crLog", "Paid 995.0 USDC to your wallet.");
      assertEqual((await t.erc20(usdc).balanceOf(carol)) - before, ethers.parseUnits("995", 6), "USDC that reached carol");
    },
  },
];

async function assertReverts(promise, errorName) {
  try {
    const tx = await promise;
    await tx.wait();
  } catch (error) {
    const text = `${error.shortMessage || ""} ${error.message || ""} ${error.revert?.name || ""} ${JSON.stringify(error.info || {})}`;
    if (text.includes(errorName) || error.revert?.name === errorName) return;
    // The node's message names the custom error only in its data; decode it.
    throw new Error(`expected a ${errorName} revert, got: ${error.shortMessage || error.message}`);
  }
  throw new Error(`expected a ${errorName} revert, but the call succeeded`);
}
