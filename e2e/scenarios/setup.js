"use strict";
// The deployment as the app sees it: launch values, the ABI, the production headers, connecting
// (and the two ways connecting can go wrong), and the notice about the retired v1 contract.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { assert, assertEqual, poll, short, same, utcDateText } = require("../lib/util");
const { artifact, Chain } = require("../lib/chain");
const { LISTED, TOKENS } = require("../lib/world");
const {
  copySite, setLaunchValues, launchArgs, validateCopy, snapshotFiles, changedFiles,
} = require("../lib/site");

const read = (t, rel) => fs.readFileSync(path.join(t.prepared.root, rel), "utf8");

/** Runs `fn(root)` on a fresh copy of site/ and the documents, and removes the copy afterwards. */
async function withCopy(fn) {
  const root = copySite("willandkey-e2e-slv-");
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function signatures(abi) {
  return new ethers.Interface(abi).format(false).slice().sort();
}

module.exports = [
  {
    name: "launch values: markers filled in the copy, abi.js matches the compiled v2, production headers",
    async run(t) {
      await t.step("set-launch-values.js left no *_TBD marker in the copied site", async () => {
        assert(t.prepared.left.length === 0, `markers left after set-launch-values.js: ${t.prepared.left.join(", ")}`);
        assert(/transaction 0x[0-9a-f]{64} created 0x[0-9a-fA-F]{40} in block \d+ \(status 1\)/.test(t.prepared.output)
          && /logged CreationPauseSet\(true\) on v1/.test(t.prepared.output),
        `set-launch-values.js did not report its on-chain checks:\n${t.prepared.output}`);
        assert(/these match the launch plan/.test(t.prepared.output) && /name exactly the verified values/.test(t.prepared.output),
          `set-launch-values.js did not report the launch-plan and published-values checks:\n${t.prepared.output}`);
      });
      await t.step("the app's Base entry names the local v2 deployment and its code hash", async () => {
        const app = read(t, "site/assets/app.js");
        const expected = `contract: "${t.world.v2Address}", deployBlock: "${t.world.launch.block}"`;
        assert(app.includes(expected), `site/assets/app.js (copy) lacks ${expected}`);
        const hash = ethers.keccak256(await t.chain.provider.getCode(t.world.v2Address)).slice(2);
        assert(app.includes(`codehash: "${hash}"`), `site/assets/app.js (copy) lacks codehash "${hash}"`);
      });
      await t.step("the filled-in copy passes scripts/validate-site.js", async () => {
        const run = validateCopy(t.prepared.root);
        assertEqual(run.status, 0, `validate-site.js exit code on the filled-in copy (output: ${run.output.trim()})`);
      });
      await t.step("site/assets/abi.js is the ABI of contracts/InheritanceVault.sol as compiled now", async () => {
        const text = read(t, "site/assets/abi.js");
        const match = /const VAULT_ABI = (\[[\s\S]*\]);?\s*$/.exec(text.trim());
        assert(match, "site/assets/abi.js does not define VAULT_ABI as one JSON array");
        const served = signatures(JSON.parse(match[1]));
        const compiled = signatures(t.world.abi.v2);
        const missing = compiled.filter((s) => !served.includes(s));
        const extra = served.filter((s) => !compiled.includes(s));
        assert(!missing.length && !extra.length,
          `abi.js differs from the compiled v2 ABI.\n  missing from abi.js: ${missing.join("\n    ") || "-"}\n  only in abi.js: ${extra.join("\n    ") || "-"}`);
      });
      await t.step("/app is served with the production headers of site/_headers", async () => {
        const res = await fetch(`${t.session.site.origin}/app`);
        assertEqual(res.status, 200, "GET /app status");
        const headers = read(t, "site/_headers");
        const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)[1].trim();
        assertEqual(res.headers.get("content-security-policy"), csp, "the CSP served on /app");
        assert(/noindex/.test(res.headers.get("x-robots-tag") || ""), "X-Robots-Tag noindex missing on /app");
        assertEqual(res.headers.get("x-frame-options"), "DENY", "X-Frame-Options");
      });
    },
  },

  {
    // scripts/set-launch-values.js writes what the published site says about the deployment, so
    // every way it could publish an unverified value is tried here against copies of site/ and
    // the documents, with its on-chain checks pointed at the local node.
    name: "set-launch-values: --offline writes nothing, and values the chain does not confirm, or the launch plan does not describe, are refused before anything is written",
    async run(t) {
      const L = t.world.launch;
      const node = t.chain.url;
      await t.step("--offline only previews: it writes nothing, even with a wrong address", async () => {
        await withCopy(async (root) => {
          const before = snapshotFiles(root);
          const run = setLaunchValues(root, ["--offline", ...launchArgs({ ...L, address: t.world.ledger }, node).slice(0, -2)]);
          assertEqual(run.status, 0, `--offline exit code (output: ${run.output})`);
          assert(/nothing will be written/.test(run.output) && /Nothing was written/.test(run.output), `--offline output: ${run.output}`);
          assertEqual(JSON.stringify(changedFiles(before, snapshotFiles(root))), "[]", "files changed by --offline");
        });
      });
      await t.step("a value an earlier run left in the app is refused, and nothing is written", async () => {
        await withCopy(async (root) => {
          // As if an earlier run (or a hand edit) had written the Ledger's address into the app.
          const app = path.join(root, "site", "assets", "app.js");
          fs.writeFileSync(app, fs.readFileSync(app, "utf8").replace('contract: "V2_ADDRESS_TBD"', `contract: "${t.world.ledger}"`));
          const before = snapshotFiles(root);
          const run = setLaunchValues(root, launchArgs(L, node));
          assertEqual(run.status, 1, `exit code (output: ${run.output})`);
          assert(run.output.includes(`site/assets/app.js names the contract "${t.world.ledger}", not ${L.address}`),
            `the refusal should name the stale contract in app.js: ${run.output}`);
          assertEqual(JSON.stringify(changedFiles(before, snapshotFiles(root))), "[]", "files changed by a refused run");
          const valid = validateCopy(root);
          assertEqual(valid.status, 1, "validate-site.js on that copy (markers remain)");
        });
      });
      await t.step("a marker the script does not know is refused before anything is written", async () => {
        await withCopy(async (root) => {
          const page = path.join(root, "site", "about.html");
          fs.writeFileSync(page, `${fs.readFileSync(page, "utf8")}\n<!-- V2_SOMETHING_ELSE_TBD -->\n`);
          const before = snapshotFiles(root);
          const run = setLaunchValues(root, launchArgs(L, node));
          assertEqual(run.status, 1, `exit code (output: ${run.output})`);
          assert(/site\/about\.html:\d+ V2_SOMETHING_ELSE_TBD/.test(run.output) && /Nothing was changed/.test(run.output),
            `the refusal should list the unknown marker: ${run.output}`);
          assertEqual(JSON.stringify(changedFiles(before, snapshotFiles(root))), "[]", "files changed by a refused run");
        });
      });
      await t.step("a v2 deployment whose settings differ from the launch plan is refused", async () => {
        // The same contract, deployed by the hot key with itself as admin: HB_DOMAIN() is v2's,
        // so only the read-back of the constructor's settings can tell.
        const art = artifact("InheritanceVault.sol", "InheritanceVault");
        const other = await t.chain.deploy(art, t.world.hotKey, [t.world.hotKey, 50, t.world.ledger, LISTED, TOKENS.WETH.address]);
        const receipt = await other.deploymentTransaction().wait();
        const header = await t.chain.provider.getBlock(receipt.blockNumber);
        await withCopy(async (root) => {
          const before = snapshotFiles(root);
          const run = setLaunchValues(root, launchArgs({
            address: ethers.getAddress(await other.getAddress()), block: receipt.blockNumber, tx: receipt.hash,
            date: utcDateText(header.timestamp), v1PauseTx: L.v1PauseTx,
          }, node));
          assertEqual(run.status, 1, `exit code (output: ${run.output})`);
          assert(run.output.includes(`owner() is ${t.world.hotKey}, not ${t.world.ledger}`),
            `the refusal should name the admin that differs from the plan: ${run.output}`);
          assertEqual(JSON.stringify(changedFiles(before, snapshotFiles(root))), "[]", "files changed by a refused run");
        });
      });
      await t.step("validate-site refuses a filled-in site whose app talks to another contract than its pages name", async () => {
        await withCopy(async (root) => {
          assertEqual(setLaunchValues(root, launchArgs(L, node)).status, 0, "the run");
          assertEqual(validateCopy(root).status, 0, "validate-site.js before the edit");
          // A hand edit after the run: no marker shows it.
          const app = path.join(root, "site", "assets", "app.js");
          fs.writeFileSync(app, fs.readFileSync(app, "utf8").replace(`contract: "${L.address}"`, `contract: "${t.world.ledger}"`));
          const run = validateCopy(root);
          assertEqual(run.status, 1, `validate-site.js exit code after the edit (output: ${run.output.trim()})`);
          assert(run.output.includes(`app.html: the footer links contract ${L.address}, but assets/app.js uses ${t.world.ledger}`),
            `validate-site.js should name the disagreement: ${run.output}`);
        });
      });
      await t.step("run twice with the right values: the second run finds nothing to do and still checks what is published", async () => {
        await withCopy(async (root) => {
          assertEqual(setLaunchValues(root, launchArgs(L, node)).status, 0, "first run");
          const before = snapshotFiles(root);
          const again = setLaunchValues(root, launchArgs(L, node));
          assertEqual(again.status, 0, `second run exit code (output: ${again.output})`);
          assert(/already in the files/.test(again.output) && /name exactly the verified values/.test(again.output),
            `second run output: ${again.output}`);
          assertEqual(JSON.stringify(changedFiles(before, snapshotFiles(root))), "[]", "files changed by the second run");
          assertEqual(validateCopy(root).status, 0, "validate-site.js after the runs");
        });
      });
    },
  },

  {
    // The suite's own guards, proven to fire: without this, a green run could mean that CSP
    // violations, page errors or console errors were simply never seen.
    name: "harness canaries: a CSP violation, a page error, a console error and a stray request are caught",
    async run(t) {
      await t.app.open();
      const s = t.session;
      const expectProblem = async (what, pattern, act) => {
        s.problems.length = 0;
        s.unexpectedRequests.length = 0;
        await act();
        await poll(() => [...s.problems, ...s.unexpectedRequests].join("\n"), (text) => pattern.test(text),
          { what: `the harness to record ${what}`, timeout: 5000 });
      };
      await expectProblem("an inline-script CSP violation", /csp: .*script-src|Content Security Policy/, () =>
        t.page.evaluate(() => {
          const script = document.createElement("script");
          script.textContent = "window.__inlineRan = true";
          document.body.append(script);
        }));
      assertEqual(await t.page.evaluate(() => window.__inlineRan === true), false, "the inline script must not have run");
      await expectProblem("an uncaught page error", /pageerror: canary-throw/, () =>
        t.page.evaluate(() => { setTimeout(() => { throw new Error("canary-throw"); }, 0); }));
      await expectProblem("a console error", /console\.error: canary-console/, () =>
        t.page.evaluate(() => console.error("canary-console")));
      // sepolia.base.org is allowed by the CSP's connect-src, so only the harness can stop it.
      await expectProblem("a request to a host other than the site", /^POST https:\/\/sepolia\.base\.org\/$/m, () =>
        t.page.evaluate(() => fetch("https://sepolia.base.org/", { method: "POST", body: "{}" }).catch(() => {})));
      s.problems.length = 0;
      s.unexpectedRequests.length = 0;
    },
  },

  {
    name: "connect: button, auto-connect on reload, account switch, deployment details",
    async run(t) {
      const { app } = t;
      const { alice, bob } = t.who;
      await t.step("before connecting, nothing is read", async () => {
        await app.open();
        assertEqual((await app.text("#netPill")).trim(), "no wallet", "network pill before connecting");
        assert((await app.text("#mineEmpty")).includes("Connect your wallet"), "the empty card should ask to connect");
        assertEqual(t.wallet.requests.filter((m) => m !== "eth_chainId").length, 0, "wallet requests before connecting");
      });
      await t.step("each tab's action asks for a wallet first", async () => {
        const ask = "Connect a wallet on a network where Will & Key v2 is deployed first.";
        await app.tab("create");
        await t.page.click("#createBtn");
        await app.waitText("#createLog", ask);
        await app.tab("heir");
        await t.page.fill("#hOwner", t.who.bob);
        await t.page.click("#hLookupBtn");
        await app.waitText("#heirList", ask);
        await t.page.click("#hScanBtn");
        await app.waitText("#hScanLog", ask);
        await app.tab("credits");
        await t.page.click("#crCheckBtn");
        await app.waitText("#crLog", ask);
        await app.tab("mine");
        assertEqual(t.wallet.requests.filter((m) => m !== "eth_chainId").length, 0, "wallet requests before connecting");
      });
      await t.step("the person declines the connection request", async () => {
        t.wallet.account = null; // the e2e wallet answers eth_requestAccounts with 4001 then
        await t.page.click("#connectBtn");
        await app.waitText("#walletBanner", "Could not connect: you declined it in your wallet");
      });
      await t.step("Connect wallet", async () => {
        await app.connect(alice);
        assert(!(await app.visible("#deployBanner")), "the deployment banner should be hidden on Base with v2 deployed");
        await app.waitText("#mineEmpty", "No vaults yet", "the empty list for a wallet with no v2 vault");
        assert(!(await app.visible("#checkAllBtn")), "Check in on all vaults must be hidden with no vaults");
      });
      await t.step("the footer names the v2 deployment filled in by set-launch-values.js", async () => {
        const footer = await app.text(".footer-contract");
        const { launch } = t.world;
        for (const part of [launch.address, String(launch.block), launch.date]) {
          assert(footer.includes(part), `footer lacks ${part}: ${footer}`);
        }
        const hrefs = await t.page.locator(".footer-contract a").evaluateAll((links) => links.map((a) => a.href));
        assert(hrefs.includes(`https://basescan.org/tx/${launch.tx}`), `footer lacks the deploy tx link: ${hrefs}`);
        assert(hrefs.includes(`https://basescan.org/block/${launch.block}`), `footer lacks the block link: ${hrefs}`);
      });
      await t.step("reload: the app reconnects by itself", async () => {
        const before = t.wallet.requests.filter((m) => m === "eth_requestAccounts").length;
        await t.page.reload({ waitUntil: "load" });
        await app.waitConnected(alice);
        const after = t.wallet.requests.filter((m) => m === "eth_requestAccounts").length;
        assertEqual(after - before, 1, "eth_requestAccounts calls by the auto-connect");
      });
      await t.step("switching accounts in the wallet reloads the page as the new account", async () => {
        await app.switchAccount(bob);
        assertEqual((await app.text("#connectBtn")).trim(), short(bob), "Connect button after the switch");
      });
    },
  },

  {
    name: "connect: unsupported network, and switching back to Base",
    async run(t) {
      const { app } = t;
      await app.open();
      await app.connect(t.who.alice);
      await t.step("the wallet moves to Ethereum mainnet", async () => {
        t.wallet.chainId = "0x1";
        const loaded = t.page.waitForEvent("load");
        await t.page.evaluate((s) => setTimeout(() => window.__e2eWalletEmit("chainChanged", "0x1", s), 0), t.wallet.state());
        await loaded;
        await app.waitText("#netPill", "unsupported network");
        await app.waitText("#deployBanner", "This network is not supported. Switch to:");
      });
      await t.step("the banner's Base button asks the wallet to switch, and the app comes back on Base", async () => {
        const loaded = t.page.waitForEvent("load");
        await app.press(t.page.locator("#deployBanner"), "Base");
        await loaded;
        await app.waitConnected(t.who.alice);
        assert(t.wallet.requests.includes("wallet_switchEthereumChain"), "wallet_switchEthereumChain was not requested");
      });
    },
  },

  {
    name: "connect: a wallet without Base configured: declining the switch, declining to add Base, then adding it",
    async run(t) {
      const { app } = t;
      t.wallet.chainId = "0x1";
      t.wallet.account = t.who.alice;
      await app.open();
      await t.page.click("#connectBtn");
      await app.waitText("#netPill", "unsupported network");
      const bannerBase = () => app.press(t.page.locator("#deployBanner"), "Base");
      await t.step("the person declines the switch: the banner says so", async () => {
        t.wallet.declineSwitch = true;
        await bannerBase();
        await poll(() => t.wallet.requests.filter((m) => m === "wallet_switchEthereumChain").length, (n) => n === 1, { what: "the switch request" });
        await app.waitText("#deployBanner", "You declined the switch to Base in your wallet. Nothing changed.");
        t.wallet.declineSwitch = false;
      });
      await t.step("the wallet does not know Base, and the person declines adding it: the banner says so", async () => {
        t.wallet.knowsBase = false;
        t.wallet.declineAdd = true;
        await bannerBase();
        await poll(() => t.wallet.addChainRequests.length, (n) => n === 1, { what: "the add-chain request" });
        await app.waitText("#deployBanner", "You declined adding Base to your wallet. Nothing changed.");
        assert(!(await app.textOf("#deployBanner")).includes("declined the switch"), "the earlier message must be replaced");
        const add = t.wallet.addChainRequests[0];
        assertEqual(JSON.stringify(add), JSON.stringify({
          chainId: "0x2105", chainName: "Base", rpcUrls: ["https://mainnet.base.org"],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://basescan.org"],
        }), "the chain the app asks the wallet to add");
      });
      await t.step("the person adds Base: the app comes back on Base", async () => {
        t.wallet.declineAdd = false;
        const loaded = t.page.waitForEvent("load");
        await bannerBase();
        await loaded;
        await app.waitConnected(t.who.alice);
      });
    },
  },

  {
    // The app compares the code at its configured address with the code hash set-launch-values.js
    // wrote next to it, so a wrong address (or different code there) is never served as the vault.
    name: "connect: a contract whose code differs from the deployment's code hash is refused, and nothing is read from it",
    async run(t) {
      const { app } = t;
      const code = await t.chain.provider.getCode(t.world.v2Address);
      // One byte of the trailing metadata changed: the contract still runs, but it is not the code
      // the page was built for.
      const changed = `${code.slice(0, -2)}${code.slice(-2) === "00" ? "01" : "00"}`;
      await t.chain.send("hardhat_setCode", [t.world.v2Address, changed]);
      assertEqual(await t.chain.provider.getCode(t.world.v2Address), changed, "the changed code on chain");
      await app.open();
      t.wallet.account = t.who.alice;
      await t.page.click("#connectBtn");
      const banner = await app.waitText("#deployBanner", "could not be read");
      assert(banner.includes(`the contract at ${t.world.v2Address} is not the Will & Key v2 deployment this page was built for: its code differs`),
        `the refusal: ${banner}`);
      assert((await app.text("#mineEmpty")).includes("Connect your wallet"), "no vault list may be shown");
      const calls = t.wallet.requests.filter((m) => m === "eth_call").length;
      assertEqual(calls, 0, "eth_call requests made to a contract that failed the code check");
    },
  },

  {
    name: "connect: no wallet installed",
    session: { wallet: false },
    async run(t) {
      await t.app.open();
      await t.page.click("#connectBtn");
      await t.app.waitText("#walletBanner", "No wallet detected");
    },
  },

  {
    name: "v1 notice: retired contract, pause transaction, and what a wallet still has on v1",
    async run(t) {
      const { app } = t;
      const { launch } = t.world;
      await app.open();
      await t.step("the static notice carries the launch date and the v1 pause transaction", async () => {
        const text = await app.text("#v1Notice");
        assert(text.includes(`deployed on ${launch.date}`), `v1 notice lacks the deploy date: ${text}`);
        assert(text.includes(t.world.v1Address), "v1 notice lacks the v1 address");
        const hrefs = await t.page.locator("#v1Notice a").evaluateAll((links) => links.map((a) => a.href));
        assert(hrefs.includes(`https://basescan.org/tx/${t.world.v1PauseTx}`), `v1 notice lacks the pause tx link: ${hrefs}`);
        assert(hrefs.some((h) => h.includes(`${t.world.v1Address}#writeContract`)), "v1 notice lacks the Write Contract link");
        assert(!(await app.visible("#v1Mine")), "the per-wallet v1 lines must stay hidden before connecting");
      });
      await t.step("a wallet with a v1 credit and an open v1 vault is told about both", async () => {
        await app.connect(t.who.alice);
        const owed = await t.v1().creditOf(ethers.ZeroAddress, t.who.alice);
        assertEqual(owed, ethers.parseEther("0.25"), "alice's v1 credit on chain");
        const text = await app.waitText("#v1Mine", "credited on v1");
        assert(text.includes("Your connected wallet has 0.25 ETH credited on v1"), `v1 credit line: ${text}`);
        assert(text.includes("still owns 1 open v1 vault (#0)"), `v1 open-vault line: ${text}`);
        assert(await app.visible("#v1Mine"), "the v1 lines must be visible");
      });
      await t.step("a wallet with nothing on v1 sees no per-wallet line", async () => {
        await app.switchAccount(t.who.grace);
        // checkV1 runs after connect; give it time to (not) show anything.
        await poll(() => t.page.evaluate(() => document.getElementById("v1Mine").hidden), (hidden) => hidden === true,
          { what: "#v1Mine to stay hidden", timeout: 3000 });
        await new Promise((r) => setTimeout(r, 1500));
        assert(!(await app.visible("#v1Mine")), "#v1Mine must be hidden for a wallet with nothing on v1");
      });
      await t.step("v1 is paused on chain, as the notice says", async () => {
        assertEqual(await t.v1().creationPaused(), true, "v1 creationPaused()");
        assert(same(await t.v1().owner(), t.world.ledger), "v1 admin should be the Ledger");
      });
    },
  },
];
