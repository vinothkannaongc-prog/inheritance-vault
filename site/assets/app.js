/* Will & Key app. Plain JS + self-hosted ethers v6 UMD. No build step. */

"use strict";

const CHAINS = {
  84532: {
    name: "Base Sepolia", contract: "", explorer: "https://sepolia.basescan.org",
    hex: "0x14a34", rpc: "https://sepolia.base.org", coin: "ETH", testnet: true,
  },
  8453: {
    name: "Base",
    contract: "0xC821849A1D74959753450409b594b23eCE7fEe2f",
    explorer: "https://basescan.org",
    hex: "0x2105", rpc: "https://mainnet.base.org", coin: "ETH", testnet: false,
  },
  97: {
    name: "BNB Testnet", contract: "", explorer: "https://testnet.bscscan.com",
    hex: "0x61", rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", coin: "tBNB", testnet: true,
  },
  56: {
    name: "BNB Chain", contract: "", explorer: "https://bscscan.com",
    hex: "0x38", rpc: "https://bsc-dataseed.bnbchain.org", coin: "BNB", testnet: false,
  },
};

const ZERO = "0x0000000000000000000000000000000000000000";
const STATES = ["-", "Active", "Claim pending", "Settled", "Closed"];
const DAY = 86400n;
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const S = { provider: null, signer: null, account: null, chainId: null, contract: null };
const tokenMeta = { [ZERO]: null };

const $ = (id) => document.getElementById(id);
const chain = () => CHAINS[S.chainId];
const short = (address) => address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

function element(tag, className, text) {
  const out = document.createElement(tag);
  if (className) out.className = className;
  if (text !== undefined) out.textContent = String(text);
  return out;
}

function button(label, className, handler) {
  const out = element("button", className, label);
  out.type = "button";
  out.addEventListener("click", handler);
  return out;
}

function notice(container, tone, message) {
  const out = element("div", `banner ${tone}`, message);
  container.replaceChildren(out);
  return out;
}

function fmtWhen(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function fmtCountdown(timestamp) {
  const delta = Number(timestamp) - Math.floor(Date.now() / 1000);
  const days = Math.floor(Math.abs(delta) / 86400);
  const hours = Math.floor((Math.abs(delta) % 86400) / 3600);
  const span = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

async function meta(token) {
  if (token === ZERO) return { symbol: chain().coin, decimals: 18 };
  if (tokenMeta[token]) return tokenMeta[token];
  const contract = new ethers.Contract(token, ERC20_ABI, S.provider);
  const result = { symbol: await contract.symbol(), decimals: Number(await contract.decimals()) };
  tokenMeta[token] = result;
  return result;
}

async function fmtAmount(token, amount) {
  const tokenInfo = await meta(token);
  return `${ethers.formatUnits(amount, tokenInfo.decimals)} ${tokenInfo.symbol}`;
}

function renderTx(logElement, label, state, hash) {
  logElement.replaceChildren(document.createTextNode(`${label}: ${state}`));
  if (!hash) return;
  logElement.append(document.createTextNode(" "));
  const link = element("a", "", short(hash));
  link.href = `${chain().explorer}/tx/${hash}`;
  link.target = "_blank";
  link.rel = "noopener";
  logElement.append(link);
}

async function runTx(logElement, label, send) {
  try {
    renderTx(logElement, label, "confirm in wallet...");
    const transaction = await send();
    renderTx(logElement, label, "sent", transaction.hash);
    logElement.append(document.createTextNode(" - waiting..."));
    await transaction.wait();
    renderTx(logElement, label, "confirmed", transaction.hash);
    await refreshMine();
    return true;
  } catch (error) {
    const message = error?.reason || error?.shortMessage || error?.message || String(error);
    logElement.textContent = `${label} failed: ${message}`;
    return false;
  }
}

async function connect() {
  if (!window.ethereum) {
    $("walletBanner").hidden = false;
    $("walletBanner").textContent =
      "No wallet detected. Install MetaMask or another EIP-1193 wallet, then reload this page.";
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
  const currentChain = chain();
  if (!currentChain) {
    $("netPill").className = "pill bad";
    $("netPill").textContent = "unsupported network";
    const banner = $("deployBanner");
    banner.hidden = false;
    banner.replaceChildren(document.createTextNode("This network is not supported. Switch to: "));
    for (const [id, configuredChain] of Object.entries(CHAINS)) {
      banner.append(button(configuredChain.name, "btn small ghost", () => switchChain(Number(id))));
    }
    return;
  }

  $("netPill").className = currentChain.testnet ? "pill warn" : "pill ok";
  $("netPill").textContent = currentChain.name;
  if (!currentChain.contract) {
    $("deployBanner").hidden = false;
    $("deployBanner").textContent = `Will & Key is not deployed on ${currentChain.name}.`;
    return;
  }

  S.contract = new ethers.Contract(currentChain.contract, VAULT_ABI, S.signer);
  await refreshMine();
}

async function switchChain(id) {
  const configuredChain = CHAINS[id];
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain", params: [{ chainId: configuredChain.hex }],
    });
  } catch (error) {
    if (error.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: configuredChain.hex,
          chainName: configuredChain.name,
          rpcUrls: [configuredChain.rpc],
          nativeCurrency: { name: configuredChain.coin, symbol: configuredChain.coin, decimals: 18 },
          blockExplorerUrls: [configuredChain.explorer],
        }],
      });
    }
  }
}

function warningLines(warnings) {
  const lines = [];
  if (warnings & 1) lines.push("timer expired - check in or your heir can claim");
  if (warnings & 2) lines.push("horizon reached - check-ins no longer work; extend the horizon to continue");
  if (warnings & 4) lines.push("a claim is pending");
  if (warnings & 8) lines.push("paper check-in chain exhausted");
  return lines;
}

function ownerLog(id) { return $(`log-owner-${id}`); }
function heirLog(id) { return $(`log-heir-${id}`); }

async function actCheckIn(id) {
  return runTx(ownerLog(id), "Check-in", () => S.contract.checkIn(id));
}

async function actAbort(id) {
  return runTx(ownerLog(id), "Veto", () => S.contract.abortClaim(id));
}

async function actTopUp(id) {
  const vault = await S.contract.getVault(S.account, id);
  const tokenInfo = await meta(vault.token);
  const amount = prompt(`Top up amount (${tokenInfo.symbol}):`);
  if (!amount) return;
  const units = ethers.parseUnits(amount, tokenInfo.decimals);
  if (vault.token !== ZERO && !(await ensureAllowance(vault.token, units, ownerLog(id)))) return;
  await runTx(ownerLog(id), "Top-up", () =>
    S.contract.topUp(S.account, id, units, { value: vault.token === ZERO ? units : 0n }));
}

async function actWithdraw(id) {
  const vault = await S.contract.getVault(S.account, id);
  const tokenInfo = await meta(vault.token);
  const amount = prompt(
    `Withdraw amount (${tokenInfo.symbol}). Current balance: ${ethers.formatUnits(vault.balance, tokenInfo.decimals)}`,
  );
  if (!amount) return;
  await runTx(ownerLog(id), "Withdraw", () =>
    S.contract.withdraw(id, ethers.parseUnits(amount, tokenInfo.decimals), S.account));
}

async function actHeir(id) {
  const address = prompt("New heir's wallet address:");
  if (!address) return;
  await runTx(ownerLog(id), "Change heir", () =>
    S.contract.setBeneficiary(id, ethers.getAddress(address.trim())));
}

async function actHorizon(id) {
  const date = prompt("New horizon date (YYYY-MM-DD):");
  if (!date) return;
  const timestamp = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  if (!timestamp || Number.isNaN(timestamp)) {
    ownerLog(id).textContent = "Unreadable date.";
    return;
  }
  await runTx(ownerLog(id), "Extend horizon", () => S.contract.extendHorizon(id, timestamp));
}

async function actClaim(owner, id) {
  const destination = prompt("Payout address (default: your connected wallet):", S.account);
  if (!destination) return;
  await runTx(heirLog(id), "Initiate claim", () =>
    S.contract.initiateClaim(owner, id, ethers.getAddress(destination.trim())));
  $("hLookupBtn").click();
}

async function actFinalize(owner, id) {
  await runTx(heirLog(id), "Finalize", () => S.contract.finalizeClaim(owner, id));
  $("hLookupBtn").click();
}

async function vaultCard(vault, role) {
  const id = Number(vault.vaultId);
  const card = element("div", "vault-card");
  const top = element("div", "top");
  top.append(
    element("span", "amount", await fmtAmount(vault.token, vault.balance)),
    element(
      "span",
      `pill ${Number(vault.state) === 1 ? (vault.expired ? "warn" : "ok") : "warn"}`,
      STATES[Number(vault.state)] ?? "?",
    ),
  );
  card.append(top);

  const metaBox = element("div", "meta");
  metaBox.append(element(
    "div", "", `Vault #${id} - owner ${short(vault.owner)} - heir ${short(vault.beneficiary)}`,
  ));

  const deadline = element("div");
  deadline.append(document.createTextNode("Next deadline: "));
  deadline.append(element("span", `countdown ${vault.expired ? "late" : ""}`, fmtCountdown(vault.deadline)));
  deadline.append(document.createTextNode(
    ` (${fmtWhen(vault.deadline)}) - check-in period ${Number(vault.inactivityPeriod) / 86400} days`,
  ));
  metaBox.append(deadline);
  metaBox.append(element(
    "div", "",
    `Guaranteed inheritance by ${fmtWhen(vault.guaranteedInheritanceAt)} - veto window ` +
    `${Number(vault.challengeWindow) / 86400} days - fee ${Number(vault.feeBps) / 100}%`,
  ));
  for (const warning of warningLines(Number(vault.warnings))) {
    metaBox.append(element("div", "warning-text", `Warning: ${warning}`));
  }
  card.append(metaBox);

  const actions = element("div", "actions");
  if (role === "owner") {
    actions.append(button("Check in", "btn small primary", () => actCheckIn(id)));
    actions.append(button("Top up", "btn small ghost", () => actTopUp(id)));
    actions.append(button("Withdraw", "btn small ghost", () => actWithdraw(id)));
    actions.append(button("Change heir", "btn small ghost", () => actHeir(id)));
    actions.append(button("Extend horizon", "btn small ghost", () => actHorizon(id)));
    if (Number(vault.state) === 2) {
      actions.append(button("Veto claim", "btn small danger", () => actAbort(id)));
    }
  } else {
    if (Number(vault.state) === 1 && vault.expired) {
      actions.append(button("Initiate claim", "btn small primary", () => actClaim(vault.owner, id)));
    }
    if (Number(vault.state) === 2 && !vault.finalizable) {
      actions.append(element("span", "pill warn", `veto window until ${fmtWhen(vault.finalizableAt)}`));
    }
    if (vault.finalizable) {
      actions.append(button("Finalize inheritance", "btn small primary", () => actFinalize(vault.owner, id)));
    }
  }
  card.append(actions);

  const log = element("div", "txlog");
  log.id = `log-${role}-${id}`;
  card.append(log);
  return card;
}

async function refreshMine() {
  if (!S.contract) return;
  const vaults = await S.contract.getOpenVaults(S.account);
  $("mineEmpty").hidden = vaults.length > 0;
  $("checkAllBtn").hidden = vaults.length < 2;
  if (vaults.length === 0) {
    $("mineEmpty").replaceChildren(element("p", "", "No vaults yet. Create your first one - it takes a minute."));
    $("vaultList").replaceChildren();
    return;
  }
  const cards = [];
  for (const vault of vaults) cards.push(await vaultCard(vault, "owner"));
  $("vaultList").replaceChildren(...cards);
}

$("checkAllBtn").addEventListener("click", async () => {
  const ids = await S.contract.openVaultIds(S.account);
  const log = $("vaultList").querySelector(".txlog") || $("createLog");
  await runTx(log, "Check-in (all vaults)", () => S.contract.checkInMany([...ids]));
});

$("cAsset").addEventListener("change", () => {
  $("cTokenWrap").hidden = $("cAsset").value !== "erc20";
});

async function ensureAllowance(token, amount, logElement) {
  const tokenContract = new ethers.Contract(token, ERC20_ABI, S.signer);
  const allowance = await tokenContract.allowance(S.account, chain().contract);
  if (allowance >= amount) return true;
  return runTx(logElement, "Approve token", () => tokenContract.approve(chain().contract, amount));
}

$("createBtn").addEventListener("click", async () => {
  const log = $("createLog");
  if (!S.contract) {
    log.textContent = "Connect a wallet on a deployed network first.";
    return;
  }
  try {
    const isNative = $("cAsset").value === "native";
    const token = isNative ? ZERO : ethers.getAddress($("cToken").value.trim());
    const tokenInfo = await meta(token);
    const amount = ethers.parseUnits($("cAmount").value.trim(), tokenInfo.decimals);
    const heir = ethers.getAddress($("cHeir").value.trim());
    const period = BigInt($("cPeriod").value) * DAY;
    const challengeWindow = BigInt($("cWindow").value) * DAY;
    const horizon = BigInt(Math.floor(Date.parse(`${$("cHorizon").value}T00:00:00Z`) / 1000));
    if (!isNative && !(await ensureAllowance(token, amount, log))) return;
    await runTx(log, "Create vault", () => S.contract.createVault(
      token, amount, heir, period, challengeWindow, horizon, { value: isNative ? amount : 0n },
    ));
  } catch (error) {
    log.textContent = `Could not create: ${error?.reason || error?.shortMessage || error?.message || error}`;
  }
});

$("hLookupBtn").addEventListener("click", async () => {
  const out = $("heirList");
  if (!S.contract) {
    notice(out, "warn", "Connect a wallet on a deployed network first.");
    return;
  }
  try {
    const owner = ethers.getAddress($("hOwner").value.trim());
    const vaults = await S.contract.getOpenVaults(owner);
    const mine = vaults.filter(
      (vault) => vault.beneficiary.toLowerCase() === S.account.toLowerCase(),
    );
    if (mine.length === 0) {
      notice(out, "warn", "No open vaults at that address name your wallet as heir.");
      return;
    }
    const cards = [];
    for (const vault of mine) cards.push(await vaultCard(vault, "heir"));
    out.replaceChildren(...cards);
  } catch (error) {
    notice(out, "bad", `Lookup failed: ${error?.reason || error?.message || error}`);
  }
});

$("crCheckBtn").addEventListener("click", async () => {
  const log = $("crLog");
  if (!S.contract) {
    log.textContent = "Connect a wallet on a deployed network first.";
    return;
  }
  try {
    const raw = $("crToken").value.trim();
    const token = raw ? ethers.getAddress(raw) : ZERO;
    const owed = await S.contract.creditOf(token, S.account);
    log.textContent = `Owed to you: ${await fmtAmount(token, owed)}`;
    $("crPullBtn").hidden = owed === 0n;
    $("crPullBtn").onclick = () =>
      runTx(log, "Withdraw payout", () => S.contract.withdrawCredit(token, S.account));
  } catch (error) {
    log.textContent = `Check failed: ${error?.reason || error?.message || error}`;
  }
});

$("tabs").addEventListener("click", (event) => {
  const selected = event.target.closest("button");
  if (!selected) return;
  document.querySelectorAll("#tabs button").forEach(
    (candidate) => candidate.classList.toggle("active", candidate === selected),
  );
  document.querySelectorAll(".tab-pane").forEach((pane) => { pane.hidden = true; });
  $(`tab-${selected.dataset.tab}`).hidden = false;
});

$("connectBtn").addEventListener("click", (event) => {
  event.preventDefault();
  connect();
});

(() => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 20);
  $("cHorizon").value = date.toISOString().slice(0, 10);
})();

if (window.ethereum?.selectedAddress) connect();
