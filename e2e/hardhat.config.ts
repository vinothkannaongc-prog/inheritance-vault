/**
 * Hardhat config for the browser end-to-end suite (e2e/run.js). It is the project config with
 * three changes, so the local node looks like Base to the app:
 *   - the in-process network reports chain id 8453, the id the app's CHAINS table serves;
 *   - a transaction that reverts is mined and its hash returned (throwOnTransactionFailures
 *     false), as a real node does: the app must read the failure from the receipt;
 *   - compiler output goes to a directory outside the repository (WK_E2E_BUILD_DIR, by default
 *     <os tmp>/willandkey-e2e-build), so a suite run never rewrites artifacts/ or cache/ under
 *     another process running the unit tests.
 * Sources are the repository's own contracts/ (paths.root is the repository root).
 */
import os from "os";
import path from "path";
import type { HardhatUserConfig } from "hardhat/config";
import base from "../hardhat.config";

const root = path.resolve(__dirname, "..");
const build = process.env.WK_E2E_BUILD_DIR ?? path.join(os.tmpdir(), "willandkey-e2e-build");

const config: HardhatUserConfig = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      ...(base.networks?.hardhat ?? {}),
      chainId: 8453,
      throwOnTransactionFailures: false,
      throwOnCallFailures: true,
    },
  },
  paths: {
    ...base.paths,
    root,
    sources: "./contracts",
    tests: "./test",
    cache: path.join(build, "cache"),
    artifacts: path.join(build, "artifacts"),
  },
};

export default config;
