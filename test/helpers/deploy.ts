/**
 * The one place every test deploys InheritanceVault.
 *
 * v2 constructor: (initialAdmin, initialFeeBps, initialFeeRecipient, supported[], wrappedNative).
 * Tests that deposit an ERC20 must list it in `supported`, because v2 refuses every other token.
 *
 * VAULT_IMPL=v1 deploys InheritanceVaultV1 (contracts/v1, the deployed Base source) with the v1
 * constructor instead, and attaches the v2 ABI so the same test code can drive it. That is how a
 * regression test is shown to fail on v1 semantics:
 *
 *   VAULT_IMPL=v1 npx hardhat test test/AuditPrelim2026-09.ts
 *
 * In v1 mode `supported` and `wrappedNative` are ignored (v1 has neither), and calls to
 * functions v1 does not have revert. Where the two versions give the same function or event a
 * different shape (getVault's VaultView gained lockedFeeBps; ClaimInitiated gained
 * lockedFeeBps), v1's own fragment is used, so a test sees the v2-only field missing instead of
 * a decoding error, and v1-mode controls that read getVault still work. Never use v1 mode for
 * anything but that check.
 */
import { ethers } from "hardhat";
import { BaseContract, Contract, Interface } from "ethers";
import type { Signer } from "ethers";

export const VAULT_IMPL: "v1" | "v2" = process.env.VAULT_IMPL === "v1" ? "v1" : "v2";

export interface DeployVaultOptions {
  /** Signs the deployment. Defaults to the first signer. */
  deployer?: Signer;
  /** Defaults to the deployer's address. */
  admin?: string;
  /** Defaults to 50 (0.5%). */
  feeBps?: number;
  /** Defaults to address(0): no fee is charged. */
  feeRecipient?: string;
  /** ERC20s vaults may hold. Defaults to none (native only). */
  supported?: string[];
  /** The chain's wrapped-native token. Defaults to address(0) (none). */
  wrappedNative?: string;
}

/** Deploys the vault and resolves once it is mined. Rejects with the constructor's revert. */
export async function deployVault(opts: DeployVaultOptions = {}): Promise<Contract> {
  const deployer = opts.deployer ?? (await ethers.getSigners())[0];
  const admin = opts.admin ?? (await deployer.getAddress());
  const feeBps = opts.feeBps ?? 50;
  const feeRecipient = opts.feeRecipient ?? ethers.ZeroAddress;

  if (VAULT_IMPL === "v1") {
    const V1 = await ethers.getContractFactory("InheritanceVaultV1", deployer);
    const v1 = await V1.deploy(admin, feeBps, feeRecipient);
    await v1.waitForDeployment();
    // The deployment transaction is carried over (review round 2), so a test that reads the
    // deployment receipt fails on v1 for what v1's receipt lacks, not on a null transaction.
    // (Contract is BaseContract at runtime; only BaseContract's typing names the 4th argument.)
    return new BaseContract(
      await v1.getAddress(), await v1HybridInterface(V1.interface), deployer, v1.deploymentTransaction()
    ) as unknown as Contract;
  }

  const Vault = await ethers.getContractFactory("InheritanceVault", deployer);
  const vault = await Vault.deploy(
    admin,
    feeBps,
    feeRecipient,
    opts.supported ?? [],
    opts.wrappedNative ?? ethers.ZeroAddress
  );
  await vault.waitForDeployment();
  return vault as unknown as Contract;
}

/**
 * The v2 ABI, except that a v2 function whose selector v1 also has but whose outputs differ,
 * and a v2 event or error whose name v1 also uses with a different signature, are replaced by
 * v1's. (Review round 1: NothingCheckedIn gained an argument in v2, so a v1-mode control that
 * expects the bare error still matches v1's selector, while a v2 test that checks the argument
 * fails on v1 as it should.)
 */
async function v1HybridInterface(v1: Interface): Promise<Interface> {
  const v2 = (await ethers.getContractFactory("InheritanceVault")).interface;
  const fragments = v2.fragments.map((frag: any) => {
    if (frag.type === "function") {
      const old = v1.getFunction(frag.format("sighash"));
      if (old && old.format("json") !== frag.format("json")) return old;
    } else if (frag.type === "event") {
      const old = v1.getEvent(frag.name);
      if (old && old.format("sighash") !== frag.format("sighash")) return old;
    } else if (frag.type === "error") {
      const old = v1.getError(frag.name);
      if (old && old.format("sighash") !== frag.format("sighash")) return old;
    }
    return frag;
  });
  return new Interface(fragments);
}

/** The v2 factory, for matching constructor reverts (revertedWithCustomError needs an ABI). */
export async function vaultFactory(deployer?: Signer) {
  return ethers.getContractFactory("InheritanceVault", deployer);
}
