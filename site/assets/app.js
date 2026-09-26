/* Will & Key app. Plain JS + self-hosted ethers v6 UMD. No build step. */

"use strict";

// `tokens` is the per-chain list of known plain, single-address ERC-20s. Every address below was
// checked read-only on chain on 2026-09-26 (code present, symbol() and decimals() as listed). Any
// other token needs an explicit acknowledgement before a vault is created with it.
// `wrappedNative` and every listed token are refused as payout destinations and as heirs: a token
// contract can never call initiateClaim or withdrawCredit, and coin pushed to a wrap-on-receive
// contract comes back to the vault as surplus that only the admin can move.
const CHAINS = {
  84532: {
    name: "Base Sepolia", contract: "", explorer: "https://sepolia.basescan.org",
    hex: "0x14a34", rpc: "https://sepolia.base.org", coin: "ETH", testnet: true,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    tokens: [],
  },
  8453: {
    name: "Base",
    contract: "0xC821849A1D74959753450409b594b23eCE7fEe2f",
    explorer: "https://basescan.org",
    hex: "0x2105", rpc: "https://mainnet.base.org", coin: "ETH", testnet: false,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    // The heir search (F44) reads the v1 contract's logs from its first block (creation tx
    // 0x3e74385e...a6759f3, block 49,728,661). `logCanary` is a block holding one of its
    // VaultCreated events: a connection that returns nothing there does not serve logs that old,
    // so its empty answers are not trusted. `logSpan` is the public endpoint's eth_getLogs limit.
    logsFrom: 49728661, logCanary: 49730575, logSpan: 2000,
    tokens: [
      { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      { symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0x4200000000000000000000000000000000000006" },
      { symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
      { symbol: "EURC", name: "EURC", decimals: 6, address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
    ],
  },
  97: {
    name: "BNB Testnet", contract: "", explorer: "https://testnet.bscscan.com",
    hex: "0x61", rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", coin: "tBNB", testnet: true,
    wrappedNative: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    tokens: [],
  },
  56: {
    name: "BNB Chain", contract: "", explorer: "https://bscscan.com",
    hex: "0x38", rpc: "https://bsc-dataseed.bnbchain.org", coin: "BNB", testnet: false,
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    tokens: [
      { symbol: "USDT", name: "Tether USD (Binance-Peg)", decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955" },
      { symbol: "USDC", name: "USD Coin (Binance-Peg)", decimals: 18, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
      { symbol: "WBNB", name: "Wrapped BNB", decimals: 18, address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
      { symbol: "BTCB", name: "BTCB Token (Binance-Peg BTC)", decimals: 18, address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
      { symbol: "ETH", name: "Ethereum Token (Binance-Peg)", decimals: 18, address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
    ],
  },
};

const ZERO = "0x0000000000000000000000000000000000000000";
const STATES = ["-", "Active", "Claim pending", "Settled", "Closed"];
const DAY = 86400n;
const MAX_HORIZON_DAYS = 36500;
// Slack for the time between review and mining: the contract checks the horizon floor against the
// block timestamp, so a date that only just clears it at review time could revert when mined.
const HORIZON_MARGIN = 3600;
// Address poisoners match the first and last few hex characters of an address the victim already
// uses. Four is the strictest useful width: an innocent collision on either end is 1 in 32,768.
const LOOKALIKE_HEX = 4;
const TEN_YEARS = 3653 * 86400;
// Heir search (F44). Measured on https://mainnet.base.org on 2026-09-26: eth_getLogs refuses more
// than 2,000 blocks (-32614), a range past its head (-32602), and more than 10 calls per batch;
// after a burst of about 25 calls it answers HTTP 429 / -32016 "over rate limit", while one call
// at a time ran the whole 1,040-chunk history clean in about 5.5 minutes. So the search sends one
// call at a time, backs off on a rate limit, and shrinks the range when a connection refuses one.
const MIN_LOG_SPAN = 2000;
const WALLET_LOG_SPAN = 1000000;
const LOG_CALL_TIMEOUT = 30000;
const RATE_WAITS = [1000, 2000, 4000, 8000, 16000];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const S = {
  provider: null, signer: null, account: null, chainId: null, contract: null,
  fee: null, heirs: [],
  // What the heir tab shows: { owner } after a lookup by owner, { found: true } after a search.
  heirView: null,
  // The heir search's progress for this page load: { next, candidates, summary, running, stop }.
  heirScan: null,
};
const tokenMeta = { [ZERO]: null };

const $ = (id) => document.getElementById(id);
const chain = () => CHAINS[S.chainId];
const short = (address) => address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
const same = (a, b) => Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
const pct = (bps) => `${Number(bps) / 100}%`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Plain-language help for the reverts an owner or heir meets when a vault's state has moved on
// (F03, F19, F43). ethers decodes the contract's custom errors into error.revert.
const REVERT_HELP = {
  ClaimPendingUseAbort: "A claim is pending on this vault, and a check-in does not cancel it. Use Veto.",
  HorizonReached: "This vault is past its horizon, so this action no longer works. Only extending the horizon or withdrawing everything still does.",
  HorizonTooSoon: "That horizon is too soon: when mined it must be at least one full check-in period from then.",
  NoClaimPending: "No claim is pending on this vault any more.",
  VaultNotActive: "The vault is not active: a claim is pending on it, or it has settled or closed.",
  NothingCheckedIn: "None of the vaults sent could be checked in.",
  ChallengeWindowOpen: "The challenge window is still open, so the claim cannot be finalized yet.",
  NotYetExpired: "The owner's deadline has not passed, so a claim cannot start yet.",
};

function errorText(error) {
  const name = error?.revert?.name;
  if (name && REVERT_HELP[name]) return `${REVERT_HELP[name]} (${name})`;
  // ethers reports any failed eth_call as "missing revert data" and an error it does not recognise
  // as "could not coalesce error"; the connection's own message (a rate limit, say) is inside.
  const inner = error?.info?.error?.message || error?.error?.message;
  const wrapped = error?.code === "UNKNOWN_ERROR" || (error?.code === "CALL_EXCEPTION" && error?.data == null && !error?.revert);
  if (inner && wrapped) return `the network connection returned an error: ${cleanText(inner, 200)}`;
  return error?.reason || error?.shortMessage || error?.message || String(error);
}

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

// Local date and time with the zone, for the moments an owner or heir must act by.
function fmtLocal(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

// `now` is chain time where the caller has it; the device clock can be wrong.
function fmtCountdown(timestamp, now) {
  const delta = Number(timestamp) - (now ?? Math.floor(Date.now() / 1000));
  const days = Math.floor(Math.abs(delta) / 86400);
  const hours = Math.floor((Math.abs(delta) % 86400) / 3600);
  const span = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

// Horizon dates are typed and shown in UTC, so what the owner reads is exactly what is signed.
function fmtUtc(timestamp) {
  return `${new Date(Number(timestamp) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function utcDay(timestamp) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

// The first UTC midnight at or after `timestamp`, as YYYY-MM-DD.
function utcDayCeil(timestamp) {
  return utcDay(Math.ceil(Number(timestamp) / 86400) * 86400);
}

// The earliest horizon extendHorizon accepts if mined soon: later than the current horizon and at
// least one inactivity period after the block it is mined in, plus HORIZON_MARGIN for the wait.
// Past the horizon this is also the only date that stops a pending claim (F19, F43).
function horizonFloor(vault, now) {
  return Math.max(Number(vault.absoluteDeadline) + 1, floorNow(now) + Number(vault.inactivityPeriod) + HORIZON_MARGIN);
}

// YYYY-MM-DD -> seconds at 00:00 UTC, or null. The round trip refuses dates that Date.parse would
// silently roll over (2046-02-30 would otherwise become 2046-03-02).
function parseUtcDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) return null;
  return Math.floor(ms / 1000);
}

// "+18 years 3 days" between two timestamps, counted in UTC calendar years.
function fmtSpan(fromTs, toTs) {
  const from = new Date(Number(fromTs) * 1000);
  const to = new Date(Number(toTs) * 1000);
  const anniversary = (years) => {
    const out = new Date(from.getTime());
    out.setUTCFullYear(from.getUTCFullYear() + years);
    return out;
  };
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  if (anniversary(years) > to) years -= 1;
  const days = Math.floor((to - anniversary(years)) / 86400000);
  return `+${years} year${years === 1 ? "" : "s"} ${days} day${days === 1 ? "" : "s"}`;
}

const deviceNow = () => Math.floor(Date.now() / 1000);

// Chain time: the latest block's timestamp. State decisions and countdowns use it alone, because
// the device clock can be wrong in either direction; the device clock stands in only when no
// block can be read.
async function chainNow() {
  try {
    const block = await S.provider.getBlock("latest");
    return Number(block.timestamp);
  } catch {
    return deviceNow();
  }
}

// For floors only (the earliest date a transaction will accept when mined), the later of chain
// time and the device clock: erring late there costs a day, erring early costs a revert.
const floorNow = (now) => Math.max(Number(now), deviceNow());

// ---------------------------------------------------------------- addresses

function knownToken(address) {
  if (!chain() || !address) return null;
  return (chain().tokens || []).find((token) => same(token.address, address)) || null;
}

// Contracts that book a plain payment to msg.sender in their own ledger: coin sent there is
// credited to the vault contract, which can never withdraw it, so it is lost (v2 review round 4).
// The ERC-4337 EntryPoints v0.6-v0.9 have the same address on every chain (checked read-only on
// Base 2026-09-27); Venus vBNB mints vBNB to the sender on BNB Chain.
const CREDIT_THE_SENDER = [
  { address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", name: "the ERC-4337 EntryPoint v0.6" },
  { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", name: "the ERC-4337 EntryPoint v0.7" },
  { address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", name: "the ERC-4337 EntryPoint v0.8" },
  { address: "0x433709009B8330FDa32311DF1C2AFA402eD8D009", name: "the ERC-4337 EntryPoint v0.9" },
  { address: "0xA07c5b74C9B40447a954e1466938b865b6BBea36", name: "the Venus vBNB market", chainId: 56 },
];
// OP-stack predeploys (0x4200...0000 to 0x4200...07FF): the bridge and message-passer contracts
// there keep what they are sent, or move it to another chain on the vault's behalf.
const OP_STACK_CHAINS = new Set([8453, 84532]);

// Why an address can never be an heir or a payout destination, or null if it can.
function refusedReason(address) {
  const currentChain = chain();
  if (same(address, ZERO)) return "the zero address";
  if (currentChain?.contract && same(address, currentChain.contract)) return "the Will & Key vault contract itself";
  if (currentChain?.wrappedNative && same(address, currentChain.wrappedNative)) {
    return `the wrapped ${currentChain.coin} token contract`;
  }
  const token = knownToken(address);
  if (token) return `the ${token.symbol} token contract`;
  const sender = CREDIT_THE_SENDER.find((entry) =>
    same(address, entry.address) && (!entry.chainId || entry.chainId === Number(S.chainId)));
  if (sender) return `${sender.name}, which would credit the payment to the vault contract, where nobody can ever withdraw it`;
  if (OP_STACK_CHAINS.has(Number(S.chainId)) && /^0x4200000000000000000000000000000000000[0-7][0-9a-f]{2}$/i.test(address)) {
    return "an OP-stack system contract (0x4200...), which keeps or bridges what it is sent";
  }
  return null;
}

// The known address that `candidate` imitates (same first or last LOOKALIKE_HEX hex characters,
// different address), or null.
function lookalikeOf(candidate, known) {
  const hex = candidate.toLowerCase().slice(2);
  for (const address of known) {
    const other = address.toLowerCase().slice(2);
    if (other === hex) continue;
    if (other.slice(0, LOOKALIKE_HEX) === hex.slice(0, LOOKALIKE_HEX)
      || other.slice(-LOOKALIKE_HEX) === hex.slice(-LOOKALIKE_HEX)) return address;
  }
  return null;
}

// Parses one typed address: exactly 0x and 40 hex characters (getAddress alone would also take
// ICAP "XE..." strings and a missing 0x). getAddress rejects a wrong mixed-case checksum but accepts
// all-lower and all-upper input, which carries no checksum; that is reported so the review says so.
function parseAddress(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}: enter an address.`);
  const hex = text.slice(2);
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    throw new Error(`${label}: "${text}" is not an address. It must be 0x followed by 40 hex characters.`);
  }
  try {
    return { address: ethers.getAddress(text), unchecked: !/[a-f]/.test(hex) || !/[A-F]/.test(hex) };
  } catch {
    throw new Error(`${label}: the capital letters in "${text}" do not match its checksum, so at least one character is wrong.`);
  }
}

// Two independent entries of the same address, compared after checksum normalisation.
function readAddressPair(first, second, label) {
  const one = parseAddress(first, label);
  const two = parseAddress(second, `${label} (again)`);
  if (one.address !== two.address) {
    throw new Error(`${label}: the two entries are different addresses. Compare them character by character.`);
  }
  return { address: one.address, unchecked: one.unchecked || two.unchecked };
}

async function hasCode(address) {
  try {
    return (await S.provider.getCode(address)) !== "0x";
  } catch {
    return false;
  }
}

function explorerLink(kind, value, label) {
  const link = element("a", "addr-link", label);
  link.href = `${chain().explorer}/${kind}/${value}`;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

function copyButton(value) {
  const out = button("Copy", "addr-act", async () => {
    try {
      await navigator.clipboard.writeText(value);
      out.textContent = "Copied";
    } catch {
      out.textContent = "Copy blocked - select the address instead";
    }
    setTimeout(() => { out.textContent = "Copy"; }, 2500);
  });
  out.setAttribute("aria-label", `Copy address ${value}`);
  return out;
}

// A full checksummed address in ten groups of four, with copy and explorer actions. Never shortened:
// eight characters are exactly what an address poisoner matches. Selecting the text copies it
// without spaces, because the groups are separated by margins, not characters.
function addressBlock(address, tone) {
  const full = ethers.getAddress(address);
  const out = element("span", tone ? `addr addr-${tone}` : "addr");
  const hex = element("code", "addr-hex");
  hex.setAttribute("aria-label", full);
  hex.append(element("span", "addr-0x", "0x"));
  for (const group of full.slice(2).match(/.{4}/g)) hex.append(element("span", "addr-g", group));
  out.append(hex, copyButton(full), explorerLink("address", full, "Explorer"));
  return out;
}

function addressRow(label, address, tone) {
  const row = element("div", "addr-row");
  row.append(element("span", "addr-label", label), addressBlock(address, tone));
  return row;
}

// The distinct heirs of the connected owner's open vaults, each with the vault ids naming it.
function collectHeirs(vaults) {
  const byAddress = new Map();
  for (const vault of vaults) {
    const key = vault.beneficiary.toLowerCase();
    if (!byAddress.has(key)) byAddress.set(key, { address: ethers.getAddress(vault.beneficiary), vaultIds: [], closedIds: [] });
    byAddress.get(key).vaultIds.push(Number(vault.vaultId));
  }
  return [...byAddress.values()];
}

const vaultList = (ids) => ids.map((id) => `#${id}`).join(", ");

function heirPickerOptions(select, heirs, exclude) {
  const first = element("option", "", "Choose an existing heir...");
  first.value = "";
  const options = [first];
  for (const heir of heirs) {
    if (exclude && same(heir.address, exclude)) continue;
    const option = element(
      "option", "", `${heir.address.slice(0, 2)} ${heir.address.slice(2).match(/.{4}/g).join(" ")} (vault ${vaultList(heir.vaultIds)})`,
    );
    option.value = heir.address;
    options.push(option);
  }
  select.replaceChildren(...options);
  return options.length > 1;
}

// F41: the look-alike check compares a new heir with the heirs the owner uses, read fresh for every
// review. A list left over from an earlier read, or never loaded because that read failed, would
// let a look-alike of an existing heir through, so a review that cannot read them does not run.
// The heirs of the owner's closed and settled vaults count too, so closing a vault does not drop
// its heir from the check. The exception is a closed vault's heir that itself looks like another
// of the owner's addresses: that is the pair the app warns about, and its remedy (close the vault
// naming the wrong one, create a new vault for the confirmed one) must stay possible.
// A closed or settled vault can never change its heir, so each is read once per page load.
const closedHeirs = new Map(); // vault id -> { address, state }

async function loadKnownHeirs() {
  let vaults;
  try {
    const [open, count] = await Promise.all([S.contract.getOpenVaults(S.account), S.contract.vaultCount(S.account)]);
    vaults = open;
    const openIds = new Set(open.map((vault) => Number(vault.vaultId)));
    for (let id = 0; id < Number(count); id += 1) {
      if (openIds.has(id) || closedHeirs.has(id)) continue;
      const vault = await S.contract.getVault(S.account, id);
      const state = Number(vault.state);
      if (state === 3 || state === 4) closedHeirs.set(id, { address: ethers.getAddress(vault.beneficiary), state });
    }
  } catch (error) {
    throw new Error(
      "Your existing heirs could not be read, so the new address cannot be checked against them for " +
      `look-alikes. Nothing was reviewed; try again in a moment. (${errorText(error)})`,
    );
  }
  const heirs = collectHeirs(vaults);
  const everyAddress = [S.account, ...heirs.map((heir) => heir.address), ...[...closedHeirs.values()].map((heir) => heir.address)];
  for (const [id, closed] of closedHeirs) {
    if (lookalikeOf(closed.address, everyAddress)) continue;
    let entry = heirs.find((heir) => same(heir.address, closed.address));
    if (!entry) {
      entry = { address: closed.address, vaultIds: [], closedIds: [] };
      heirs.push(entry);
    }
    entry.closedIds.push(id);
  }
  return heirs;
}

function heirVaults(entry) {
  const parts = [];
  if (entry.vaultIds.length) parts.push(`vault ${vaultList(entry.vaultIds)}`);
  if (entry.closedIds?.length) parts.push(`vault ${vaultList(entry.closedIds)} (no longer open)`);
  return parts.join(" and your ");
}

// Every hard stop for a would-be heir. `heirs` comes from loadKnownHeirs; `extra` are further
// addresses to compare with (the vault's current heir). The owner's own wallet is always included.
function heirProblem(heir, heirs, extra = []) {
  const refused = refusedReason(heir);
  if (refused) return `That is ${refused}. It can never start a claim, so it cannot be an heir.`;
  if (same(heir, S.account)) return "That is your own connected wallet. The owner cannot be the heir.";
  const imitated = lookalikeOf(heir, [S.account, ...heirs.map((known) => known.address), ...extra]);
  if (imitated) {
    const entry = heirs.find((known) => same(known.address, imitated));
    let whose = "an heir on one of your vaults";
    if (same(imitated, S.account)) whose = "your own wallet";
    else if (entry) whose = `the heir of your ${heirVaults(entry)}`;
    return {
      imitated,
      message: `Blocked: this address starts or ends with the same ${LOOKALIKE_HEX} characters as ${whose}, ` +
        "but it is a different address. That is the pattern of an address-poisoning scam. Get the heir's " +
        "address from the heir directly, not from wallet history. If it truly is a different person whose " +
        "address happens to match, they will need to use another address.",
    };
  }
  return null;
}

function blockedBanner(container, problem, candidate) {
  const out = element("div", "banner bad");
  if (typeof problem === "string") {
    out.append(element("p", "banner-copy", problem));
  } else {
    out.append(element("p", "banner-copy", problem.message));
    out.append(addressRow("Entered", candidate, "bad"), addressRow("Looks like", problem.imitated));
  }
  container.replaceChildren(out);
}

// ---------------------------------------------------------------- tokens and fees

// Strips control and bidi characters from text the app did not write (a token's symbol, a
// connection's error message) and caps its length.
function cleanText(text, max) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max);
}

function cleanLabel(text) {
  return cleanText(text, 24);
}

async function meta(token) {
  if (token === ZERO) return { symbol: chain().coin, decimals: 18, known: true };
  const known = knownToken(token);
  if (known) return { symbol: known.symbol, decimals: known.decimals, known: true };
  if (tokenMeta[token]) return tokenMeta[token];
  const contract = new ethers.Contract(token, ERC20_ABI, S.provider);
  let symbol = null;
  let decimals = null;
  try { symbol = cleanLabel(await contract.symbol()); } catch { symbol = null; }
  try { decimals = Number(await contract.decimals()); } catch { decimals = null; }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) decimals = null;
  const result = { symbol, decimals, known: false };
  tokenMeta[token] = result;
  return result;
}

// Unknown tokens never get a bare symbol: it is whatever their deployer chose, "USDC" included.
async function fmtAmount(token, amount) {
  const tokenInfo = await meta(token);
  if (tokenInfo.decimals === null) return `${amount.toString()} raw units (unverified token)`;
  const value = ethers.formatUnits(amount, tokenInfo.decimals);
  if (tokenInfo.known) return `${value} ${tokenInfo.symbol}`;
  return `${value} "${tokenInfo.symbol || "?"}" (unverified token)`;
}

function tokenRow(token) {
  if (token === ZERO) return element("div", "", `Asset: native ${chain().coin}`);
  const known = knownToken(token);
  const row = addressRow(known ? `Token ${known.symbol}` : "Unverified token", token, known ? null : "bad");
  if (known) return row;
  const box = element("div");
  box.append(row, element(
    "div", "warning-text",
    "This token is not on the app's known list. Its name, symbol and decimals are set by whoever deployed " +
    "it, and rebasing, fee-on-transfer, reflection, interest-bearing and double-entry tokens do not work " +
    "safely in the vault. Only trust a vault like this from an owner you know.",
  ));
  return box;
}

async function loadFee() {
  const [bps, recipient] = await Promise.all([S.contract.claimFeeBps(), S.contract.feeRecipient()]);
  S.fee = { bps: Number(bps), recipient };
  return S.fee;
}

// vault.feeBps is a ceiling snapshotted at creation, not the fee. The effective rate is the lower
// of the ceiling and the current global rate, and on v1 no fee is taken only while no fee
// recipient is set -- which the admin can change before any claim settles.
function feeText(ceilingBps, pending) {
  const current = S.fee.bps;
  const effective = Math.min(Number(ceilingBps), current);
  const parts = [
    `Claim fee: ceiling ${pct(ceilingBps)} (fixed at creation), current rate ${pct(current)}, ` +
    `effective now ${pct(effective)} (the lower of the two).`,
  ];
  if (pending) {
    parts.push("This claim pays at most the rate locked when it was filed, which this contract does not display.");
  }
  parts.push(S.fee.recipient === ZERO
    ? "It is 0 only while no fee recipient is set, and none is set now; on this contract the admin can set one, " +
      "or change the rate, before a claim settles, never above the ceiling."
    : "On this contract the admin can change the rate before a claim settles, never above the ceiling.");
  return parts.join(" ");
}

function feeRuleText() {
  return S.fee.recipient === ZERO
    ? "No fee is taken while no fee recipient is set, and none is set now, but on this contract the admin can " +
      "set one, or change the rate, before a claim settles, never above the ceiling."
    : "A claim pays the lowest of the ceiling, the rate when the claim is filed and the rate when it settles; " +
      "on this contract the admin can change the rate at any time, never above the ceiling.";
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

// refreshMine re-renders the owner cards, so a message is carried over to the card's new log
// element when the old one was replaced.
const liveLog = (logElement) => (!logElement.isConnected && logElement.id && $(logElement.id)) || logElement;

// Resolves to one of three results, and callers must tell them apart:
// - the mined receipt (truthy): the transaction succeeded;
// - false: nothing happened (refused in the wallet, rejected before sending, or mined and
//   reverted), so the caller may offer its Sign button again;
// - null: it was sent but its outcome could not be read, so it may still go through. The caller
//   must NOT offer its Sign button again: a second signature could repeat it (a second funded vault).
// Only sending and waiting can fail the transaction. The re-read after it is mined is separate:
// a failed refresh is reported under the confirmation and never turns a success into a failure.
// `onMined(receipt)` runs as soon as the receipt exists, before that refresh.
async function runTx(logElement, label, send, onMined) {
  let transaction = null;
  let receipt = null;
  try {
    renderTx(logElement, label, "confirm in wallet...");
    transaction = await send();
    renderTx(logElement, label, "sent", transaction.hash);
    logElement.append(document.createTextNode(" - waiting..."));
    receipt = await transaction.wait();
  } catch (error) {
    // A wallet "speed up" re-sends the same call; ethers reports it as replaced, with the receipt.
    if (error?.code === "TRANSACTION_REPLACED" && error.reason === "repriced" && error.receipt?.status === 1) {
      transaction = { hash: error.receipt.hash };
      receipt = error.receipt;
    } else {
      return await txFailed(logElement, label, transaction, error);
    }
  }
  renderTx(logElement, label, "confirmed", transaction.hash);
  try {
    onMined?.(receipt);
  } catch {
    // A display step; the transaction is mined either way.
  }
  let refreshError = null;
  try {
    await refreshMine();
  } catch (error) {
    refreshError = error;
  }
  const log = liveLog(logElement);
  if (log !== logElement) renderTx(log, label, "confirmed", transaction.hash);
  if (refreshError) {
    log.append(element(
      "div", "follow-up warn",
      `It is confirmed on chain, but the page could not re-read your vaults afterwards (${errorText(refreshError)}). ` +
      "What is shown may be out of date: reload the page before doing anything else, and do not sign this again.",
    ));
  }
  return receipt || true;
}

async function txFailed(logElement, label, transaction, error) {
  const hash = transaction?.hash || error?.info?.sendTransactionHash || null;
  const reverted = error?.code === "CALL_EXCEPTION";
  // Sent, and not known to have reverted: the connection failed while waiting, or the wallet
  // replaced the transaction. It may be mined, so it is reported as unknown, not as failed.
  if (hash && !(reverted && error.receipt)) {
    renderTx(logElement, label, "sent, but its result could not be read", hash);
    logElement.append(document.createTextNode(
      ` (${errorText(error)}). It may still go through. Open the transaction on the explorer and reload ` +
      "this page before signing anything again.",
    ));
    return null;
  }
  const text = `${label} failed: ${errorText(error)}`;
  logElement.textContent = text;
  // A revert usually means the vault changed under the card (a claim was filed, the horizon
  // passed), so re-read it rather than leave a stale card (F43); the message is carried over.
  if (reverted) {
    try {
      await refreshMine();
    } catch {
      // Keep the stale view; the message above still stands.
    }
    const log = liveLog(logElement);
    if (log !== logElement) log.textContent = text;
  }
  return false;
}

// Appends a follow-up line under a transaction log, looked up by id so it survives a re-render.
function followUp(logId, tone, message) {
  const log = $(logId);
  if (!log) return;
  log.append(element("div", `follow-up ${tone}`, message));
}

const HEIR_CHECK_STEP = "Next: ask your heir to open the \"I'm an heir\" tab with their own wallet, enter your " +
  "address and confirm this vault appears. That is the only check that proves the address is really theirs.";

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
  fillAssetOptions();
  await loadMine();
}

// The first read after connecting. A failure is shown with a retry, instead of an uncaught error
// behind the "Connect your wallet" card. (Reviews never rely on this read: see loadKnownHeirs.)
async function loadMine() {
  try {
    await refreshMine();
  } catch (error) {
    const box = $("mineEmpty");
    box.hidden = false;
    notice(box, "bad", `Your vaults could not be read (${errorText(error)}). Nothing is shown until they can be.`);
    box.append(button("Try again", "btn small ghost", loadMine));
  }
}

function connectFailed(error) {
  const banner = $("walletBanner");
  banner.hidden = false;
  banner.textContent = `Could not connect: ${errorText(error)}`;
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

const pinnedText = (horizon) => `Your deadline is pinned to the horizon (${fmtUtc(horizon)}): a check-in can no ` +
  "longer move it later. At the horizon your heir can claim, and then only extending the horizon or withdrawing " +
  "everything stops the claim. Extend the horizon to keep checking in.";

// Owner warnings only. A pending claim and a passed horizon get their own block on the card, which
// says what still works; the generic "check in" advice would be wrong in both (F03, F43).
function warningLines(vault, role) {
  const warnings = Number(vault.warnings);
  const lines = [];
  if (role !== "owner") return lines;
  if (Number(vault.state) === 1 && !vault.horizonReached) {
    if (warnings & 1) lines.push("your timer has expired - check in now; until you do, your heir can start a claim");
    if (Number(vault.deadline) >= Number(vault.absoluteDeadline)) lines.push(pinnedText(vault.absoluteDeadline));
  }
  if (warnings & 8) lines.push("paper check-in chain exhausted");
  return lines;
}

// Card element ids. An heir can see vault #0 of several owners at once, so heir ids carry the owner.
const heirKey = (owner, id) => `${owner.toLowerCase()}-${Number(id)}`;
function ownerLog(id) { return $(`log-owner-${id}`); }
function heirLog(owner, id) { return $(`log-heir-${heirKey(owner, id)}`); }

// Card actions report their own failures (a read that failed, an amount that does not parse) in
// the card's log. A click handler whose promise rejects would otherwise fail without a word.
function guarded(logOf, action) {
  return async () => {
    try {
      return await action();
    } catch (error) {
      const log = logOf();
      if (log) log.textContent = `Could not continue: ${errorText(error)}`;
      return false;
    }
  };
}
const ownerAct = (id, action) => guarded(() => ownerLog(id), () => action(id));
const heirAct = (owner, id, action) => guarded(() => heirLog(owner, id), () => action(owner, id));

// A typed amount: digits with at most one dot. parseUnits alone would reject "1,5" with a message
// about FixedNumber strings, and accept 0, which every vault function refuses.
function parseAmount(value, decimals, label) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label}: "${text}" is not an amount. Use digits and at most one dot, like 1.5 (no commas or spaces).`);
  }
  let units;
  try {
    units = ethers.parseUnits(text, decimals);
  } catch {
    throw new Error(`${label}: "${text}" has more than ${decimals} decimal places.`);
  }
  if (units <= 0n) throw new Error(`${label}: enter an amount above zero.`);
  return units;
}

// ---------------------------------------------------------------- in-card review panels
// Every irreversible or authority-moving action is reviewed in the card before the wallet opens:
// no prompt(), and every address in full.

// Returns null when the card was re-rendered while the action was loading; callers then stop.
function openPanel(role, id, title) {
  const panel = $(`panel-${role}-${id}`);
  if (!panel) return null;
  panel.hidden = false;
  panel.replaceChildren(element("h4", "", title));
  return panel;
}

function closePanel(role, id) {
  const panel = $(`panel-${role}-${id}`);
  if (!panel) return;
  panel.hidden = true;
  panel.replaceChildren();
}

function textInput(placeholder, type = "text") {
  const out = element("input", "f");
  out.type = type;
  if (placeholder) out.placeholder = placeholder;
  out.autocomplete = "off";
  out.spellcheck = false;
  return out;
}

function field(label, control, hint) {
  const out = element("label", "f");
  out.append(element("span", "", label), control);
  if (hint) out.append(element("small", "hint", hint));
  return out;
}

function checkbox(text, type = "checkbox", name) {
  const wrap = element("label", "check");
  const box = element("input");
  box.type = type;
  if (name) box.name = name;
  wrap.append(box, element("span", "", text));
  return { wrap, box };
}

// rows: [term, value (text or Node), tag?] where tag is { tone, text }.
function reviewList(rows) {
  const list = element("dl", "review");
  for (const [term, value, tag] of rows) {
    const dd = element("dd");
    if (value instanceof Node) dd.append(value);
    else dd.textContent = String(value);
    if (tag) dd.append(element("span", `tag ${tag.tone}`, tag.text));
    list.append(element("dt", "", term), dd);
  }
  return list;
}

function noteList(notes) {
  const list = element("ul", "review-notes");
  for (const [tone, text] of notes) list.append(element("li", tone ? `note-${tone}` : "", text));
  return list;
}

function panelButtons(...buttons) {
  const out = element("div", "review-actions");
  out.append(...buttons);
  return out;
}

// What changed on a vault between two reads that would make a panel or a review say the wrong
// thing about what the signature does, or null. A check-in or a top-up changes nothing here.
function vaultChange(before, after) {
  const was = Number(before.state);
  const is = Number(after.state);
  if (is !== was) {
    if (is === 2) return "a claim was filed on it";
    if (was === 2 && is === 1) return "the claim that was pending on it ended";
    return `it is now ${(STATES[is] || "in another state").toLowerCase()}`;
  }
  if (is === 2 && after.claimInitiatedAt !== before.claimInitiatedAt) return "a new claim was filed on it";
  if (Boolean(after.horizonReached) !== Boolean(before.horizonReached)) return "it passed its horizon";
  if (!same(after.beneficiary, before.beneficiary)) return "its heir changed";
  if (after.absoluteDeadline !== before.absoluteDeadline) return "its horizon changed";
  if (after.inactivityPeriod !== before.inactivityPeriod) return "its check-in period changed";
  return null;
}

// Re-reads the owner's vault `id` and compares it with `seen`, the read a panel or review was built
// from. Returns the fresh read, or null after saying in `out` why nothing may be signed. On a change
// the cards are re-read, so the vault's card shows what happened (a pending claim leads it), and
// the message moves to that card's log when the panel is replaced.
async function recheckVault(id, seen, out) {
  let latest;
  try {
    latest = await S.contract.getVault(S.account, id);
  } catch (error) {
    notice(out, "bad", `Vault #${id} could not be re-read, so nothing can be signed yet: ${errorText(error)}`);
    return null;
  }
  const change = vaultChange(seen, latest);
  if (!change) return latest;
  const message = `Vault #${id} changed after this panel was opened: ${change}. What it said no longer ` +
    "describes what signing would do, so nothing was signed. Review the vault again from its card.";
  notice(out, "bad", message);
  try {
    await refreshMine();
  } catch {
    return null;
  }
  if (!out.isConnected) {
    const log = ownerLog(id);
    if (log) log.textContent = message;
    else $("mineAlerts").append(element("div", "banner bad", message));
  }
  return null;
}

// Maps vault id -> new deadline for each CheckedIn event of the connected owner in a receipt.
function checkedInIds(receipt) {
  const out = new Map();
  for (const entry of receipt?.logs || []) {
    if (!same(entry.address, chain().contract)) continue;
    let parsed = null;
    try {
      parsed = S.contract.interface.parseLog(entry);
    } catch {
      parsed = null;
    }
    if (parsed?.name !== "CheckedIn" || !same(parsed.args.owner, S.account)) continue;
    out.set(Number(parsed.args.vaultId), Number(parsed.args.newDeadline));
  }
  return out;
}

async function actCheckIn(id) {
  const receipt = await runTx(ownerLog(id), "Check-in", () => S.contract.checkIn(id));
  if (!receipt) return;
  // A check-in cannot move the deadline past the horizon; say so when it did not move (F18).
  const newDeadline = checkedInIds(receipt).get(Number(id));
  const vault = await S.contract.getVault(S.account, id).catch(() => null);
  if (vault && newDeadline !== undefined && newDeadline >= Number(vault.absoluteDeadline)) {
    followUp(`log-owner-${id}`, "bad", `Checked in, but it did not help. ${pinnedText(vault.absoluteDeadline)}`);
  }
}

async function actAbort(id) {
  return runTx(ownerLog(id), "Veto", () => S.contract.abortClaim(id));
}

async function actTopUp(id) {
  const vault = await S.contract.getVault(S.account, id);
  const tokenInfo = await meta(vault.token);
  if (tokenInfo.decimals === null) {
    ownerLog(id).textContent = "This token's decimals() cannot be read, so the app cannot convert amounts for it.";
    return;
  }
  if (!tokenInfo.known && !confirm(
    `This vault holds a token that is not on the app's known list (${vault.token}). Rebasing, ` +
    "fee-on-transfer, reflection, interest-bearing and double-entry tokens do not work safely in the " +
    "vault. Add more of it anyway?",
  )) return;
  const amount = prompt(`Top up amount (${tokenInfo.symbol}):`);
  if (!amount) return;
  const units = parseAmount(amount, tokenInfo.decimals, "Top-up amount");
  if (vault.token !== ZERO && !(await ensureAllowance(vault.token, units, ownerLog(id)))) return;
  await runTx(ownerLog(id), "Top-up", () =>
    S.contract.topUp(S.account, id, units, { value: vault.token === ZERO ? units : 0n }));
}

async function actWithdraw(id) {
  const vault = await S.contract.getVault(S.account, id);
  const tokenInfo = await meta(vault.token);
  if (tokenInfo.decimals === null) {
    ownerLog(id).textContent = "This token's decimals() cannot be read, so the app cannot convert amounts for it.";
    return;
  }
  let caveat = "";
  if (Number(vault.state) === 2 && vault.horizonReached) {
    caveat = "A partial withdrawal does NOT stop the pending claim: past the horizon only withdrawing everything " +
      "or extending the horizon does, and the heir inherits whatever is left.\n\n";
  } else if (Number(vault.state) === 2) {
    caveat = "Any withdrawal also cancels the pending claim.\n\n";
  }
  const amount = prompt(
    `${caveat}Withdraw amount (${tokenInfo.symbol}). Current balance: ${ethers.formatUnits(vault.balance, tokenInfo.decimals)}`,
  );
  if (!amount) return;
  const units = parseAmount(amount, tokenInfo.decimals, "Withdrawal amount");
  await runTx(ownerLog(id), "Withdraw", () => S.contract.withdraw(id, units, S.account));
}

// F19: past the horizon, withdrawing the whole balance is one of the two owner actions that still
// ends a claim. It closes the vault for good, and the balance is credited to the owner's wallet.
async function actWithdrawAll(id) {
  const vault = await S.contract.getVault(S.account, id);
  // Everything that needs a read happens before the panel opens, so two quick clicks cannot both
  // fill it and leave two Sign buttons.
  const amountText = await fmtAmount(vault.token, vault.balance);
  const panel = openPanel("owner", id, `Withdraw everything from vault #${id}`);
  if (!panel) return;
  const notes = [
    ["bad", "This closes the vault permanently: its heir, timer and horizon end with it. To protect these funds again you would create a new vault."],
    ["", "The whole balance is credited to your wallet; collect it on the Payouts tab. No fee is charged on a withdrawal."],
  ];
  if (Number(vault.state) === 2) notes.unshift(["warn", "This ends the pending claim by closing the vault."]);
  const problems = element("div");
  const sign = button("Sign withdrawal", "btn small primary", async () => {
    sign.disabled = true;
    // v1 has no "withdraw all": the exact balance is sent, so it must not have changed since review,
    // and neither may the state the notes above describe.
    const latest = await recheckVault(id, vault, problems);
    if (!latest) {
      sign.disabled = false;
      return;
    }
    if (latest.balance !== vault.balance) {
      notice(problems, "bad", "The balance changed since this review. Close this panel and review again.");
      return;
    }
    if ((await runTx(ownerLog(id), "Withdraw everything", () => S.contract.withdraw(id, vault.balance, S.account))) === false) {
      sign.disabled = false;
    }
  });
  panel.append(
    reviewList([
      ["Vault", `#${id}`],
      ["Amount", amountText, { tone: "bad", text: "whole balance" }],
      ["Credited to", addressBlock(S.account), { tone: "ok", text: "your wallet" }],
    ]),
    noteList(notes),
    problems,
    panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("owner", id))),
  );
}

// F41: the heir alone decides who inherits, so a new heir is entered twice, checked against every
// heir the owner already uses (a look-alike is a hard stop), and reviewed in full before signing.
async function actHeir(id) {
  const vault = await S.contract.getVault(S.account, id);
  const panel = openPanel("owner", id, `Change the heir of vault #${id}`);
  if (!panel) return;
  if (Number(vault.state) === 2 && vault.horizonReached) {
    panel.append(element(
      "p", "banner-copy warning-text",
      "A claim is pending and the horizon has passed, so changing the heir cannot stop it any more. " +
      "Only extending the horizon, or withdrawing everything, stops this claim.",
    ));
    panel.append(panelButtons(button("Close", "btn small ghost", () => closePanel("owner", id))));
    return;
  }
  if (!vault.horizonReached) {
    heirForm(panel, vault, id);
    return;
  }
  // F43: past the horizon a heir change still succeeds, but it restarts nothing: the new heir can
  // claim as soon as it is mined, the owner could then stop that claim only by extending the horizon
  // or withdrawing everything, and if the current heir files first the change reverts. The
  // capability stays, but the owner is routed through extending the horizon first.
  panel.append(
    element(
      "p", "banner-copy warning-text",
      `This vault passed its horizon on ${fmtUtc(vault.absoluteDeadline)}. Changing the heir now does not ` +
      "restart your check-in timer: the new heir can start a claim as soon as the change is mined, and you " +
      "could then stop it only by extending the horizon or withdrawing everything, not with Veto. If the " +
      "current heir files a claim before your change is mined, the change fails and their claim stands.",
    ),
    element(
      "p", "banner-copy",
      "To stay in control, extend the horizon first. That restarts your timer, and you can then change the " +
      "heir safely.",
    ),
  );
  const ack = checkbox("I understand: the new heir could claim at once, and I could not veto that claim.");
  const problems = element("div");
  panel.append(
    ack.wrap,
    problems,
    panelButtons(
      button("Extend horizon first", "btn small primary", ownerAct(id, actHorizon)),
      button("Change heir without extending", "btn small ghost", () => {
        if (!ack.box.checked) {
          notice(problems, "bad", "Tick the box above first, or extend the horizon first.");
          return;
        }
        panel.replaceChildren(element("h4", "", `Change the heir of vault #${id} (past the horizon)`));
        heirForm(panel, vault, id);
      }),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
  );
}

function heirForm(panel, vault, id) {
  panel.append(addressRow("Current heir", vault.beneficiary));

  const first = textInput("0x...");
  const second = textInput("0x...");
  const out = element("div", "panel-out");
  const picker = element("select", "f addr-pick");
  if (heirPickerOptions(picker, S.heirs, vault.beneficiary)) {
    picker.addEventListener("change", () => {
      first.value = picker.value;
      second.value = picker.value;
      out.replaceChildren();
    });
    panel.append(field(
      "Use an existing heir", picker,
      "Fills both boxes from the heirs of your other open vaults, so nothing is pasted from wallet history.",
    ));
  }
  panel.append(
    field("New heir's address", first),
    field(
      "New heir's address, again", second,
      "Type or paste it a second time. Scammers plant look-alike addresses in wallet histories, so check " +
      "every character, not only the first and last few.",
    ),
  );
  // Each review and each edit starts a new generation; a review that finds a newer one when its
  // reads return shows nothing, so two quick clicks can never leave two Sign buttons.
  let generation = 0;
  const reset = () => {
    generation += 1;
    out.replaceChildren();
  };
  for (const control of [first, second]) control.addEventListener("input", reset);
  picker.addEventListener("change", reset);
  panel.append(
    panelButtons(
      button("Review change", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
    out,
  );

  async function review() {
    reset();
    const mine = generation;
    const current = () => mine === generation && out.isConnected;
    let entry;
    try {
      entry = readAddressPair(first.value, second.value, "New heir");
    } catch (error) {
      notice(out, "bad", error.message);
      return;
    }
    const heir = entry.address;
    // The notes describe the vault as it is now, not as it was when the panel opened: a claim filed
    // or a horizon passed since then changes what this signature does.
    const latest = await recheckVault(id, vault, out);
    if (!current() || !latest) return;
    if (same(heir, latest.beneficiary)) {
      notice(out, "warn", "That address is already the heir of this vault.");
      return;
    }
    let heirs;
    try {
      heirs = await loadKnownHeirs();
    } catch (error) {
      if (current()) notice(out, "bad", error.message);
      return;
    }
    if (!current()) return;
    const problem = heirProblem(heir, heirs, [latest.beneficiary]);
    if (problem) {
      blockedBanner(out, problem, heir);
      return;
    }
    const notes = [
      latest.horizonReached
        ? ["bad", "Past the horizon this does not restart your check-in timer: the new heir can start a claim as soon as it is mined, and you could not veto it."]
        : ["", "Changing the heir restarts your check-in timer."],
      ["", "Read the new address to your heir, or have them read it from their own wallet: all 40 characters."],
    ];
    if (Number(latest.state) === 2) notes.unshift(["bad", "This also cancels the claim that is pending on this vault."]);
    if (entry.unchecked) {
      notes.push(["warn", "This address was entered without checksum capitals, so a mistyped character would not be detected by its format. Your two entries matched; check it against the heir's wallet."]);
    }
    const contract = await hasCode(heir);
    if (!current()) return;
    if (contract) {
      notes.push(["warn", "This address is a smart contract. That is fine for a multisig or smart wallet your heir controls, but a contract that cannot send transactions can never claim."]);
    }
    const problems = element("div");
    const sign = button("Sign heir change", "btn small primary", async () => {
      sign.disabled = true;
      // Once more at signing: the review may have been left open while the vault changed.
      if (!(await recheckVault(id, latest, problems))) {
        sign.disabled = false;
        return;
      }
      const receipt = await runTx(ownerLog(id), "Change heir", () => S.contract.setBeneficiary(id, heir));
      if (receipt) followUp(`log-owner-${id}`, "ok", HEIR_CHECK_STEP);
      else if (receipt === false) sign.disabled = false;
    });
    out.append(
      reviewList([
        ["Vault", `#${id}`],
        ["Current heir", addressBlock(latest.beneficiary)],
        ["New heir", addressBlock(heir), { tone: "warn", text: "claim authority" }],
      ]),
      noteList(notes),
      problems,
      panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("owner", id))),
    );
  }
}

// F47: a date input with a round-trip check instead of free text, the current and new horizon side
// by side, and the fact that it can never be lowered. F19/F43: past the horizon this is the way to
// stop a claim (or regain control), so the date comes pre-filled with the earliest one that works.
async function actHorizon(id) {
  const [vault, now] = await Promise.all([S.contract.getVault(S.account, id), chainNow()]);
  const current = Number(vault.absoluteDeadline);
  const floor = horizonFloor(vault, now);
  const ceiling = now + MAX_HORIZON_DAYS * 86400 - HORIZON_MARGIN;
  const minDay = utcDayCeil(floor);
  const maxDay = utcDay(ceiling);
  const stopping = Number(vault.state) === 2 && vault.horizonReached;
  const panel = openPanel(
    "owner", id, stopping ? `Stop the claim on vault #${id}: extend its horizon` : `Extend the horizon of vault #${id}`,
  );
  if (!panel) return;
  const periodDays = Number(vault.inactivityPeriod) / 86400;
  if (vault.horizonReached) {
    panel.append(element(
      "p", "banner-copy warning-text",
      (stopping
        ? "Past the horizon, extending it (or withdrawing everything) is the only way to stop this claim. "
        : "Past the horizon, extending it is how you regain control: it restarts your check-in timer. ") +
      `The contract accepts a new horizon at least one full check-in period (${periodDays} days) after the ` +
      `block it is mined in, so the date below is pre-filled with ${minDay}: the first UTC midnight after ` +
      "that, with an hour's allowance for mining. A later date also works, but it can never be lowered again.",
    ));
  }
  panel.append(reviewList([
    ["Current horizon", fmtUtc(current)],
    ["Challenge window", `${Number(vault.challengeWindow) / 86400} days`],
  ]));
  const date = textInput("", "date");
  date.min = minDay;
  date.max = maxDay;
  if (vault.horizonReached) date.value = minDay;
  panel.append(field(
    "New horizon (UTC date)", date,
    `Earliest ${minDay}, latest ${maxDay}. The horizon can be moved later but never earlier.`,
  ));
  const out = element("div", "panel-out");
  // As in heirForm: a review superseded by a newer one or by an edit shows nothing.
  let generation = 0;
  const reset = () => {
    generation += 1;
    out.replaceChildren();
  };
  date.addEventListener("input", reset);
  panel.append(
    panelButtons(
      button("Review change", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
    out,
  );

  async function review() {
    reset();
    const mine = generation;
    // The notes below describe the vault as it is now: a claim filed or the horizon passed since
    // the panel opened changes what this signature does, and the pre-filled date with it.
    const latest = await recheckVault(id, vault, out);
    if (mine !== generation || !out.isConnected || !latest) return;
    const timestamp = parseUtcDate(date.value);
    if (timestamp === null) {
      notice(out, "bad", "Pick a real calendar date (YYYY-MM-DD).");
      return;
    }
    if (timestamp < floor) {
      notice(out, "bad", `The new horizon must be ${minDay} or later: after the current horizon and at least one inactivity period from now.`);
      return;
    }
    if (timestamp > ceiling) {
      notice(out, "bad", `The new horizon must be ${maxDay} or earlier (at most ${MAX_HORIZON_DAYS} days from now).`);
      return;
    }
    // F21: the horizon is a long-stop, not a payout date.
    const earliestPayout = timestamp + Number(vault.challengeWindow);
    const notes = [
      ["bad", "The horizon can never be lowered on this vault. A date set too late can only be undone by withdrawing everything and creating a new vault."],
      ["", "This also restarts your check-in timer."],
    ];
    if (Number(latest.state) === 2) notes.push(["warn", "This also cancels the claim that is pending on this vault."]);
    const children = [
      reviewList([
        ["Current horizon", fmtUtc(current)],
        ["New horizon", fmtUtc(timestamp), { tone: "bad", text: "raise-only" }],
        ["Change", fmtSpan(current, timestamp)],
        ["If your heir claims at it", `finalizable from ${fmtUtc(earliestPayout)} (horizon + challenge window), unless your key is used first`],
      ]),
      noteList(notes),
    ];
    // A transposed year (2064 for 2046) cannot be corrected, so a long jump needs the year retyped.
    let yearCheck = null;
    if (timestamp - current > TEN_YEARS) {
      yearCheck = textInput("YYYY");
      yearCheck.inputMode = "numeric";
      children.push(field(
        "Type the new horizon's year to confirm", yearCheck,
        `This moves the horizon more than ten years (${fmtSpan(current, timestamp)}).`,
      ));
    }
    const problems = element("div");
    const sign = button("Sign horizon change", "btn small primary", async () => {
      if (yearCheck && yearCheck.value.trim() !== utcDay(timestamp).slice(0, 4)) {
        notice(problems, "bad", "The year you typed does not match the new horizon.");
        return;
      }
      sign.disabled = true;
      // Once more at signing: the review may have been left open while the vault changed.
      if (!(await recheckVault(id, latest, problems))) {
        sign.disabled = false;
        return;
      }
      // The floor moves with the clock: a review left open for hours can fall below it.
      const freshFloor = horizonFloor(vault, await chainNow());
      if (timestamp < freshFloor) {
        notice(problems, "bad", `The earliest horizon that works is now ${utcDayCeil(freshFloor)}. Pick that date or later and review again.`);
        sign.disabled = false;
        return;
      }
      if ((await runTx(ownerLog(id), "Extend horizon", () => S.contract.extendHorizon(id, timestamp))) === false) {
        sign.disabled = false;
      }
    });
    children.push(problems, panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("owner", id))));
    out.append(...children);
  }
}

// F20 + F09: the payout defaults to the heir's own connected wallet. Any other address is entered
// twice, refused if it is a token or wrapped-native contract, flagged if it has code, and needs an
// explicit acknowledgement, because on v1 the recipient is fixed for the life of the claim.
async function actClaim(owner, id) {
  const vault = await S.contract.getVault(owner, id);
  const key = heirKey(owner, id);
  const panel = openPanel("heir", key, `Start the claim on vault #${id}`);
  if (!panel) return;
  const own = checkbox("Pay to my connected wallet (recommended)", "radio", `payto-${key}`);
  const other = checkbox("Pay to a different address", "radio", `payto-${key}`);
  own.box.checked = true;
  const ownRow = addressRow("Your wallet", S.account);
  const first = textInput("0x...");
  const second = textInput("0x...");
  const otherBox = element("div");
  otherBox.hidden = true;
  otherBox.append(
    field("Payout address", first),
    field(
      "Payout address, again", second,
      "Type or paste it a second time. An exchange deposit address, a token contract or an address on another " +
      "network can lose the whole inheritance.",
    ),
  );
  const out = element("div", "panel-out");
  // As in heirForm: a review superseded by a newer one or by an edit shows nothing.
  let generation = 0;
  const reset = () => {
    generation += 1;
    otherBox.hidden = !other.box.checked;
    out.replaceChildren();
  };
  for (const control of [own.box, other.box, first, second]) {
    control.addEventListener(control.type === "radio" ? "change" : "input", reset);
  }
  panel.append(own.wrap, ownRow, other.wrap, otherBox);
  panel.append(
    panelButtons(
      button("Review claim", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("heir", key)),
    ),
    out,
  );

  async function review() {
    reset();
    const mine = generation;
    const current = () => mine === generation && out.isConnected;
    let recipient = S.account;
    let unchecked = false;
    if (other.box.checked) {
      try {
        const entry = readAddressPair(first.value, second.value, "Payout address");
        recipient = entry.address;
        unchecked = entry.unchecked;
      } catch (error) {
        notice(out, "bad", error.message);
        return;
      }
    }
    const different = !same(recipient, S.account);
    const refused = refusedReason(recipient);
    if (refused) {
      blockedBanner(out, `Refused: that is ${refused}. Anything paid there is lost or ends up where only the admin can move it.`);
      return;
    }
    if (different) {
      const imitated = lookalikeOf(recipient, [S.account, owner]);
      if (imitated) {
        blockedBanner(out, {
          imitated,
          message: `Blocked: this address starts or ends with the same ${LOOKALIKE_HEX} characters as ` +
            `${same(imitated, S.account) ? "your connected wallet" : "the vault owner"}, but it is a different ` +
            "address. That is the pattern of an address-poisoning scam.",
        }, recipient);
        return;
      }
    }
    // Every read happens before anything is shown, and only the newest review shows its result.
    let amountText;
    let contract = false;
    try {
      await loadFee();
      amountText = await fmtAmount(vault.token, vault.balance);
      if (different) contract = await hasCode(recipient);
    } catch (error) {
      if (current()) notice(out, "bad", `Could not review the claim: ${errorText(error)}`);
      return;
    }
    if (!current()) return;
    // F13: "finalizable" is not "final". The owner's key can cancel until a finalize is mined.
    const notes = [
      ["bad", "The payout address is fixed when the claim starts. On this contract nobody, including you, can change it afterwards."],
      ["", `Anyone can finalize the claim from ${Number(vault.challengeWindow) / 86400} days after it is mined. Until a finalize is mined, the owner's key can still cancel it, so come back and finalize promptly: nobody will remind you.`],
    ];
    if (unchecked) notes.push(["warn", "This address was entered without checksum capitals, so a mistyped character would not be detected by its format."]);
    const acks = [];
    if (different) {
      const ack = checkbox("I have checked every character of this payout address. I understand it cannot be changed once the claim starts, and a wrong address loses the inheritance.");
      acks.push(ack);
      if (contract) {
        acks.push(checkbox(
          "This address is a smart contract. I have confirmed it can receive this asset and is a wallet I control, " +
          "not an exchange deposit address or a token contract.",
        ));
      }
    }
    const problems = element("div");
    const sign = button("Sign claim", "btn small primary", async () => {
      if (acks.some((ack) => !ack.box.checked)) {
        notice(problems, "bad", "Tick every confirmation above first.");
        return;
      }
      sign.disabled = true;
      const receipt = await runTx(heirLog(owner, id), "Initiate claim", () => S.contract.initiateClaim(owner, id, recipient));
      if (receipt) await refreshHeir();
      else if (receipt === false) sign.disabled = false;
    });
    out.append(
      reviewList([
        ["Vault", `#${id}`],
        ["Owner", addressBlock(owner)],
        ["Heir (you)", addressBlock(S.account)],
        ["Payout to", addressBlock(recipient, different ? "bad" : null), different
          ? { tone: "bad", text: "not your wallet" } : { tone: "ok", text: "your wallet" }],
        ["Amount", amountText],
        ["Claim fee", feeText(vault.feeBps, false)],
      ]),
      noteList(notes),
      ...acks.map((ack) => ack.wrap),
      problems,
      panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("heir", key))),
    );
  }
}

// A settled vault leaves the open-vault list, and its card with it, so the result is reported at
// the top of the heir list after the refresh.
async function actFinalize(owner, id) {
  const { token } = await S.contract.getVault(owner, id);
  const receipt = await runTx(heirLog(owner, id), "Finalize", () => S.contract.finalizeClaim(owner, id));
  if (!receipt) return;
  let settled = null;
  for (const entry of receipt.logs || []) {
    if (!same(entry.address, chain().contract)) continue;
    try {
      const parsed = S.contract.interface.parseLog(entry);
      if (parsed?.name === "ClaimSettled") settled = parsed.args;
    } catch {
      // Not one of the vault's events.
    }
  }
  await refreshHeir();
  if (!settled) return;
  const note = element("div", "follow-up ok");
  note.append(
    element(
      "p", "banner-copy",
      `Vault #${id} settled: ${await fmtAmount(token, settled.amount)} was credited to the address below. ` +
      "Nothing has moved to a wallet yet: open the Payouts tab with that wallet connected to withdraw it.",
    ),
    addressRow("Credited to", settled.recipient),
  );
  $("heirList").prepend(note);
}

// F46 + F13 + F03 + F19: a pending claim is the moment the owner must act, so it leads the card
// with everything getVault knows: when it was filed, by whom, where it pays and when anyone can
// finalize it. "Finalizable" is not "final": until a finalize is mined, the owner's key can still
// cancel, so the owner must get a veto mined first and the heir should finalize promptly.
function claimBlock(vault, role, now) {
  const owner = role === "owner";
  const elsewhere = !same(vault.claimRecipient, vault.beneficiary);
  const open = now < Number(vault.finalizableAt);
  const out = element("div", `banner ${owner ? "bad" : "warn"} claim-alert`);
  out.append(element(
    "p", "banner-copy claim-head",
    owner ? "A claim has been filed on this vault." : "Your claim on this vault is pending.",
  ));
  let payingTag = { tone: "ok", text: owner ? "the heir's address" : "your wallet" };
  if (elsewhere) payingTag = owner ? { tone: "bad", text: "not the heir's address" } : { tone: "warn", text: "not your wallet" };
  // v1 does not record the filer, but only the current heir can file, and changing the heir while
  // a claim is pending either cancels the claim or reverts, so the heir shown is the one who filed.
  out.append(reviewList([
    ["Filed", `${fmtLocal(vault.claimInitiatedAt)} (${fmtCountdown(vault.claimInitiatedAt, now)})`],
    ["Filed by", addressBlock(vault.beneficiary), { tone: "warn", text: owner ? "the heir" : "you" }],
    ["Paying", addressBlock(vault.claimRecipient, elsewhere && owner ? "bad" : null), payingTag],
    [
      open ? "Finalizable from" : "Finalizable since",
      `${fmtLocal(vault.finalizableAt)} (${fmtCountdown(vault.finalizableAt, now)}, by chain time)`,
    ],
  ]));
  const say = (text) => out.append(element("p", "banner-copy", text));
  if (!owner) {
    say(`${open ? "From then anyone, you included, can finalize it." : "Anyone can finalize it now."} Until a ` +
      "finalize is mined, the owner's key can still cancel the claim, so finalize promptly: nobody will remind you.");
    return out;
  }
  say(`${open ? "From then anyone can finalize this claim, and the vault pays out." : "Anyone can finalize this claim now."} ` +
    `${vault.horizonReached ? "Stopping it" : "Your veto"} only works if it is mined before someone's finalize is: ` +
    "act now, not on the last day.");
  if (elsewhere) {
    say("It pays an address that is not the heir's own. The heir chose it when filing and it cannot be changed; " +
      "if you do not recognise it, stop this claim.");
  }
  if (vault.horizonReached) {
    say(`This vault passed its horizon on ${fmtUtc(vault.absoluteDeadline)}, so Veto, Check in and Change heir ` +
      "no longer work: the contract refuses them. Only two things stop this claim now: extending the horizon to " +
      `${utcDayCeil(horizonFloor(vault, now))} or later (one full check-in period from now), or withdrawing ` +
      "everything, which closes the vault. A partial withdrawal does not stop it; the heir would inherit the rest.");
  } else {
    say("To stop it, use Veto. Changing the heir, extending the horizon or any withdrawal also cancels it, as " +
      "do changing the check-in period or installing a check-in chain (neither is offered in this app). A " +
      "check-in does not: the contract refuses check-ins while a claim is pending, so Veto replaces Check in here.");
  }
  return out;
}

// F43 + F19: past the horizon on an active vault, a check-in no longer works, the heir can file a
// claim at any moment, and a changed heir could claim at once. Extending the horizon restores control.
function horizonBlock(vault, now) {
  const out = element("div", "banner bad claim-alert");
  out.append(
    element("p", "banner-copy claim-head", `This vault passed its horizon on ${fmtUtc(vault.absoluteDeadline)}.`),
    element(
      "p", "banner-copy",
      "Check-ins no longer work, and your heir can start a claim at any time. Once a claim is filed, only " +
      "extending the horizon or withdrawing everything stops it; Veto will not.",
    ),
    element(
      "p", "banner-copy",
      `To keep control, extend the horizon to ${utcDayCeil(horizonFloor(vault, now))} or later (one full ` +
      "check-in period from now). Change the heir only after that: a change now does not restart the clock, " +
      "so the new heir could claim at once.",
    ),
  );
  return out;
}

// F21: the horizon is a long-stop, not a payout date. The earliest payout it implies needs a claim
// filed at the horizon and the owner's key unused; during a claim the claim block has the real date.
function horizonText(vault, role) {
  const line = `Horizon (long-stop) ${fmtUtc(vault.absoluteDeadline)} (can only be raised) - challenge window ` +
    `${Number(vault.challengeWindow) / 86400} days (fixed).`;
  if (Number(vault.state) === 2) return line;
  const earliest = fmtUtc(vault.guaranteedInheritanceAt);
  if (role === "owner") {
    return `${line} Check-ins stop working at the horizon. If your heir claims then and your key is not used, ` +
      `they can finalize from ${earliest}.`;
  }
  return `${line} After it the owner can no longer check in. If you claim at the horizon and the owner's key is ` +
    `not used, you can finalize from ${earliest}. Nothing happens by itself: you start the claim, then finalize it.`;
}

function ownerActions(vault, now) {
  const id = Number(vault.vaultId);
  const state = Number(vault.state);
  const out = [];
  if (vault.horizonReached) {
    // F19/F43: Check in, Veto and Change heir revert here (or, on an active vault, no longer protect).
    if (state === 2) {
      out.push(button("Stop this claim: extend horizon", "btn small danger", ownerAct(id, actHorizon)));
    } else {
      out.push(button(`Extend horizon (from ${utcDayCeil(horizonFloor(vault, now))})`, "btn small primary", ownerAct(id, actHorizon)));
      out.push(button("Top up", "btn small ghost", ownerAct(id, actTopUp)));
    }
    out.push(button("Withdraw everything", state === 2 ? "btn small danger" : "btn small ghost", ownerAct(id, actWithdrawAll)));
    out.push(button("Withdraw", "btn small ghost", ownerAct(id, actWithdraw)));
    if (state === 1) out.push(button("Change heir without extending", "btn small ghost", ownerAct(id, actHeir)));
  } else if (state === 2) {
    // F03: checkIn reverts ClaimPendingUseAbort and topUp reverts VaultNotActive while a claim is
    // pending, so both are replaced by Veto; the other owner actions here also cancel the claim.
    out.push(button("Veto claim", "btn small danger", ownerAct(id, actAbort)));
    out.push(button("Withdraw", "btn small ghost", ownerAct(id, actWithdraw)));
    out.push(button("Change heir", "btn small ghost", ownerAct(id, actHeir)));
    out.push(button("Extend horizon", "btn small ghost", ownerAct(id, actHorizon)));
  } else {
    out.push(button("Check in", "btn small primary", ownerAct(id, actCheckIn)));
    out.push(button("Top up", "btn small ghost", ownerAct(id, actTopUp)));
    out.push(button("Withdraw", "btn small ghost", ownerAct(id, actWithdraw)));
    out.push(button("Change heir", "btn small ghost", ownerAct(id, actHeir)));
    out.push(button("Extend horizon", "btn small ghost", ownerAct(id, actHorizon)));
  }
  return out;
}

function heirActions(vault) {
  const id = Number(vault.vaultId);
  const out = [];
  if (Number(vault.state) === 1 && vault.expired) {
    out.push(button("Initiate claim", "btn small primary", heirAct(vault.owner, id, actClaim)));
  }
  if (Number(vault.state) === 2 && !vault.finalizable) {
    out.push(element("span", "pill warn", `finalizable from ${fmtWhen(vault.finalizableAt)}`));
  }
  if (vault.finalizable) {
    out.push(button("Finalize inheritance", "btn small primary", heirAct(vault.owner, id, actFinalize)));
  }
  return out;
}

// `now` is chain time (chainNow) read once for the whole list.
async function vaultCard(vault, role, now) {
  const id = Number(vault.vaultId);
  const state = Number(vault.state);
  const owner = role === "owner";
  const key = owner ? String(id) : heirKey(vault.owner, id);
  const card = element("div", "vault-card");
  const top = element("div", "top");
  let tone = "warn";
  if (state === 1 && !vault.expired) tone = "ok";
  if (state === 2 && owner) tone = "bad";
  top.append(
    element("span", "amount", await fmtAmount(vault.token, vault.balance)),
    element("span", `pill ${tone}`, STATES[state] ?? "?"),
  );
  card.append(top);
  if (state === 2) card.append(claimBlock(vault, role, now));
  else if (owner && state === 1 && vault.horizonReached) card.append(horizonBlock(vault, now));

  const metaBox = element("div", "meta");
  metaBox.append(element("div", "", `Vault #${id}`));
  // F41: every party in full, never the eight characters a poisoner matches.
  if (!owner) metaBox.append(addressRow("Owner", vault.owner));
  metaBox.append(addressRow(owner ? "Heir" : "Heir (you)", vault.beneficiary));
  metaBox.append(tokenRow(vault.token));

  // F46: during a claim the deadline is stale; the claim block carries the dates that matter.
  if (state !== 2) {
    const deadline = element("div");
    deadline.append(document.createTextNode(owner ? "Next deadline: " : "Owner's next deadline: "));
    deadline.append(element("span", `countdown ${vault.expired ? "late" : ""}`, fmtCountdown(vault.deadline, now)));
    deadline.append(document.createTextNode(
      ` (${fmtWhen(vault.deadline)}) - check-in period ${Number(vault.inactivityPeriod) / 86400} days`,
    ));
    metaBox.append(deadline);
  }
  if (!owner && state === 1 && vault.expired) {
    metaBox.append(element("div", "", "The owner's deadline has passed: you can start a claim now. Nobody will do it for you."));
  }
  metaBox.append(element("div", "", horizonText(vault, role)));
  if (S.fee) metaBox.append(element("div", "", feeText(vault.feeBps, state === 2)));
  for (const warning of warningLines(vault, role)) {
    metaBox.append(element("div", "warning-text", `Warning: ${warning}`));
  }
  card.append(metaBox);

  const actions = element("div", "actions");
  actions.append(...(owner ? ownerActions(vault, now) : heirActions(vault)));
  card.append(actions);

  const panel = element("div", "act-panel");
  panel.id = `panel-${role}-${key}`;
  panel.hidden = true;
  card.append(panel);

  const log = element("div", "txlog");
  log.id = `log-${role}-${key}`;
  log.setAttribute("role", "status");
  card.append(log);
  return card;
}

// Two of the owner's own heirs that look alike (or an heir that looks like the owner) mean one of
// them may already be a poisoned address. The change-heir and create checks refuse to add another.
function renderHeirAlerts() {
  const alerts = [];
  const seen = new Set();
  for (const heir of S.heirs) {
    const imitated = lookalikeOf(heir.address, [S.account, ...S.heirs.map((other) => other.address)]);
    if (!imitated) continue;
    const key = [heir.address, imitated].map((a) => a.toLowerCase()).sort().join();
    if (seen.has(key)) continue;
    seen.add(key);
    const out = element("div", "banner bad");
    const other = S.heirs.find((candidate) => same(candidate.address, imitated));
    out.append(
      element(
        "p", "banner-copy",
        `Two addresses on your vaults look alike: they share their first or last ${LOOKALIKE_HEX} characters ` +
        "but are different. One of them may be an address-poisoning look-alike. Ask your heir to open " +
        "\"I'm an heir\" with their own wallet: only vaults naming their real address will appear. The app " +
        "will not move a vault's heir to either of these addresses; to correct a vault, withdraw everything " +
        "from it and create a new one for the confirmed address.",
      ),
      addressRow(`Heir of vault ${vaultList(heir.vaultIds)}`, heir.address, "bad"),
      addressRow(other ? `Heir of vault ${vaultList(other.vaultIds)}` : "Your own wallet", imitated, "bad"),
    );
    alerts.push(out);
  }
  $("mineAlerts").replaceChildren(...alerts);
}

function renderCreateFee() {
  if (!S.fee) return;
  $("cFeeInfo").textContent =
    `Claim fee: the current rate is ${pct(S.fee.bps)}. It becomes this vault's fee ceiling, read from the ` +
    "block your transaction is mined in, so a rate change before then changes it; the app compares the " +
    `ceiling with this quote after mining. ${feeRuleText()}`;
}

async function refreshMine() {
  if (!S.contract) return;
  await loadFee();
  renderCreateFee();
  const [vaults, now] = await Promise.all([S.contract.getOpenVaults(S.account), chainNow()]);
  S.heirs = collectHeirs(vaults);
  $("cHeirPickWrap").hidden = !heirPickerOptions($("cHeirPick"), S.heirs, null);
  renderHeirAlerts();
  // A check-in-all report describes the vaults as they were; any later re-read retires it.
  $("checkAllReport").replaceChildren();
  $("mineEmpty").hidden = vaults.length > 0;
  $("checkAllBtn").hidden = vaults.length < 2;
  if (vaults.length === 0) {
    $("mineEmpty").replaceChildren(element("p", "", "No vaults yet. Create your first one - it takes a minute."));
    $("vaultList").replaceChildren();
    return;
  }
  const cards = [];
  for (const vault of vaults) cards.push(await vaultCard(vault, "owner", now));
  $("vaultList").replaceChildren(...cards);
}

// ---------------------------------------------------------------- check in on all vaults
// F03 + F15: checkInMany silently skips a vault with a pending claim or past its horizon, reports
// only a count that a mined receipt does not carry, and a check-in never cancels a claim. So the
// batch is pre-filtered by state and horizon, and the receipt's CheckedIn logs are diffed against
// the ids sent: every vault that was not checked in is listed with its reason and its remedy.

// The remedy buttons act on the vault's own card, so that card is brought into view first.
function onCard(id, action) {
  const run = ownerAct(id, action);
  return () => {
    ownerLog(id)?.closest(".vault-card")?.scrollIntoView({ block: "center" });
    return run();
  };
}

// Why checkInMany cannot help this vault, and what does; null when it can be checked in.
function checkInBlocker(vault, now) {
  const id = Number(vault.vaultId);
  const state = Number(vault.state);
  const past = Boolean(vault.horizonReached) || now >= Number(vault.absoluteDeadline);
  if (state === 2 && past) {
    return {
      reason: "a claim is pending and the vault is past its horizon",
      remedy: "A check-in does not cancel a claim, and past the horizon neither does Veto. Only extending the " +
        "horizon or withdrawing everything stops it.",
      actions: [
        ["Stop this claim: extend horizon", "btn small danger", onCard(id, actHorizon)],
        ["Withdraw everything", "btn small ghost", onCard(id, actWithdrawAll)],
      ],
    };
  }
  if (state === 2) {
    return {
      reason: "a claim is pending",
      remedy: "A check-in does not cancel a claim; the contract skips this vault. Veto the claim.",
      actions: [["Veto claim", "btn small danger", onCard(id, actAbort)]],
    };
  }
  if (state === 1 && past) {
    return {
      reason: "the vault is past its horizon",
      remedy: "Check-ins no longer work on it, and the heir can start a claim at any time. Extend the horizon.",
      actions: [["Extend horizon", "btn small primary", onCard(id, actHorizon)]],
    };
  }
  if (state !== 1) return { reason: `it is ${(STATES[state] || "not active").toLowerCase()}`, remedy: "", actions: [] };
  return null;
}

// checked: [{ id, pinned, horizon }], skipped: [{ id, blocker }]. `sending` names the vaults of a
// batch that is not mined yet.
function renderCheckInReport(checked, skipped, sending) {
  const out = [];
  if (sending?.length) out.push(element("div", "follow-up ok", `Sending a check-in for vault ${vaultList(sending)}.`));
  const moved = checked.filter((entry) => !entry.pinned);
  if (moved.length) out.push(element("div", "follow-up ok", `Checked in: vault ${vaultList(moved.map((entry) => entry.id))}.`));
  for (const entry of checked.filter((item) => item.pinned)) {
    out.push(element("div", "follow-up bad", `Vault #${entry.id}: checked in, but it did not help. ${pinnedText(entry.horizon)}`));
  }
  if (skipped.length) {
    const box = element("div", "banner bad");
    box.append(element(
      "p", "banner-copy claim-head",
      `${skipped.length === 1 ? "1 vault is" : `${skipped.length} vaults are`} NOT checked in:`,
    ));
    const list = element("ul", "skip-list");
    for (const { id, blocker } of skipped) {
      const item = element("li");
      item.append(element("strong", "", `Vault #${id}: `), document.createTextNode(`${blocker.reason}. ${blocker.remedy}`));
      if (blocker.actions.length) {
        item.append(panelButtons(...blocker.actions.map(([label, className, handler]) => button(label, className, handler))));
      }
      list.append(item);
    }
    box.append(list);
    out.push(box);
  }
  $("checkAllReport").replaceChildren(...out);
}

$("checkAllBtn").addEventListener("click", async () => {
  const log = $("checkAllLog");
  log.textContent = "";
  $("checkAllReport").replaceChildren();
  let vaults;
  let now;
  try {
    [vaults, now] = await Promise.all([S.contract.getOpenVaults(S.account), chainNow()]);
  } catch (error) {
    log.textContent = `Could not read your vaults: ${errorText(error)}`;
    return;
  }
  const send = [];
  const skipped = [];
  for (const vault of vaults) {
    const blocker = checkInBlocker(vault, now);
    if (blocker) skipped.push({ id: Number(vault.vaultId), blocker });
    else send.push(vault);
  }
  if (send.length === 0) {
    log.textContent = "Nothing sent: none of your vaults can be checked in right now.";
    renderCheckInReport([], skipped);
    return;
  }
  // Shown before the wallet opens, so a pending claim is visible before anything is signed.
  renderCheckInReport([], skipped, send.map((vault) => Number(vault.vaultId)));
  const receipt = await runTx(
    log, `Check-in (${send.length} of ${vaults.length} vaults)`,
    () => S.contract.checkInMany(send.map((vault) => vault.vaultId)),
  );
  if (!receipt) {
    renderCheckInReport([], skipped);
    return;
  }
  // A vault can change between the read above and mining (a claim filed, the horizon passed), and
  // the contract skips it without an event: whatever has no CheckedIn log was not checked in.
  const done = checkedInIds(receipt);
  const checked = [];
  const after = await chainNow();
  for (const vault of send) {
    const id = Number(vault.vaultId);
    if (done.has(id)) {
      checked.push({ id, pinned: done.get(id) >= Number(vault.absoluteDeadline), horizon: vault.absoluteDeadline });
      continue;
    }
    let latest = vault;
    try {
      latest = await S.contract.getVault(S.account, id);
    } catch {
      // Report it with the reason the contract gives most often.
    }
    skipped.push({
      id,
      blocker: checkInBlocker(latest, after) || {
        reason: "the contract skipped it", remedy: "Check this vault's card and check in on it on its own.", actions: [],
      },
    });
  }
  skipped.sort((a, b) => a.id - b.id);
  renderCheckInReport(checked, skipped);
});

// F01/F10/F11/F36: known tokens are offered by name; anything else is "not reviewed" and needs the
// acknowledgement in #cTokenWarn. The chosen token's address is always shown with an explorer link.
function fillAssetOptions() {
  const select = $("cAsset");
  const options = [element("option", "", `Native coin (${chain().coin})`)];
  options[0].value = "native";
  for (const token of chain().tokens || []) {
    const option = element("option", "", `${token.symbol} - ${token.name}`);
    option.value = `token:${token.address}`;
    options.push(option);
  }
  const other = element("option", "", "Other ERC-20 token (not reviewed)");
  other.value = "other";
  options.push(other);
  select.replaceChildren(...options);
  showAsset();
}

function showAsset() {
  const value = $("cAsset").value;
  const isOther = value === "other";
  $("cTokenWrap").hidden = !isOther;
  $("cTokenWarn").hidden = !isOther;
  const info = $("cTokenInfo");
  info.replaceChildren();
  if (value.startsWith("token:") && chain()) {
    info.append(addressRow("Token contract", value.slice(6)));
  } else if (isOther && chain()) {
    try {
      info.append(addressRow("Token contract", parseAddress($("cToken").value, "Token").address, "bad"));
    } catch {
      // Nothing valid typed yet.
    }
  }
}

$("cAsset").addEventListener("change", showAsset);
$("cToken").addEventListener("input", () => {
  $("cTokenAck").checked = false;
  showAsset();
});

$("cHeirPick").addEventListener("change", () => {
  const picked = $("cHeirPick").value;
  if (!picked) return;
  $("cHeir").value = picked;
  $("cHeir2").value = picked;
  clearCreateReview();
});

// Each review, and each edit to the form, starts a new generation. A review whose reads return
// after a newer one started shows nothing, so two quick clicks can never leave two Sign buttons.
let createGeneration = 0;
// True from the create signature until its transaction has a result; Review is disabled meanwhile.
let creating = false;

function clearCreateReview() {
  createGeneration += 1;
  $("cReview").replaceChildren();
}

// Any edit after a review makes that review stale.
for (const eventName of ["input", "change"]) {
  $("createCard").addEventListener(eventName, (event) => {
    if (!$("cReview").contains(event.target)) clearCreateReview();
  });
}

async function ensureAllowance(token, amount, logElement) {
  const tokenContract = new ethers.Contract(token, ERC20_ABI, S.signer);
  const allowance = await tokenContract.allowance(S.account, chain().contract);
  if (allowance >= amount) return true;
  return runTx(logElement, "Approve token", () => tokenContract.approve(chain().contract, amount));
}

function wholeDays(id, label, min, max) {
  const text = $(id).value.trim();
  const days = Number(text);
  if (!/^\d+$/.test(text) || days < min || days > max) throw new Error(`${label} must be a whole number of days from ${min} to ${max}.`);
  return days;
}

// F47/F06/F40/F41: everything createVault will sign, checked and shown in full before the wallet
// opens. The challenge window is immutable and the horizon raise-only, so both are labelled.
async function reviewCreate() {
  const log = $("createLog");
  const out = $("cReview");
  // The pending create's status is in the log; a new review would wipe it.
  if (creating) return;
  clearCreateReview();
  const mine = createGeneration;
  const current = () => mine === createGeneration && !creating;
  log.textContent = "";
  if (!S.contract) {
    log.textContent = "Connect a wallet on a deployed network first.";
    return;
  }
  try {
    const asset = $("cAsset").value;
    let token = ZERO;
    if (asset.startsWith("token:")) {
      token = ethers.getAddress(asset.slice(6));
      if (!knownToken(token)) throw new Error("Pick the token again.");
    } else if (asset === "other") {
      token = parseAddress($("cToken").value, "Token contract address").address;
      if (same(token, chain().contract)) throw new Error("The token cannot be the Will & Key vault contract itself.");
      if (!knownToken(token)) {
        if (!(await hasCode(token))) throw new Error("There is no contract at that token address on this network.");
        if (!$("cTokenAck").checked) {
          throw new Error("This token is not on the known list. Read the warning under the asset and tick its box, or pick a known token.");
        }
      }
    } else if (asset !== "native") {
      throw new Error("Pick an asset.");
    }
    const tokenInfo = await meta(token);
    if (tokenInfo.decimals === null) throw new Error("This token's decimals() cannot be read, so amounts cannot be converted.");
    const amount = parseAmount($("cAmount").value, tokenInfo.decimals, "Amount");

    const entry = readAddressPair($("cHeir").value, $("cHeir2").value, "Heir's address");
    const heir = entry.address;
    // F41: compared with the heirs read now, not with whatever an earlier read left behind.
    const heirs = await loadKnownHeirs();
    if (!current()) return;
    const problem = heirProblem(heir, heirs);
    if (problem) {
      blockedBanner(out, problem, heir);
      return;
    }

    const periodDays = wholeDays("cPeriod", "The inactivity period", 7, 3650);
    const windowDays = wholeDays("cWindow", "The challenge window", 7, 365);
    const horizon = parseUtcDate($("cHorizon").value);
    if (horizon === null) throw new Error("Pick a real calendar date for the horizon (YYYY-MM-DD).");
    const now = await chainNow();
    const floor = floorNow(now) + periodDays * 86400 + HORIZON_MARGIN;
    const ceiling = now + MAX_HORIZON_DAYS * 86400 - HORIZON_MARGIN;
    if (horizon < floor) throw new Error(`The horizon must be ${utcDayCeil(floor)} or later: at least one inactivity period from now.`);
    if (horizon > ceiling) throw new Error(`The horizon must be ${utcDay(ceiling)} or earlier (at most ${MAX_HORIZON_DAYS} days from now).`);
    if (!$("cAlertAck").checked) throw new Error("Tick the box confirming you understand that Will & Key sends no alerts.");

    const fee = await loadFee();
    renderCreateFee();
    const heirIsContract = await hasCode(heir);
    const amountText = await fmtAmount(token, amount);
    if (!current()) return;
    const notes = [
      ["", "The vault is created by your connected wallet, which becomes its owner."],
      ["", HEIR_CHECK_STEP.replace("this vault", "the new vault")],
      ["warn", "The contract lets the owner change the inactivity period later, but this app does not offer that yet. Choose the period as if it were fixed."],
    ];
    if (windowDays < 14) notes.unshift(["warn", "A challenge window under 14 days leaves little time to notice a claim, and Will & Key sends no alerts. We recommend 14 days or more."]);
    if (windowDays > 90) notes.unshift(["warn", "A challenge window over 90 days delays every settlement to your heir by that long, and it can never be shortened."]);
    if (entry.unchecked) notes.push(["warn", "The heir's address was entered without checksum capitals, so a mistyped character would not be detected by its format. Your two entries matched; check it against the heir's wallet."]);
    if (heirIsContract) notes.push(["warn", "The heir's address is a smart contract. That is fine for a multisig or smart wallet your heir controls, but a contract that cannot send transactions can never claim."]);
    if (!tokenInfo.known) notes.unshift(["bad", "Unverified token: you acknowledged the risks above. Its growth, if any, is not inherited and can be swept by the admin."]);
    const assetValue = token === ZERO ? `native ${chain().coin}` : element("div");
    if (token !== ZERO) {
      assetValue.append(
        element("div", "", tokenInfo.known ? tokenInfo.symbol : `"${tokenInfo.symbol || "?"}" (unverified token)`),
        addressBlock(token, tokenInfo.known ? null : "bad"),
      );
    }
    const plan = {
      token, amount, heir, period: periodDays * 86400, challengeWindow: windowDays * 86400, horizon, quote: fee.bps,
    };
    const sign = button("Sign and create vault", "btn primary", () => signCreate(plan, sign));
    out.append(
      reviewList([
        ["Asset", assetValue],
        ["Amount", amountText],
        ["Heir", addressBlock(heir), { tone: "warn", text: "can be changed later" }],
        ["Inactivity period", `${periodDays} days`, { tone: "warn", text: "not changeable in this app" }],
        ["Challenge window", `${windowDays} days`, { tone: "bad", text: "immutable" }],
        ["Horizon", fmtUtc(horizon), { tone: "warn", text: "raise-only" }],
        ["Fee ceiling", `${pct(fee.bps)}: the current rate, snapshotted when your transaction is mined`, { tone: "bad", text: "fixed at creation" }],
        ["Current rate", `${pct(fee.bps)}. ${feeRuleText()}`],
        ["Alerts", "None. You confirmed that nobody will notify you if your timer expires or a claim is filed."],
      ]),
      noteList(notes),
      panelButtons(sign, button("Edit", "btn ghost", clearCreateReview)),
    );
  } catch (error) {
    if (current()) log.textContent = `Could not review: ${errorText(error)}`;
  }
}

// The Sign button is offered again only when nothing happened (runTx returned false). A create
// that was mined, or whose result is unknown, never gets a second signature from this review.
async function signCreate(plan, sign) {
  if (creating) return;
  creating = true;
  sign.disabled = true;
  $("createBtn").disabled = true;
  try {
    await sendCreate(plan, sign);
  } finally {
    creating = false;
    $("createBtn").disabled = false;
  }
}

async function sendCreate(plan, sign) {
  const log = $("createLog");
  const isNative = plan.token === ZERO;
  if (!isNative) {
    let approved;
    try {
      approved = await ensureAllowance(plan.token, plan.amount, log);
    } catch (error) {
      log.textContent = `Could not read the token allowance: ${errorText(error)}`;
      approved = false;
    }
    if (!approved) {
      if (approved === false) sign.disabled = false;
      return;
    }
  }
  const receipt = await runTx(log, "Create vault", () => S.contract.createVault(
    plan.token, plan.amount, plan.heir, plan.period, plan.challengeWindow, plan.horizon,
    { value: isNative ? plan.amount : 0n },
  ), clearCreateReview);
  if (!receipt) {
    if (receipt === false) sign.disabled = false;
    return;
  }
  // F06: the ceiling is whatever claimFeeBps was in the mined block; compare it with the quote.
  let created = null;
  for (const entry of receipt.logs || []) {
    if (!same(entry.address, chain().contract)) continue;
    try {
      const parsed = S.contract.interface.parseLog(entry);
      if (parsed?.name === "VaultCreated") created = parsed.args;
    } catch {
      // Not one of the vault's events.
    }
  }
  if (!created) return;
  const vaultId = Number(created.vaultId);
  followUp("createLog", "ok", `Vault #${vaultId} created. ${HEIR_CHECK_STEP.replace("this vault", `vault #${vaultId}`)}`);
  if (Number(created.feeBps) !== plan.quote) {
    followUp(
      "createLog", "bad",
      `The fee ceiling recorded on chain is ${pct(created.feeBps)}, not the ${pct(plan.quote)} shown before you ` +
      `signed: the rate changed before your transaction was mined. If you do not accept it, withdraw everything ` +
      `from vault #${vaultId} (no fee is charged on withdrawals) and create it again.`,
    );
  }
}

$("createBtn").addEventListener("click", reviewCreate);

// ---------------------------------------------------------------- heir tab
// The heir list shows either one owner's vaults (lookup by owner) or the vaults the search found.
// After a claim or finalize, refreshHeir re-reads whichever it was.

async function refreshHeir() {
  try {
    if (S.heirView?.found) await showFound();
    else if (S.heirView?.owner) await lookupOwner(S.heirView.owner);
  } catch (error) {
    notice($("heirList"), "bad", `Could not refresh: ${errorText(error)}`);
  }
}

$("hLookupBtn").addEventListener("click", async () => {
  const out = $("heirList");
  if (!S.contract) {
    notice(out, "warn", "Connect a wallet on a deployed network first.");
    return;
  }
  try {
    await lookupOwner(parseAddress($("hOwner").value, "Vault owner's address").address);
  } catch (error) {
    notice(out, "bad", `Lookup failed: ${errorText(error)}`);
  }
});

async function lookupOwner(owner) {
  const out = $("heirList");
  if (!S.fee) await loadFee();
  const [vaults, now] = await Promise.all([S.contract.getOpenVaults(owner), chainNow()]);
  const mine = vaults.filter((vault) => same(vault.beneficiary, S.account));
  // F41: a vault naming a look-alike of this wallet is how a poisoned heir address shows up.
  const lookalikes = vaults.filter((vault) => !same(vault.beneficiary, S.account)
    && lookalikeOf(vault.beneficiary, [S.account]));
  const shown = [];
  for (const vault of lookalikes) {
    const warn = element("div", "banner bad");
    warn.append(
      element(
        "p", "banner-copy",
        `Vault #${Number(vault.vaultId)} of this owner names an heir that looks like your wallet but is NOT ` +
        "your wallet. If you expected to inherit this vault, tell the owner, and read them your full address: " +
        "this is how address-poisoning scams redirect an inheritance.",
      ),
      addressRow("Vault names", vault.beneficiary, "bad"),
      addressRow("Your wallet", S.account),
    );
    shown.push(warn);
  }
  for (const vault of mine) shown.push(await vaultCard(vault, "heir", now));
  if (mine.length === 0) {
    const none = element("div", "banner warn", "No open vaults at that address name your wallet as heir.");
    shown.unshift(none);
  }
  S.heirView = { owner };
  out.replaceChildren(...shown);
}

// ---------------------------------------------------------------- heir search (F44)
// v1 has no lookup by heir, so the search reads the contract's VaultCreated and BeneficiaryChanged
// logs whose indexed heir (topic 3) is the connected wallet, from the deployment block on, confirms
// every hit with getVault and shows only open vaults that name this wallet NOW. It tries the
// wallet's own connection first (often one call for the whole history) and falls back to the
// chain's public endpoint, which the CSP's connect-src allows. Logs are untrusted data: a hit is
// only ever a candidate for getVault, and a connection that leaves logs out can make the search
// incomplete, which the result always says.

// A rate limit, recognised from the error's own fields: the HTTP status, the JSON-RPC code, or the
// server's message. The error is never searched as one string: ethers puts the whole request in
// its message (payload={... "id":429 ...}), and request number 429 is not HTTP 429. `error.error`
// is the server's { code, message } inside an ethers wrapper; rpcCall errors carry them directly.
function isRateLimited(error) {
  const inner = error?.error ?? error?.info?.error ?? null;
  const data = inner?.data ?? error?.data ?? null;
  if ([error?.status, inner?.status, data?.httpStatus].includes(429)) return true;
  if ([error?.code, inner?.code, data?.code].includes(-32016)) return true;
  const messages = [error?.shortMessage ?? error?.message, inner?.message, data?.message];
  return messages.some((text) => typeof text === "string" && /rate.?limit|over rate|too many requests/i.test(text));
}

function withTimeout(promise, ms) {
  let timer = null;
  const expiry = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// One JSON-RPC call to a public endpoint, keeping the HTTP status for the rate-limit check.
async function rpcCall(url, method, params) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (body?.error) {
    throw Object.assign(new Error(String(body.error.message || "RPC error")), { status: response.status, code: body.error.code });
  }
  if (!response.ok || !body || !("result" in body)) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  return body.result;
}

// Where logs can be read, in order of preference. `span` is the first range tried per call.
function logSources() {
  const sources = [{
    label: "your wallet's connection",
    span: WALLET_LOG_SPAN,
    head: () => S.provider.getBlockNumber(),
    logs: (filter) => S.provider.send("eth_getLogs", [filter]),
  }];
  const url = chain().rpc;
  if (url) {
    sources.push({
      label: `the public endpoint ${new URL(url).host}`,
      span: chain().logSpan || MIN_LOG_SPAN,
      head: async () => Number(await rpcCall(url, "eth_blockNumber", [])),
      logs: (filter) => rpcCall(url, "eth_getLogs", [filter]),
    });
  }
  return sources;
}

// One call, retried with backoff while the source says it is rate-limited.
async function askSource(call) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTimeout(call(), LOG_CALL_TIMEOUT);
    } catch (error) {
      if (!isRateLimited(error) || attempt >= RATE_WAITS.length) throw error;
      await sleep(RATE_WAITS[attempt]);
    }
  }
}

async function fetchLogs(source, filter) {
  const logs = await askSource(() => source.logs(filter));
  if (!Array.isArray(logs)) throw new Error("the answer was not a list of logs");
  return logs;
}

// A connection that returns nothing for a block known to hold a VaultCreated event does not serve
// logs that old, and its empty answers would look like "no vaults".
async function servesHistory(source) {
  const block = chain().logCanary;
  if (!block) return true;
  const logs = await fetchLogs(source, {
    address: chain().contract,
    topics: [S.contract.interface.getEvent("VaultCreated").topicHash],
    fromBlock: ethers.toQuantity(block), toBlock: ethers.toQuantity(block),
  });
  return logs.length > 0;
}

// Reads blocks [from, to] from one source and returns { next, error }: `next` is the first block
// not read. A refused range shrinks the chunk down to MIN_LOG_SPAN; a failure at that size, or a
// rate limit that outlasts the backoff, ends this source's turn.
async function scanSource(source, filter, from, to, onLogs, onProgress) {
  let span = source.span;
  let cursor = from;
  while (cursor <= to) {
    if (S.heirScan.stop) return { next: cursor, error: null };
    const end = Math.min(cursor + span - 1, to);
    try {
      onLogs(await fetchLogs(source, { ...filter, fromBlock: ethers.toQuantity(cursor), toBlock: ethers.toQuantity(end) }));
      cursor = end + 1;
      onProgress(cursor, source);
    } catch (error) {
      if (span <= MIN_LOG_SPAN || isRateLimited(error)) return { next: cursor, error };
      span = Math.max(MIN_LOG_SPAN, Math.floor((end - cursor + 1) / 8));
    }
  }
  return { next: cursor, error: null };
}

const fmtBlock = (number) => Number(number).toLocaleString("en-US");

function heirScanButtons(running) {
  $("hScanBtn").disabled = running;
  $("hScanStop").hidden = !running;
}

$("hScanStop").addEventListener("click", () => {
  if (S.heirScan) S.heirScan.stop = true;
  $("hScanLog").textContent = "Stopping after the current request...";
});

$("hScanBtn").addEventListener("click", async () => {
  const log = $("hScanLog");
  const config = chain();
  if (!S.contract) {
    log.textContent = "Connect a wallet on a deployed network first.";
    return;
  }
  if (!config.logsFrom) {
    log.textContent = "The search is not available on this network. Ask for the vault owner's address and use Look up.";
    return;
  }
  // One search per page load (a new wallet or network reloads the page). A second click continues
  // a stopped or failed search, or reads only the blocks added since the last one finished.
  if (!S.heirScan) S.heirScan = { next: config.logsFrom, candidates: new Map(), summary: null, running: false, stop: false };
  const scan = S.heirScan;
  if (scan.running) return;
  scan.running = true;
  scan.stop = false;
  heirScanButtons(true);
  const failures = [];
  const used = [];
  let target = null;
  try {
    target = await S.provider.getBlockNumber();
    const events = S.contract.interface;
    const filter = {
      address: config.contract,
      topics: [
        [events.getEvent("VaultCreated").topicHash, events.getEvent("BeneficiaryChanged").topicHash],
        null, null, ethers.zeroPadValue(S.account, 32),
      ],
    };
    const collect = (logs) => {
      for (const entry of logs) {
        if (!same(entry.address, config.contract)) continue;
        let parsed = null;
        try {
          parsed = events.parseLog(entry);
        } catch {
          parsed = null;
        }
        if (parsed?.name !== "VaultCreated" && parsed?.name !== "BeneficiaryChanged") continue;
        // Defence in depth against a connection that ignores the topic filter.
        const heir = parsed.name === "VaultCreated" ? parsed.args.beneficiary : parsed.args.newBeneficiary;
        if (!same(heir, S.account)) continue;
        const owner = ethers.getAddress(parsed.args.owner);
        scan.candidates.set(heirKey(owner, parsed.args.vaultId), { owner, vaultId: parsed.args.vaultId });
      }
    };
    const progress = (cursor, source) => {
      const done = Math.min(100, Math.floor(((cursor - config.logsFrom) / Math.max(1, target + 1 - config.logsFrom)) * 100));
      log.textContent = `Searching blocks ${fmtBlock(config.logsFrom)}-${fmtBlock(target)} through ${source.label}: ` +
        `${done}% done, ${scan.candidates.size} record${scan.candidates.size === 1 ? "" : "s"} naming your wallet so far.`;
    };
    log.textContent = "Starting the search...";
    for (const source of logSources()) {
      if (scan.next > target || scan.stop) break;
      try {
        if (!(await servesHistory(source))) {
          failures.push(`${source.label} returned no records for a block known to hold one, so it was not used`);
          continue;
        }
        // A range past a source's own head is refused, so each source reads up to its own head.
        const until = Math.min(target, Number(await askSource(() => source.head())));
        const before = scan.next;
        const result = await scanSource(source, filter, scan.next, until, collect, progress);
        scan.next = result.next;
        if (scan.next > before) used.push(source.label);
        if (result.error) failures.push(`${source.label}: ${errorText(result.error)}`);
      } catch (error) {
        failures.push(`${source.label}: ${errorText(error)}`);
      }
    }
  } catch (error) {
    failures.push(errorText(error));
  }
  // target stays null when the latest block could not be read: then nothing is claimed complete.
  scan.summary = {
    from: config.logsFrom, searchedTo: scan.next - 1, target: target === null ? null : Math.max(target, scan.next - 1),
    stopped: scan.stop, failures, used,
  };
  // The previous result stays on screen until the new one replaces it, so the search counts as
  // running (button disabled) until then.
  $("hScanStop").hidden = true;
  S.heirView = { found: true };
  log.textContent = `Checking ${scan.candidates.size} record${scan.candidates.size === 1 ? "" : "s"} on chain...`;
  try {
    await showFound();
    log.textContent = "";
  } catch (error) {
    log.textContent = "";
    notice($("heirList"), "bad", `The search finished, but its results could not be checked: ${errorText(error)}`);
  }
  scan.running = false;
  scan.stop = false;
  heirScanButtons(false);
  const finished = scan.summary.target !== null && scan.next > scan.summary.target;
  $("hScanBtn").textContent = finished ? "Search again (new blocks only)" : "Continue the search";
});

// Confirms every candidate with getVault and renders the ones this wallet can act on now.
async function showFound() {
  const scan = S.heirScan;
  const summary = scan.summary;
  const out = $("heirList");
  if (!S.fee) await loadFee();
  const now = await chainNow();
  const cards = [];
  let elsewhere = 0;
  let unconfirmed = 0;
  for (const candidate of scan.candidates.values()) {
    let vault;
    try {
      vault = await S.contract.getVault(candidate.owner, candidate.vaultId);
    } catch {
      unconfirmed += 1;
      continue;
    }
    const state = Number(vault.state);
    if (same(vault.beneficiary, S.account) && (state === 1 || state === 2)) cards.push(await vaultCard(vault, "heir", now));
    else elsewhere += 1;
  }

  const head = element("div", "banner warn");
  const say = (text, className = "banner-copy") => head.append(element("p", className, text));
  const complete = summary.target !== null && summary.searchedTo >= summary.target;
  say(cards.length
    ? `${cards.length} open vault${cards.length === 1 ? " names" : "s name"} your wallet as heir.`
    : "No open vault names your wallet as heir in the blocks searched.", "banner-copy claim-head");
  const through = summary.used.length ? ` Latest pass read through ${summary.used.join(", then ")}.` : "";
  if (complete) {
    say(`Searched every block from the contract's deployment (${fmtBlock(summary.from)}) to ` +
      `${fmtBlock(summary.searchedTo)}.${through}`);
  } else if (summary.target === null) {
    say("INCOMPLETE: the latest block number could not be read, so the search could not run. Press " +
      "\"Continue the search\" to try again.");
    for (const failure of summary.failures) say(`Connection problem: ${failure}.`);
  } else {
    const searched = summary.searchedTo >= summary.from
      ? `searched blocks ${fmtBlock(summary.from)}-${fmtBlock(summary.searchedTo)}; blocks ` : "blocks ";
    say(`INCOMPLETE: ${searched}${fmtBlock(summary.searchedTo + 1)}-${fmtBlock(summary.target)} were not searched` +
      `${summary.stopped ? " because you stopped the search" : ""}. Press "Continue the search" to go on.${through}`);
    for (const failure of summary.failures) say(`Connection problem: ${failure}.`);
  }
  if (elsewhere) {
    say(`${elsewhere} earlier record${elsewhere === 1 ? "" : "s"} for your wallet no longer appl${elsewhere === 1 ? "ies" : "y"}: ` +
      "that vault now names a different heir, or has settled or closed.");
  }
  if (unconfirmed) say(`${unconfirmed} record${unconfirmed === 1 ? "" : "s"} could not be checked on chain and ${unconfirmed === 1 ? "is" : "are"} not shown. Search again later.`);
  say("This search may be incomplete: it relies on a network connection returning every record, and one can " +
    "leave records out. If you expect a vault that is not listed, ask for the owner's address and use Look up.");
  // F36: anyone can create a vault naming any address.
  say("Anyone can create a vault that names any address, so a vault here is not proof that someone you know " +
    "left it. Check that the owner's address belongs to someone you know. Claiming never requires approving a " +
    "token or sending anyone funds.");
  out.replaceChildren(head, ...cards);
}

$("crCheckBtn").addEventListener("click", async () => {
  const log = $("crLog");
  if (!S.contract) {
    log.textContent = "Connect a wallet on a deployed network first.";
    return;
  }
  try {
    const raw = $("crToken").value.trim();
    const token = raw ? parseAddress(raw, "Token").address : ZERO;
    const owed = await S.contract.creditOf(token, S.account);
    log.replaceChildren(document.createTextNode(`Owed to you: ${await fmtAmount(token, owed)}`));
    if (token !== ZERO) log.append(tokenRow(token));
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
  document.querySelectorAll("#tabs button").forEach((candidate) => {
    candidate.classList.toggle("active", candidate === selected);
    candidate.setAttribute("aria-selected", String(candidate === selected));
  });
  document.querySelectorAll(".tab-pane").forEach((pane) => { pane.hidden = true; });
  $(`tab-${selected.dataset.tab}`).hidden = false;
});

$("connectBtn").addEventListener("click", (event) => {
  event.preventDefault();
  connect().catch(connectFailed);
});

(() => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 20);
  $("cHorizon").value = date.toISOString().slice(0, 10);
})();

if (window.ethereum?.selectedAddress) connect().catch(connectFailed);
