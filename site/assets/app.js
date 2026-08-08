/* Will & Key app. Plain JS + ethers v6 UMD. No build step.
 * Contract addresses are per-chain; empty string = not deployed there yet, and the UI says so
 * rather than failing on the first call. */

"use strict";

const CHAINS = {
  84532: {
    name: "Base Sepolia", contract: "", notify: "", explorer: "https://sepolia.basescan.org",
    hex: "0x14a34", rpc: "https://sepolia.base.org", coin: "ETH", testnet: true,
  },
  8453: {
    name: "Base", contract: "", notify: "", explorer: "https://basescan.org",
    hex: "0x2105", rpc: "https://mainnet.base.org", coin: "ETH", testnet: false,
  },
  97: {
    name: "BNB Testnet", contract: "", notify: "", explorer: "https://testnet.bscscan.com",
    hex: "0x61", rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", coin: "tBNB", testnet: true,
  },
  56: {
    name: "BNB Chain", contract: "", notify: "", explorer: "https://bscscan.com",
    hex: "0x38", rpc: "https://bsc-dataseed.bnbchain.org", coin: "BNB", testnet: false,
  },
};

const SUB_ABI = [
  "function pricePerMonth() view returns (uint256)",
  "function paidUntil(address) view returns (uint64)",
  "function subscribe(address account, uint256 minSecondsAdded) payable",
];
const MONTH_SECS = 2592000n;

const ZERO = "0x0000000000000000000000000000000000000000";
const STATES = ["—", "Active", "Claim pending", "Settled", "Closed"];
const DAY = 86400n;
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const S = { provider: null, signer: null, account: null, chainId: null, contract: null };
const tokenMeta = { [ZERO]: null }; // address -> {symbol, decimals}

const $ = (id) => document.getElementById(id);
const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const chain = () => CHAINS[S.chainId];

function fmtWhen(ts) {
  return new Date(Number(ts) * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtCountdown(ts) {
  const d = Number(ts) - Math.floor(Date.now() / 1000);
  const days = Math.floor(Math.abs(d) / 86400);
  const hrs = Math.floor((Math.abs(d) % 86400) / 3600);
  const span = days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

async function meta(token) {
  if (token === ZERO) return { symbol: chain().coin, decimals: 18 };
  if (tokenMeta[token]) return tokenMeta[token];
  const c = new ethers.Contract(token, ERC20_ABI, S.provider);
  const m = { symbol: await c.symbol(), decimals: Number(await c.decimals()) };
  tokenMeta[token] = m;
  return m;
}
async function fmtAmount(token, wei) {
  const m = await meta(token);
  return `${ethers.formatUnits(wei, m.decimals)} ${m.symbol}`;
}

function txLink(hash) {
  return `<a href="${chain().explorer}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`;
}
async function runTx(logEl, label, fn) {
  try {
    logEl.textContent = `${label}: confirm in wallet…`;
    const tx = await fn();
    logEl.innerHTML = `${label}: sent ${txLink(tx.hash)} — waiting…`;
    await tx.wait();
    logEl.innerHTML = `${label}: confirmed ${txLink(tx.hash)}`;
    await refreshMine();
    return true;
  } catch (e) {
    const msg = e?.reason || e?.shortMessage || e?.message || String(e);
    logEl.textContent = `${label} failed: ${msg}`;
    return false;
  }
}

/* ---------------- connection ---------------- */

async function connect() {
  if (!window.ethereum) {
    $("walletBanner").hidden = false;
    $("walletBanner").textContent =
      "No wallet detected. Install MetaMask (or any EIP-1193 wallet), then reload this page.";
    return;
  }
  S.provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await S.provider.send("eth_requestAccounts", []);
  S.account = ethers.getAddress(accounts[0]);
  S.chainId = Number((await S.provider.getNetwork()).chainId);
  S.signer = await S.provider.getSigner();

  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());

  $("connectBtn").textContent = short(S.account);
  const c = chain();
  if (!c) {
    $("netPill").className = "pill bad";
    $("netPill").textContent = "unsupported network";
    $("deployBanner").hidden = false;
    $("deployBanner").innerHTML =
      `This network isn't supported. Switch to: ` +
      Object.entries(CHAINS).map(([id, cc]) =>
        `<button class="btn small ghost" onclick="switchChain(${id})">${cc.name}</button>`).join(" ");
    return;
  }
  $("netPill").className = c.testnet ? "pill warn" : "pill ok";
  $("netPill").textContent = c.name;

  if (!c.contract) {
    $("deployBanner").hidden = false;
    $("deployBanner").textContent =
      `Will & Key isn't deployed on ${c.name} yet. This build ships ahead of the audited deployment — check back soon.`;
    return;
  }
  S.contract = new ethers.Contract(c.contract, VAULT_ABI, S.signer);
  await refreshMine();
}

async function switchChain(id) {
  const c = CHAINS[id];
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.hex }] });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: c.hex, chainName: c.name, rpcUrls: [c.rpc],
          nativeCurrency: { name: c.coin, symbol: c.coin, decimals: 18 },
          blockExplorerUrls: [c.explorer] }],
      });
    }
  }
}
window.switchChain = switchChain;

/* ---------------- my vaults ---------------- */

function warningLine(w) {
  const bits = [];
  if (w & 1) bits.push("timer expired — check in or your heir can claim");
  if (w & 2) bits.push("horizon reached — check-ins no longer work; extend the horizon to continue");
  if (w & 4) bits.push("a claim is pending");
  if (w & 8) bits.push("paper check-in chain exhausted");
  return bits;
}

async function vaultCard(v, role) {
  const id = Number(v.vaultId);
  const amount = await fmtAmount(v.token, v.balance);
  const state = STATES[Number(v.state)] ?? "?";
  const pillClass = Number(v.state) === 1 ? (v.expired ? "warn" : "ok") : "warn";
  const warn = warningLine(Number(v.warnings));
  const late = v.expired ? "late" : "";

  let actions = "";
  if (role === "owner") {
    actions = `
      <button class="btn small primary" onclick="actCheckIn(${id})">Check in</button>
      <button class="btn small ghost" onclick="actTopUp(${id})">Top up</button>
      <button class="btn small ghost" onclick="actWithdraw(${id})">Withdraw</button>
      <button class="btn small ghost" onclick="actHeir(${id})">Change heir</button>
      <button class="btn small ghost" onclick="actHorizon(${id})">Extend horizon</button>
      ${Number(v.state) === 2 ? `<button class="btn small danger" onclick="actAbort(${id})">Veto claim</button>` : ""}`;
  } else {
    const canInit = Number(v.state) === 1 && v.expired;
    const canFinal = v.finalizable;
    actions = `
      ${canInit ? `<button class="btn small primary" onclick="actClaim('${v.owner}', ${id})">Initiate claim</button>` : ""}
      ${Number(v.state) === 2 && !canFinal ? `<span class="pill warn">veto window until ${fmtWhen(v.finalizableAt)}</span>` : ""}
      ${canFinal ? `<button class="btn small primary" onclick="actFinalize('${v.owner}', ${id})">Finalize inheritance</button>` : ""}`;
  }

  return `<div class="vault-card">
    <div class="top">
      <span class="amount">${amount}</span>
      <span class="pill ${pillClass}">${state}</span>
    </div>
    <div class="meta">
      <div>Vault #${id} · owner ${short(v.owner)} · heir ${short(v.beneficiary)}</div>
      <div>Next deadline: <span class="countdown ${late}">${fmtCountdown(v.deadline)}</span>
        (${fmtWhen(v.deadline)}) · check-in period ${Number(v.inactivityPeriod) / 86400} days</div>
      <div>Guaranteed inheritance by ${fmtWhen(v.guaranteedInheritanceAt)} ·
        veto window ${Number(v.challengeWindow) / 86400} days · fee ${Number(v.feeBps) / 100}%</div>
      ${warn.map((w) => `<div style="color:var(--red)">⚠ ${w}</div>`).join("")}
    </div>
    <div class="actions">${actions}</div>
    <div class="txlog" id="log-${role}-${id}"></div>
  </div>`;
}

async function refreshMine() {
  if (!S.contract) return;
  const vaults = await S.contract.getOpenVaults(S.account);
  $("mineEmpty").hidden = vaults.length > 0;
  $("checkAllBtn").hidden = vaults.length < 2;
  if (vaults.length === 0) {
    $("mineEmpty").innerHTML = "<p>No vaults yet. Create your first one — it takes a minute.</p>";
    $("vaultList").innerHTML = "";
    return;
  }
  const cards = [];
  for (const v of vaults) cards.push(await vaultCard(v, "owner"));
  $("vaultList").innerHTML = cards.join("");
}

const ownerLog = (id) => $(`log-owner-${id}`);

window.actCheckIn = (id) => runTx(ownerLog(id), "Check-in", () => S.contract.checkIn(id));
window.actAbort = (id) => runTx(ownerLog(id), "Veto", () => S.contract.abortClaim(id));

window.actTopUp = async (id) => {
  const v = await S.contract.getVault(S.account, id);
  const m = await meta(v.token);
  const amt = prompt(`Top up amount (${m.symbol}):`);
  if (!amt) return;
  const wei = ethers.parseUnits(amt, m.decimals);
  if (v.token !== ZERO) { if (!(await ensureAllowance(v.token, wei, ownerLog(id)))) return; }
  runTx(ownerLog(id), "Top-up", () =>
    S.contract.topUp(S.account, id, wei, { value: v.token === ZERO ? wei : 0n }));
};

window.actWithdraw = async (id) => {
  const v = await S.contract.getVault(S.account, id);
  const m = await meta(v.token);
  const amt = prompt(`Withdraw amount (${m.symbol}). Your current balance: ${ethers.formatUnits(v.balance, m.decimals)}`);
  if (!amt) return;
  runTx(ownerLog(id), "Withdraw", () =>
    S.contract.withdraw(id, ethers.parseUnits(amt, m.decimals), S.account));
};

window.actHeir = (id) => {
  const a = prompt("New heir's wallet address:");
  if (!a) return;
  runTx(ownerLog(id), "Change heir", () => S.contract.setBeneficiary(id, ethers.getAddress(a.trim())));
};

window.actHorizon = (id) => {
  const d = prompt("New horizon date (YYYY-MM-DD):");
  if (!d) return;
  const ts = Math.floor(Date.parse(d + "T00:00:00Z") / 1000);
  if (!ts || Number.isNaN(ts)) { ownerLog(id).textContent = "Unreadable date."; return; }
  runTx(ownerLog(id), "Extend horizon", () => S.contract.extendHorizon(id, ts));
};

$("checkAllBtn").addEventListener("click", async () => {
  const ids = await S.contract.openVaultIds(S.account);
  const log = $("vaultList").querySelector(".txlog") || $("createLog");
  runTx(log, "Check-in (all vaults)", () => S.contract.checkInMany([...ids]));
});

/* ---------------- create ---------------- */

$("cAsset").addEventListener("change", () => {
  $("cTokenWrap").hidden = $("cAsset").value !== "erc20";
});

async function ensureAllowance(token, wei, logEl) {
  const t = new ethers.Contract(token, ERC20_ABI, S.signer);
  const have = await t.allowance(S.account, chain().contract);
  if (have >= wei) return true;
  return runTx(logEl, "Approve token", () => t.approve(chain().contract, wei));
}

$("createBtn").addEventListener("click", async () => {
  const log = $("createLog");
  if (!S.contract) { log.textContent = "Connect a wallet on a deployed network first."; return; }
  try {
    const isNative = $("cAsset").value === "native";
    const token = isNative ? ZERO : ethers.getAddress($("cToken").value.trim());
    const m = await meta(token);
    const wei = ethers.parseUnits($("cAmount").value.trim(), m.decimals);
    const heir = ethers.getAddress($("cHeir").value.trim());
    const period = BigInt($("cPeriod").value) * DAY;
    const win = BigInt($("cWindow").value) * DAY;
    const horizon = BigInt(Math.floor(Date.parse($("cHorizon").value + "T00:00:00Z") / 1000));
    if (!isNative) { if (!(await ensureAllowance(token, wei, log))) return; }
    await runTx(log, "Create vault", () =>
      S.contract.createVault(token, wei, heir, period, win, horizon, { value: isNative ? wei : 0n }));
  } catch (e) {
    log.textContent = `Could not create: ${e?.reason || e?.shortMessage || e?.message || e}`;
  }
});

/* ---------------- heir ---------------- */

$("hLookupBtn").addEventListener("click", async () => {
  const out = $("heirList");
  if (!S.contract) { out.innerHTML = `<div class="banner warn">Connect a wallet on a deployed network first.</div>`; return; }
  try {
    const owner = ethers.getAddress($("hOwner").value.trim());
    const vaults = await S.contract.getOpenVaults(owner);
    const mine = vaults.filter((v) => v.beneficiary.toLowerCase() === S.account.toLowerCase());
    if (mine.length === 0) {
      out.innerHTML = `<div class="banner warn">No open vaults at that address name your wallet as heir.</div>`;
      return;
    }
    const cards = [];
    for (const v of mine) cards.push(await vaultCard(v, "heir"));
    out.innerHTML = cards.join("");
  } catch (e) {
    out.innerHTML = `<div class="banner bad">Lookup failed: ${e?.reason || e?.message || e}</div>`;
  }
});

const heirLog = (id) => $(`log-heir-${id}`);

window.actClaim = (owner, id) => {
  const to = prompt("Payout address (default: your connected wallet). A fresh address is fine:", S.account);
  if (!to) return;
  runTx(heirLog(id), "Initiate claim", () =>
    S.contract.initiateClaim(owner, id, ethers.getAddress(to.trim())))
    .then(() => $("hLookupBtn").click());
};
window.actFinalize = (owner, id) => {
  runTx(heirLog(id), "Finalize", () => S.contract.finalizeClaim(owner, id))
    .then(() => $("hLookupBtn").click());
};

/* ---------------- credits ---------------- */

$("crCheckBtn").addEventListener("click", async () => {
  const log = $("crLog");
  if (!S.contract) { log.textContent = "Connect a wallet on a deployed network first."; return; }
  try {
    const raw = $("crToken").value.trim();
    const token = raw ? ethers.getAddress(raw) : ZERO;
    const owed = await S.contract.creditOf(token, S.account);
    log.textContent = `Owed to you: ${await fmtAmount(token, owed)}`;
    $("crPullBtn").hidden = owed === 0n;
    $("crPullBtn").onclick = () =>
      runTx(log, "Withdraw payout", () => S.contract.withdrawCredit(token, S.account));
  } catch (e) {
    log.textContent = `Check failed: ${e?.reason || e?.message || e}`;
  }
});

/* ---------------- reminders (crypto-paid subscription) ---------------- */

async function refreshSub() {
  const status = $("subStatus"), log = $("subLog");
  status.hidden = false;
  if (!S.account || !chain()) { status.textContent = "Connect a wallet first."; return null; }
  if (!chain().notify) {
    status.textContent = `The reminder service isn't live on ${chain().name} yet — it launches with the audited deployment.`;
    return null;
  }
  const sub = new ethers.Contract(chain().notify, SUB_ABI, S.signer);
  const [price, until] = await Promise.all([sub.pricePerMonth(), sub.paidUntil(S.account)]);
  const active = Number(until) * 1000 > Date.now();
  status.className = active ? "banner warn" : "banner bad";
  // The address is named in BOTH branches, deliberately. Subscriptions are keyed by address and
  // can never be moved, so a green "active" banner that doesn't say WHICH wallet is how someone
  // pays for a year of reminders on the wrong account and never finds out.
  status.textContent = (active
    ? `Reminders active until ${new Date(Number(until) * 1000).toLocaleDateString()} for ${short(S.account)}. `
    : `No active subscription for ${short(S.account)}. `) +
    `Price: ${ethers.formatEther(price)} ${chain().coin}/month. ` +
    `This must be the wallet that OWNS your vaults — reminders follow the vault owner's address.`;
  return { sub, price };
}

$("subBtn").addEventListener("click", async () => {
  const log = $("subLog");
  const r = await refreshSub();
  if (!r) return;
  const months = BigInt($("subMonths").value || "0");
  if (months < 1n) { log.textContent = "Enter at least one month."; return; }

  // Warn if this wallet owns no vaults: paying from the wrong account is unrecoverable.
  try {
    const owned = await S.contract.openVaultIds(S.account);
    if (owned.length === 0 &&
        !confirm(`${short(S.account)} owns no vaults on ${chain().name}.\n\n` +
                 `Subscriptions are tied to an address permanently and cannot be moved or ` +
                 `refunded. Pay from this wallet anyway?`)) return;
  } catch { /* vault contract not deployed here; fall through */ }

  const value = r.price * months;
  // Slippage floor at 99% of the quote: if the price moves between this read and the mined
  // transaction, revert rather than silently deliver less time than we just displayed.
  const minSeconds = ((value * MONTH_SECS) / r.price) * 99n / 100n;
  await runTx(log, `Subscribe ${months} month(s)`, () => r.sub.subscribe(S.account, minSeconds, { value }));
  await refreshSub();
});

/* ---------------- tabs & boot ---------------- */

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab-pane").forEach((p) => (p.hidden = true));
  $(`tab-${b.dataset.tab}`).hidden = false;
  if (b.dataset.tab === "remind") refreshSub().catch(() => {});
});

$("connectBtn").addEventListener("click", (e) => { e.preventDefault(); connect(); });

// Sensible default horizon: 20 years out.
(() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 20);
  $("cHorizon").value = d.toISOString().slice(0, 10);
})();

if (window.ethereum?.selectedAddress) connect();
