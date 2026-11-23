/**
 * CoW Protocol deployments this module trades on. Every address is a constant of the package — nothing here is
 * ever read from the API:
 *
 * - GPv2Settlement and GPv2VaultRelayer are the same CREATE2 addresses on every chain
 *   (github.com/cowprotocol/contracts `networks.json`); the order's EIP-712 domain names the settlement contract,
 *   the allowance goes to the vault relayer.
 * - CoWSwapEthFlow (production) is one address on every chain
 *   (github.com/cowprotocol/ethflowcontract `broadcast/Deploy.sol/<chainId>/deployment.prod.json`); its `wrappedNativeToken()` is the chain's wrapped
 *   native, pinned here too.
 *
 * Checked on 2026-11-10 against the repositories above and on-chain on each chain: code present at all three
 * addresses, `GPv2Settlement.domainSeparator()` equal to the locally computed separator, `vaultRelayer()` equal to
 * the pinned relayer, `CoWSwapEthFlow.cowSwapSettlement()` and `wrappedNativeToken()` equal to the pins
 * (`scripts/verify-live.mjs` repeats all of it).
 */

/** GPv2Settlement — the EIP-712 verifying contract of every order, same address on every chain. */
export const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
/** GPv2VaultRelayer — the only spender an order's sell token is ever approved (or permitted) for. */
export const COW_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
/** CoWSwapEthFlow (production) — native-coin sells are created by calling it. */
export const COW_ETH_FLOW = "0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC";
/** The buy-token marker for "pay out the chain's native coin". */
export const COW_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** The public orderbook. No key. */
export const COW_API_BASE = "https://api.cow.fi";

export interface CowDeployment {
  chainId: number;
  /** The orderbook's path segment for the chain: `https://api.cow.fi/<network>/api/v1/…`. */
  network: string;
  /** Shown in refusals and the activity feed. */
  label: string;
  settlement: string;
  vaultRelayer: string;
  ethFlow: string;
  /** The wrapped native token eth-flow sells (its `wrappedNativeToken()`). */
  wrappedNative: string;
}

const chain = (chainId: number, network: string, label: string, wrappedNative: string): CowDeployment =>
  Object.freeze({chainId, network, label, settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER, ethFlow: COW_ETH_FLOW, wrappedNative});

/** The chains of v1. Another chain is one more line here (and in `module.json` / `watch.json`). */
export const COW_DEPLOYMENTS: Readonly<Record<number, CowDeployment>> = Object.freeze({
  1: chain(1, "mainnet", "Ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  8453: chain(8453, "base", "Base", "0x4200000000000000000000000000000000000006"),
  42161: chain(42161, "arbitrum_one", "Arbitrum", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The deployment table a provider runs on: the shipped chains plus the caller's `extra` ones (a chain CoW added
 * after this release). An extra chain may bring its own eth-flow and wrapped native; its settlement and vault
 * relayer must be the canonical ones — the engine pins those two for every CoW order, so another address could
 * never be signed for anyway.
 */
export function cowDeployments(extra?: Readonly<Record<number, CowDeployment>>): Readonly<Record<number, CowDeployment>> {
  if (!extra) return COW_DEPLOYMENTS;
  const out: Record<number, CowDeployment> = {...COW_DEPLOYMENTS};
  for (const [key, d] of Object.entries(extra)) {
    const chainId = Number(key);
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !d || d.chainId !== chainId) throw new Error(`cow: chain ${key} is not a valid deployment entry`);
    if (!/^[a-z0-9_]{1,40}$/.test(d.network)) throw new Error(`cow: chain ${chainId} names no orderbook network`);
    for (const a of [d.settlement, d.vaultRelayer, d.ethFlow, d.wrappedNative]) if (typeof a !== "string" || !ADDRESS.test(a)) throw new Error(`cow: chain ${chainId} has a malformed address`);
    if (d.settlement.toLowerCase() !== COW_SETTLEMENT.toLowerCase() || d.vaultRelayer.toLowerCase() !== COW_VAULT_RELAYER.toLowerCase()) {
      throw new Error(`cow: chain ${chainId} must use the canonical GPv2Settlement and GPv2VaultRelayer`);
    }
    out[chainId] = Object.freeze({...d});
  }
  return Object.freeze(out);
}

/** The deployment of `chainId`, own properties only (a chain id of "constructor" finds nothing). */
export function deploymentOf(table: Readonly<Record<number, CowDeployment>>, chainId: number): CowDeployment | null {
  return Object.prototype.hasOwnProperty.call(table, chainId) ? table[chainId]! : null;
}
