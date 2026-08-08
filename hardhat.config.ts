import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";

/**
 * Target chains are Base (OP-stack ETH L2) and BNB Chain. Both run Cancun, so unlike the
 * Ozone contracts this project needs no London pin and PUSH0 is fine.
 *
 * Deploy keys come from the environment and are deliberately never committed. An unset key
 * simply leaves the network unusable, which is the correct failure mode.
 */
const deployer = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "storageLayout"] } },
    },
  },
  networks: {
    hardhat: {},
    // Port 8547, not 8545: the ozo-dapp project's London-pinned local node claims 8545 on this
    // machine, and Cancun bytecode sent there dies with "invalid opcode".
    localnode: { url: "http://127.0.0.1:8547", chainId: 31337 },
    base: {
      url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
      chainId: 8453,
      accounts: deployer,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts: deployer,
    },
    bnb: {
      url: process.env.BNB_RPC_URL ?? "https://bsc-dataseed.bnbchain.org",
      chainId: 56,
      accounts: deployer,
    },
    bnbTestnet: {
      url: process.env.BNB_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: deployer,
    },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  mocha: { timeout: 60_000 },
};

export default config;
