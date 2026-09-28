/* Will & Key app for the v2 vault contract. Plain JS + self-hosted ethers v6 UMD. No build step. */

"use strict";

// Per-chain configuration.
// - `contract`, `deployBlock` and `codehash` name the v2 deployment: its address, the block it was
//   created in and the keccak-256 of its runtime code (its EXTCODEHASH). Until the launch values
//   are filled in (scripts/set-launch-values.js), they hold placeholders, and the app says v2 is
//   not yet deployed on that network. On every connect the app compares the code at `contract`
//   with `codehash` and refuses a contract whose code differs, so a wrong address in this table
//   can never be served as the vault.
// - The contract's own supportedTokens() decides what a vault can hold: the list was fixed when the
//   contract was deployed, and the contract refuses every other token. `tokens` is the app's table
//   of names and decimals for them. A listed token is offered for deposits only when its symbol()
//   and decimals() on chain match this table, which is checked on every connect. Every entry was
//   also checked read-only on 2026-09-27 (name, symbol and decimals).
// - `v1` is the retired v1 contract, read only to tell a wallet what it still has there. `v1` and
//   `billing` (the retired reminder-billing contract) are refused as heirs and payout addresses:
//   neither can collect anything credited to it on v2.
const CHAINS = {
  84532: {
    name: "Base Sepolia", explorer: "https://sepolia.basescan.org",
    hex: "0x14a34", rpc: "https://sepolia.base.org", coin: "ETH", testnet: true,
    // The testnet deployment: `node scripts/set-launch-values.js --chain 84532 ...` fills these in.
    contract: "BASE_SEPOLIA_V2_ADDRESS_UNSET", deployBlock: "BASE_SEPOLIA_V2_BLOCK_UNSET",
    codehash: "BASE_SEPOLIA_V2_KECCAK_UNSET",
    logSpan: 2000,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0x4200000000000000000000000000000000000006" },
      { symbol: "USDC", name: "USDC", decimals: 6, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    ],
  },
  8453: {
    name: "Base", explorer: "https://basescan.org",
    hex: "0x2105", rpc: "https://mainnet.base.org", coin: "ETH", testnet: false,
    contract: "0xA07b59d9249A996604A5fF482f1E564EdeE3A774", deployBlock: "51900754",
    codehash: "1b3c172193ad01100daefcbd31e16682210462a7455a50908e65c72b2d077f1b",
    // The public endpoint's eth_getLogs limit (blocks per call), for the heir search.
    logSpan: 2000,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    v1: "0xC821849A1D74959753450409b594b23eCE7fEe2f",
    billing: "0x60749aF621180de1DC05DB4f3d158D09dE979dC6",
    tokens: [
      { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      { symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0x4200000000000000000000000000000000000006" },
      { symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
      { symbol: "EURC", name: "EURC", decimals: 6, address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
    ],
  },
  // BNB Chain comes later: no v2 deployment yet.
  97: {
    name: "BNB Testnet", explorer: "https://testnet.bscscan.com",
    hex: "0x61", rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", coin: "tBNB", testnet: true,
    contract: "", deployBlock: "", codehash: "",
    wrappedNative: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    tokens: [],
  },
  56: {
    name: "BNB Chain", explorer: "https://bscscan.com",
    hex: "0x38", rpc: "https://bsc-dataseed.bnbchain.org", coin: "BNB", testnet: false,
    contract: "", deployBlock: "", codehash: "",
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
const MAX_HORIZON_DAYS = 36500;
// Slack for the time between review and mining: the contract checks the horizon floor against the
// block timestamp, so a date that only just clears it at review time could revert when mined.
const HORIZON_MARGIN = 3600;
// Address poisoners match the first and last few hex characters of an address the victim already
// uses. Four is the strictest useful width: an innocent collision on either end is 1 in 32,768.
const LOOKALIKE_HEX = 4;
const TEN_YEARS = 3653 * 86400;
// A vault's balance is a uint128 on chain.
const MAX_VAULT_UNITS = (1n << 128n) - 1n;
// Heir search (F44). Measured on https://mainnet.base.org on 2026-09-26: eth_getLogs refuses more
// than 2,000 blocks (-32614), a range past its head (-32602), and more than 10 calls per batch;
// after a burst of about 25 calls it answers HTTP 429 / -32016 "over rate limit", while one call
// at a time ran a 1,040-chunk history clean in about 5.5 minutes. So the search sends one call at
// a time, backs off on a rate limit, and shrinks the range when a connection refuses one.
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
// The retired v1 contract, read only for the notice about what a wallet still has there.
const V1_ABI = [
  "function creditOf(address token, address account) view returns (uint256)",
  "function openVaultIds(address vaultOwner) view returns (uint64[])",
];

// The fixed addresses v2's _checkPayee refuses on every chain, besides the vault itself and every
// token it lists (ForbiddenPayoutAddress): payees that keep what they are sent, but book it to the
// vault contract, which can never collect it (PAYOUT ADDRESSES in the contract's NatSpec).
// The OP-stack predeploys are 0x4200...0000 to 0x4200...07FF: the contract compares address >> 11.
const OP_PREDEPLOY_PREFIX = BigInt("0x4200000000000000000000000000000000000000") >> 11n;
const ENTRYPOINTS = [
  { address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", version: "v0.6" },
  { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: "v0.7" },
  { address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", version: "v0.8" },
  { address: "0x433709009B8330FDa32311DF1C2AFA402eD8D009", version: "v0.9" },
];
const VENUS_VBNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";

// checkInMany logs CheckInSkipped(owner, vaultId, reason) for every vault it does not check in;
// `reason` is one of the contract's SKIP_* constants. Each gets its plain meaning, its remedy and
// the remedy buttons (see skipActions). Reason 7 is the one where Veto no longer works.
const SKIP_REASONS = {
  1: { reason: "your wallet has no vault with this number", remedy: "", act: [] },
  2: { reason: "it has settled or closed", remedy: "Nothing can be checked in on it any more.", act: [] },
  3: {
    reason: "a claim is pending on it",
    remedy: "A check-in never cancels a claim. Veto the claim.",
    act: ["veto"],
  },
  4: {
    reason: "it has reached its horizon",
    remedy: "Check-ins no longer work on it, and your heir can start a claim at any time. Extend the horizon.",
    act: ["extend"],
  },
  5: {
    reason: "its deadline already sits at the horizon, so a check-in cannot move it",
    remedy: "At the horizon your heir can claim. Extend the horizon to keep checking in.",
    act: ["extend"],
  },
  6: {
    reason: "it was already checked in at this second",
    remedy: "Nothing is wrong: its deadline already moved in this block.",
    act: [], ok: true,
  },
  7: {
    reason: "a claim is pending on it and it has reached its horizon",
    remedy: "Veto no longer works here, and a check-in never cancels a claim. Only extending the horizon to at " +
      "least one full check-in period from now, or withdrawing everything, stops this claim, and only if it is " +
      "mined before someone finalizes the claim.",
    act: ["stop", "close"],
  },
};

const S = {
  provider: null, signer: null, account: null, chainId: null, contract: null,
  // The v2 deployment on this chain: its address, the block it was created in, and the
  // keccak-256 of its runtime code.
  address: null, deployBlock: null, codehash: null,
  // A transaction that was sent but whose result could not be read: { hash, label, ... }, or
  // null. While it is set, the page signs nothing else (see holdUnsettled).
  unsettled: null,
  // True once the contract's settings (tokens, pause, constants) have been read on this page load.
  ready: false,
  // supportedTokens(), checksummed; each one's metadata by lower-case address (see loadTokens).
  listed: [], tokens: new Map(), wrappedNative: null, paused: false,
  // Listed tokens the create form does not offer, with the reason (see fillAssetOptions).
  assetProblems: [],
  pushGrace: null, feeDelay: null,
  fee: null, heirs: [],
  // What the heir tab shows: { owner } after a lookup by owner, { found: true } after a search.
  heirView: null,
  // The heir search's progress for this page load: { next, candidates, summary, running, stop }.
  heirScan: null,
};

const $ = (id) => document.getElementById(id);
const chain = () => CHAINS[S.chainId];
const short = (address) => address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
const same = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
const pct = (bps) => `${Number(bps) / 100}%`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const stateName = (state) => (STATES[Number(state)] || "in another state").toLowerCase();

// The v2 deployment in a chain's configuration, or null while it still holds placeholders. The
// code hash is written as 64 hex characters, with or without 0x (set-launch-values.js fills in the
// same bare hex the security page shows).
function deployment(config) {
  const address = String(config?.contract ?? "");
  const block = String(config?.deployBlock ?? "");
  const hash = String(config?.codehash ?? "").replace(/^0x/i, "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^[1-9]\d*$/.test(block) || !/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  try {
    return { address: ethers.getAddress(address), block: Number(block), codehash: `0x${hash.toLowerCase()}` };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- errors
// Every v2 custom error in plain words. ethers decodes the contract's custom errors into
// error.revert ({ name, args }); each entry turns the arguments into the sentence.

const vaultWord = (state) => (Number(state) === 3 ? "settled" : "closed");
// The app pays a credit only to the connected wallet itself. The contract lets the credited
// wallet send it anywhere with withdrawCredit(token, to), which the explorer's Write Contract tab
// can call.
const ELSEWHERE = "to have it paid to an ordinary wallet address instead, call withdrawCredit(token, to) from " +
  "the credited wallet on the vault contract's Write Contract tab on the explorer, with the token's address " +
  "(0x0000000000000000000000000000000000000000 for the coin) and that wallet address.";
// Solidity's Panic(uint256) codes.
const PANIC_REASONS = {
  0x01: "a failed assertion", 0x11: "an arithmetic overflow or underflow", 0x12: "a division by zero",
  0x21: "an invalid enum value", 0x22: "a corrupt storage byte array", 0x31: "a pop from an empty array",
  0x32: "an array index out of bounds", 0x41: "an out-of-memory condition", 0x51: "a call to an invalid function",
};

const REVERT_HELP = {
  BadCheckIn: () => "That check-in chain value is not the next one for this vault.",
  BatchTooLarge: ([given, maximum]) => `Too many vaults in one batch (${given}; at most ${maximum}).`,
  BeneficiaryIsOwner: () => "The owner cannot be the heir.",
  CannotPayToSelf: () => "That address is the vault contract itself, which can never be paid.",
  ChallengeWindowOpen: ([finalizableAt]) =>
    `The challenge window is still open: the claim can be finalized from ${fmtLocal(finalizableAt)}.`,
  CheckInAlreadyUsed: () => "This vault was already checked in at this second, or that chain value was already used.",
  CheckInChainEpochMismatch: () => "That check-in chain was built for another installation on this vault.",
  CheckInChainExhausted: () => "This vault's paper check-in chain is used up.",
  ClaimPendingUseAbort: () => "A claim is pending on this vault, and a check-in does not cancel it. Use Veto.",
  CreationIsPaused: () =>
    "New-vault creation is paused on this contract by its admin. Existing vaults and every way out of them keep working.",
  DeadlinePinnedAtHorizon: ([horizon]) =>
    `The deadline already sits at the horizon (${fmtUtc(horizon)}), so a check-in cannot move it. Extend the ` +
    "horizon to keep checking in.",
  FeeRaiseNotDue: ([effectiveAt]) => `The announced fee raise takes effect only at ${fmtLocal(effectiveAt)}.`,
  FeeTooHigh: ([given, maximum]) => `A fee of ${pct(given)} is above the contract's cap of ${pct(maximum)}.`,
  ForbiddenPayoutAddress: ([to]) =>
    `The vault contract refuses ${to} as a payout address: it is a token the contract lists, an OP-stack system ` +
    "contract, an ERC-4337 EntryPoint or the Venus vBNB market, and a payment there would be lost.",
  HorizonNotExtended: ([current]) => `The new horizon must be later than the current one (${fmtUtc(current)}).`,
  HorizonReached: ([horizon]) =>
    `This vault reached its horizon on ${fmtUtc(horizon)}, so this action no longer works. Past the horizon a ` +
    "pending claim is stopped only by extending the horizon or by withdrawing everything.",
  HorizonTooFar: ([, maximum]) => `That horizon is too far away: the latest the contract accepted was ${fmtUtc(maximum)}.`,
  HorizonTooSoon: ([minimum]) =>
    `That horizon is too soon: when mined it had to be ${fmtUtc(minimum)} or later (one full check-in period ` +
    "after the block).",
  InsufficientBalance: ([available, requested]) =>
    `That is more than is available (${available} base units available, ${requested} requested).`,
  InvalidChallengeWindow: ([given]) => `The challenge window must be 7 to 365 days, not ${Number(given) / 86400} days.`,
  InvalidCheckInChain: () => "That check-in chain setting is not valid.",
  InvalidPeriod: ([given]) => `The inactivity period must be 7 to 3650 days, not ${Number(given) / 86400} days.`,
  InvalidTokenConfig: ([token]) => `The contract's token list refused ${token}.`,
  NativeAmountMismatch: ([sent, declared]) => `The coin sent (${sent}) does not match the amount declared (${declared}).`,
  NativeTransferFailed: ([to]) =>
    `${to} refused the payment: it cannot receive the coin. The credit is kept. This app pays a credit only to ` +
    `the wallet it belongs to; ${ELSEWHERE}`,
  NoClaimPending: () => "No claim is pending on this vault any more.",
  NoFeeRaisePending: () => "No fee raise is pending.",
  NoSuchVault: ([owner, id]) => `${owner} has no vault #${id}.`,
  NoSurplus: () => "There is no surplus to sweep.",
  NotTheBeneficiary: ([, beneficiary]) =>
    `Only the vault's current heir can do this, and the connected wallet is not it (the heir is ${beneficiary}).`,
  NotYetExpired: ([deadline]) =>
    `The owner's deadline (${fmtLocal(deadline)}) has not passed, so a claim cannot start yet.`,
  NothingCheckedIn: ([skipped]) => `None of the vaults sent could be checked in. ${skipBitsText(skipped)}`,
  NothingCredited: () => "Nothing is credited to your wallet in this asset.",
  NothingReceived: () => "The token transfer delivered nothing to the vault contract.",
  NothingToClaim: () => "This vault holds nothing to claim.",
  OwnableInvalidOwner: () => "Only the contract's admin can do this.",
  OwnableUnauthorizedAccount: () => "Only the contract's admin can do this.",
  PayoutOverdebited: ([, debited, amount]) =>
    `The token took ${debited} base units from the vault contract to pay ${amount}, so the payout was refused. ` +
    "The credit is kept.",
  PayoutReturned: ([to]) =>
    `${to} sent value back to the vault contract while it was being paid, so the payout was refused. The credit ` +
    `is kept. This app pays a credit only to the wallet it belongs to; ${ELSEWHERE}`,
  PayoutShortfall: ([, debited, amount]) =>
    `The token reported a transfer but moved only ${debited} of the ${amount} base units, so the payout was ` +
    "refused and the credit is kept. Try again later, or withdraw a smaller part.",
  PushTooEarly: ([pushableAt]) => `Only the credited address itself can push this credit before ${fmtLocal(pushableAt)}.`,
  ReentrancyGuardReentrantCall: () => "The vault contract refused a call made while another of its operations was running.",
  RenounceDisabled: () => "The contract's admin role cannot be renounced.",
  SafeCastOverflowedUintDowncast: () => "That amount is too large for a vault.",
  SafeERC20FailedOperation: ([token]) =>
    `The token contract ${token} refused the transfer. Check your balance and the amount you approved.`,
  TooManyOpenVaults: ([maximum]) => `You already have ${maximum} open vaults, the most one wallet can have. Close one first.`,
  UnexpectedNativeValue: () => "Coin was sent with a token deposit, so nothing was deposited.",
  UnsupportedToken: ([token]) =>
    `The vault contract does not accept ${token}: a vault holds only the native coin or one of the tokens the ` +
    "contract lists.",
  UseTopUp: () => "The vault contract does not accept plain payments: use Top up.",
  VaultNotActive: ([, state]) =>
    `The vault is not active (it is ${stateName(state)}): a claim is pending on it, or it has settled or closed.`,
  VaultTerminal: ([, state]) => `This vault has already ${vaultWord(state)}, so nothing more can be done with it.`,
  ZeroAddress: () => "That address is not allowed: the zero address, or the vault contract itself.",
  ZeroAmount: () => "Enter an amount above zero.",
};

// The reasons NothingCheckedIn carries: bit r is set when some vault was skipped for SKIP reason r.
function skipBitsText(bits) {
  const reasons = Object.keys(SKIP_REASONS).map(Number).filter((code) => (Number(bits) >> code) & 1)
    .map((code) => `${SKIP_REASONS[code].reason} (${SKIP_REASONS[code].remedy || "nothing to do"})`);
  return reasons.length ? `The contract's reasons: ${reasons.join("; ")}.` : "";
}

// ethers decodes a custom error into error.revert only for a static call. A transaction whose gas
// estimate reverts, and a call made through the provider, carry the raw revert data instead
// ("execution reverted (unknown custom error)"), so the vault's own interface decodes it here.
// It also decodes Solidity's own Error(string) and Panic(uint256): a token's revert reason, which
// SafeERC20 passes through, arrives as Error(string). Data that is none of these (another
// contract's custom error) is left to the generic text.
function revertOf(error) {
  if (error?.revert?.name) return error.revert;
  const found = [error?.data, error?.info?.error?.data, error?.error?.data, error?.info?.error?.data?.data, error?.error?.data?.data];
  for (const data of found) {
    if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8}/.test(data) || !S.contract) continue;
    try {
      const parsed = S.contract.interface.parseError(data);
      if (parsed) return { name: parsed.name, args: parsed.args };
    } catch {
      // Not one of the vault's errors.
    }
  }
  return null;
}

function errorText(error) {
  const revert = revertOf(error);
  // The vault contract reverts only with its custom errors, so a reason string comes from the
  // contract it called (a token blocking an address, or paused) and is shown as that contract's
  // own words, never in place of them.
  if (revert?.name === "Error") {
    const reason = cleanText(revert.args?.[0] ?? "", 200).trim();
    return reason
      ? `the token contract, or another contract the transaction called, refused it with the message "${reason}"`
      : "the token contract, or another contract the transaction called, refused it without giving a reason";
  }
  if (revert?.name === "Panic") {
    let code = null;
    try {
      code = Number(BigInt(revert.args?.[0] ?? 0));
    } catch {
      code = null;
    }
    const what = PANIC_REASONS[code] || "an internal error";
    return `the transaction stopped on ${what} (Solidity panic${code === null ? "" : ` 0x${code.toString(16).padStart(2, "0")}`})`;
  }
  if (revert?.name) {
    let text = null;
    try {
      text = REVERT_HELP[revert.name]?.([...(revert.args || [])]) ?? null;
    } catch {
      text = null;
    }
    return text ? `${text} (${revert.name})` : `the contract refused it (${revert.name})`;
  }
  if (error?.code === "ACTION_REJECTED" || error?.info?.error?.code === 4001 || error?.error?.code === 4001) {
    return "you declined it in your wallet";
  }
  // ethers reports any failed eth_call as "missing revert data" and an error it does not recognise
  // as "could not coalesce error"; the connection's own message (a rate limit, say) is inside.
  const inner = error?.info?.error?.message || error?.error?.message;
  const wrapped = error?.code === "UNKNOWN_ERROR" || (error?.code === "CALL_EXCEPTION" && error?.data == null && !error?.revert);
  if (inner && wrapped) return `the network connection returned an error: ${cleanText(inner, 200)}`;
  return cleanText(error?.reason || error?.shortMessage || error?.message || String(error), 400);
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
  const minutes = Math.floor((Math.abs(delta) % 3600) / 60);
  let span = `${minutes}m`;
  if (days > 0) span = `${days}d ${hours}h`;
  else if (hours > 0) span = `${hours}h`;
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
// block can be read. The block is asked of the connection directly: the provider's getBlock
// ("latest") can answer from its own cache of the last quarter second, and a deadline checked at
// signing (the heir's cancel, a horizon floor) must see the newest block.
async function chainNow() {
  try {
    const block = await S.provider.send("eth_getBlockByNumber", ["latest", false]);
    const timestamp = Number(block?.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("no block timestamp");
    return timestamp;
  } catch {
    return deviceNow();
  }
}

// For floors only (the earliest date a transaction will accept when mined), the later of chain
// time and the device clock: erring late there costs a day, erring early costs a revert.
const floorNow = (now) => Math.max(Number(now), deviceNow());

// ---------------------------------------------------------------- tokens

// Strips control and bidi characters from text the app did not write (a token's symbol, a
// connection's error message) and caps its length.
function cleanText(text, max) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max);
}

function cleanLabel(text) {
  return cleanText(text, 24);
}

// Reads supportedTokens() and wrappedNative(), and checks every listed token's symbol() and
// decimals() against the app's table. Only a listed token that matches the table is `verified`,
// and only a verified token is offered for deposits. A listed token outside the table, or one
// that disagrees with it or cannot be read, is shown with its problem and never offered.
async function loadTokens() {
  const [listed, wrapped] = await Promise.all([S.contract.supportedTokens(), S.contract.wrappedNative()]);
  S.listed = listed.map((address) => ethers.getAddress(address));
  S.wrappedNative = same(wrapped, ZERO) ? null : ethers.getAddress(wrapped);
  const entries = await Promise.all(S.listed.map(checkToken));
  S.tokens = new Map(entries.map((entry) => [entry.address.toLowerCase(), entry]));
}

async function checkToken(address) {
  const known = (chain().tokens || []).find((token) => same(token.address, address)) || null;
  const contract = new ethers.Contract(address, ERC20_ABI, S.provider);
  let symbol = null;
  let decimals = null;
  try {
    const [rawSymbol, rawDecimals] = await Promise.all([contract.symbol(), contract.decimals()]);
    symbol = cleanLabel(rawSymbol);
    decimals = Number(rawDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) decimals = null;
  } catch {
    symbol = null;
    decimals = null;
  }
  const entry = {
    address, known: Boolean(known), verified: false,
    symbol: known ? known.symbol : symbol, name: known ? known.name : null, decimals: known ? known.decimals : decimals,
    problem: null,
  };
  if (!known) {
    entry.problem = "it is not in this app's table of tokens, so its name and decimals are unchecked";
  } else if (symbol === null || decimals === null) {
    entry.problem = "its symbol and decimals could not be read on chain just now (reload the page to try again)";
  } else if (symbol !== known.symbol || decimals !== known.decimals) {
    entry.problem = `on chain it reports "${symbol}" with ${decimals} decimals, but the app expects ${known.symbol} ` +
      `with ${known.decimals}`;
    entry.symbol = symbol;
    entry.decimals = decimals;
  } else {
    entry.verified = true;
  }
  return entry;
}

function tokenInfo(token) {
  if (same(token, ZERO)) return { native: true, verified: true, symbol: chain().coin, decimals: 18, problem: null };
  return S.tokens.get(String(token).toLowerCase()) || {
    address: token, known: false, verified: false, symbol: null, decimals: null,
    problem: "the vault contract does not list it",
  };
}

// A token that is not verified never gets a bare symbol: its symbol is whatever the chain reported.
function amountText(token, amount) {
  const info = tokenInfo(token);
  if (info.decimals === null) return `${BigInt(amount).toString()} base units (unverified token)`;
  const value = ethers.formatUnits(amount, info.decimals);
  if (info.verified) return `${value} ${info.symbol}`;
  return `${value} "${info.symbol || "?"}" (unverified token)`;
}

function tokenRow(token) {
  if (same(token, ZERO)) return element("div", "", `Asset: native ${chain().coin}`);
  const info = tokenInfo(token);
  const row = addressRow(info.verified ? `Token ${info.symbol}` : "Unverified token", token, info.verified ? null : "bad");
  if (info.verified) return row;
  const box = element("div");
  box.append(row, element(
    "div", "warning-text",
    `Check this token: ${info.problem}. Amounts in it are shown as the chain reports them, and the app does not ` +
    "offer it for new deposits.",
  ));
  return box;
}

// ---------------------------------------------------------------- addresses

// Why an address can never be a payout destination or an heir, or null if it can. The first part
// mirrors v2's _checkPayee: the vault contract itself (CannotPayToSelf), every token it lists
// (wrappedNative is always one), the OP-stack predeploy range, the four ERC-4337 EntryPoints and
// Venus vBNB (ForbiddenPayoutAddress). The contract refuses those as a withdraw or withdrawCredit
// destination and as a claim recipient. The app also refuses the tokens in its own table and the
// chain's wrapped coin, listed or not, and the retired v1 and billing contracts, which the
// contract accepts: neither has a receive function or any call into v2, so a coin payout to one
// reverts for good and a token credited to one can only be pushed into it, where no heir can
// reach it. None of these addresses can ever start a claim, so none of them can be an heir either.
function refusedPayee(address) {
  const config = chain();
  if (same(address, ZERO)) return "the zero address";
  if (S.address && same(address, S.address)) return "the Will & Key vault contract itself";
  if (config?.v1 && same(address, config.v1)) {
    return "the retired Will & Key v1 vault contract, which cannot receive the coin and has no way to collect a " +
      "credit on this contract";
  }
  if (config?.billing && same(address, config.billing)) {
    return "the retired Will & Key reminder-billing contract, which cannot receive the coin and has no way to " +
      "collect a credit on this contract";
  }
  const listed = S.listed.find((token) => same(token, address));
  if (listed) return `the ${tokenInfo(listed).symbol || "listed"} token contract, one of the tokens the vault contract lists`;
  if (S.wrappedNative && same(address, S.wrappedNative)) return `the wrapped ${config.coin} token contract`;
  const tabled = (config?.tokens || []).find((token) => same(token.address, address));
  if (tabled) return `the ${tabled.symbol} token contract`;
  if (config?.wrappedNative && same(address, config.wrappedNative)) return `the wrapped ${config.coin} token contract`;
  let value = null;
  try {
    value = BigInt(address);
  } catch {
    value = null;
  }
  if (value !== null && value >> 11n === OP_PREDEPLOY_PREFIX) {
    return "an OP-stack system contract (0x4200...0000 to 0x4200...07FF), which keeps or bridges what it is sent";
  }
  const entryPoint = ENTRYPOINTS.find((entry) => same(entry.address, address));
  if (entryPoint) {
    return `the ERC-4337 EntryPoint ${entryPoint.version}, which would book the payment to the vault contract, ` +
      "where nobody can ever withdraw it";
  }
  if (same(address, VENUS_VBNB)) {
    return "the Venus vBNB market address, which would mint vBNB to the vault contract, where nobody can ever redeem it";
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
    throw new Error(`${label}: "${cleanText(text, 60)}" is not an address. It must be 0x followed by 40 hex characters.`);
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
  heirs.openCount = vaults.length;
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
  const refused = refusedPayee(heir);
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

// ---------------------------------------------------------------- fees
// v2's fee rules (FEES in the contract): claimFeeBps() is the rate in force, and already counts an
// announced raise once its time has come. A raise is announced FEE_RAISE_DELAY ahead
// (pendingClaimFeeBps, pendingClaimFeeAt); a cut applies at once. Each vault's feeBps is a
// ceiling fixed at creation. initiateClaim locks min(ceiling, rate) as lockedFeeBps, or 0 while no
// fee recipient is in force (from feeRecipientActiveAt); finalizeClaim pays min(lock, rate then),
// and nothing while no recipient is in force.

async function loadFee() {
  const [bps, pendingBps, pendingAt, recipient, recipientActiveAt, now] = await Promise.all([
    S.contract.claimFeeBps(), S.contract.pendingClaimFeeBps(), S.contract.pendingClaimFeeAt(),
    S.contract.feeRecipient(), S.contract.feeRecipientActiveAt(), chainNow(),
  ]);
  S.fee = {
    bps: Number(bps), pendingBps: Number(pendingBps), pendingAt: Number(pendingAt),
    recipient, recipientActiveAt: Number(recipientActiveAt), readAt: now,
  };
  return S.fee;
}

const feeRecipientInForce = (now) => !same(S.fee.recipient, ZERO) && Number(now) >= S.fee.recipientActiveAt;
// A raise announced and not yet in force (claimFeeBps() already counts one whose time has come).
const scheduledRaise = (now) => (S.fee.pendingAt > Number(now) ? { bps: S.fee.pendingBps, at: S.fee.pendingAt } : null);
const raiseDelay = () => `${Math.round(Number(S.feeDelay ?? 2592000) / 86400)} days`;
// PUSH_GRACE: how long a new credit is the credited address's alone to move (THE CREDIT LANE).
const graceDays = () => `${Math.round(Number(S.pushGrace ?? 2592000) / 86400)} days`;
// What a claim filed now would lock on a vault with this ceiling.
const lockNow = (ceiling, now) => (feeRecipientInForce(now) ? Math.min(Number(ceiling), S.fee.bps) : 0);
// The rate in force at `at`, a moment not before `now` (when S.fee was read): the rate now, or an
// announced raise once it has taken effect. A cut can come at any moment, but only the admin knows
// of one in advance; everything announced is counted.
const rateAt = (at, now) => {
  const raise = scheduledRaise(now);
  return raise && raise.at <= Number(at) ? raise.bps : S.fee.bps;
};
// What a pending claim that locked `locked` pays if it is finalized at `at` (not before `now`).
const settleBpsAt = (locked, at, now) => (feeRecipientInForce(at) ? Math.min(Number(locked), rateAt(at, now)) : 0);
// When the lower fee a pending claim would pay now ends, if that happens by `until`: an announced
// raise taking effect, or the fee recipient coming into force. Null if neither does.
function feeRiseAt(now, until) {
  const moments = [];
  const raise = scheduledRaise(now);
  if (raise && raise.at <= Number(until)) moments.push(raise.at);
  if (!feeRecipientInForce(now) && !same(S.fee.recipient, ZERO) && S.fee.recipientActiveAt <= Number(until)) {
    moments.push(S.fee.recipientActiveAt);
  }
  return moments.length ? Math.min(...moments) : null;
}

function feeRule() {
  return "A claim locks the lower of the vault's ceiling and the rate in force when the claim is filed, and pays " +
    "the lower of that lock and the rate in force when it is finalized. The admin can cut the rate at once; a " +
    `raise takes effect only ${raiseDelay()} after it is announced, and never above a vault's ceiling.`;
}

// Announced changes and the fee recipient's state, in plain words.
function feeNotes(now) {
  const lines = [];
  const raise = scheduledRaise(now);
  if (raise) {
    lines.push(`A raise to ${pct(raise.bps)} has been announced: it takes effect ${fmtLocal(raise.at)} ` +
      `(${fmtCountdown(raise.at, now)}).`);
  }
  if (same(S.fee.recipient, ZERO)) {
    lines.push(`No fee recipient is set, so no fee is charged now; one set later comes into force only ${raiseDelay()} ` +
      "after it is announced.");
  } else if (Number(now) < S.fee.recipientActiveAt) {
    lines.push(`Fees are off until ${fmtLocal(S.fee.recipientActiveAt)}, when the fee recipient comes into force: a ` +
      "claim filed before then locks no fee, and a claim finalized before then pays none.");
  }
  return lines;
}

// The fee lines on a vault card and in claim reviews. `vault.feeBps` is a ceiling, never the fee
// (F07, F25); during a claim, `lockedFeeBps` is the most the claim can pay. A pending claim is
// quoted at the first moment it can be finalized (finalizableAt, or now once that has passed),
// counting every change already announced for that moment: a raise, or the fee recipient coming
// into force. When one of them ends a lower fee before then, the heir is told the one way to keep
// it (FEES in the contract): cancel and file again while it is in force, at a price.
function vaultFeeText(vault, now, role) {
  if (Number(vault.state) === 2) {
    const locked = Number(vault.lockedFeeBps);
    const first = Math.max(Number(now), Number(vault.finalizableAt));
    const settleBps = settleBpsAt(locked, first, now);
    const fee = (BigInt(vault.balance) * BigInt(settleBps)) / 10000n;
    const when = first > Number(now)
      ? `Finalized as soon as it can be (${fmtLocal(vault.finalizableAt)}), it would pay`
      : "Finalized now it would pay";
    const parts = [
      `Claim fee: this claim pays at most ${pct(locked)}, the rate locked when it was filed. ${when} ${pct(settleBps)} ` +
      `(${amountText(vault.token, fee)}), and ${amountText(vault.token, BigInt(vault.balance) - fee)} would be ` +
      "credited to the payout address. A lower rate counts only if it is still in force when the claim is " +
      "finalized; no raise can take the claim above its lock.",
      ...feeNotes(now),
    ];
    const nowBps = settleBpsAt(locked, now, now);
    const refiled = lockNow(vault.feeBps, now);
    const endsAt = feeRiseAt(now, first);
    if (role !== "owner" && settleBps > nowBps && refiled < settleBps && endsAt !== null) {
      parts.push(`The lower fee this claim would pay now (${pct(nowBps)}) ends ${fmtLocal(endsAt)}, before the claim ` +
        "can be finalized. You can keep a lower fee for good only by cancelling this claim and filing it again " +
        `before then: the new claim would lock ${pct(refiled)}, but it could be finalized only ` +
        `${Number(vault.challengeWindow) / 86400} days after it is mined, and until it is filed a check-in by the ` +
        "owner (or by anyone holding one of the owner's check-in chain values) pushes the claim back by a full " +
        "check-in period; past the horizon the owner can name a new heir, who can claim at once.");
    }
    return parts.join(" ");
  }
  const ceiling = Number(vault.feeBps);
  const parts = [
    `Claim fee: this vault's ceiling is ${pct(ceiling)}, fixed at its creation. The rate in force is ${pct(S.fee.bps)}, ` +
    `so a claim filed now would lock ${pct(lockNow(ceiling, now))}.`,
  ];
  const raise = scheduledRaise(now);
  if (raise) {
    parts.push(`A raise to ${pct(raise.bps)} takes effect ${fmtLocal(raise.at)}; it can never take this vault above ` +
      `${pct(ceiling)}.`);
  }
  if (same(S.fee.recipient, ZERO)) parts.push("No fee recipient is set, so no fee is charged now.");
  else if (Number(now) < S.fee.recipientActiveAt) parts.push(`Fees are off until ${fmtLocal(S.fee.recipientActiveAt)}.`);
  return parts.join(" ");
}

function renderCreateFee(now) {
  if (!S.fee) return;
  $("cFeeInfo").textContent = [
    `Claim fee: the rate in force is ${pct(S.fee.bps)}. The rate in force in the block your vault is created in ` +
    "becomes its ceiling, fixed for good; the app compares it with this quote after mining.",
    ...feeNotes(now ?? S.fee.readAt),
    feeRule(),
  ].join(" ");
}

// ---------------------------------------------------------------- transactions

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

// A re-render replaces a card's elements, so a message is carried over to the card's new log
// element (same id) when the old one was replaced.
const liveLog = (logElement) => (!logElement.isConnected && logElement.id && $(logElement.id)) || logElement;

// The parts of the page that show transactions, each re-read after one. `refresh` re-renders the
// view and throws when its read fails, leaving what is shown in place; `what` names the view in
// the warning about such a failure; `home` is where a transaction's line goes when its card is
// gone after the re-read (a vault closed or settled, a credit paid in full).
const VIEWS = {
  owner: { refresh: () => refreshMine(), what: "your vaults", home: () => $("mineAlerts") },
  heir: { refresh: () => rereadHeir(), what: "the vaults that name you as heir", home: () => $("heirList") },
  credit: { refresh: () => readCredits(), what: "your payouts", home: () => $("crLog") },
};

// A transaction's line that had to leave its card, by the log element it was first written in.
const movedLogs = new WeakMap();

// The element that shows the line of the transaction logged in `logElement` now: that element,
// the same card's log after a re-render, or the line's place at its view's home.
function logNow(logElement) {
  const moved = movedLogs.get(logElement);
  if (moved?.isConnected) return moved;
  return liveLog(logElement);
}

// After `view` was re-read: the element that carries `logElement`'s line from now on. A card that
// is gone hands its line to the view's home: the home itself when it is a status line (Payouts),
// otherwise a line of its own at the top of it.
function relocate(logElement, view) {
  let log = logNow(logElement);
  if (!log.isConnected) {
    const home = view.home?.();
    if (home?.classList.contains("txlog")) {
      log = home;
    } else if (home) {
      log = element("div", "txlog");
      log.setAttribute("role", "status");
      home.prepend(log);
    }
  }
  if (log !== logElement) movedLogs.set(logElement, log);
  return log;
}

// Resolves to one of three results, and callers must tell them apart:
// - the mined receipt (truthy): the transaction succeeded;
// - false: nothing happened (refused in the wallet, rejected before sending, replaced in the
//   wallet, or mined and reverted), so the caller may offer its Sign button again;
// - null: it was sent but its outcome could not be read, so it may still go through. The caller
//   must NOT offer its Sign button again: a second signature could repeat it (a second funded
//   vault). The page then signs nothing else until that outcome is known (holdUnsettled).
// Only sending and waiting can fail the transaction. The re-read after it is mined is separate:
// a failed refresh is reported under the confirmation and never turns a success into a failure.
// Options: `view`, the part of the page the transaction belongs to (VIEWS.owner by default),
// re-read after mining and after a revert; `onMined(receipt)`, run as soon as the receipt exists,
// before that re-read; `onSettled(receipt)`, run if the result could not be read at first and the
// transaction turns out to have succeeded.
async function runTx(logElement, label, send, options = {}) {
  if (S.unsettled) {
    refuseUnsettled(logElement, label);
    return false;
  }
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
      return txFailed(logElement, label, transaction, error, options);
    }
  }
  return finishTx(logElement, label, transaction.hash, receipt, options);
}

// Everything after a transaction was mined successfully: the confirmed line, onMined, the view's
// re-read and, if that fails, the warning under the line. Also run when the result of an
// unsettled transaction is read later.
async function finishTx(logElement, label, hash, receipt, { onMined, view = VIEWS.owner } = {}) {
  renderTx(logElement, label, "confirmed", hash);
  try {
    onMined?.(receipt);
  } catch {
    // A display step; the transaction is mined either way.
  }
  let refreshError = null;
  try {
    await view.refresh();
  } catch (error) {
    refreshError = error;
  }
  const log = relocate(logElement, view);
  if (log !== logElement) renderTx(log, label, "confirmed", hash);
  if (refreshError) {
    log.append(element(
      "div", "follow-up warn",
      `It is confirmed on chain, but the page could not re-read ${view.what} afterwards (${errorText(refreshError)}). ` +
      "What is shown may be out of date: reload the page before doing anything else, and do not sign this again.",
    ));
  }
  return receipt || true;
}

// ---------------------------------------------------------------- unsettled transactions
// A transaction that was sent but whose result could not be read may still be mined, so until its
// receipt is read the page signs nothing else: a second signature could repeat it (a second funded
// vault, a second deposit, a second payout). runTx refuses to send, the create form's Review
// button is off, and every review says why. The page keeps asking the wallet's connection for the
// receipt and reports the result where the transaction was logged. A reload also ends the hold:
// the reloaded page reads everything afresh, and the message asked for the explorer to be checked.

const UNSETTLED_WAITS = [2000, 4000, 8000, 15000];

// entry: { hash, label, why, log, transaction, options }, where `why` is the connection's error.
function holdUnsettled(entry) {
  S.unsettled = entry;
  $("createBtn").disabled = true;
  watchUnsettled(entry).catch(() => {});
}

// The unsettled transaction's own line. A card re-rendered before the result is known (a lookup,
// "Check my payouts") writes it again into its new log, so the warning never goes missing.
function unsettledLine(log, entry) {
  renderTx(log, entry.label, "sent, but its result could not be read", entry.hash);
  log.append(document.createTextNode(
    ` (${entry.why}). It may still go through. Open the transaction on the explorer and reload this page before ` +
    "signing anything again. Until its result is known this page signs nothing else; it keeps checking.",
  ));
}

function unsettledText() {
  const { label, hash } = S.unsettled;
  return `Nothing can be signed on this page until the result of your earlier "${label}" transaction ` +
    `(${short(hash)}) is known: it was sent, but its result could not be read, and it may still go through. ` +
    "The page keeps checking; you can also open it on the explorer and reload this page.";
}

// A transaction refused while another's result is unknown. In the unsettled transaction's own log
// the refusal goes under its line instead of replacing it.
function refuseUnsettled(logElement, label) {
  const text = `${label}: not sent. ${unsettledText()}`;
  if (logNow(S.unsettled.log) !== logElement) {
    logElement.textContent = text;
    return;
  }
  logElement.querySelector(":scope > .follow-up.held")?.remove();
  logElement.append(element("div", "follow-up bad held", text));
}

// For a review: true, after saying why in `out`, while a transaction's result is unknown.
function heldBack(out) {
  if (!S.unsettled) return false;
  notice(out, "bad", unsettledText());
  return true;
}

async function watchUnsettled(entry) {
  for (let attempt = 0; S.unsettled === entry; attempt += 1) {
    await sleep(UNSETTLED_WAITS[Math.min(attempt, UNSETTLED_WAITS.length - 1)]);
    if (S.unsettled !== entry) return;
    let receipt = null;
    try {
      receipt = await S.provider.getTransactionReceipt(entry.hash);
    } catch {
      receipt = null;
    }
    if (!receipt) continue;
    S.unsettled = null;
    $("createBtn").disabled = S.paused;
    if (receipt.status === 1) {
      await finishTx(entry.log, entry.label, entry.hash, receipt, entry.options);
      try {
        entry.options.onSettled?.(receipt);
      } catch {
        // A display step.
      }
    } else {
      await txFailed(entry.log, entry.label, entry.transaction ?? { hash: entry.hash },
        { code: "CALL_EXCEPTION", receipt, shortMessage: "transaction execution reverted" }, entry.options);
    }
    return;
  }
}

// A transaction that was mined and reverted carries no reason. The same call is simulated against
// the latest block; what it reverts with now is most likely why the transaction failed.
async function likelyRevert(transaction) {
  if (!transaction?.to || !transaction?.data) return null;
  try {
    await S.provider.call({ to: transaction.to, from: S.account, data: transaction.data, value: transaction.value ?? 0n });
    return null;
  } catch (error) {
    const revert = revertOf(error);
    return revert ? errorText({ revert }) : null;
  }
}

async function txFailed(logElement, label, transaction, error, { view = VIEWS.owner, ...options } = {}) {
  const hash = transaction?.hash || error?.info?.sendTransactionHash || null;
  const reverted = error?.code === "CALL_EXCEPTION";
  // The wallet sent another transaction with the same nonce in its place (a cancellation, or a
  // different call), so this one can never be mined.
  if (error?.code === "TRANSACTION_REPLACED" && error.reason !== "repriced") {
    renderTx(logElement, label, `not done: your wallet replaced it with ${error.reason === "cancelled"
      ? "a cancellation" : "a different transaction"}, so it can never go through`, error.replacement?.hash ?? null);
    return false;
  }
  // Sent, and not known to have reverted: the connection failed while waiting. It may be mined,
  // so it is reported as unknown, not as failed, and the page signs nothing else until it knows.
  if (hash && !(reverted && error.receipt)) {
    const entry = { hash, label, why: errorText(error), log: logElement, transaction, options: { view, ...options } };
    unsettledLine(logElement, entry);
    holdUnsettled(entry);
    return null;
  }
  let text = `${label} failed: ${errorText(error)}`;
  if (reverted && error.receipt && !revertOf(error)) {
    const why = await likelyRevert(transaction);
    if (why) text = `${text.replace(/[.\s]+$/, "")}. Most likely: ${why}`;
  }
  logElement.textContent = text;
  // A revert usually means the vault changed under the card (a claim was filed, the horizon
  // passed, someone finalized first), so the view is re-read rather than left stale (F43), and
  // the message is carried over to the card's new log, or to the view's home if the card is gone.
  if (reverted) {
    try {
      await view.refresh();
    } catch {
      // Keep the stale view; the message above still stands.
    }
    const log = relocate(logElement, view);
    if (log !== logElement) log.textContent = text;
  }
  return false;
}

// Appends a follow-up line under a transaction's line. `log` is the element the transaction was
// logged in, followed wherever the line has moved since (logNow), or a log element's id.
function followUp(log, tone, message) {
  const target = typeof log === "string" ? $(log) : logNow(log);
  if (!target) return null;
  const out = element("div", `follow-up ${tone}`, message);
  target.append(out);
  return out;
}

const HEIR_CHECK_STEP = "Next: ask your heir to open the \"I'm an heir\" tab with their own wallet, enter your " +
  "address and confirm this vault appears. That is the only check that proves the address is really theirs.";

// ---------------------------------------------------------------- connecting

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
  const banner = $("deployBanner");
  if (!currentChain) {
    $("netPill").className = "pill bad";
    $("netPill").textContent = "unsupported network";
    banner.hidden = false;
    banner.replaceChildren(document.createTextNode("This network is not supported. Switch to: "));
    const targets = Object.entries(CHAINS).filter(([, config]) => deployment(config));
    for (const [id, config] of targets.length ? targets : [["8453", CHAINS[8453]]]) {
      banner.append(button(config.name, "btn small ghost", () => switchChain(Number(id)).catch(connectFailed)));
    }
    return;
  }

  $("netPill").className = currentChain.testnet ? "pill warn" : "pill ok";
  $("netPill").textContent = currentChain.name;
  const deployed = deployment(currentChain);
  if (!deployed) {
    banner.hidden = false;
    banner.textContent = `Will & Key v2 is not yet deployed on ${currentChain.name}.` +
      (currentChain.v1 ? " The retired v1 contract no longer accepts new vaults: see the notice about v1 below." : "");
    return;
  }

  S.address = deployed.address;
  S.deployBlock = deployed.block;
  S.codehash = deployed.codehash;
  S.contract = new ethers.Contract(S.address, VAULT_ABI, S.signer);
  await loadConfig();
}

// The contract's settings, read once per page load: its code (compared with the deployment's code
// hash), its token list (checked against the app's table), the creation pause and two constants.
// Nothing else is shown until they are read.
async function loadConfig() {
  const banner = $("deployBanner");
  try {
    const code = await S.provider.getCode(S.address);
    if (code === "0x") throw new Error(`there is no contract at ${S.address} on this network`);
    if (ethers.keccak256(code) !== S.codehash) {
      throw new Error(`the contract at ${S.address} is not the Will & Key v2 deployment this page was built for: ` +
        "its code differs");
    }
    await loadTokens();
    const [paused, grace, delay] = await Promise.all([
      S.contract.creationPaused(), S.contract.PUSH_GRACE(), S.contract.FEE_RAISE_DELAY(),
    ]);
    S.paused = Boolean(paused);
    S.pushGrace = Number(grace);
    S.feeDelay = Number(delay);
  } catch (error) {
    S.ready = false;
    banner.hidden = false;
    banner.replaceChildren(document.createTextNode(
      `The vault contract's settings could not be read (${errorText(error)}). Nothing is shown until they can be. `,
    ));
    banner.append(button("Try again", "btn small ghost", () => loadConfig().catch(connectFailed)));
    return;
  }
  banner.hidden = true;
  banner.replaceChildren();
  S.ready = true;
  $("cPaused").hidden = !S.paused;
  $("createBtn").disabled = S.paused;
  fillAssetOptions();
  checkV1().catch(() => {});
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

// Asks the wallet to switch to chain `id`, and to add it first if the wallet does not know it
// (EIP-1193 code 4902; some mobile wallets wrap it). A switch or an add the person declines, or
// that fails, is said in the network banner; on success the wallet's chainChanged reloads the page.
async function switchChain(id) {
  const configuredChain = CHAINS[id];
  const banner = $("deployBanner");
  const say = (text) => {
    let note = $("switchNote");
    if (!note) {
      note = element("p", "banner-copy switch-note");
      note.id = "switchNote";
      note.setAttribute("role", "status");
      banner.append(note);
    }
    note.textContent = text;
  };
  const declined = (error) => error?.code === 4001 || error?.code === "ACTION_REJECTED";
  say(`Asking your wallet to switch to ${configuredChain.name}...`);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain", params: [{ chainId: configuredChain.hex }],
    });
    say(`Your wallet is switching to ${configuredChain.name}; the page reloads when it has.`);
    return;
  } catch (error) {
    const unknown = error?.code === 4902 || error?.data?.originalError?.code === 4902;
    if (!unknown) {
      say(declined(error)
        ? `You declined the switch to ${configuredChain.name} in your wallet. Nothing changed.`
        : `Your wallet could not switch to ${configuredChain.name}: ${errorText(error)}`);
      return;
    }
  }
  say(`Your wallet does not know ${configuredChain.name} yet, so it is asked to add it...`);
  try {
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
    say(`${configuredChain.name} was added to your wallet. If the page does not reload, switch to it in your wallet.`);
  } catch (error) {
    say(declined(error)
      ? `You declined adding ${configuredChain.name} to your wallet. Nothing changed.`
      : `Your wallet could not add ${configuredChain.name}: ${errorText(error)}`);
  }
}

// What the connected wallet still has on the retired v1 contract (Base only): its credits in the
// coin and the table's tokens, and any open vault. Shown under the v1 notice; silent on failure,
// because the notice already says how to reach v1.
async function checkV1() {
  const v1 = chain()?.v1;
  const box = $("v1Mine");
  if (!v1 || !box) return;
  const contract = new ethers.Contract(v1, V1_ABI, S.provider);
  const tokens = [{ address: ZERO, symbol: chain().coin, decimals: 18 }, ...(chain().tokens || [])];
  const credits = [];
  for (const token of tokens) {
    const owed = await contract.creditOf(token.address, S.account);
    if (owed > 0n) credits.push(`${ethers.formatUnits(owed, token.decimals)} ${token.symbol}`);
  }
  const open = await contract.openVaultIds(S.account);
  const lines = [];
  if (credits.length) {
    lines.push(`Your connected wallet has ${credits.join(", ")} credited on v1. Withdraw it on Basescan with ` +
      "withdrawCredit, giving the token's address (0x0000000000000000000000000000000000000000 for the coin) and " +
      "your own wallet's address as the destination.");
  }
  if (open.length) {
    lines.push(`Your connected wallet still owns ${open.length} open v1 vault${open.length === 1 ? "" : "s"} ` +
      `(${vaultList(open.map(Number))}). This page no longer manages v1: its check-ins, vetoes and withdrawals ` +
      "are on Basescan. To move to v2, withdraw everything from each v1 vault there and create a new vault here. " +
      "v1 has no \"everything\" option: withdraw the exact balance its getVault shows, and withdraw again if a " +
      "top-up sent just before leaves the vault open.");
  }
  box.replaceChildren(...lines.map((line) => element("p", "banner-copy", line)));
  box.hidden = lines.length === 0;
}

// ---------------------------------------------------------------- vault cards and panels

const pinnedText = (horizon) => `Your deadline has reached the horizon (${fmtUtc(horizon)}): check-ins can no ` +
  "longer move it, and the contract refuses them. At the horizon your heir can claim, and then only extending the " +
  "horizon or withdrawing everything stops the claim. Extend the horizon to keep checking in.";

// warnings bit 4 (computed on chain): the deadline has reached a horizon that is still ahead.
const isPinned = (vault) => Boolean(Number(vault.warnings) & 16) && !vault.horizonReached;

// Owner warnings only. A pending claim, a passed horizon and a pinned deadline get their own block
// on the card, which says what still works; the generic "check in" advice would be wrong there.
function warningLines(vault, role) {
  const warnings = Number(vault.warnings);
  const lines = [];
  if (role !== "owner") return lines;
  if (Number(vault.state) === 1 && !vault.horizonReached && !isPinned(vault) && (warnings & 1)) {
    lines.push("your timer has expired - check in now; until you do, your heir can start a claim");
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
    throw new Error(`${label}: "${cleanText(text, 40)}" is not an amount. Use digits and at most one dot, like 1.5 (no commas or spaces).`);
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
// no prompt(), no confirm(), and every address in full.

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

// A panel's review area whose content belongs to one review at a time. Each review and each edit
// starts a new generation; a review that finds a newer one when its reads return shows nothing,
// so two quick clicks can never leave two Sign buttons.
function reviewArea() {
  const out = element("div", "panel-out");
  let generation = 0;
  return {
    out,
    reset() {
      generation += 1;
      out.replaceChildren();
    },
    // Starts a review; the returned function tells whether it is still the current one.
    start() {
      this.reset();
      const mine = generation;
      return () => mine === generation && out.isConnected;
    },
  };
}

// What changed on a vault between two reads that would make a panel or a review say the wrong
// thing about what the signature does, or null. A check-in or a top-up changes nothing here.
function vaultChange(before, after) {
  const was = Number(before.state);
  const is = Number(after.state);
  if (is !== was) {
    if (is === 2) return "a claim was filed on it";
    if (was === 2 && is === 1) return "the claim that was pending on it ended";
    return `it is now ${stateName(is)}`;
  }
  if (is === 2 && after.claimInitiatedAt !== before.claimInitiatedAt) return "a new claim was filed on it";
  if (is === 2 && !same(after.claimRecipient, before.claimRecipient)) return "the claim's payout address changed";
  if (Boolean(after.horizonReached) !== Boolean(before.horizonReached)) return "it reached its horizon";
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

// The heir's version: re-reads `owner`'s vault `id` before an heir signs. Returns the fresh read,
// or null after saying in `out` why nothing may be signed.
async function recheckHeirVault(owner, id, seen, out) {
  let latest;
  try {
    latest = await S.contract.getVault(owner, id);
  } catch (error) {
    notice(out, "bad", `Vault #${id} could not be re-read, so nothing can be signed yet: ${errorText(error)}`);
    return null;
  }
  const change = !same(latest.beneficiary, S.account) ? "it no longer names your wallet as heir" : vaultChange(seen, latest);
  if (!change) return latest;
  notice(out, "bad", `Vault #${id} changed after this panel was opened: ${change}. Nothing was signed. Look the ` +
    "vault up again and review it from its card.");
  return null;
}

// The owner's CheckedIn and CheckInSkipped logs in a receipt from this contract:
// checked maps vault id -> new deadline, skipped maps vault id -> SKIP reason.
function checkInLogs(receipt) {
  const checked = new Map();
  const skipped = new Map();
  for (const entry of receipt?.logs || []) {
    if (!same(entry.address, S.address)) continue;
    let parsed = null;
    try {
      parsed = S.contract.interface.parseLog(entry);
    } catch {
      parsed = null;
    }
    if (!parsed || !same(parsed.args.owner, S.account)) continue;
    if (parsed.name === "CheckedIn") checked.set(Number(parsed.args.vaultId), Number(parsed.args.newDeadline));
    if (parsed.name === "CheckInSkipped") skipped.set(Number(parsed.args.vaultId), Number(parsed.args.reason));
  }
  return { checked, skipped };
}

// The first log of `name` from this contract in a receipt, parsed, or null.
function receiptEvent(receipt, name) {
  for (const entry of receipt?.logs || []) {
    if (!same(entry.address, S.address)) continue;
    try {
      const parsed = S.contract.interface.parseLog(entry);
      if (parsed?.name === name) return parsed.args;
    } catch {
      // Not one of the vault's events.
    }
  }
  return null;
}

// ---------------------------------------------------------------- owner actions

async function actCheckIn(id) {
  const log = ownerLog(id);
  const receipt = await runTx(log, "Check-in", () => S.contract.checkIn(id));
  if (!receipt) return;
  // A check-in moves the deadline at most to the horizon; the one that gets there is the last.
  const moved = checkInLogs(receipt).checked.get(Number(id));
  const vault = await S.contract.getVault(S.account, id).catch(() => null);
  if (vault && moved !== undefined && moved >= Number(vault.absoluteDeadline)) {
    followUp(log, "bad", `Checked in, and that was the last check-in that can move this deadline. ${pinnedText(vault.absoluteDeadline)}`);
  }
}

async function actAbort(id) {
  const log = ownerLog(id);
  const receipt = await runTx(log, "Veto", () => S.contract.abortClaim(id));
  if (receipt) followUp(log, "ok", "Claim vetoed. The vault is active again and your check-in timer restarted.");
  return receipt;
}

// A top-up adds to the vault; anyone may send one, and it never restarts the check-in timer. The
// contract refuses it while a claim is pending, so it is offered on active vaults only.
async function actTopUp(id) {
  const vault = await S.contract.getVault(S.account, id);
  const info = tokenInfo(vault.token);
  if (!info.verified) {
    ownerLog(id).textContent = `The app does not add to this vault: ${info.problem}.`;
    return;
  }
  const panel = openPanel("owner", id, `Top up vault #${id}`);
  if (!panel) return;
  const amount = textInput("1.0");
  amount.inputMode = "decimal";
  const area = reviewArea();
  amount.addEventListener("input", () => area.reset());
  panel.append(
    reviewList([["Vault", `#${id}`], ["Balance now", amountText(vault.token, vault.balance)]]),
    field(`Amount to add (${info.symbol})`, amount),
    panelButtons(
      button("Review top-up", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
    area.out,
  );

  async function review() {
    const current = area.start();
    const { out } = area;
    if (heldBack(out)) return;
    let units;
    try {
      units = parseAmount(amount.value, info.decimals, "Top-up amount");
    } catch (error) {
      notice(out, "bad", error.message);
      return;
    }
    const latest = await recheckVault(id, vault, out);
    if (!current() || !latest) return;
    if (Number(latest.state) !== 1) {
      notice(out, "bad", "The contract refuses top-ups while a claim is pending, and on a settled or closed vault.");
      return;
    }
    if (BigInt(latest.balance) + units > MAX_VAULT_UNITS) {
      notice(out, "bad", "That amount is too large for one vault.");
      return;
    }
    const notes = [
      ["", "A top-up does not restart your check-in timer: check in separately."],
      ["", "What you add becomes part of what your heir can inherit. No fee is charged on a top-up."],
    ];
    if (latest.horizonReached) {
      notes.unshift(["bad", "This vault has reached its horizon: your heir can start a claim at any time, and the top-up would be part of it."]);
    }
    if (!info.native) {
      notes.push(["", `If the vault contract may not yet take this much of your ${info.symbol}, your wallet first asks you to approve exactly this amount, then to sign the top-up.`]);
    }
    const problems = element("div");
    const sign = button("Sign top-up", "btn small primary", async () => {
      sign.disabled = true;
      if (!(await recheckVault(id, latest, problems))) {
        sign.disabled = false;
        return;
      }
      if (!info.native) {
        let approved;
        try {
          approved = await ensureAllowance(vault.token, units, ownerLog(id));
        } catch (error) {
          ownerLog(id).textContent = `Could not read the token allowance: ${errorText(error)}`;
          approved = false;
        }
        if (!approved) {
          if (approved === false) sign.disabled = false;
          return;
        }
      }
      const receipt = await runTx(ownerLog(id), "Top-up", () =>
        S.contract.topUp(S.account, id, units, { value: info.native ? units : 0n }));
      if (receipt === false) sign.disabled = false;
    });
    out.append(
      reviewList([
        ["Vault", `#${id}`],
        ["Add", amountText(vault.token, units)],
        ["Balance after", amountText(vault.token, BigInt(latest.balance) + units)],
      ]),
      noteList(notes),
      problems,
      panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("owner", id))),
    );
  }
}

// A partial withdrawal. The whole balance goes through actWithdrawAll instead, which closes the
// vault whatever the balance is when mined (F22).
async function actWithdraw(id) {
  const vault = await S.contract.getVault(S.account, id);
  const info = tokenInfo(vault.token);
  if (info.decimals === null) {
    ownerLog(id).textContent = "This vault's token decimals cannot be read, so the app cannot convert amounts for it. " +
      "Use \"Withdraw everything and close\", which needs no amount.";
    return;
  }
  const panel = openPanel("owner", id, `Withdraw part of vault #${id}`);
  if (!panel) return;
  const amount = textInput("1.0");
  amount.inputMode = "decimal";
  const area = reviewArea();
  amount.addEventListener("input", () => area.reset());
  panel.append(
    reviewList([["Vault", `#${id}`], ["Balance now", amountText(vault.token, vault.balance)]]),
    field(`Amount to withdraw (${info.symbol || "base units"})`, amount,
      "Less than the whole balance. To take everything, use \"Withdraw everything and close\"."),
    panelButtons(
      button("Review withdrawal", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
    area.out,
  );

  async function review() {
    const current = area.start();
    const { out } = area;
    if (heldBack(out)) return;
    let units;
    try {
      units = parseAmount(amount.value, info.decimals, "Withdrawal amount");
    } catch (error) {
      notice(out, "bad", error.message);
      return;
    }
    const latest = await recheckVault(id, vault, out);
    if (!current() || !latest) return;
    if (units >= BigInt(latest.balance)) {
      notice(out, "bad", "That is the whole balance or more. Use \"Withdraw everything and close\": it closes the " +
        "vault whatever the balance is when your transaction is mined, so a top-up sent just before cannot leave it open.");
      return;
    }
    const state = Number(latest.state);
    const notes = [];
    if (state === 2 && latest.horizonReached) {
      notes.push(["bad", "This does NOT stop the pending claim: past the horizon only withdrawing everything or extending " +
        "the horizon does, and the heir inherits whatever is left."]);
    } else if (state === 2) {
      notes.push(["warn", "This also cancels the claim pending on this vault, and restarts your check-in timer."]);
    } else if (latest.horizonReached) {
      notes.push(["warn", "Past the horizon a withdrawal does not restart your check-in timer: your heir can still start a claim at any time."]);
    } else {
      notes.push(["", "A withdrawal restarts your check-in timer, like any owner action."]);
    }
    notes.push(["", "The amount is credited to your wallet, not sent: collect it on the Payouts tab. No fee is charged on a withdrawal."]);
    const problems = element("div");
    const sign = button("Sign withdrawal", "btn small primary", async () => {
      sign.disabled = true;
      const fresh = await recheckVault(id, latest, problems);
      if (!fresh) {
        sign.disabled = false;
        return;
      }
      if (units >= BigInt(fresh.balance)) {
        notice(problems, "bad", "The balance changed and this is now the whole of it. Close this panel and use \"Withdraw everything and close\".");
        return;
      }
      const log = ownerLog(id);
      const receipt = await runTx(log, "Withdraw", () => S.contract.withdraw(id, units, S.account));
      if (receipt) followUp(log, "ok", "Credited to your wallet: collect it on the Payouts tab.");
      else if (receipt === false) sign.disabled = false;
    });
    out.append(
      reviewList([
        ["Vault", `#${id}`],
        ["Amount", amountText(latest.token, units)],
        ["Left in the vault", amountText(latest.token, BigInt(latest.balance) - units)],
        ["Credited to", addressBlock(S.account), { tone: "ok", text: "your wallet" }],
      ]),
      noteList(notes),
      problems,
      panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("owner", id))),
    );
  }
}

// F19 + F22: withdraw(id, type(uint256).max, to) withdraws the whole balance, whatever it is when
// the transaction is mined, and closes the vault; a 1-wei top-up sent in front of it can no longer
// keep the vault open. Past the horizon it is one of the two owner actions that still end a claim.
async function actWithdrawAll(id) {
  const vault = await S.contract.getVault(S.account, id);
  // Everything that needs a read happens before the panel opens, so two quick clicks cannot both
  // fill it and leave two Sign buttons.
  const panel = openPanel("owner", id, `Withdraw everything from vault #${id} and close it`);
  if (!panel) return;
  const state = Number(vault.state);
  const notes = [
    ["bad", "This closes the vault permanently: its heir, timer and horizon end with it. To protect these funds again you would create a new vault."],
    ["", "The whole balance is credited to your wallet, whatever it is when your transaction is mined: a top-up sent before then is included. Collect it on the Payouts tab. No fee is charged on a withdrawal."],
  ];
  if (state === 2) {
    notes.unshift(["warn", "This ends the pending claim by closing the vault, provided it is mined before anyone " +
      `finalizes the claim (${vault.finalizable ? "anyone can finalize it now" : `anyone can from ${fmtLocal(vault.finalizableAt)}`}).`]);
  }
  const problems = element("div");
  const sign = button("Sign: withdraw everything", "btn small primary", async () => {
    sign.disabled = true;
    // The amount is the contract's "everything" sentinel, so a changed balance does not matter;
    // a changed state does, because the notes above describe it.
    if (!(await recheckVault(id, vault, problems))) {
      sign.disabled = false;
      return;
    }
    // A closed vault leaves the list, and its card with it: runTx then moves the confirmation to
    // the top of the owner's alerts, and the result is reported under it.
    const log = ownerLog(id);
    const receipt = await runTx(log, "Withdraw everything", () => S.contract.withdraw(id, ethers.MaxUint256, S.account));
    if (receipt) {
      // Withdrawn(owner, vaultId, to, amount, closed) says what the transaction did.
      const withdrawn = receiptEvent(receipt, "Withdrawn");
      if (!withdrawn) {
        followUp(log, "warn", `The withdrawal is confirmed, but its receipt carries no Withdrawn record. Check vault #${id} ` +
          "in your list and your Payouts tab.");
      } else if (withdrawn.closed) {
        followUp(log, "ok", `Vault #${id} is closed. ${amountText(vault.token, withdrawn.amount)} was credited to your ` +
          "wallet: collect it on the Payouts tab.");
      } else {
        followUp(log, "bad", `${amountText(vault.token, withdrawn.amount)} was credited to your wallet, but vault #${id} ` +
          "is still open: the contract did not close it. Check its card before relying on it being closed.");
      }
    } else if (receipt === false) {
      sign.disabled = false;
    }
  });
  panel.append(
    reviewList([
      ["Vault", `#${id}`],
      ["Amount", `everything (now ${amountText(vault.token, vault.balance)})`, { tone: "bad", text: "closes the vault" }],
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
      "A claim is pending and the horizon has passed, so changing the heir cannot stop it any more: the contract " +
      "refuses it. Only extending the horizon, or withdrawing everything, stops this claim.",
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
  const area = reviewArea();
  const picker = element("select", "f addr-pick");
  if (heirPickerOptions(picker, S.heirs, vault.beneficiary)) {
    picker.addEventListener("change", () => {
      first.value = picker.value;
      second.value = picker.value;
      area.reset();
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
  for (const control of [first, second]) control.addEventListener("input", () => area.reset());
  panel.append(
    panelButtons(
      button("Review change", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
    area.out,
  );

  async function review() {
    const current = area.start();
    const { out } = area;
    if (heldBack(out)) return;
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
      const log = ownerLog(id);
      const receipt = await runTx(log, "Change heir", () => S.contract.setBeneficiary(id, heir));
      if (receipt) followUp(log, "ok", HEIR_CHECK_STEP);
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
  const period = Number(vault.inactivityPeriod);
  const periodDays = period / 86400;
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
  } else if (isPinned(vault)) {
    panel.append(element("p", "banner-copy warning-text", pinnedText(vault.absoluteDeadline)));
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
  const area = reviewArea();
  date.addEventListener("input", () => area.reset());
  panel.append(
    panelButtons(
      button("Review change", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("owner", id)),
    ),
    area.out,
  );

  async function review() {
    const currentReview = area.start();
    const { out } = area;
    if (heldBack(out)) return;
    // The notes below describe the vault as it is now: a claim filed or the horizon passed since
    // the panel opened changes what this signature does, and the pre-filled date with it.
    const latest = await recheckVault(id, vault, out);
    if (!currentReview() || !latest) return;
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
    // v2: check-ins move the deadline only up to the horizon, and refuse once it sits there.
    if (timestamp < floorNow(now) + 2 * period) {
      notes.push(["warn", `This date is less than two check-in periods (${2 * periodDays} days) away, so your deadline ` +
        "reaches it within one or two check-ins; from then the contract refuses check-ins until you extend the " +
        "horizon again. A later date keeps check-ins working for longer."]);
    }
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

// ---------------------------------------------------------------- heir actions

// F20 + F09 + R5-2: the payout defaults to the heir's own connected wallet. Any other address is
// entered twice, refused if v2 would refuse it (or if it is any token or wrapped-coin contract),
// flagged if it has code, and needs an explicit acknowledgement. The recipient is recorded for the
// claim: the heir can correct it only by cancelling the claim and starting again, and safely only
// before finalizableAt, from which anyone may finalize the claim to the recorded address.
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
  const area = reviewArea();
  const reset = () => {
    otherBox.hidden = !other.box.checked;
    area.reset();
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
    area.out,
  );

  async function review() {
    const current = area.start();
    const { out } = area;
    if (heldBack(out)) return;
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
    const refused = refusedPayee(recipient);
    if (refused) {
      blockedBanner(out, `Refused: that is ${refused}. Anything paid there is lost, or ends up where only the admin can move it.`);
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
    let latest;
    let now;
    let contract = false;
    let owedAlready = 0n;
    try {
      [latest, now] = await Promise.all([S.contract.getVault(owner, id), chainNow(), loadFee()]);
      if (different) {
        [contract, owedAlready] = await Promise.all([hasCode(recipient), S.contract.creditOf(latest.token, recipient)]);
      }
    } catch (error) {
      if (current()) notice(out, "bad", `Could not review the claim: ${errorText(error)}`);
      return;
    }
    if (!current()) return;
    if (Number(latest.state) !== 1 || !latest.expired || !same(latest.beneficiary, S.account)) {
      notice(out, "bad", "This vault can no longer be claimed by your wallet: the owner checked in, the heir changed, " +
        "or a claim is already pending. Look the vault up again.");
      return;
    }
    const windowDays = Number(latest.challengeWindow) / 86400;
    const locked = lockNow(latest.feeBps, now);
    // F13 + R5-2: "finalizable" is not "final", and finalizableAt is the last safe moment to fix the recipient.
    const notes = [
      ["bad", `The payout address is recorded for this claim. You can correct it only by cancelling the claim and ` +
        `starting again, and safely only in the next ${windowDays} days: from ${windowDays} days after this ` +
        "claim is mined, anyone can finalize it, and a finalize settles the inheritance to this address for good."],
      ["", "Until a finalize is mined, the owner's key can still stop the claim (before the horizon with Veto; past it " +
        "by extending the horizon or withdrawing everything). Come back and finalize promptly once the window ends: " +
        "nobody will remind you."],
      ["", "The payout is credited to this address when the claim is finalized, and that address then withdraws it on " +
        `the Payouts tab. If it never does, anyone may push the payout to it ${graceDays()} after it was credited.`],
    ];
    if (unchecked) notes.push(["warn", "This address was entered without checksum capitals, so a mistyped character would not be detected by its format."]);
    if (different && owedAlready > 0n) {
      notes.push(["warn", `This address already has ${amountText(latest.token, owedAlready)} credited on this contract. ` +
        `A smaller new credit joins that older credit's ${graceDays()} clock, so once it has run out anyone can push ` +
        "the whole balance to this address as soon as the claim settles. Withdraw the older credit first, or use a " +
        "fresh address."]);
    }
    const acks = [];
    if (different) {
      acks.push(checkbox(
        "I have checked every character of this payout address. I understand that once the claim can be " +
        "finalized, anyone can settle it to this address, and a wrong address then loses the inheritance.",
      ));
      if (contract) {
        acks.push(checkbox(
          "This address is a smart contract. I have confirmed it can receive this asset and is a wallet I control, " +
          "not an exchange deposit address or a token contract.",
        ));
        notes.push(["warn", "A contract that sends value back to the vault contract while it is paid is refused at payout: " +
          "the credit stays, and that contract then has to withdraw it to another address itself, by calling " +
          "withdrawCredit(token, to) on the vault contract."]);
      }
    }
    const problems = element("div");
    const sign = button("Sign claim", "btn small primary", async () => {
      if (acks.some((ack) => !ack.box.checked)) {
        notice(problems, "bad", "Tick every confirmation above first.");
        return;
      }
      sign.disabled = true;
      const fresh = await recheckHeirVault(owner, id, latest, problems);
      if (!fresh) {
        sign.disabled = false;
        return;
      }
      // A check-in by the owner since the review moves the deadline: nothing can be claimed then.
      if (!fresh.expired) {
        notice(problems, "bad", `The owner checked in after this review: the new deadline is ${fmtLocal(fresh.deadline)}, ` +
          "and no claim can start before it. Nothing was signed.");
        return;
      }
      // runTx re-reads the heir list after mining and carries the confirmation into the card's
      // new log; if that re-read fails, the list stays as it was, with a warning under the line.
      const log = heirLog(owner, id);
      const receipt = await runTx(log, "Initiate claim", () => S.contract.initiateClaim(owner, id, recipient), { view: VIEWS.heir });
      if (receipt) {
        const started = receiptEvent(receipt, "ClaimInitiated");
        if (started) {
          followUp(log, "ok", `Claim started. It can be finalized from ${fmtLocal(started.finalizableAt)}; ` +
            `until then you can still cancel it to correct the payout address. It locked a fee of at most ${pct(started.lockedFeeBps)}.`);
        }
      } else if (receipt === false) {
        sign.disabled = false;
      }
    });
    out.append(
      reviewList([
        ["Vault", `#${id}`],
        ["Owner", addressBlock(owner)],
        ["Heir (you)", addressBlock(S.account)],
        ["Payout to", addressBlock(recipient, different ? "bad" : null), different
          ? { tone: "bad", text: "not your wallet" } : { tone: "ok", text: "your wallet" }],
        ["Amount", amountText(latest.token, latest.balance)],
        ["Correctable until", `${windowDays} days after this claim is mined (its finalizableAt)`, { tone: "warn", text: "then fixed" }],
        ["Claim fee", `locks ${pct(locked)} now: the lower of this vault's ceiling (${pct(latest.feeBps)}) and the rate in force ` +
          `(${pct(S.fee.bps)})${feeRecipientInForce(now) ? "" : ", or nothing while no fee recipient is in force"}. ${feeNotes(now).join(" ")}`],
      ]),
      noteList(notes),
      ...acks.map((ack) => ack.wrap),
      problems,
      panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("heir", key))),
    );
  }
}

// A cancel signed this close to finalizableAt (seconds) counts as late: anyone may finalize from
// that second on, and the cancel is mined some time after it is signed.
const CANCEL_MARGIN = 300;

// F20 + R5-2: the heir's undo. beneficiaryCancelClaim ends the heir's own pending claim, so a
// wrong payout address can be corrected by starting again. It is certain to work only if mined
// before finalizableAt: from then anyone may finalize the claim to the recorded address. Whether
// the cancel is late is decided when the panel opens and again at signing, so a panel opened in
// time and signed too late still shows the warning and asks for the acknowledgement first.
async function actCancelClaim(owner, id) {
  const [vault, now] = await Promise.all([S.contract.getVault(owner, id), chainNow()]);
  const key = heirKey(owner, id);
  const panel = openPanel("heir", key, `Cancel your claim on vault #${id}`);
  if (!panel) return;
  if (Number(vault.state) !== 2) {
    panel.append(element("p", "banner-copy", "No claim is pending on this vault any more."),
      panelButtons(button("Close", "btn small ghost", () => closePanel("heir", key))));
    return;
  }
  const finalizableAt = Number(vault.finalizableAt);
  const isLate = (at) => Number(at) >= finalizableAt - CANCEL_MARGIN;
  const windowDays = Number(vault.challengeWindow) / 86400;
  const notes = [
    ["", "Cancel only to correct the payout address, then start a new claim straight away with the right one. The " +
      `new claim has a fresh challenge window: it can be finalized ${windowDays} days after it is mined.`],
    ["warn", "Until you start again the vault is active with its deadline passed. Before the horizon the owner, the " +
      "owner's automation or anyone holding one of the owner's check-in chain values can check in, which pushes your " +
      "next claim back by a full check-in period; past the horizon the owner can name a new heir, who can claim at once."],
    ["", `The new claim locks the fee in force then, up to this vault's ceiling of ${pct(vault.feeBps)}; this claim ` +
      `locked ${pct(vault.lockedFeeBps)}.`],
  ];
  const summary = reviewList([
    ["Vault", `#${id}`],
    ["Owner", addressBlock(owner)],
    ["Now paying", addressBlock(vault.claimRecipient)],
    ["Filed", fmtLocal(vault.claimInitiatedAt)],
    ["", ""],
  ]);
  // The last row: finalizableAt, as the last safe moment to cancel or as passed, at chain time `at`.
  const showMoment = (at) => {
    const over = Number(at) >= finalizableAt;
    summary.lastElementChild.previousElementSibling.textContent = over ? "Finalizable since" : "Last safe moment to cancel";
    summary.lastElementChild.replaceChildren(
      document.createTextNode(`${fmtLocal(finalizableAt)} (${fmtCountdown(finalizableAt, at)})`),
      element("span", `tag ${over ? "bad" : "warn"}`, over ? "passed" : "finalizableAt"),
    );
  };
  showMoment(now);
  // The warning and the acknowledgement for a cancel that may come too late.
  const lateNote = element("div");
  const ackBox = element("div");
  let ack = null;
  const showLate = (at) => {
    showMoment(at);
    lateNote.replaceChildren(noteList([["bad", Number(at) >= finalizableAt
      ? `The challenge window ended ${fmtLocal(finalizableAt)}. From then anyone can finalize this claim, and a ` +
        "finalize mined before your cancel settles the inheritance to the address below for good. The cancel is " +
        "certain to work only before that moment."
      : `The challenge window ends ${fmtLocal(finalizableAt)}, within minutes. From then anyone can finalize this ` +
        "claim, and a finalize mined before your cancel settles the inheritance to the address below for good. The " +
        "cancel is certain to work only if it is mined before that moment."]]));
    if (!ack) {
      ack = checkbox("I understand that someone may finalize this claim before my cancel is mined.");
      ackBox.replaceChildren(ack.wrap);
    }
  };
  if (isLate(now)) showLate(now);
  const problems = element("div");
  const sign = button("Sign: cancel my claim", "btn small primary", async () => {
    if (ack && !ack.box.checked) {
      notice(problems, "bad", "Tick the confirmation above first.");
      return;
    }
    sign.disabled = true;
    const [fresh, signNow] = await Promise.all([recheckHeirVault(owner, id, vault, problems), chainNow()]);
    if (!fresh) {
      sign.disabled = false;
      return;
    }
    if (!ack && isLate(signNow)) {
      showLate(signNow);
      notice(problems, "bad", `Nothing was signed: the challenge window ${signNow >= finalizableAt ? "has ended" : "is about to end"} ` +
        "since this panel was opened. Read the warning above, and tick the box if you still want to cancel.");
      sign.disabled = false;
      return;
    }
    const log = heirLog(owner, id);
    const receipt = await runTx(log, "Cancel claim", () => S.contract.beneficiaryCancelClaim(owner, id), { view: VIEWS.heir });
    if (receipt) {
      followUp(log, "warn", "Your claim is cancelled. Start it again now, with the correct payout " +
        "address: until you do, a check-in (or, past the horizon, a new heir) can take the claim away from you.");
    } else if (receipt === false) {
      sign.disabled = false;
    }
  });
  panel.append(
    summary,
    lateNote,
    noteList(notes),
    ackBox,
    problems,
    panelButtons(sign, button("Keep my claim", "btn small ghost", () => closePanel("heir", key))),
  );
}

// A settled vault leaves the open-vault list, and its card with it, so runTx moves the
// confirmation to the top of the heir list, and the result is reported under it.
async function actFinalize(owner, id) {
  const { token } = await S.contract.getVault(owner, id);
  const log = heirLog(owner, id);
  const receipt = await runTx(log, "Finalize", () => S.contract.finalizeClaim(owner, id), { view: VIEWS.heir });
  if (!receipt) return;
  const settled = receiptEvent(receipt, "ClaimSettled");
  if (!settled) return;
  const note = element("div", "follow-up ok");
  note.append(
    element(
      "p", "banner-copy",
      `Vault #${id} settled: ${amountText(token, settled.amount)} was credited to the address below` +
      `${settled.fee > 0n ? `, and a fee of ${amountText(token, settled.fee)} to the fee recipient` : ", with no fee"}. ` +
      "Nothing has moved to a wallet yet: open the Payouts tab with that wallet connected to withdraw it.",
    ),
    addressRow("Credited to", settled.recipient),
  );
  logNow(log).append(note);
}

// ---------------------------------------------------------------- vault cards

// F46 + F13 + F03 + F19 + R5-2: a pending claim is the moment the owner must act, so it leads the
// card with everything getVault knows: when it was filed, by whom, where it pays, the fee it
// locked and when anyone can finalize it. "Finalizable" is not "final": until a finalize is mined,
// the owner's key can still stop it, so the owner must get a veto mined first; for the heir,
// finalizableAt is also the last safe moment to correct the payout address.
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
  // Only the current heir can file, and changing the heir while a claim is pending either cancels
  // the claim or reverts, so the heir shown is the one who filed.
  out.append(reviewList([
    ["Filed", `${fmtLocal(vault.claimInitiatedAt)} (${fmtCountdown(vault.claimInitiatedAt, now)})`],
    ["Filed by", addressBlock(vault.beneficiary), { tone: "warn", text: owner ? "the heir" : "you" }],
    ["Paying", addressBlock(vault.claimRecipient, elsewhere && owner ? "bad" : null), payingTag],
    [
      open ? "Finalizable from" : "Finalizable since",
      `${fmtLocal(vault.finalizableAt)} (${fmtCountdown(vault.finalizableAt, now)}, by chain time)`,
    ],
    ["Fee locked", `at most ${pct(vault.lockedFeeBps)}`],
  ]));
  const say = (text) => out.append(element("p", "banner-copy", text));
  if (!owner) {
    say(open
      ? `Until ${fmtLocal(vault.finalizableAt)} you can still correct the payout address: cancel this claim and ` +
        "start it again. From then anyone can finalize it, to the address above, and it is too late to correct it safely."
      : "Anyone can finalize it now, and the payout goes to the address above: it is too late to correct the " +
        "payout address safely.");
    say("Until a finalize is mined, the owner's key can still stop the claim, so finalize promptly once you can: " +
      "nobody will remind you.");
    return out;
  }
  say(`${open ? "From then anyone can finalize this claim, and the vault pays out." : "Anyone can finalize this claim now."} ` +
    `${vault.horizonReached ? "Stopping it" : "Your veto"} only works if it is mined before someone's finalize is: ` +
    "act now, not on the last day.");
  if (elsewhere) {
    say("It pays an address that is not the heir's own. The heir chose it when filing; if you do not recognise it, " +
      "stop this claim.");
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

// F18 in v2: once the deadline has reached the horizon, check-ins revert DeadlinePinnedAtHorizon
// (checkInMany skips the vault with reason 5). Extending the horizon is the remedy.
function pinnedBlock(vault) {
  const out = element("div", "banner warn claim-alert");
  out.append(
    element("p", "banner-copy claim-head", "Check-ins can no longer move this vault's deadline."),
    element("p", "banner-copy", pinnedText(vault.absoluteDeadline)),
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
  const close = (className) => button("Withdraw everything and close", className, ownerAct(id, actWithdrawAll));
  if (vault.horizonReached) {
    // F19/F43: Check in, Veto and Change heir during a claim revert here (or, on an active vault,
    // no longer protect).
    if (state === 2) {
      out.push(button("Stop this claim: extend horizon", "btn small danger", ownerAct(id, actHorizon)));
      out.push(close("btn small danger"));
      out.push(button("Withdraw part", "btn small ghost", ownerAct(id, actWithdraw)));
    } else {
      out.push(button(`Extend horizon (from ${utcDayCeil(horizonFloor(vault, now))})`, "btn small primary", ownerAct(id, actHorizon)));
      out.push(button("Top up", "btn small ghost", ownerAct(id, actTopUp)));
      out.push(button("Withdraw part", "btn small ghost", ownerAct(id, actWithdraw)));
      out.push(close("btn small ghost"));
      out.push(button("Change heir without extending", "btn small ghost", ownerAct(id, actHeir)));
    }
  } else if (state === 2) {
    // F03: checkIn reverts ClaimPendingUseAbort and topUp reverts VaultNotActive while a claim is
    // pending, so both are replaced by Veto; the other owner actions here also cancel the claim.
    out.push(button("Veto claim", "btn small danger", ownerAct(id, actAbort)));
    out.push(button("Withdraw part", "btn small ghost", ownerAct(id, actWithdraw)));
    out.push(close("btn small ghost"));
    out.push(button("Change heir", "btn small ghost", ownerAct(id, actHeir)));
    out.push(button("Extend horizon", "btn small ghost", ownerAct(id, actHorizon)));
  } else if (isPinned(vault)) {
    // A check-in would revert DeadlinePinnedAtHorizon, so it is not offered.
    out.push(button("Extend horizon", "btn small primary", ownerAct(id, actHorizon)));
    out.push(button("Top up", "btn small ghost", ownerAct(id, actTopUp)));
    out.push(button("Withdraw part", "btn small ghost", ownerAct(id, actWithdraw)));
    out.push(close("btn small ghost"));
    out.push(button("Change heir", "btn small ghost", ownerAct(id, actHeir)));
  } else {
    out.push(button("Check in", "btn small primary", ownerAct(id, actCheckIn)));
    out.push(button("Top up", "btn small ghost", ownerAct(id, actTopUp)));
    out.push(button("Withdraw part", "btn small ghost", ownerAct(id, actWithdraw)));
    out.push(close("btn small ghost"));
    out.push(button("Change heir", "btn small ghost", ownerAct(id, actHeir)));
    out.push(button("Extend horizon", "btn small ghost", ownerAct(id, actHorizon)));
  }
  return out;
}

function heirActions(vault) {
  const id = Number(vault.vaultId);
  const state = Number(vault.state);
  const out = [];
  if (state === 1 && vault.expired) {
    out.push(button("Initiate claim", "btn small primary", heirAct(vault.owner, id, actClaim)));
  }
  if (state === 2) {
    if (vault.finalizable) {
      out.push(button("Finalize inheritance", "btn small primary", heirAct(vault.owner, id, actFinalize)));
    } else {
      out.push(element("span", "pill warn", `finalizable from ${fmtWhen(vault.finalizableAt)}`));
    }
    out.push(button("Cancel my claim", "btn small ghost", heirAct(vault.owner, id, actCancelClaim)));
  }
  return out;
}

// `now` is chain time (chainNow) read once for the whole list.
function vaultCard(vault, role, now) {
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
    element("span", "amount", amountText(vault.token, vault.balance)),
    element("span", `pill ${tone}`, STATES[state] ?? "?"),
  );
  card.append(top);
  if (state === 2) card.append(claimBlock(vault, role, now));
  else if (owner && state === 1 && vault.horizonReached) card.append(horizonBlock(vault, now));
  else if (owner && state === 1 && isPinned(vault)) card.append(pinnedBlock(vault));

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
  if (S.fee) metaBox.append(element("div", "", vaultFeeText(vault, now, role)));
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
  if (S.unsettled && S.unsettled.log.id === log.id) unsettledLine(log, S.unsettled);
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

async function refreshMine() {
  if (!S.ready) return;
  const [vaults, now] = await Promise.all([S.contract.getOpenVaults(S.account), chainNow(), loadFee()]);
  renderCreateFee(now);
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
  $("vaultList").replaceChildren(...vaults.map((vault) => vaultCard(vault, "owner", now)));
}

// ---------------------------------------------------------------- check in on all vaults
// F03 + F15: a check-in never cancels a claim, and checkInMany skips what it cannot check in. v2
// logs CheckedIn or CheckInSkipped(reason) for every vault sent, and reverts NothingCheckedIn(bits)
// when it moves no deadline at all. The batch is pre-filtered by state and horizon, and the
// receipt's logs are read back, so every vault that was not checked in is listed with the reason
// the contract gave and its remedy.

// The remedy buttons act on the vault's own card, so that card is brought into view first.
function onCard(id, action) {
  const run = ownerAct(id, action);
  return () => {
    ownerLog(id)?.closest(".vault-card")?.scrollIntoView({ block: "center" });
    return run();
  };
}

function skipActions(id, act) {
  const actions = {
    veto: ["Veto claim", "btn small danger", onCard(id, actAbort)],
    extend: ["Extend horizon", "btn small primary", onCard(id, actHorizon)],
    stop: ["Stop this claim: extend horizon", "btn small danger", onCard(id, actHorizon)],
    close: ["Withdraw everything and close", "btn small ghost", onCard(id, actWithdrawAll)],
  };
  return act.map((name) => actions[name]);
}

// A SKIP reason as a report entry: { reason, remedy, actions, ok }.
function skipBlocker(id, code) {
  const entry = SKIP_REASONS[code];
  if (!entry) return { reason: `the contract skipped it (reason ${code})`, remedy: "Check this vault's card.", actions: [] };
  return { reason: entry.reason, remedy: entry.remedy, actions: skipActions(id, entry.act), ok: Boolean(entry.ok) };
}

// The reason checkInMany would skip this vault now (read before sending), or null when it can be
// checked in.
function checkInBlocker(vault, now) {
  const id = Number(vault.vaultId);
  const state = Number(vault.state);
  const past = Boolean(vault.horizonReached) || now >= Number(vault.absoluteDeadline);
  if (state === 2) return skipBlocker(id, past ? 7 : 3);
  if (state !== 1) return skipBlocker(id, 2);
  if (past) return skipBlocker(id, 4);
  if (Number(vault.deadline) >= Number(vault.absoluteDeadline)) return skipBlocker(id, 5);
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
    out.push(element("div", "follow-up bad", `Vault #${entry.id}: checked in, and that was the last check-in that can move its deadline. ${pinnedText(entry.horizon)}`));
  }
  const harmless = skipped.filter((entry) => entry.blocker.ok);
  const problems = skipped.filter((entry) => !entry.blocker.ok);
  for (const { id, blocker } of harmless) {
    out.push(element("div", "follow-up ok", `Vault #${id}: not checked in again, because ${blocker.reason}. ${blocker.remedy}`));
  }
  if (problems.length) {
    const box = element("div", "banner bad");
    box.append(element(
      "p", "banner-copy claim-head",
      `${problems.length === 1 ? "1 vault is" : `${problems.length} vaults are`} NOT checked in:`,
    ));
    const list = element("ul", "skip-list");
    for (const { id, blocker } of problems) {
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

// After a batch the contract refused as a whole (NothingCheckedIn), each vault sent is re-read and
// reported with the reason that applies to it now.
async function reportUnsent(send, skipped) {
  const now = await chainNow();
  for (const vault of send) {
    const id = Number(vault.vaultId);
    let latest = vault;
    try {
      latest = await S.contract.getVault(S.account, id);
    } catch {
      // Report it from the earlier read.
    }
    skipped.push({
      id,
      blocker: checkInBlocker(latest, now) || { reason: "the check-in was not sent or not mined", remedy: "Check in on its card.", actions: [] },
    });
  }
  skipped.sort((a, b) => a.id - b.id);
  renderCheckInReport([], skipped);
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
  if (receipt === null) {
    renderCheckInReport([], skipped);
    return;
  }
  if (receipt === false) {
    // Declined, or refused as a whole (NothingCheckedIn names its reasons in the log above).
    await reportUnsent(send, skipped);
    return;
  }
  // A vault can change between the read above and mining (a claim filed, the horizon reached):
  // the contract then logs CheckInSkipped with its reason instead of CheckedIn.
  const { checked: moved, skipped: refused } = checkInLogs(receipt);
  const checked = [];
  for (const vault of send) {
    const id = Number(vault.vaultId);
    if (moved.has(id)) {
      checked.push({ id, pinned: moved.get(id) >= Number(vault.absoluteDeadline), horizon: vault.absoluteDeadline });
    } else if (refused.has(id)) {
      skipped.push({ id, blocker: skipBlocker(id, refused.get(id)) });
    } else {
      skipped.push({ id, blocker: { reason: "the contract logged nothing for it", remedy: "Check this vault's card and check in on it on its own.", actions: [] } });
    }
  }
  skipped.sort((a, b) => a.id - b.id);
  renderCheckInReport(checked, skipped);
});

// ---------------------------------------------------------------- create a vault

// F01/F10/F11/F36 in v2: a vault holds the native coin or a token the contract lists; the contract
// refuses every other token (UnsupportedToken), so there is no "other token" path at all. A listed
// token is offered only once verified against the app's table; the others are shown, disabled,
// with the reason. The chosen token's address is always shown with an explorer link.
function fillAssetOptions() {
  const select = $("cAsset");
  const native = element("option", "", `Native coin (${chain().coin})`);
  native.value = "native";
  const options = [native];
  const problems = [];
  for (const address of S.listed) {
    const info = tokenInfo(address);
    const option = element("option", "", info.verified
      ? `${info.symbol} - ${info.name}`
      : `${info.symbol || short(address)} - not offered: see below`);
    option.value = `token:${address}`;
    option.disabled = !info.verified;
    options.push(option);
    if (!info.verified) problems.push(`${address}: ${info.problem}.`);
  }
  select.replaceChildren(...options);
  select.value = "native";
  S.assetProblems = problems;
  showAsset();
}

function showAsset() {
  const value = $("cAsset").value;
  const info = $("cTokenInfo");
  info.replaceChildren();
  if (value.startsWith("token:") && chain()) info.append(addressRow("Token contract", value.slice(6)));
  for (const problem of S.assetProblems || []) {
    info.append(element("div", "warning-text", `Listed by the vault contract but not offered here: ${problem}`));
  }
}

$("cAsset").addEventListener("change", showAsset);

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
  const allowance = await tokenContract.allowance(S.account, S.address);
  if (allowance >= amount) return true;
  return runTx(logElement, "Approve token", () => tokenContract.approve(S.address, amount));
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
  // The pending create's status is in the log; a new review would wipe it. So would one while a
  // transaction's result is unknown (the button is off then; this is the second lock).
  if (creating || S.unsettled) return;
  clearCreateReview();
  const mine = createGeneration;
  const current = () => mine === createGeneration && !creating;
  log.textContent = "";
  if (!S.ready) {
    log.textContent = "Connect a wallet on a network where Will & Key v2 is deployed first.";
    return;
  }
  try {
    if (S.paused) throw new Error("New-vault creation is paused on this contract by its admin.");
    const asset = $("cAsset").value;
    let token = ZERO;
    if (asset.startsWith("token:")) {
      token = ethers.getAddress(asset.slice(6));
      if (!tokenInfo(token).verified) throw new Error("That token is not offered: pick the asset again.");
    } else if (asset !== "native") {
      throw new Error("Pick an asset.");
    }
    const info = tokenInfo(token);
    const amount = parseAmount($("cAmount").value, info.decimals, "Amount");
    if (amount > MAX_VAULT_UNITS) throw new Error("That amount is too large for one vault.");

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
    if (heirs.openCount >= 32) throw new Error("You already have 32 open vaults, the most one wallet can have. Close one first.");

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
    renderCreateFee(now);
    const heirIsContract = await hasCode(heir);
    if (!current()) return;
    const notes = [
      ["", "The vault is created by your connected wallet, which becomes its owner."],
      ["", HEIR_CHECK_STEP.replace("this vault", "the new vault")],
      ["warn", "The contract lets the owner change the inactivity period later, but this app does not offer that yet. Choose the period as if it were fixed."],
    ];
    if (windowDays < 14) notes.unshift(["warn", "A challenge window under 14 days leaves little time to notice a claim, and Will & Key sends no alerts. We recommend 14 days or more."]);
    if (windowDays > 90) notes.unshift(["warn", "A challenge window over 90 days delays every settlement to your heir by that long, and it can never be shortened."]);
    if (horizon < floor + periodDays * 86400) {
      notes.push(["warn", "This horizon is less than two check-in periods away, so your deadline reaches it within one or two check-ins; from then the contract refuses check-ins until you extend the horizon."]);
    }
    if (entry.unchecked) notes.push(["warn", "The heir's address was entered without checksum capitals, so a mistyped character would not be detected by its format. Your two entries matched; check it against the heir's wallet."]);
    if (heirIsContract) notes.push(["warn", "The heir's address is a smart contract. That is fine for a multisig or smart wallet your heir controls, but a contract that cannot send transactions can never claim."]);
    const assetValue = token === ZERO ? `native ${chain().coin}` : element("div");
    if (token !== ZERO) assetValue.append(element("div", "", `${info.symbol} - ${info.name}`), addressBlock(token));
    const plan = {
      token, amount, heir, period: periodDays * 86400, challengeWindow: windowDays * 86400, horizon, quote: fee.bps,
    };
    const sign = button("Sign and create vault", "btn primary", () => signCreate(plan, sign));
    out.append(
      reviewList([
        ["Asset", assetValue],
        ["Amount", amountText(token, amount)],
        ["Heir", addressBlock(heir), { tone: "warn", text: "can be changed later" }],
        ["Inactivity period", `${periodDays} days`, { tone: "warn", text: "not changeable in this app" }],
        ["Challenge window", `${windowDays} days`, { tone: "bad", text: "immutable" }],
        ["Horizon", fmtUtc(horizon), { tone: "warn", text: "raise-only" }],
        ["Fee ceiling", `${pct(fee.bps)}: the rate in force, recorded when your transaction is mined`, { tone: "bad", text: "fixed at creation" }],
        ["Fee rules", [...feeNotes(now), feeRule()].join(" ")],
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
// that was mined, or whose result is unknown, never gets a second signature from this review, and
// while the result is unknown Review vault stays off too (holdUnsettled), so no new review can
// offer one either.
async function signCreate(plan, sign) {
  if (creating) return;
  creating = true;
  sign.disabled = true;
  $("createBtn").disabled = true;
  try {
    await sendCreate(plan, sign);
  } finally {
    creating = false;
    $("createBtn").disabled = S.paused || Boolean(S.unsettled);
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
  ), { onMined: clearCreateReview, onSettled: (settled) => reportCreated(settled, plan) });
  if (!receipt) {
    if (receipt === false) sign.disabled = false;
    return;
  }
  reportCreated(receipt, plan);
}

// The new vault's number, and F06: the ceiling is whatever claimFeeBps() was in the mined block,
// compared with the quote the review showed.
function reportCreated(receipt, plan) {
  const created = receiptEvent(receipt, "VaultCreated");
  if (!created) return;
  const vaultId = Number(created.vaultId);
  followUp("createLog", "ok", `Vault #${vaultId} created. ${HEIR_CHECK_STEP.replace("this vault", `vault #${vaultId}`)}`);
  if (Number(created.feeBps) !== plan.quote) {
    followUp(
      "createLog", "bad",
      `The fee ceiling recorded on chain is ${pct(created.feeBps)}, not the ${pct(plan.quote)} shown before you ` +
      "signed: an announced raise took effect before your transaction was mined. If you do not accept it, withdraw " +
      `everything from vault #${vaultId} (no fee is charged on withdrawals) and create it again.`,
    );
  }
}

$("createBtn").addEventListener("click", reviewCreate);

// ---------------------------------------------------------------- heir tab
// The heir list shows either one owner's vaults (lookup by owner) or the vaults the search found.
// After a claim, a cancel or a finalize (mined or reverted), runTx re-reads whichever it was with
// rereadHeir. Both renderers read everything first and replace the list only at the end, so a
// read that fails throws and leaves the list, and the transaction's line in it, as it was.

async function rereadHeir() {
  if (S.heirView?.found) await showFound();
  else if (S.heirView?.owner) await lookupOwner(S.heirView.owner);
}

$("hLookupBtn").addEventListener("click", async () => {
  const out = $("heirList");
  if (!S.ready) {
    notice(out, "warn", "Connect a wallet on a network where Will & Key v2 is deployed first.");
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
  const [vaults, now] = await Promise.all([S.contract.getOpenVaults(owner), chainNow(), loadFee()]);
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
  for (const vault of mine) shown.push(vaultCard(vault, "heir", now));
  if (mine.length === 0) {
    const none = element("div", "banner warn", "No open vaults at that address name your wallet as heir.");
    shown.unshift(none);
  }
  S.heirView = { owner };
  out.replaceChildren(...shown);
}

// ---------------------------------------------------------------- heir search (F44)
// The contract has no lookup by heir, so the search reads its VaultCreated and BeneficiaryChanged
// logs whose indexed heir (topic 3 in both v2 events: VaultCreated's beneficiary and
// BeneficiaryChanged's newBeneficiary) is the connected wallet, from the v2 deployment block on,
// confirms every hit with getVault and shows only open vaults that name this wallet NOW. It tries
// the wallet's own connection first (often one call for the whole history) and falls back to the
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

// The deployment block always holds the contract's own logs (the constructor emits
// OwnershipTransferred and a TokenSupported per listed token). A connection that returns nothing
// there does not serve logs that old, and its empty answers would look like "no vaults".
async function servesHistory(source) {
  const block = ethers.toQuantity(S.deployBlock);
  const logs = await fetchLogs(source, { address: S.address, fromBlock: block, toBlock: block });
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
  if (!S.ready) {
    log.textContent = "Connect a wallet on a network where Will & Key v2 is deployed first.";
    return;
  }
  const from = S.deployBlock;
  // One search per page load (a new wallet or network reloads the page). A second click continues
  // a stopped or failed search, or reads only the blocks added since the last one finished.
  if (!S.heirScan) S.heirScan = { next: from, candidates: new Map(), summary: null, running: false, stop: false };
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
      address: S.address,
      topics: [
        [events.getEvent("VaultCreated").topicHash, events.getEvent("BeneficiaryChanged").topicHash],
        null, null, ethers.zeroPadValue(S.account, 32),
      ],
    };
    const collect = (logs) => {
      for (const entry of logs) {
        if (!same(entry.address, S.address)) continue;
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
      const done = Math.min(100, Math.floor(((cursor - from) / Math.max(1, target + 1 - from)) * 100));
      log.textContent = `Searching blocks ${fmtBlock(from)}-${fmtBlock(target)} through ${source.label}: ` +
        `${done}% done, ${scan.candidates.size} record${scan.candidates.size === 1 ? "" : "s"} naming your wallet so far.`;
    };
    log.textContent = "Starting the search...";
    for (const source of logSources()) {
      if (scan.next > target || scan.stop) break;
      try {
        if (!(await servesHistory(source))) {
          failures.push(`${source.label} returned no records for the block the contract was deployed in, so it was not used`);
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
    from, searchedTo: scan.next - 1, target: target === null ? null : Math.max(target, scan.next - 1),
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
  const [now] = await Promise.all([chainNow(), loadFee()]);
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
    if (same(vault.beneficiary, S.account) && (state === 1 || state === 2)) cards.push(vaultCard(vault, "heir", now));
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

// ---------------------------------------------------------------- payouts (the credit lane)
// A withdrawal or a settled claim is a credit, not a transfer. The credited address pulls it with
// withdrawCredit(token, to), all at once, or in parts with withdrawCredit(token, to, amount) (F04:
// a token that caps a single transfer cannot freeze a large credit). This app always pays the
// connected wallet itself. Anyone else may push a credit to its address from creditedSince +
// PUSH_GRACE (F08).

$("crCheckBtn").addEventListener("click", () => checkCredits());

async function checkCredits() {
  const log = $("crLog");
  if (!S.ready) {
    log.textContent = "Connect a wallet on a network where Will & Key v2 is deployed first.";
    return;
  }
  log.textContent = "Reading your payouts...";
  try {
    await readCredits();
  } catch (error) {
    log.textContent = `Could not read your payouts: ${errorText(error)}`;
    return;
  }
  log.textContent = "";
}

// Reads every credit of the connected wallet and renders the list. The list is replaced only once
// everything is read, so a read that fails throws and leaves it as it was (runTx relies on that
// after a payout).
async function readCredits() {
  const now = await chainNow();
  const rows = await Promise.all([ZERO, ...S.listed].map(async (token) => {
    const [owed, since] = await Promise.all([S.contract.creditOf(token, S.account), S.contract.creditedSince(token, S.account)]);
    return { token, owed, since: Number(since) };
  }));
  const list = $("crList");
  const owed = rows.filter((row) => row.owed > 0n);
  if (!owed.length) {
    list.replaceChildren(element("div", "banner warn", `Nothing is credited to your wallet on this vault contract, in ${chain().coin} or any listed token.`));
    return;
  }
  list.replaceChildren(...owed.map((row) => creditCard(row, now)));
}

function creditCard({ token, owed, since }, now) {
  const key = `credit-${token.toLowerCase()}`;
  const card = element("div", "vault-card");
  const top = element("div", "top");
  top.append(element("span", "amount", amountText(token, owed)), element("span", "pill ok", "Credited"));
  const meta = element("div", "meta");
  meta.append(tokenRow(token));
  if (since && S.pushGrace !== null) {
    const pushable = since + S.pushGrace;
    meta.append(element("div", "", `Credited since ${fmtLocal(since)}. ` + (now >= pushable
      ? "Anyone can now push it to your wallet, which pays it to this same wallet."
      : `From ${fmtLocal(pushable)} anyone may push it to your wallet; until then only you can move it.`)));
  }
  const actions = element("div", "actions");
  actions.append(
    button("Withdraw all to my wallet", "btn small primary", () => actWithdrawCredit(token, key, false)),
    button("Withdraw part", "btn small ghost", () => actWithdrawCredit(token, key, true)),
  );
  const panel = element("div", "act-panel");
  panel.id = `panel-credit-${key}`;
  panel.hidden = true;
  const log = element("div", "txlog");
  log.id = `log-credit-${key}`;
  log.setAttribute("role", "status");
  if (S.unsettled && S.unsettled.log.id === log.id) unsettledLine(log, S.unsettled);
  card.append(top, meta, actions, panel, log);
  return card;
}

// Pays the connected wallet from its own credit: everything, or `partial` a typed amount.
async function actWithdrawCredit(token, key, partial) {
  const log = () => $(`log-credit-${key}`);
  const info = tokenInfo(token);
  // The read happens before the panel opens, so two quick clicks cannot both fill it and leave two
  // Sign buttons (for a partial withdrawal, a second signature would pay a second time).
  let owed;
  try {
    owed = await S.contract.creditOf(token, S.account);
  } catch (error) {
    const out = log();
    if (out) out.textContent = `Could not read the credit: ${errorText(error)}`;
    return;
  }
  const panel = openPanel("credit", key, partial ? "Withdraw part of this payout" : "Withdraw this payout");
  if (!panel) return;
  const area = reviewArea();
  const amount = partial ? textInput("1.0") : null;
  if (partial && info.decimals === null) {
    notice(panel, "bad", "This token's decimals cannot be read, so the app cannot convert an amount. Withdraw all instead.");
    return;
  }
  if (amount) {
    amount.inputMode = "decimal";
    amount.addEventListener("input", () => area.reset());
  }
  panel.append(
    reviewList([["Credited", amountText(token, owed)]]),
    ...(amount ? [field(`Amount to withdraw (${info.symbol})`, amount, "The rest stays credited to you.")] : []),
    panelButtons(
      button("Review withdrawal", "btn small primary", review),
      button("Cancel", "btn small ghost", () => closePanel("credit", key)),
    ),
    area.out,
  );

  async function review() {
    const current = area.start();
    const { out } = area;
    if (heldBack(out)) return;
    let units = null;
    if (amount) {
      try {
        units = parseAmount(amount.value, info.decimals, "Amount");
      } catch (error) {
        notice(out, "bad", error.message);
        return;
      }
    }
    let fresh;
    try {
      fresh = await S.contract.creditOf(token, S.account);
    } catch (error) {
      if (current()) notice(out, "bad", `Could not read the credit: ${errorText(error)}`);
      return;
    }
    if (!current()) return;
    if (fresh === 0n) {
      notice(out, "warn", "Nothing is credited to your wallet in this asset any more.");
      return;
    }
    if (units !== null && units > fresh) {
      notice(out, "bad", `That is more than is credited to you (${amountText(token, fresh)}).`);
      return;
    }
    const paying = units ?? fresh;
    const notes = [["", "It is paid now, to your connected wallet."]];
    if (units !== null && units < fresh) notes.push(["", `${amountText(token, fresh - units)} stays credited to you.`]);
    if (!same(token, ZERO)) {
      notes.push(["", "If the token blocks the transfer (a paused token, or a blocked address) or moves a different amount, the contract refuses the payout and your credit is kept."]);
    }
    const problems = element("div");
    const sign = button("Sign withdrawal", "btn small primary", async () => {
      sign.disabled = true;
      // runTx re-reads the payouts after mining. The confirmation stays in this card's new log
      // when some credit is left, and moves to the Payouts status line when the card is gone.
      const txLog = log();
      if (!txLog) return;
      const receipt = await runTx(txLog, units === null ? "Withdraw payout" : "Withdraw part of payout", () => (units === null
        ? S.contract["withdrawCredit(address,address)"](token, S.account)
        : S.contract["withdrawCredit(address,address,uint256)"](token, S.account, units)), { view: VIEWS.credit });
      if (receipt) {
        const paid = receiptEvent(receipt, "CreditPaid");
        followUp(txLog, "ok", paid ? `Paid ${amountText(token, paid.amount)} to your wallet.` : "Paid to your wallet.");
      } else if (receipt === false) {
        sign.disabled = false;
      }
    });
    out.append(
      reviewList([
        ["Amount", amountText(token, paying), units === null ? { tone: "ok", text: "everything" } : undefined],
        ["Paid to", addressBlock(S.account), { tone: "ok", text: "your wallet" }],
      ]),
      noteList(notes),
      problems,
      panelButtons(sign, button("Cancel", "btn small ghost", () => closePanel("credit", key))),
    );
  }
}

// ---------------------------------------------------------------- page wiring

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
