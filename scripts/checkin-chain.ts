/**
 * Reference generator for the Will & Key check-in chain (the lost-wallet path).
 *
 * The specification is docs/CHECKIN-CHAIN.md. In short, a chain for one vault installation is
 *
 *   x_0 = tip(seed, context)            derived, so the seed itself is never revealed
 *   x_i = step(x_{i-1}, context)        i = 1 .. count
 *   anchor = x_count                     what setCheckInChain installs
 *
 * and while getVault shows hbLeft == L, the value to submit to checkInByChain is x_{L-1}. So the
 * values are revealed in the order x_{count-1}, x_{count-2}, ..., x_0, and the last check-in
 * reveals x_0, the derived tip, never the seed.
 *
 *   tip(seed) = keccak256(abi.encode("WillAndKey/hb/v1", chainId, vault, owner, vaultId, epoch, seed))
 *               in v1 mode, and the same with "WillAndKey/hb/v2" in v2 mode.
 *
 * Two modes, because the two contracts check a step differently:
 *
 *   v1  (0xC821...fEe2f on Base) step = keccak256(x), the raw 32 bytes, because that is
 *       all v1 checks. The context is bound off-chain only, through the tip; `epoch` is then an
 *       install index you choose and print on the paper (1 for the first installation of that
 *       vault, +1 for every re-installation). Never re-use an install index for the same vault.
 *   v2  (contracts/InheritanceVault.sol) step = keccak256(abi.encode(HB_DOMAIN, chainId, vault,
 *       owner, vaultId, epoch, x)), exactly as the contract's hbStep. `epoch` is the vault's
 *       installation epoch the chain is for: getVault(...).hbEpoch + 1 at install.
 *
 * In both modes the tip binds the chain id, the vault contract, the owner, the vault id and the
 * epoch, so values revealed on one vault, chain or installation are useless on another. That is
 * a second line of defence, not a licence to share seeds: a LEAKED seed rebuilds every chain made
 * from it. Use a fresh seed for every vault and every chain.
 *
 * Usage (no Hardhat needed; the seed is read from the environment so it stays out of shell
 * history):
 *
 *   npx ts-node scripts/checkin-chain.ts seed
 *   CHECKIN_SEED=0x... npx ts-node scripts/checkin-chain.ts anchor --mode v2 --rpc <url> \
 *       --vault 0x... --owner 0x... --vault-id 0 --count 12
 *   CHECKIN_SEED=0x... npx ts-node scripts/checkin-chain.ts next --mode v2 --rpc <url> \
 *       --vault 0x... --owner 0x... --vault-id 0
 *
 * `anchor` prints the setCheckInChain call (anchor, count and, in v2, the epoch) and then every
 * value in the order it must be revealed (pass --no-values to leave them out). Without --rpc,
 * pass --chain-id and --epoch (and, for `next`, --left, the hbLeft getVault shows). With --rpc,
 * v2 mode reads hbEpoch, hbLeft and hbAnchor from the vault and checks this file's step against
 * the contract's own hbStep before printing anything. `next` refuses to print a value when no
 * chain is armed, when the chain is used up, and (with --rpc) when the seed does not lead to the
 * anchor installed on chain; it warns once the deadline is pinned at the horizon, and not
 * before, because the first check-in within one inactivity period of the horizon still moves
 * the deadline (to the horizon). docs/CHECKIN-CHAIN.md lists every refusal.
 */
import { AbiCoder, Contract, JsonRpcProvider, getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";
import type { ContractRunner } from "ethers";

export type Mode = "v1" | "v2";

export interface ChainContext {
  chainId: bigint | number;
  /** The InheritanceVault contract address. */
  vault: string;
  /** The vault owner's address. */
  owner: string;
  vaultId: bigint | number;
  /** v2: the installation epoch (getVault().hbEpoch + 1 at install). v1: your install index. */
  epoch: number;
}

/** The contract's HB_DOMAIN, the tag of every v2 step. */
export const HB_DOMAIN = keccak256(toUtf8Bytes("WillAndKey.CheckInChain.v2"));
/** The tag of the tip derivation, a Solidity `string` in abi.encode (so a dynamic field). */
export const TIP_TAG: Record<Mode, string> = { v1: "WillAndKey/hb/v1", v2: "WillAndKey/hb/v2" };
export const MAX_HB_COUNT = 100_000;

const coder = AbiCoder.defaultAbiCoder();
const STEP_TYPES = ["bytes32", "uint256", "address", "address", "uint256", "uint32", "bytes32"];
const TIP_TYPES = ["string", "uint256", "address", "address", "uint256", "uint32", "bytes32"];
const ZERO = "0x" + "00".repeat(32);

function encode(types: string[], tag: string, ctx: ChainContext, x: string): string {
  if (!Number.isInteger(ctx.epoch) || ctx.epoch < 1 || ctx.epoch > 0xffffffff) {
    throw new Error(`epoch must be an integer from 1 to 2^32-1, got ${ctx.epoch}`);
  }
  return coder.encode(types, [
    tag,
    BigInt(ctx.chainId),
    getAddress(ctx.vault),
    getAddress(ctx.owner),
    BigInt(ctx.vaultId),
    ctx.epoch,
    x,
  ]);
}

function assertBytes32(name: string, x: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(x)) throw new Error(`${name} must be 32 bytes of hex (0x + 64 digits)`);
}

/** x_0: the seed never appears on chain, only this. */
export function tip(mode: Mode, ctx: ChainContext, seed: string): string {
  assertBytes32("seed", seed);
  if (seed === ZERO) throw new Error("the seed must not be zero");
  return keccak256(encode(TIP_TYPES, TIP_TAG[mode], ctx, seed));
}

/** One step, exactly as the contract of `mode` verifies it. */
export function step(mode: Mode, ctx: ChainContext, x: string): string {
  assertBytes32("value", x);
  return mode === "v1" ? keccak256(x) : keccak256(encode(STEP_TYPES, HB_DOMAIN, ctx, x));
}

/** [x_0, x_1, ..., x_k]: the tip and every step up to x_k. */
function links(mode: Mode, ctx: ChainContext, seed: string, k: number): string[] {
  if (!Number.isInteger(k) || k < 0 || k > MAX_HB_COUNT) throw new Error(`link index out of range: ${k}`);
  const xs = [tip(mode, ctx, seed)];
  for (let i = 0; i < k; i++) xs.push(step(mode, ctx, xs[i]));
  // 2^-256, but the contract refuses a zero value, so such a chain would lose a check-in.
  if (xs.includes(ZERO)) throw new Error("a chain value is zero; use another seed");
  return xs;
}

/** x_k = step^k(tip). */
export function link(mode: Mode, ctx: ChainContext, seed: string, k: number): string {
  return links(mode, ctx, seed, k)[k];
}

export interface InstallPlan {
  anchor: string;
  count: number;
  epoch: number;
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_HB_COUNT) {
    throw new Error(`count must be 1..${MAX_HB_COUNT}`);
  }
}

/** The setCheckInChain arguments for an n-use chain: (vaultId, anchor, count[, epoch]). */
export function buildChain(mode: Mode, ctx: ChainContext, seed: string, count: number): InstallPlan {
  assertCount(count);
  return { anchor: link(mode, ctx, seed, count), count, epoch: ctx.epoch };
}

/**
 * Every value of an n-use chain, in the order checkInByChain must receive them:
 * [x_{count-1}, x_{count-2}, ..., x_0]. Entry i is the value to submit while hbLeft is count - i.
 */
export function revealOrder(mode: Mode, ctx: ChainContext, seed: string, count: number): string[] {
  assertCount(count);
  return links(mode, ctx, seed, count - 1).reverse();
}

/** The value to submit to checkInByChain while getVault shows hbLeft == left. */
export function nextValue(mode: Mode, ctx: ChainContext, seed: string, left: number): string {
  if (!Number.isInteger(left) || left < 1) throw new Error("the chain is exhausted (hbLeft is 0)");
  return link(mode, ctx, seed, left - 1);
}

// ------------------------------------------------------------------ reading a vault

const GET_VAULT_V1 =
  "function getVault(address,uint256) view returns ((address owner, uint256 vaultId, uint8 state, " +
  "address beneficiary, address token, uint128 balance, uint16 feeBps, uint64 createdAt, uint64 deadline, " +
  "uint64 absoluteDeadline, uint64 guaranteedInheritanceAt, uint32 inactivityPeriod, uint32 challengeWindow, " +
  "bool expired, bool horizonReached, address claimRecipient, uint64 claimInitiatedAt, uint64 finalizableAt, " +
  "bool finalizable, bytes32 hbAnchor, uint32 hbLeft, uint16 warnings))";
export const GET_VAULT_V2 =
  "function getVault(address,uint256) view returns ((address owner, uint256 vaultId, uint8 state, " +
  "address beneficiary, address token, uint128 balance, uint16 feeBps, uint16 lockedFeeBps, uint64 createdAt, " +
  "uint64 deadline, uint64 absoluteDeadline, uint64 guaranteedInheritanceAt, uint32 inactivityPeriod, " +
  "uint32 challengeWindow, bool expired, bool horizonReached, address claimRecipient, uint64 claimInitiatedAt, " +
  "uint64 finalizableAt, bool finalizable, bytes32 hbAnchor, uint32 hbLeft, uint32 hbEpoch, uint16 warnings))";
const HB_STEP = "function hbStep(address,uint256,uint32,bytes32) view returns (bytes32)";

export interface ChainState {
  chainId: bigint;
  hbAnchor: string;
  hbLeft: number;
  /** v2 only. */
  hbEpoch?: number;
  deadline: bigint;
  absoluteDeadline: bigint;
}

/** Reads the chain fields of one vault. `runner` is any ethers provider. */
export async function readChainState(
  runner: ChainReader,
  mode: Mode,
  vault: string,
  owner: string,
  vaultId: bigint | number
): Promise<ChainState> {
  const c = new Contract(vault, [mode === "v1" ? GET_VAULT_V1 : GET_VAULT_V2], runner);
  const v = await c.getVault(owner, vaultId);
  const { chainId } = await runner.getNetwork();
  return {
    chainId,
    hbAnchor: v.hbAnchor,
    hbLeft: Number(v.hbLeft),
    hbEpoch: mode === "v2" ? Number(v.hbEpoch) : undefined,
    deadline: v.deadline,
    absoluteDeadline: v.absoluteDeadline,
  };
}

/** v2: refuses to go on unless this file's step agrees with the contract's hbStep. */
export async function checkStepAgainstContract(runner: ContractRunner, ctx: ChainContext, probe: string): Promise<void> {
  const c = new Contract(ctx.vault, [HB_STEP], runner);
  const onChain: string = await c.hbStep(ctx.owner, ctx.vaultId, ctx.epoch, probe);
  const local = step("v2", ctx, probe);
  if (onChain !== local) {
    throw new Error(`step mismatch: contract ${onChain}, generator ${local}. Wrong chain, contract or mode?`);
  }
}

// ------------------------------------------------------------------ CLI

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function need(v: string | undefined, what: string): string {
  if (v === undefined || v === "") throw new Error(`missing ${what}`);
  return v;
}

/** What --rpc needs from a provider: contract calls and the chain id. */
export type ChainReader = ContractRunner & { getNetwork(): Promise<{ chainId: bigint }> };

/**
 * The command line. `log` receives every line of output (tests pass their own). The seed is
 * taken from `env.CHECKIN_SEED`, or from --seed (avoid: it lands in shell history).
 * `connect` turns the --rpc URL into a provider; tests pass one that returns their own, so the
 * on-chain checks below run exactly as they do against a real node.
 */
export async function cli(
  argv: string[],
  log: (line: string) => void = console.log,
  env: Record<string, string | undefined> = process.env,
  connect: (url: string) => ChainReader = (url) => new JsonRpcProvider(url)
): Promise<void> {
  const [cmd, ...args] = argv;
  if (cmd === "seed") {
    log(hexlify(randomBytes(32)));
    log("Write this down and keep it offline. Use it for ONE vault on ONE chain.");
    log("Anyone holding it can postpone your heir, up to the horizon.");
    return;
  }
  if (cmd !== "anchor" && cmd !== "next") {
    throw new Error("usage: checkin-chain.ts seed | anchor | next  (see the header of this file)");
  }
  const mode = need(arg(args, "mode"), "--mode v1|v2") as Mode;
  if (mode !== "v1" && mode !== "v2") throw new Error("--mode must be v1 or v2");
  const seed = need(env.CHECKIN_SEED ?? arg(args, "seed"), "the seed (CHECKIN_SEED or --seed)");
  const vault = getAddress(need(arg(args, "vault"), "--vault"));
  const owner = getAddress(need(arg(args, "owner"), "--owner"));
  const vaultId = BigInt(need(arg(args, "vault-id"), "--vault-id"));
  const rpc = arg(args, "rpc");
  const provider = rpc ? connect(rpc) : undefined;
  const state = provider ? await readChainState(provider, mode, vault, owner, vaultId) : undefined;
  // Checked before anything is derived: a disarmed vault's hbLeft is 0 too, and "exhausted"
  // would send its owner looking for the wrong fix.
  if (cmd === "next" && state && state.hbAnchor === ZERO) {
    throw new Error("no chain is armed on this vault (never installed, or disarmed); nothing to submit");
  }
  const chainId = state ? state.chainId : BigInt(need(arg(args, "chain-id"), "--chain-id (or --rpc)"));

  let epoch: number;
  const given = arg(args, "epoch");
  if (mode === "v2" && state) {
    // Installing moves the vault to hbEpoch + 1; a running chain is on hbEpoch itself.
    const onChain = cmd === "anchor" ? state.hbEpoch! + 1 : state.hbEpoch!;
    if (given !== undefined && Number(given) !== onChain) {
      throw new Error(`--epoch ${given} disagrees with the vault, which needs ${onChain}`);
    }
    epoch = onChain;
  } else {
    epoch = Number(need(given, mode === "v1" ? "--epoch (your install index for this vault)" : "--epoch (or --rpc)"));
  }
  const ctx: ChainContext = { chainId, vault, owner, vaultId, epoch };
  if (mode === "v2" && provider) await checkStepAgainstContract(provider, ctx, tip(mode, ctx, seed));

  if (cmd === "anchor") {
    const count = Number(need(arg(args, "count"), "--count"));
    const plan = buildChain(mode, ctx, seed, count);
    log(`mode ${mode}, chain ${chainId}, vault contract ${vault}, owner ${owner}, vault ${vaultId}`);
    log(`anchor ${plan.anchor}`);
    log(`count ${plan.count}`);
    if (mode === "v2") {
      log(`epoch ${plan.epoch}`);
      log(`call setCheckInChain(${vaultId}, ${plan.anchor}, ${plan.count}, ${plan.epoch})`);
    } else {
      log(`install index ${plan.epoch} (never re-use it for this vault)`);
      log(`call setCheckInChain(${vaultId}, ${plan.anchor}, ${plan.count})`);
    }
    if (args.includes("--no-values")) return;
    log("");
    log(`Values, in the order they must be revealed. Each is a bearer credential: whoever holds an`);
    log(`unspent one can postpone the heir by one inactivity period, up to the horizon.`);
    log(`Submit each at least a day before the deadline, never at the wire.`);
    const values = revealOrder(mode, ctx, seed, count);
    values.forEach((x, i) => log(`${String(i + 1).padStart(6)}  hbLeft ${String(count - i).padStart(6)}  ${x}`));
    return;
  }

  // next
  const left = state ? state.hbLeft : Number(need(arg(args, "left"), "--left (the hbLeft getVault shows) or --rpc"));
  const value = nextValue(mode, ctx, seed, left);
  if (state && state.hbAnchor !== step(mode, ctx, value)) {
    throw new Error("this seed, epoch and vault do not lead to the anchor installed on chain; do not submit");
  }
  if (state && state.deadline >= state.absoluteDeadline) {
    log(
      mode === "v2"
        ? "warning: the deadline is pinned at the horizon; checkInByChain reverts until the owner extends it"
        : "warning: the deadline is pinned at the horizon; v1 accepts this check-in but moves nothing, and the value is spent"
    );
  }
  log(`call checkInByChain(${owner}, ${vaultId}, ${value})`);
  log(`it must be mined STRICTLY before the deadline${state ? ` (${state.deadline})` : ""}; send it at least a day early`);
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
