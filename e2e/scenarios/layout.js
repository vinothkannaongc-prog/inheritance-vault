"use strict";
// The app at phone width: no view may scroll sideways. Full addresses (ten groups of four),
// review lists and claim blocks are the widest things the app draws, so each is opened here.

const { ethers } = require("ethers");
const { DAY } = require("../lib/util");
const { fillCreate, reviewCreate, horizonDay, lookupOwner, openOwnerPanel, expectKind } = require("../lib/flows");

async function overflow(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scroll = document.documentElement.scrollWidth;
    const culprits = [];
    if (scroll > width) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > width + 1) {
          culprits.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].join(".")}` : ""} (right edge ${Math.round(r.right)} px)`);
        }
      }
    }
    return { width, scroll, culprits: culprits.slice(0, 6) };
  });
}

module.exports = [
  {
    name: "layout: at phone width (375 px) no view scrolls sideways (cards, a claim, panels, the create review, the heir card, payouts)",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol } = t.who;
      const claimed = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      const plain = await t.createVault(alice, { heir: carol });
      await t.tx(alice, "withdraw", plain, ethers.parseEther("0.25"), alice);
      await t.expire(alice, claimed);
      await t.tx(bob, "initiateClaim", alice, claimed, bob);
      await t.page.setViewportSize({ width: 375, height: 812 });
      const look = async (what) => {
        const o = await overflow(t.page);
        t.check(o.scroll <= o.width, `${what}: the page is ${o.scroll} px wide in a ${o.width} px viewport; too wide: ${o.culprits.join("; ")}`);
      };
      await app.open();
      await look("the page before connecting");
      await app.connect(alice);
      await look("my vaults, with a claim pending");
      await openOwnerPanel(app, claimed, "Withdraw everything and close");
      await look("the withdraw-everything panel");
      const now = await t.now();
      await fillCreate(app, { asset: "native", amount: "1", heir: carol, period: 90, window: 30, horizon: horizonDay(now, 3650), ack: true });
      expectKind(await reviewCreate(app), "sign", null, "the review");
      await look("the create review");
      await app.tab("credits");
      await t.page.click("#crCheckBtn");
      await app.waitText("#crList", "0.25 ETH");
      await look("payouts");
      await app.switchAccount(bob);
      await lookupOwner(app, alice);
      await look("the heir's card with a pending claim");
    },
  },
];
