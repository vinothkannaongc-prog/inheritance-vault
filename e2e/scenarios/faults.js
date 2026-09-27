"use strict";
// When things go wrong around a transaction: it is mined but the page cannot re-read the chain
// afterwards (owner, heir and payouts), its receipt cannot be read at all (and nothing else may be
// signed until it can), the person declines it in the wallet, a stale card sends a call the
// contract refuses at estimation, and a payout is refused by the token or by the receiving wallet.

const { ethers } = require("ethers");
const { assert, assertEqual, poll, short, DAY } = require("../lib/util");
const {
  fillCreate, reviewCreate, horizonDay, lookupOwner, expectKind, openOwnerPanel, reviewPanel,
} = require("../lib/flows");
const { artifact, Chain } = require("../lib/chain");

const REREAD = "It is confirmed on chain, but the page could not re-read your vaults afterwards";

/** Opens Payouts, presses "Withdraw all to my wallet" on `token`'s card, reviews and signs; returns the card's log text. */
async function withdrawAllCredit(t, token, until) {
  const { app } = t;
  await app.tab("credits");
  await t.page.click("#crCheckBtn");
  await poll(() => app.creditCard(token).count(), (n) => n === 1, { what: `the ${token} payout card` });
  await app.press(app.creditCard(token).locator(".actions"), "Withdraw all to my wallet");
  const panel = t.page.locator(`#panel-credit-credit-${token.toLowerCase()}`);
  await poll(() => panel.isVisible(), Boolean, { what: "the payout panel" });
  await app.press(panel, "Review withdrawal");
  await poll(() => panel.getByRole("button", { name: "Sign withdrawal" }).count(), (n) => n === 1, { what: "Sign withdrawal" });
  await app.press(panel, "Sign withdrawal");
  return app.waitText(`#log-credit-credit-${token.toLowerCase()}`, until);
}

module.exports = [
  {
    name: "re-read fails after mining: a create is reported confirmed, never offered for a second signature",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      await app.open();
      await app.connect(alice);
      const now = await t.now();
      await fillCreate(app, { asset: "native", amount: "1", heir: bob, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
      expectKind(await reviewCreate(app), "sign", null, "the review");
      t.wallet.faults.failCallsAfterNextReceipt = true;
      const before = t.wallet.hashes.length;
      await app.press(t.page.locator("#cReview"), "Sign and create vault");
      const hash = await poll(() => t.wallet.hashes[before] ?? null, Boolean, { what: "the create transaction" });
      const log = await app.waitText("#createLog", "Vault #0 created");
      t.check(log.includes(`Create vault: confirmed ${short(hash)}`), `confirmation line: ${log}`);
      t.check(log.includes(`${REREAD} (the network connection returned an error: e2e: the wallet's connection to the network dropped). What is shown may be out of date: reload the page before doing anything else, and do not sign this again.`),
        `re-read warning: ${log}`);
      assertEqual(await t.page.locator("#cReview button").count(), 0, "buttons left in the create review (a Sign button would allow a second vault)");
      assert(t.wallet.failedCalls > 0, "the fault never fired");
      assertEqual(Number(await t.v2().vaultCount(alice)), 1, "vaults created");
      t.wallet.faults.failCalls = false;
      await app.reload();
      await app.waitText(app.card(0), "1.0 ETH");
    },
  },

  {
    name: "re-read fails after mining: an owner's check-in keeps its confirmation and says the view may be stale",
    async run(t) {
      const { app } = t;
      const { alice } = t.who;
      const id = await t.createVault(alice, { period: 7 * DAY });
      await app.open();
      await app.connect(alice);
      t.wallet.faults.failCallsAfterNextReceipt = true;
      const hash = await app.sign(app.card(id).locator(".actions"), "Check in", `#log-owner-${id}`, "Check-in");
      const log = await app.waitLog(id, REREAD);
      t.check(log.includes(`Check-in: confirmed ${short(hash)}`), `check-in log: ${log}`);
      t.wallet.faults.failCalls = false;
    },
  },

  {
    name: "re-read fails after mining: the heir's claim keeps its confirmation instead of vanishing behind \"Could not refresh\"",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      await t.expire(alice, id);
      await app.open();
      await app.connect(bob);
      await lookupOwner(app, alice);
      const panel = t.page.locator(`#panel-heir-${alice.toLowerCase()}-${id}`);
      await app.press(app.heirCard(alice, id).locator(".actions"), "Initiate claim");
      await poll(() => panel.isVisible(), Boolean, { what: "the claim panel" });
      await app.press(panel, "Review claim");
      await poll(() => panel.getByRole("button", { name: "Sign claim" }).count(), (n) => n === 1, { what: "Sign claim" });
      t.wallet.faults.failCallsAfterNextReceipt = true;
      await app.press(panel, "Sign claim");
      await t.waitVault(alice, id, (v) => Number(v.state) === 2, "the claim to be mined");
      // Let the page finish whatever it does after mining.
      await poll(() => t.wallet.failedCalls, (n) => n > 0, { what: "the re-read to be attempted" });
      await new Promise((r) => setTimeout(r, 1500));
      const text = await app.textOf("#heirList");
      t.check(/confirmed/.test(text),
        `after a mined claim whose re-read failed, the heir tab shows no confirmation at all: "${text}"`);
      t.check(!/^Could not refresh:/.test(text) || text.includes("Claim started"),
        `the claim's success is replaced by the refresh error alone: "${text}"`);
      // The card stays, with the confirmation, the warning and the claim's follow-up in its log.
      const logSelector = `#log-heir-${alice.toLowerCase()}-${id}`;
      assertEqual(await t.page.locator(logSelector).count(), 1, "the heir card's log after the failed re-read (the card must stay)");
      const log = await app.textOf(logSelector);
      const hash = t.wallet.lastHash();
      t.check(log.includes(`Initiate claim: confirmed ${short(hash)}`), `the heir card's log: "${log}"`);
      t.check(log.includes("It is confirmed on chain, but the page could not re-read the vaults that name you as heir afterwards"),
        `the re-read warning in the heir card's log: "${log}"`);
      t.check(log.includes("Claim started."), `the claim's follow-up in the heir card's log: "${log}"`);
      t.wallet.faults.failCalls = false;
    },
  },

  {
    name: "re-read fails after mining: a payout keeps its confirmation, and the payout list stays as it was",
    async run(t) {
      const { app } = t;
      const { alice } = t.who;
      const eth = ethers.ZeroAddress;
      const id = await t.createVault(alice, {});
      await t.tx(alice, "withdraw", id, ethers.parseEther("0.4"), alice);
      await app.open();
      await app.connect(alice);
      await app.tab("credits");
      await t.page.click("#crCheckBtn");
      await app.waitText("#crList", "0.4 ETH");
      await app.press(app.creditCard(eth).locator(".actions"), "Withdraw all to my wallet");
      const panel = t.page.locator(`#panel-credit-credit-${eth}`);
      await poll(() => panel.isVisible(), Boolean, { what: "the payout panel" });
      await app.press(panel, "Review withdrawal");
      await poll(() => panel.getByRole("button", { name: "Sign withdrawal" }).count(), (n) => n === 1, { what: "Sign withdrawal" });
      t.wallet.faults.failCallsAfterNextReceipt = true;
      const before = t.wallet.hashes.length;
      await app.press(panel, "Sign withdrawal");
      const hash = await app.waitConfirmed(`#log-credit-credit-${eth}`, "Withdraw payout", before);
      const log = await app.waitText(`#log-credit-credit-${eth}`, "could not re-read your payouts afterwards");
      t.check(log.includes("Paid 0.4 ETH to your wallet."), `the payout's follow-up: "${log}"`);
      t.check(!(await app.textOf("#crLog")).includes("Could not read"), "the status line must not replace the confirmation");
      assertEqual(await t.credit(eth, alice), 0n, "alice's credit after the payout");
      t.wallet.faults.failCalls = false;
      assert(hash, "the payout transaction");
    },
  },

  {
    name: "receipt unreadable after sending: the create is reported as possibly sent, nothing else can be signed until its result is read, then it is settled",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const existing = await t.createVault(alice, { heir: bob });
      await app.open();
      await app.connect(alice);
      const now = await t.now();
      await fillCreate(app, { asset: "native", amount: "1", heir: bob, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
      expectKind(await reviewCreate(app), "sign", null, "the review");
      t.wallet.faults.failReceipts = 1000;
      const before = t.wallet.hashes.length;
      await app.press(t.page.locator("#cReview"), "Sign and create vault");
      const log = await app.waitText("#createLog", "sent, but its result could not be read");
      const hash = t.wallet.hashes[before];
      t.check(log.includes("It may still go through. Open the transaction on the explorer and reload this page before signing anything again."),
        `unknown-outcome log: ${log}`);
      const sign = t.page.getByRole("button", { name: "Sign and create vault" });
      assertEqual(await sign.count(), 1, "the review stays on screen");
      assertEqual(await sign.isDisabled(), true, "the Sign button of that review must stay disabled");
      assertEqual(Number(await t.v2().vaultCount(alice)), 2, "the transaction was in fact mined");

      await t.step("while its result is unknown, Review vault stays off and cannot wipe the warning", async () => {
        assertEqual(await t.page.locator("#createBtn").isDisabled(), true, "Review vault while the result is unknown");
        // Even if the button were enabled by some other path, the review itself refuses.
        await t.page.evaluate(() => { document.getElementById("createBtn").disabled = false; });
        await t.page.click("#createBtn");
        await new Promise((r) => setTimeout(r, 400));
        assert((await app.textOf("#createLog")).includes("sent, but its result could not be read"), "the warning must stay");
        assertEqual(await sign.count(), 1, "no second review may replace the first");
        assertEqual(await sign.isDisabled(), true, "and its Sign button stays off");
        await t.page.evaluate(() => { document.getElementById("createBtn").disabled = true; });
      });
      await t.step("a card's action is refused, and a card's review says why", async () => {
        await app.tab("mine");
        const sent = t.wallet.sent.length;
        await app.press(app.card(existing).locator(".actions"), "Check in");
        const refused = await app.waitLog(existing, "Check-in: not sent.");
        t.check(refused.includes(`Nothing can be signed on this page until the result of your earlier "Create vault" transaction (${short(hash)}) is known`),
          `the refusal: ${refused}`);
        assertEqual(t.wallet.sent.length, sent, "transactions sent while the result is unknown");
        const panel = await openOwnerPanel(app, existing, "Top up");
        await panel.locator("input").first().fill("0.1");
        expectKind(await reviewPanel(app, panel, "Review top-up", "Sign top-up"), "banner",
          `Nothing can be signed on this page until the result of your earlier "Create vault" transaction`, "the top-up review");
      });
      await t.step("once the receipt can be read, the page settles it: confirmed, the vault reported, Review back on", async () => {
        t.wallet.faults.failReceipts = 0;
        await app.tab("create");
        const settled = await app.waitText("#createLog", `Create vault: confirmed ${short(hash)}`, "the create to be settled", 30000);
        t.check(settled.includes("Vault #1 created."), `the settled create's report: ${settled}`);
        await poll(() => t.page.locator("#createBtn").isEnabled(), Boolean, { what: "Review vault to come back" });
        assertEqual(await sign.count(), 0, "the old review is gone once the create is known to be mined");
        await app.tab("mine");
        await app.waitText(app.card(1), "1.0 ETH");
        assertEqual(Number(await t.v2().vaultCount(alice)), 2, "vaults on chain");
      });
    },
  },

  {
    name: "declined in the wallet: nothing happens, the Sign button comes back, and signing again creates one vault",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      await app.open();
      await app.connect(alice);
      const now = await t.now();
      await fillCreate(app, { asset: "native", amount: "1", heir: bob, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
      expectKind(await reviewCreate(app), "sign", null, "the review");
      t.wallet.rejectNext = 1;
      await app.press(t.page.locator("#cReview"), "Sign and create vault");
      await app.waitText("#createLog", "Create vault failed: you declined it in your wallet");
      const sign = t.page.getByRole("button", { name: "Sign and create vault" });
      await poll(() => sign.isEnabled(), Boolean, { what: "the Sign button to be offered again" });
      assertEqual(Number(await t.v2().vaultCount(alice)), 0, "vaults after declining");
      await sign.click();
      await app.waitText("#createLog", "Vault #0 created");
      assertEqual(Number(await t.v2().vaultCount(alice)), 1, "vaults after signing");
    },
  },

  {
    // SafeERC20 passes a token's own revert through, so a blocked or paused token reaches the app
    // as Error(string): its reason must be shown, not "the contract refused it (Error)".
    name: "a payout the token refuses with a reason of its own: the app shows the token's words, and the credit is kept",
    async run(t) {
      const { alice, funder } = t.who;
      const usdc = t.world.tokens.USDC.address;
      const id = await t.createVault(alice, { token: usdc, amount: ethers.parseUnits("100", 6) });
      await t.tx(alice, "withdraw", id, ethers.parseUnits("10", 6), alice);
      // The USDC address now runs a USDC-style blocklist that reverts with a reason string, as
      // FiatToken does ("Blacklistable: account is blacklisted"), and alice is blocked.
      const temp = await t.chain.deploy(artifact("test/TestHelpers.sol", "BlocklistToken"), funder, []);
      await t.chain.send("hardhat_setCode", [usdc, await t.chain.provider.getCode(await temp.getAddress())]);
      await Chain.mined(new ethers.Contract(usdc, ["function setBlocked(address,bool)"], t.chain.signer(funder)).setBlocked(alice, true));
      await t.app.open();
      await t.app.connect(alice);
      const log = await withdrawAllCredit(t, usdc, "Withdraw payout failed:");
      t.check(log.includes('the token contract, or another contract the transaction called, refused it with the message "blocked"'),
        `the token's reason: ${log}`);
      t.check(!log.includes("(Error)"), `the bare error name must not stand in for the reason: ${log}`);
      assertEqual(await t.credit(usdc, alice), ethers.parseUnits("10", 6), "alice's credit is kept");
      assertEqual(t.wallet.sent.length, 0, "transactions sent (refused at estimation)");
    },
  },

  {
    // The app pays a credit only to the connected wallet, so its advice for a wallet that cannot
    // take the coin must be something that works: withdrawCredit(token, to) on the explorer.
    name: "a payout to a wallet that cannot receive the coin: the credit is kept, and the app says how to have it paid elsewhere",
    async run(t) {
      const { alice, funder } = t.who;
      const eth = ethers.ZeroAddress;
      // A smart wallet whose receive() reverts, connected as the credited account.
      const smart = ethers.getAddress(`0x${"5afe".repeat(10)}`);
      await t.chain.impersonate(smart, "10");
      const receiver = await t.chain.deploy(artifact("test/TestHelpers.sol", "RevertingReceiver"), funder, []);
      await t.chain.send("hardhat_setCode", [smart, await t.chain.provider.getCode(await receiver.getAddress())]);
      const id = await t.createVault(alice, {});
      await t.tx(alice, "withdraw", id, ethers.parseEther("0.3"), smart);
      await t.app.open();
      await t.app.connect(smart);
      const log = await withdrawAllCredit(t, eth, "Withdraw payout failed:");
      t.check(log.includes(`${smart} refused the payment: it cannot receive the coin. The credit is kept. This app pays a credit only ` +
        "to the wallet it belongs to; to have it paid to an ordinary wallet address instead, call withdrawCredit(token, to)"),
      `the advice: ${log}`);
      t.check(!/withdraw it to another address\.?$/.test(log), `the old advice the app cannot follow: ${log}`);
      assertEqual(await t.credit(eth, smart), ethers.parseEther("0.3"), "the credit is kept");
    },
  },

  {
    name: "a stale card: the heir files after the page loaded, the owner's Check in is refused at estimation, decoded, and the card re-read",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const id = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      await t.expire(alice, id);
      await app.open();
      await app.connect(alice);
      await t.tx(bob, "initiateClaim", alice, id, bob);
      await app.press(app.card(id).locator(".actions"), "Check in");
      const log = await app.waitLog(id, "Check-in failed:");
      t.check(log.includes("Check-in failed: A claim is pending on this vault, and a check-in does not cancel it. Use Veto. (ClaimPendingUseAbort)"),
        `decoded revert: ${log}`);
      await app.waitText(app.card(id), "A claim has been filed on this vault.");
      assertEqual(JSON.stringify((await app.buttons(app.card(id).locator(".actions"))).slice(0, 1)), JSON.stringify(["Veto claim"]),
        "the re-read card offers Veto");
      assertEqual(t.wallet.sent.length, 0, "no transaction was signed");
    },
  },
];
