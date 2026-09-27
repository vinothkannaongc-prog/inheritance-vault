"use strict";
// The Base-like world the app is tested against, on the local chain (id 8453):
//   - v1 at its real Base address 0xC821...Ee2f: the hot key's first transaction (nonce 0)
//     created it there on Base, so the same key at nonce 0 creates it there locally. The Ledger is
//     its admin and pauses creation, as the launch plan says; that pause is V1_PAUSE_TX.
//   - Mock ERC20s at the four listed Base token addresses, with the symbols and decimals the
//     app's table expects (USDC 6, WETH 18, cbBTC 8, EURC 6), placed with hardhat_setCode. WETH
//     is a WETH9 port (deposit mints).
//   - v2 deployed by the hot key with the plan's constructor: admin and fee recipient the Ledger,
//     claim fee 50 bps, the four tokens in the deploy script's order, wrappedNative = WETH.

const { ethers } = require("ethers");
const { artifact, Chain } = require("./chain");
const { utcDateText, same, DAY } = require("./util");

const HOT_KEY = "0x4306a8875a04c0FbaC76CE2FC860E0b3c7aAd986";
const LEDGER = "0x883C821103B5415C53B11E584D3592205B5CdCA3";
const V1_ADDRESS = "0xC821849A1D74959753450409b594b23eCE7fEe2f";
const TOKENS = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", symbol: "USDC", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", name: "Coinbase Wrapped BTC", symbol: "cbBTC", decimals: 8 },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", name: "EURC", symbol: "EURC", decimals: 6 },
};
const LISTED = [TOKENS.USDC.address, TOKENS.WETH.address, TOKENS.cbBTC.address, TOKENS.EURC.address];
// Payees v2's _checkPayee refuses besides the vault and its listed tokens.
const REFUSED = {
  messagePasser: "0x4200000000000000000000000000000000000016",
  entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  vBNB: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function mint(address,uint256)",
  "function deposit() payable",
];

async function placeToken(chain, from, art, args, at) {
  const temp = await chain.deploy(art, from, args);
  const code = await chain.provider.getCode(await temp.getAddress());
  await chain.send("hardhat_setCode", [at, code]);
  // OpenZeppelin's ERC20 keeps name and symbol in storage (short strings sit inline in their
  // slot); the decimals of F36_LabelledToken are an immutable, so they came with the code.
  for (let slot = 0; slot < 8; slot += 1) {
    const value = await chain.send("eth_getStorageAt", [await temp.getAddress(), ethers.toQuantity(slot), "latest"]);
    if (BigInt(value) !== 0n) await chain.send("hardhat_setStorageAt", [at, ethers.toQuantity(slot), value]);
  }
}

/** The roles, all but the hot key and the Ledger default hardhat accounts the node signs for. */
async function roles(chain) {
  const accounts = (await chain.send("eth_accounts")).map((a) => ethers.getAddress(a));
  return {
    funder: accounts[0],
    alice: accounts[1], // a vault owner
    bob: accounts[2], // alice's heir
    carol: accounts[3], // another heir
    dave: accounts[4], // a stranger / keeper
    erin: accounts[5], // a payout address an heir names
    frank: accounts[6], // a second owner
    grace: accounts[7], // an owner with nothing anywhere
    spare: accounts.slice(8),
  };
}

async function deployWorld(chain) {
  const who = await roles(chain);
  const art = {
    v1: artifact("v1/InheritanceVaultV1.sol", "InheritanceVaultV1"),
    v2: artifact("InheritanceVault.sol", "InheritanceVault"),
    labelled: artifact("audit/F36_LabelledToken.sol", "F36_LabelledToken"),
    weth: artifact("audit/F09_WETH9Like.sol", "F09_WETH9Like"),
  };

  await chain.impersonate(HOT_KEY);
  await chain.impersonate(LEDGER);

  // v1, at its Base address.
  const v1 = await chain.deploy(art.v1, HOT_KEY, [LEDGER, 50, LEDGER]);
  if (!same(await v1.getAddress(), V1_ADDRESS)) {
    throw new Error(`v1 landed at ${await v1.getAddress()}, not ${V1_ADDRESS}: the hot key's nonce was not 0`);
  }
  // Alice keeps an open v1 vault and a v1 credit, which the app's v1 notice must report.
  const now = await chain.now();
  const v1Alice = v1.connect(chain.signer(who.alice));
  await Chain.mined(v1Alice.createVault(ethers.ZeroAddress, ethers.parseEther("1"), who.bob, 30 * DAY, 14 * DAY,
    now + 3650 * DAY, { value: ethers.parseEther("1") }));
  await Chain.mined(v1Alice.withdraw(0, ethers.parseEther("0.25"), who.alice));
  const pause = await Chain.mined(v1.connect(chain.signer(LEDGER)).setCreationPaused(true));

  // The listed tokens, at their Base addresses.
  await placeToken(chain, who.funder, art.labelled, [TOKENS.USDC.name, TOKENS.USDC.symbol, TOKENS.USDC.decimals], TOKENS.USDC.address);
  await placeToken(chain, who.funder, art.weth, [], TOKENS.WETH.address);
  await placeToken(chain, who.funder, art.labelled, [TOKENS.cbBTC.name, TOKENS.cbBTC.symbol, TOKENS.cbBTC.decimals], TOKENS.cbBTC.address);
  await placeToken(chain, who.funder, art.labelled, [TOKENS.EURC.name, TOKENS.EURC.symbol, TOKENS.EURC.decimals], TOKENS.EURC.address);
  // A token nobody listed, with a convincing name.
  const unlisted = await chain.deploy(art.labelled, who.funder, ["USD Coin", "USDC", 6]);

  // v2, as the plan deploys it. The hot key's nonce 1 created the retired billing contract on
  // Base, so v2 is sent from a later nonce: its local address is not one Base already uses.
  await chain.send("hardhat_setNonce", [HOT_KEY, "0x20"]);
  const v2 = await chain.deploy(art.v2, HOT_KEY, [LEDGER, 50, LEDGER, LISTED, TOKENS.WETH.address]);
  const deployTx = v2.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  const deployBlock = await chain.provider.getBlock(deployReceipt.blockNumber);

  // Balances for the people who deposit.
  for (const holder of [who.alice, who.frank, who.carol]) {
    for (const t of [TOKENS.USDC, TOKENS.cbBTC, TOKENS.EURC]) {
      await Chain.mined(chain.contract(t.address, ERC20_ABI, who.funder).mint(holder, ethers.parseUnits("1000000", t.decimals)));
    }
    await Chain.mined(chain.contract(TOKENS.WETH.address, ERC20_ABI, holder).deposit({ value: ethers.parseEther("50") }));
  }

  return {
    who,
    abi: { v2: art.v2.abi, v1: art.v1.abi, erc20: ERC20_ABI },
    v1Address: V1_ADDRESS,
    v1PauseTx: pause.hash,
    v2Address: ethers.getAddress(await v2.getAddress()),
    launch: {
      address: ethers.getAddress(await v2.getAddress()),
      block: deployReceipt.blockNumber,
      tx: deployTx.hash,
      date: utcDateText(deployBlock.timestamp),
      timestamp: Number(deployBlock.timestamp),
      v1PauseTx: pause.hash,
    },
    tokens: TOKENS,
    unlistedToken: ethers.getAddress(await unlisted.getAddress()),
    hotKey: HOT_KEY,
    ledger: LEDGER,
    refused: REFUSED,
  };
}

module.exports = { deployWorld, TOKENS, LISTED, HOT_KEY, LEDGER, V1_ADDRESS, REFUSED, ERC20_ABI };
