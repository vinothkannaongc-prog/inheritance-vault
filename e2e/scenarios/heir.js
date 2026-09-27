"use strict";
// The heir tab: looking an owner up (and being warned about a vault that names a look-alike of
// the heir's wallet), and the search for vaults naming the wallet, through the wallet's own
// connection and, when that refuses logs, through the public endpoint (answered by the local
// node through the page's CSP-allowed connect-src), across a rate limit.

const { ethers } = require("ethers");
const { assert, assertEqual, poll, DAY } = require("../lib/util");
const { lookupOwner, lookalike } = require("../lib/flows");

async function search(t) {
  await t.app.tab("heir");
  await t.page.evaluate(() => {
    for (const child of document.getElementById("heirList").children) child.dataset.e2eStale = "1";
  });
  await t.page.click("#hScanBtn");
  await poll(() => t.page.evaluate(() => {
    const list = document.getElementById("heirList");
    const done = !document.getElementById("hScanBtn").disabled;
    return done && list.children.length > 0 && ![...list.children].some((c) => c.dataset.e2eStale);
  }), Boolean, { what: "the heir search to finish", timeout: 60000 });
  return t.app.textOf("#heirList");
}

async function heirCards(t) {
  return t.page.locator("#heirList .vault-card").evaluateAll((cards) => cards.map((card) => {
    const log = card.querySelector(".txlog");
    return log ? log.id.replace("log-heir-", "") : null;
  }));
}

module.exports = [
  {
    name: "heir lookup: only the vaults naming this wallet, a warning for a look-alike heir, and bad input",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol, grace } = t.who;
      const mine = await t.createVault(alice, { heir: bob });
      await t.createVault(alice, { heir: carol });
      const poisoned = await t.createVault(alice, { heir: lookalike(bob) });
      await app.open();
      await app.connect(bob);
      await t.step("lookup by the owner's address", async () => {
        const text = await lookupOwner(app, alice);
        assertEqual(JSON.stringify(await heirCards(t)), JSON.stringify([`${alice.toLowerCase()}-${mine}`]), "heir cards shown");
        t.check(text.includes(`Vault #${poisoned} of this owner names an heir that looks like your wallet but is NOT your wallet.`)
          && text.includes(`Vault names0x${lookalike(bob).slice(2)}`) && text.includes(`Your wallet0x${bob.slice(2)}`),
        `look-alike warning: ${text}`);
        t.check(text.includes("Owner's next deadline: in 89d 23h") || /Owner's next deadline: in 8\dd/.test(text), `owner's deadline line: ${text}`);
      });
      await t.step("an owner with no vault naming the heir", async () => {
        const text = await lookupOwner(app, grace);
        t.check(text.includes("No open vaults at that address name your wallet as heir."), `empty lookup: ${text}`);
      });
      await t.step("not an address", async () => {
        const text = await lookupOwner(app, "0x1234");
        t.check(text.includes("Lookup failed: Vault owner's address: \"0x1234\" is not an address."), `bad input: ${text}`);
      });
    },
  },

  {
    name: "heir search: finds the wallet's vaults across owners from the logs, confirms each on chain, and drops the stale ones",
    async run(t) {
      const { app } = t;
      const { alice, bob, carol, frank } = t.who;
      const a0 = await t.createVault(alice, { heir: bob });
      const f0 = await t.createVault(frank, { heir: bob });
      const a1 = await t.createVault(alice, { heir: carol });
      await t.tx(alice, "setBeneficiary", a1, bob); // becomes bob's (BeneficiaryChanged)
      const a2 = await t.createVault(alice, { heir: bob });
      await t.tx(alice, "setBeneficiary", a2, carol); // no longer bob's
      const f1 = await t.createVault(frank, { heir: bob });
      await t.tx(frank, "withdraw", f1, ethers.MaxUint256, frank); // closed
      await app.open();
      await app.connect(bob);
      const text = await search(t);
      const head = await app.textOf("#heirList .banner");
      t.check(head.includes("3 open vaults name your wallet as heir."), `search heading: ${head}`);
      t.check(new RegExp(`Searched every block from the contract's deployment \\(${t.world.launch.block}\\) to \\d+\\. Latest pass read through your wallet's connection\\.`).test(head),
        `search coverage: ${head}`);
      t.check(head.includes("2 earlier records for your wallet no longer apply"), `stale records: ${head}`);
      const cards = (await heirCards(t)).sort();
      assertEqual(JSON.stringify(cards), JSON.stringify([`${alice.toLowerCase()}-${a0}`, `${alice.toLowerCase()}-${a1}`, `${frank.toLowerCase()}-${f0}`].sort()),
        "vaults found");
      assertEqual((await t.page.textContent("#hScanBtn")).trim(), "Search again (new blocks only)", "the search button afterwards");
      assert(t.session.publicCalls.length === 0, `the public endpoint was used although the wallet served the logs: ${t.session.publicCalls}`);
      assert(!text.includes("INCOMPLETE"), "the search must be complete");
      await t.step("a vault created since is found by searching the new blocks only", async () => {
        const f2 = await t.createVault(frank, { heir: bob });
        await search(t);
        t.check((await app.textOf("#heirList .banner")).includes("4 open vaults name your wallet as heir."), `second search: ${await app.textOf("#heirList .banner")}`);
        assert((await heirCards(t)).includes(`${frank.toLowerCase()}-${f2}`), "the new vault is listed");
      });
    },
  },

  {
    name: "heir search: stopped part-way through the public endpoint's 2,000-block pages, reported incomplete, then continued",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const a0 = await t.createVault(alice, { heir: bob });
      await t.chain.send("hardhat_mine", ["0x1770"]); // 6,000 empty blocks: four pages of 2,000
      const a1 = await t.createVault(alice, { heir: bob });
      await app.open();
      await app.connect(bob);
      t.wallet.faults.refuseLogs = true;
      t.session.expectPublic = true;
      t.session.publicFaults.delayLogsMs = 400;
      await app.tab("heir");
      await t.page.click("#hScanBtn");
      await app.waitText("#hScanLog", "Searching blocks");
      await t.page.click("#hScanStop");
      await poll(() => t.page.evaluate(() => !document.getElementById("hScanBtn").disabled), Boolean, { what: "the stopped search to finish" });
      const stopped = await app.textOf("#heirList .banner");
      t.check(/INCOMPLETE: searched blocks [\d,]+-[\d,]+; blocks [\d,]+-[\d,]+ were not searched because you stopped the search\. Press "Continue the search" to go on\./.test(stopped),
        `stopped search: ${stopped}`);
      assertEqual((await t.page.textContent("#hScanBtn")).trim(), "Continue the search", "the search button after a stop");
      await search(t);
      const done = await app.textOf("#heirList .banner");
      t.check(done.includes("2 open vaults name your wallet as heir.") && done.includes("Searched every block from the contract's deployment"),
        `continued search: ${done}`);
      assertEqual(JSON.stringify((await heirCards(t)).sort()), JSON.stringify([`${alice.toLowerCase()}-${a0}`, `${alice.toLowerCase()}-${a1}`].sort()),
        "vaults found across the pages");
    },
  },

  {
    name: "heir search: the wallet refuses eth_getLogs, so the public endpoint is used (answered locally), through a rate limit",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      const a0 = await t.createVault(alice, { heir: bob, period: 7 * DAY });
      await t.expire(alice, a0);
      await app.open();
      await app.connect(bob);
      t.wallet.faults.refuseLogs = true;
      t.session.publicFaults.rateLimitNext = 1;
      t.session.expectPublic = true;
      // The browser itself logs the 429 answer as a failed resource load; that one is expected here.
      t.session.allowedConsole.push(/the server responded with a status of 429/);
      await search(t);
      const head = await app.textOf("#heirList .banner");
      t.check(head.includes("1 open vault names your wallet as heir."), `search heading: ${head}`);
      t.check(head.includes("Latest pass read through the public endpoint mainnet.base.org."), `source used: ${head}`);
      assert(t.session.publicCalls.includes("eth_getLogs"), `the public endpoint got no eth_getLogs: ${t.session.publicCalls}`);
      assertEqual(t.session.publicCalls[0], "eth_getLogs", "the first public call (answered 429, then retried)");
      assertEqual(JSON.stringify(await heirCards(t)), JSON.stringify([`${alice.toLowerCase()}-${a0}`]), "vault found");
      await app.press(app.heirCard(alice, a0).locator(".actions"), "Initiate claim");
    },
  },
];
