// F38 evidence-suite port: the repo's hardhat config, re-pointed at one mutant source tree (with its own
// cache and artifacts), so the v1 shipped suites in ../shipped-v1 can run against a mutated v1 contract.
// Used only by audit/2026-09-preliminary/poc/F38.ts, which sets F38_MUTANT_DIR.
import * as path from "path";
import base from "../../../../hardhat.config";

const dir = process.env.F38_MUTANT_DIR;
if (!dir) throw new Error("F38_MUTANT_DIR is not set");

const config = {
  ...base,
  paths: {
    ...base.paths,
    root: path.resolve(__dirname, "..", "..", "..", ".."),
    sources: `./${dir}/contracts`,
    cache: `./${dir}/cache`,
    artifacts: `./${dir}/artifacts`,
  },
};

export default config;
