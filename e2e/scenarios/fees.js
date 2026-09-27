"use strict";
// The claim fee as the app shows it: a raise announced by the admin (pending), the raise maturing
// between a create review and its mining, older vaults keeping their ceiling, a claim's locked
// fee and a cut, and the fee recipient switched off and back on (not yet in force).

const { ethers } = require("ethers");
const { assertEqual, poll, fmtCountdown, DAY } = require("../lib/util");
const { fillCreate, reviewCreate, horizonDay, lookupOwner, expectKind } = require("../lib/flows");
const { Chain } = require("../lib/chain");

async function claimReview(t, owner, id) {
  const panel = t.page.locator(`#panel-heir-${owner.toLowerCase()}-${id}`);
  await t.app.press(t.app.heirCard(owner, id).locator(".actions"), "Initiate claim");
  await poll(() => panel.isVisible(), Boolean, { what: "the claim panel" });
  await t.app.press(panel, "Review claim");
  await poll(() => panel.getByRole("button", { name: "Sign claim" }).count(), (n) => n === 1, { what: "the Sign claim button" });
  return { panel, text: await t.app.textOf(panel) };
}

module.exports = [
  {
    name: "fees: a pending raise on the form and the cards, maturing between review and mining, never above an older vault's ceiling",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const old = await t.createVault(alice, { heir: bob, period: 7 * DAY, window: 7 * DAY });
      await Chain.mined(t.v2(t.world.ledger).setClaimFee(100));
      const at = Number(await t.v2().pendingClaimFeeAt());
      await app.open();
      await app.connect(alice);
      await t.step("the announced raise on the create form and on the older vault's card", async () => {
        await app.tab("create");
        const info = await app.textOf("#cFeeInfo");
        t.check(info.includes("Claim fee: the rate in force is 0.5%."), `fee info: ${info}`);
        // Counted by chain time: the latest block is the one that announced the raise.
        const countdown = fmtCountdown(at, await t.now());
        t.check(info.includes(`A raise to 1% has been announced: it takes effect ${await app.fmtLocal(at)} (${countdown}).`), `raise line: ${info}`);
        t.check(info.includes("a raise takes effect only 30 days after it is announced, and never above a vault's ceiling."), `fee rule: ${info}`);
        await app.tab("mine");
        const card = await app.cardText(old);
        t.check(card.includes("Claim fee: this vault's ceiling is 0.5%, fixed at its creation. The rate in force is 0.5%, so a claim filed now would lock 0.5%."),
          `older vault's fee line: ${card}`);
        t.check(card.includes(`A raise to 1% takes effect ${await app.fmtLocal(at)}; it can never take this vault above 0.5%.`), `older vault's raise line: ${card}`);
      });
      await t.step("a vault reviewed at 0.5% but mined after the raise took effect: the app says so", async () => {
        const now = await t.now();
        await fillCreate(app, { asset: "native", amount: "0.5", heir: bob, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
        const review = expectKind(await reviewCreate(app), "sign", null, "the review");
        t.check(review.includes("Fee ceiling0.5%: the rate in force, recorded when your transaction is mined") && review.includes("A raise to 1% has been announced"),
          `create review fee rows: ${review}`);
        t.wallet.beforeNext("createVault", async () => {
          const chainNow = await t.now();
          await t.chain.travel(at - chainNow + 60);
        });
        await app.press(t.page.locator("#cReview"), "Sign and create vault");
        const log = await app.waitText("#createLog", "The fee ceiling recorded on chain is");
        t.check(log.includes("The fee ceiling recorded on chain is 1%, not the 0.5% shown before you signed: an announced raise took effect before your transaction was mined. If you do not accept it, withdraw everything from vault #1 (no fee is charged on withdrawals) and create it again."),
          `ceiling warning: ${log}`);
        assertEqual(Number((await t.vault(alice, 1)).feeBps), 100, "the new vault's ceiling on chain");
      });
      await t.step("after the raise: the rate in force is 1%, the older vault still locks 0.5%", async () => {
        await app.reload();
        const info = await app.textOf("#cFeeInfo");
        t.check(info.includes("the rate in force is 1%.") && !info.includes("has been announced"), `fee info after the raise: ${info}`);
        t.check((await app.cardText(old)).includes("ceiling is 0.5%, fixed at its creation. The rate in force is 1%, so a claim filed now would lock 0.5%."),
          `older vault after the raise: ${await app.cardText(old)}`);
        t.check((await app.cardText(1)).includes("ceiling is 1%, fixed at its creation. The rate in force is 1%, so a claim filed now would lock 1%."),
          `new vault after the raise: ${await app.cardText(1)}`);
      });
      await t.step("the heir's claim on the older vault locks 0.5%", async () => {
        await app.switchAccount(bob);
        await lookupOwner(app, alice);
        const { panel, text } = await claimReview(t, alice, old);
        t.check(text.includes("locks 0.5% now: the lower of this vault's ceiling (0.5%) and the rate in force (1%)."), `claim fee row: ${text}`);
        await app.press(panel, "Sign claim");
        const v = await t.waitVault(alice, old, (x) => Number(x.state) === 2, "the claim");
        assertEqual(Number(v.lockedFeeBps), 50, "locked fee");
      });
      await t.step("the owner sees what the claim would pay when it can first be finalized, and a cut reaches it", async () => {
        await app.switchAccount(alice);
        const first = await app.fmtLocal((await t.vault(alice, old)).finalizableAt);
        t.check((await app.cardText(old)).includes(`Claim fee: this claim pays at most 0.5%, the rate locked when it was filed. Finalized as soon as it can be (${first}), it would pay 0.5% (0.005 ETH), and 0.995 ETH would be credited to the payout address.`),
          `claim fee line: ${await app.cardText(old)}`);
        await Chain.mined(t.v2(t.world.ledger).setClaimFee(20));
        await app.reload();
        t.check((await app.cardText(old)).includes(`Finalized as soon as it can be (${first}), it would pay 0.2% (0.002 ETH), and 0.998 ETH would be credited to the payout address.`),
          `claim fee line after the cut: ${await app.cardText(old)}`);
        await app.tab("create");
        t.check((await app.textOf("#cFeeInfo")).includes("the rate in force is 0.2%."), `fee info after the cut: ${await app.textOf("#cFeeInfo")}`);
      });
    },
  },

  {
    // FEES: a cut reaches a pending claim only if it is still in force when the claim is
    // finalized. A raise announced to land before finalizableAt ends the cut first, so the claim is
    // quoted at its first possible finalize, and the heir is told the one way to keep the cut.
    name: "fees: a cut that an announced raise ends before the claim can be finalized: the quote counts the raise, and the heir is told how to keep the cut",
    async run(t) {
      const { app } = t;
      const { alice, bob, dave } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY, window: 60 * DAY });
      await t.expire(alice, id);
      await t.tx(bob, "initiateClaim", alice, id, bob);
      const ledger = t.v2(t.world.ledger);
      await Chain.mined(ledger.setClaimFee(10)); // a cut, in force at once
      await Chain.mined(ledger.setClaimFee(50)); // a raise back, announced for 30 days on
      const v = await t.vault(alice, id);
      const raiseAt = Number(await t.v2().pendingClaimFeeAt());
      assertEqual(Number(v.lockedFeeBps), 50, "the lock");
      assertEqual(Number(await t.v2().claimFeeBps()), 10, "the rate in force now");
      assertEqual(raiseAt < Number(v.finalizableAt), true, "the raise lands before the claim can be finalized");
      await app.open();
      await app.connect(alice);
      const quote = `Finalized as soon as it can be (${await app.fmtLocal(v.finalizableAt)}), it would pay 0.5% (0.005 ETH), ` +
        "and 0.995 ETH would be credited to the payout address.";
      const raise = `A raise to 0.5% has been announced: it takes effect ${await app.fmtLocal(raiseAt)}`;
      const remedy = `The lower fee this claim would pay now (0.1%) ends ${await app.fmtLocal(raiseAt)}, before the claim can be ` +
        "finalized. You can keep a lower fee for good only by cancelling this claim and filing it again before then: the " +
        "new claim would lock 0.1%, but it could be finalized only 60 days after it is mined";
      await t.step("the owner's card quotes the claim at its first possible finalize, raise included", async () => {
        const text = await app.cardText(id);
        t.check(text.includes(quote) && text.includes(raise), `owner's fee lines: ${text}`);
        t.check(!text.includes("You can keep a lower fee"), `the heir's remedy does not belong on the owner's card: ${text}`);
      });
      await t.step("the heir's card says the same, and how to keep the cut", async () => {
        await app.switchAccount(bob);
        const text = await lookupOwner(app, alice);
        t.check(text.includes(quote) && text.includes(raise), `heir's fee lines: ${text}`);
        t.check(text.includes(remedy), `the heir's remedy: ${text}`);
      });
      await t.step("finalized at the first possible moment, the chain charges what the card quoted", async () => {
        await t.windowEnds(alice, id);
        const receipt = await t.tx(dave, "finalizeClaim", alice, id);
        const settled = receipt.logs.map((l) => { try { return t.v2().interface.parseLog(l); } catch { return null; } })
          .find((p) => p?.name === "ClaimSettled");
        assertEqual(settled.args.fee, ethers.parseEther("0.005"), "the fee charged");
        assertEqual(settled.args.amount, ethers.parseEther("0.995"), "the amount credited");
      });
    },
  },

  {
    name: "fees: no fee recipient, then one announced but not yet in force; a claim filed then locks nothing and settles with no fee",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY, window: 7 * DAY });
      await Chain.mined(t.v2(t.world.ledger).setFeeRecipient(ethers.ZeroAddress));
      await app.open();
      await app.connect(alice);
      await t.step("no recipient", async () => {
        await app.tab("create");
        t.check((await app.textOf("#cFeeInfo")).includes("No fee recipient is set, so no fee is charged now; one set later comes into force only 30 days after it is announced."),
          `fee info: ${await app.textOf("#cFeeInfo")}`);
        await app.tab("mine");
        const card = await app.cardText(id);
        t.check(card.includes("so a claim filed now would lock 0%.") && card.includes("No fee recipient is set, so no fee is charged now."), `card: ${card}`);
      });
      let activeAt;
      await t.step("a recipient announced, in force only in 30 days", async () => {
        await Chain.mined(t.v2(t.world.ledger).setFeeRecipient(t.world.ledger));
        activeAt = Number(await t.v2().feeRecipientActiveAt());
        await app.reload();
        await app.tab("create");
        const info = await app.textOf("#cFeeInfo");
        t.check(info.includes(`Fees are off until ${await app.fmtLocal(activeAt)}, when the fee recipient comes into force: a claim filed before then locks no fee, and a claim finalized before then pays none.`),
          `fee info: ${info}`);
        await app.tab("mine");
        t.check((await app.cardText(id)).includes(`Fees are off until ${await app.fmtLocal(activeAt)}.`), `card: ${await app.cardText(id)}`);
      });
      await t.step("the heir files now: the review says nothing is locked, and nothing is", async () => {
        await t.expire(alice, id);
        await app.switchAccount(bob);
        await lookupOwner(app, alice);
        const { panel, text } = await claimReview(t, alice, id);
        t.check(text.includes("locks 0% now: the lower of this vault's ceiling (0.5%) and the rate in force (0.5%), or nothing while no fee recipient is in force."),
          `claim fee row: ${text}`);
        await app.press(panel, "Sign claim");
        const v = await t.waitVault(alice, id, (x) => Number(x.state) === 2, "the claim");
        assertEqual(Number(v.lockedFeeBps), 0, "locked fee");
      });
      await t.step("finalized after the recipient came into force, it still pays no fee", async () => {
        const now = await t.now();
        await t.chain.travel(Math.max(activeAt, Number((await t.vault(alice, id)).finalizableAt)) - now + 60);
        await lookupOwner(app, alice);
        await app.press(app.heirCard(alice, id).locator(".actions"), "Finalize inheritance");
        await app.waitText("#heirList", `Vault #${id} settled: 1.0 ETH was credited to the address below, with no fee.`);
        assertEqual(await t.credit(ethers.ZeroAddress, t.world.ledger), 0n, "fee credited");
      });
    },
  },
];
