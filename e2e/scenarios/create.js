"use strict";
// Creating a vault through the review: the native coin, a listed token (with its approval), and
// every refusal the form must make before anything is signed.

const { ethers } = require("ethers");
const { assert, assertEqual, same, fmtUtc, utcMidnight, DAY, poll } = require("../lib/util");
const { lookalike, fillCreate, reviewCreate, signCreate, horizonDay, expectKind } = require("../lib/flows");
const { Chain } = require("../lib/chain");

/** The address with the case of its first hex letter flipped: same address, broken checksum. */
function flipOneLetter(address) {
  const i = address.slice(2).search(/[a-fA-F]/) + 2;
  const c = address[i];
  return address.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + address.slice(i + 1);
}

module.exports = [
  {
    name: "create: an ETH vault, reviewed in full, signed once, shown on its card",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      await app.open();
      await app.connect(alice);
      const now = await t.now();
      const horizon = horizonDay(now, 5 * 365);
      await t.step("the form shows the fee in force", async () => {
        await app.tab("create");
        await app.waitText("#cFeeInfo", "Claim fee: the rate in force is 0.5%.");
      });
      let review;
      await t.step("review", async () => {
        await fillCreate(app, { asset: "native", amount: "1.5", heir: bob, period: 30, window: 14, horizon, ack: true });
        review = expectKind(await reviewCreate(app), "sign", null, "the review");
        for (const part of ["native ETH", "1.5 ETH", bob, "30 days", "14 days", fmtUtc(utcMidnight(horizon)), "immutable",
          "raise-only", "0.5%: the rate in force"]) {
          assert(review.includes(part), `the review lacks "${part}": ${review}`);
        }
        assertEqual(t.wallet.sent.length, 0, "transactions sent by reviewing");
      });
      await t.step("an edit after the review withdraws it", async () => {
        await t.page.fill("#cAmount", "1.50");
        await poll(() => app.textOf("#cReview"), (text) => text === "", { what: "the review to be cleared by an edit" });
        await t.page.fill("#cAmount", "1.5");
        expectKind(await reviewCreate(app), "sign", null, "the second review");
      });
      await t.step("sign (double-clicked: still one transaction)", async () => {
        await t.page.locator("#cReview").getByRole("button", { name: "Sign and create vault" }).dblclick();
        const log = await app.waitText("#createLog", /Vault #\d+ created/, "the create log to confirm the new vault", 30000);
        assert(/Vault #0 created/.test(log), `create log: ${log}`);
        assert(log.includes("I'm an heir"), `the create log should tell the owner to have the heir check: ${log}`);
        assertEqual(JSON.stringify(t.wallet.sentCalls()), JSON.stringify(["createVault"]), "transactions signed");
        assertEqual((await app.textOf("#cReview")), "", "the review (and its Sign button) must be gone after mining");
      });
      await t.step("on chain", async () => {
        const v = await t.vault(alice, 0);
        assertEqual(v.token, ethers.ZeroAddress, "token");
        assertEqual(v.balance, ethers.parseEther("1.5"), "balance");
        assert(same(v.beneficiary, bob), "beneficiary");
        assertEqual(Number(v.inactivityPeriod), 30 * DAY, "inactivity period");
        assertEqual(Number(v.challengeWindow), 14 * DAY, "challenge window");
        assertEqual(Number(v.absoluteDeadline), utcMidnight(horizon), "horizon");
        assertEqual(Number(v.feeBps), 50, "fee ceiling");
        assertEqual(Number(v.state), 1, "state");
      });
      await t.step("the card", async () => {
        await app.tab("mine");
        const text = await app.waitText(app.card(0), "1.5 ETH");
        for (const part of ["Active", "Vault #0", bob, "Asset: native ETH", "check-in period 30 days",
          `Horizon (long-stop) ${fmtUtc(utcMidnight(horizon))}`, "challenge window 14 days (fixed)",
          "this vault's ceiling is 0.5%"]) {
          assert(text.includes(part), `vault #0's card lacks "${part}": ${text}`);
        }
        const buttons = await app.buttons(app.card(0).locator(".actions"));
        assertEqual(JSON.stringify(buttons), JSON.stringify(["Check in", "Top up", "Withdraw part",
          "Withdraw everything and close", "Change heir", "Extend horizon"]), "an active vault's actions");
      });
      await t.step("the heir's address: copied whole, and linked to the explorer", async () => {
        await t.session.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: t.session.site.origin });
        const copy = app.card(0).getByRole("button", { name: `Copy address ${bob}` });
        await copy.click();
        await app.waitText(copy, "Copied");
        assertEqual(await t.page.evaluate(() => navigator.clipboard.readText()), bob, "the copied heir address");
        const links = await app.card(0).locator("a.addr-link").evaluateAll((as) => as.map((a) => a.href));
        assert(links.includes(`https://basescan.org/address/${bob}`), `explorer links on the card: ${links}`);
      });
    },
  },

  {
    name: "create: a USDC vault (approve exactly the amount, then create), heir picked from an existing vault",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const usdc = t.world.tokens.USDC;
      await t.createVault(alice, { heir: bob });
      await app.open();
      await app.connect(alice);
      await t.step("the asset list offers the four listed tokens, each verified", async () => {
        await app.tab("create");
        const labels = await t.page.locator("#cAsset option").evaluateAll((opts) => opts.map((o) => `${o.textContent}${o.disabled ? " [disabled]" : ""}`));
        assertEqual(JSON.stringify(labels), JSON.stringify(["Native coin (ETH)", "USDC - USD Coin", "WETH - Wrapped Ether",
          "cbBTC - Coinbase Wrapped BTC", "EURC - EURC"]), "asset options");
      });
      await t.step("picking USDC shows its contract address", async () => {
        await fillCreate(app, { asset: "USDC - USD Coin" });
        const info = await app.textOf("#cTokenInfo");
        assert(info.includes("Token contract") && info.includes(usdc.address), `token info: ${info}`);
      });
      await t.step("the existing-heir picker fills both boxes", async () => {
        assert(await app.visible("#cHeirPickWrap"), "the heir picker should be offered to an owner with a vault");
        await t.page.selectOption("#cHeirPick", bob);
        assertEqual(await t.page.inputValue("#cHeir"), bob, "first heir box");
        assertEqual(await t.page.inputValue("#cHeir2"), bob, "second heir box");
      });
      await t.step("review and sign: approve, then create", async () => {
        await fillCreate(app, { amount: "250", period: 90, window: 30, ack: true });
        const review = expectKind(await reviewCreate(app), "sign", null, "the review");
        assert(review.includes("USDC - USD Coin") && review.includes("250.0 USDC") && review.includes(usdc.address),
          `the review of a USDC vault: ${review}`);
        await signCreate(app);
        assertEqual(JSON.stringify(t.wallet.sentCalls()), JSON.stringify(["0x095ea7b3", "createVault"]),
          "transactions signed (approve, createVault)");
      });
      await t.step("on chain: 250 USDC locked, the allowance used up exactly", async () => {
        const v = await t.vault(alice, 1);
        assert(same(v.token, usdc.address), "token");
        assertEqual(v.balance, ethers.parseUnits("250", 6), "balance");
        assertEqual(await t.erc20(usdc.address).allowance(alice, t.world.v2Address), 0n, "allowance left");
      });
      await t.step("the card shows the token by name", async () => {
        await app.tab("mine");
        const text = await app.waitText(app.card(1), "250.0 USDC");
        assert(text.includes("Token USDC") && text.includes(usdc.address), `the USDC card: ${text}`);
        assert(await app.visible("#checkAllBtn"), "Check in on all vaults is offered with two vaults");
      });
    },
  },

  {
    name: "create: refusals before signing (unlisted token, look-alike heirs, refused payees, no-alerts box, and more)",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol } = t.who;
      await t.createVault(alice, { heir: bob });
      const closed = await t.createVault(alice, { heir: carol });
      await t.tx(alice, "withdraw", closed, ethers.MaxUint256, alice);
      await app.open();
      await app.connect(alice);
      const now = await t.now();
      const good = { asset: "native", amount: "1", period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true };

      const refusal = async (what, fields, kind, pattern) => {
        await t.step(what, async () => {
          await fillCreate(app, { ...good, ...fields });
          expectKind(await reviewCreate(app), kind, pattern, what);
        });
      };

      await t.step("an unlisted token smuggled into the asset list is refused", async () => {
        await app.tab("create");
        await t.page.evaluate((token) => {
          const option = document.createElement("option");
          option.value = `token:${token}`;
          option.textContent = "USDC - USD Coin (unlisted)";
          document.getElementById("cAsset").append(option);
        }, t.world.unlistedToken);
        await fillCreate(app, { ...good, heir: carol, asset: "USDC - USD Coin (unlisted)" });
        expectKind(await reviewCreate(app), "log", "That token is not offered: pick the asset again.", "unlisted token");
        await t.page.selectOption("#cAsset", "native");
      });
      await refusal("a look-alike of an existing heir (same first four)", { heir: lookalike(bob) }, "banner",
        /Blocked: this address starts or ends with the same 4 characters as the heir of your vault #0, but it is a different address/);
      await refusal("a look-alike of the owner's own wallet (same last four)", { heir: lookalike(alice, { end: true }) }, "banner",
        /same 4 characters as your own wallet/);
      await refusal("a look-alike of the heir of a CLOSED vault", { heir: lookalike(carol) }, "banner",
        /the heir of your vault #1 \(no longer open\)/);
      await t.step("the blocked review shows both addresses in full", async () => {
        const text = await app.textOf("#cReview");
        assert(text.includes(`Entered0x${lookalike(carol).slice(2)}`) && text.includes(carol), `look-alike banner rows: ${text}`);
      });
      const refused = [
        ["the WETH token", t.world.tokens.WETH.address, "the WETH token contract, one of the tokens the vault contract lists"],
        ["the USDC token", t.world.tokens.USDC.address, "the USDC token contract, one of the tokens the vault contract lists"],
        ["the vault contract", t.world.v2Address, "the Will & Key vault contract itself"],
        ["the L2ToL1MessagePasser", t.world.refused.messagePasser, "an OP-stack system contract"],
        ["the EntryPoint v0.7", t.world.refused.entryPointV07, "the ERC-4337 EntryPoint v0.7"],
        ["Venus vBNB", t.world.refused.vBNB, "the Venus vBNB market address"],
        ["the zero address", ethers.ZeroAddress, "the zero address"],
        // The contract accepts these two; a payout to either could never be collected.
        ["the retired v1 contract", t.world.v1Address, "the retired Will & Key v1 vault contract"],
        ["the retired billing contract", "0x60749aF621180de1DC05DB4f3d158D09dE979dC6", "the retired Will & Key reminder-billing contract"],
      ];
      for (const [label, address, words] of refused) {
        await refusal(`a refused payee as heir: ${label}`, { heir: address }, "banner",
          `That is ${words}`);
      }
      await refusal("the owner as heir", { heir: alice }, "banner", "That is your own connected wallet. The owner cannot be the heir.");
      await refusal("two different heir entries", { heir: carol, heir2: t.who.dave }, "log",
        "the two entries are different addresses");
      await refusal("a wrong checksum (one letter's case flipped)", { heir: flipOneLetter(carol) },
        "log", "do not match its checksum");
      await refusal("no-alerts box not ticked", { heir: carol, ack: false }, "log",
        "Tick the box confirming you understand that Will & Key sends no alerts.");
      await refusal("an amount with a comma", { heir: carol, amount: "1,5" }, "log", "is not an amount");
      await refusal("a zero amount", { heir: carol, amount: "0" }, "log", "enter an amount above zero");
      await refusal("a period under 7 days", { heir: carol, period: 6 }, "log",
        "The inactivity period must be a whole number of days from 7 to 3650.");
      await refusal("a challenge window over 365 days", { heir: carol, window: 366 }, "log",
        "The challenge window must be a whole number of days from 7 to 365.");
      await refusal("a horizon sooner than one inactivity period", { heir: carol, horizon: horizonDay(now, 30) }, "log",
        /The horizon must be \d{4}-\d{2}-\d{2} or later: at least one inactivity period from now\./);
      await t.step("nothing was signed", async () => {
        assertEqual(t.wallet.sent.length, 0, "transactions sent during the refusals");
        assertEqual(Number(await t.v2().vaultCount(alice)), 2, "alice's vault count");
      });
      await t.step("with every field right the same form reviews", async () => {
        await fillCreate(app, { ...good, heir: carol });
        expectKind(await reviewCreate(app), "sign", carol, "the corrected form");
      });
    },
  },

  {
    name: "create: the 32-vault limit is refused before signing, and two look-alike heirs on the owner's vaults are flagged",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol } = t.who;
      await t.createVault(alice, { heir: bob, amount: 1n });
      await t.createVault(alice, { heir: lookalike(bob), amount: 1n });
      for (let i = 2; i < 32; i += 1) await t.createVault(alice, { heir: carol, amount: 1n });
      await app.open();
      await app.connect(alice);
      await t.step("the look-alike pair among the owner's own heirs", async () => {
        const alert = await app.waitText("#mineAlerts", "Two addresses on your vaults look alike");
        t.check(alert.includes(`Heir of vault #00x${bob.slice(2)}`) && alert.includes(`Heir of vault #10x${lookalike(bob).slice(2)}`),
          `look-alike alert rows: ${alert}`);
      });
      await t.step("a 33rd vault", async () => {
        const now = await t.now();
        await fillCreate(app, { asset: "native", amount: "1", heir: t.who.dave, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
        expectKind(await reviewCreate(app), "log", "You already have 32 open vaults, the most one wallet can have. Close one first.", "33rd vault");
        assertEqual(t.wallet.sent.length, 0, "transactions sent");
      });
    },
  },

  {
    name: "create: a listed token whose on-chain symbol disagrees with the app's table is not offered",
    async run(t) {
      const { app } = t;
      const usdc = t.world.tokens.USDC;
      // OpenZeppelin ERC20: the symbol is slot 4; a short string sits inline, length * 2 in the last byte.
      const text = Buffer.from("USDbC", "utf8");
      const slot = Buffer.alloc(32);
      text.copy(slot);
      slot[31] = text.length * 2;
      await t.chain.send("hardhat_setStorageAt", [usdc.address, "0x4", `0x${slot.toString("hex")}`]);
      assertEqual(await t.erc20(usdc.address).symbol(), "USDbC", "the token's symbol on chain");
      await app.open();
      await app.connect(t.who.alice);
      await app.tab("create");
      const options = await t.page.locator("#cAsset option").evaluateAll((opts) => opts.map((o) => [o.textContent, o.disabled]));
      const entry = options.find(([label]) => label.startsWith("USDbC"));
      assert(entry && entry[1] === true, `USDC should be listed but disabled: ${JSON.stringify(options)}`);
      const info = await app.textOf("#cTokenInfo");
      assert(info.includes(`Listed by the vault contract but not offered here: ${usdc.address}: on chain it reports "USDbC" with 6 decimals, but the app expects USDC with 6`),
        `the reason shown: ${info}`);
    },
  },

  {
    name: "create: paused by the admin after the review, the signature is refused with the reason; after a reload the form is closed",
    async run(t) {
      const { app } = t;
      await app.open();
      await app.connect(t.who.alice);
      const now = await t.now();
      await fillCreate(app, { asset: "native", amount: "1", heir: t.who.bob, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
      expectKind(await reviewCreate(app), "sign", null, "the review");
      await Chain.mined(t.v2(t.world.ledger).setCreationPaused(true));
      await app.press(t.page.locator("#cReview"), "Sign and create vault");
      const log = await app.waitText("#createLog", "Create vault failed:");
      t.check(log.includes("Create vault failed: New-vault creation is paused on this contract by its admin. Existing vaults and every way out of them keep working. (CreationIsPaused)"),
        `decoded refusal: ${log}`);
      assertEqual(t.wallet.sent.length, 0, "transactions sent");
      await app.reload();
      await app.tab("create");
      assert(await app.visible("#cPaused"), "the paused banner must show");
      assertEqual(await t.page.locator("#createBtn").isDisabled(), true, "Review vault must be disabled");
    },
  },
];
